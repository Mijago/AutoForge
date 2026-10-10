"""Regression: a result could only be pruned or re-colored while the server
still held it in memory.

The server keeps one live result (the newest) and none across a restart, so
going back in History, pruning a result a second time from where it was, or
simply restarting the server ended in "No optimization pipeline result found
(this result was pruned since, or the server was restarted)". A loaded
project couldn't be pruned at all, and after a restart it came back as a
fresh auto-preview of the photo instead of its own heightmap.

Every finished run and prune now saves its solution (helpers/result_store),
and whatever isn't live anymore is rebuilt from it. These run real (tiny)
optimizations.
"""

import io
import time

import numpy as np
import pytest
import torch
from fastapi.testclient import TestClient
from PIL import Image

from autoforge.webui.server import create_app

FILAMENTS = [
    ("Black", "#111111", 0.6),
    ("White", "#F0F0F0", 2.5),
    ("Red", "#D02020", 1.5),
    ("Blue", "#2040C0", 1.2),
]

RUN_SETTINGS = {
    "iterations": 40, "max_layers": 10, "stl_output_size": 16, "num_init_rounds": 1,
    "random_seed": 7, "auto_initial_prune": False,
}

PRUNE = {
    "pruning_max_colors": 3, "pruning_max_swaps": 4, "pruning_max_layer": 10,
    "seed_search_count": 5, "fine_tune_height": False,
}


@pytest.fixture
def client():
    with TestClient(create_app()) as c:
        yield c


def _image() -> bytes:
    y, x = np.mgrid[0:48, 0:48]
    img = np.zeros((48, 48, 3), np.uint8)
    img[..., 0] = (x * 5).astype(np.uint8)
    img[..., 2] = (y * 5).astype(np.uint8)
    img[16:32, 16:32] = (240, 240, 240)
    buf = io.BytesIO()
    Image.fromarray(img).save(buf, format="PNG")
    return buf.getvalue()


def _setup(client) -> tuple[str, list[dict]]:
    active = []
    for name, color, td in FILAMENTS:
        r = client.post("/api/filaments", json={"brand": "T", "name": name, "color": color, "td": td})
        assert r.status_code == 200, r.text
        assert client.post("/api/filaments/active", json=r.json()).status_code == 200
        active.append(r.json())
    r = client.post("/api/images/upload", files={"file": ("pic.png", _image(), "image/png")})
    assert r.status_code == 200, r.text
    return r.json()["filename"], active


def _wait(client, job_id: str, timeout: float = 240.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = client.get(f"/api/optimize/status/{job_id}").json()
        if status["status"] in ("completed", "failed", "cancelled"):
            return status
        time.sleep(0.1)
    raise AssertionError(f"{job_id} did not finish")


def _run(client, image: str) -> str:
    r = client.post("/api/optimize/start", json={"input_image": image, **RUN_SETTINGS})
    assert r.status_code == 200, r.text
    status = _wait(client, r.json()["job_id"])
    assert status["status"] == "completed", status
    return status["job_id"]


def _prune(client, **body) -> dict:
    r = client.post("/api/pruning/start", json={**PRUNE, **body})
    assert r.status_code == 200, r.text
    return _wait(client, r.json()["job_id"])


def _restart_server() -> None:
    """What a restart leaves: the job history on disk, nothing in memory."""
    from autoforge.webui.api import init as init_api
    from autoforge.webui.services import optimization_service

    optimization_service.get_optimization_service().clear_all_pipeline_results()
    optimization_service.reset_service()
    init_api._state = {"status": "idle", "preview_image": None, "error": None, "range": None}
    init_api._pipeline_result = None


def _solution(job_id: str):
    from autoforge.webui.services.optimization_service import get_optimization_service

    optimizer = get_optimization_service().get_pipeline_result(job_id)["optimizer"]
    stack, heights = optimizer.get_discretized_solution(best=True)
    return stack.cpu().clone(), heights.cpu().long().clone()


def test_rebuilt_result_is_the_same_solution(client):
    """The saved solution comes back exactly: same stack, same heights,
    same loss, same color layers and base."""
    from autoforge.Helper.PruningHelper import _compute_loss_for_heightmap
    from autoforge.webui.services.optimization_service import get_optimization_service

    image, _active = _setup(client)
    job = _run(client, image)
    stack0, heights0 = _solution(job)
    result = get_optimization_service().get_pipeline_result(job)
    loss0 = float(_compute_loss_for_heightmap(result["optimizer"], result["optimizer"].get_discretized_solution(best=True)[0]))
    sliders0 = client.get(f"/api/sliders/from-optimizer?job_id={job}").json()
    base0 = client.get(f"/api/sliders/base?job_id={job}").json()

    _restart_server()
    sliders1 = client.get(f"/api/sliders/from-optimizer?job_id={job}").json()
    base1 = client.get(f"/api/sliders/base?job_id={job}").json()
    stack1, heights1 = _solution(job)
    rebuilt = get_optimization_service().get_pipeline_result(job)
    loss1 = float(_compute_loss_for_heightmap(rebuilt["optimizer"], rebuilt["optimizer"].get_discretized_solution(best=True)[0]))

    assert torch.equal(stack0, stack1)
    assert torch.equal(heights0, heights1)
    assert loss1 == pytest.approx(loss0, abs=1e-4)
    assert sliders1 == sliders0
    assert base1 == base0


def test_prune_and_recolor_after_a_restart(client):
    image, active = _setup(client)
    job = _run(client, image)
    _restart_server()

    sliders = client.get(f"/api/sliders/from-optimizer?job_id={job}").json()["sliders"]
    r = client.post("/api/preview/render-with-sliders", json={
        "job_id": job, "sliders": sliders, "active_filaments": active,
    })
    assert r.status_code == 200, r.text

    status = _prune(client, job_id=job)
    assert status["status"] == "completed", status
    assert status["result_colors"] <= PRUNE["pruning_max_colors"]


def test_the_result_a_prune_started_from_can_be_pruned_again(client):
    """After pruning, the original result used to answer "pruned since"."""
    image, _active = _setup(client)
    job = _run(client, image)
    stack0, heights0 = _solution(job)

    first = _prune(client, job_id=job)
    assert first["status"] == "completed", first

    # Back in History to the unpruned result: it is what a prune starts from.
    second = _prune(client, job_id=job)
    assert second["status"] == "completed", second
    assert second["pruning_start_loss"] == pytest.approx(first["pruning_start_loss"], abs=1e-4)

    # And the pruned one survives a restart as well.
    _restart_server()
    third = _prune(client, job_id=second["job_id"])
    assert third["status"] == "completed", third

    # The original job's own solution never changed.
    from autoforge.webui.helpers.result_store import resolve_pipeline_result

    resolve_pipeline_result(job)
    stack1, heights1 = _solution(job)
    assert torch.equal(stack0, stack1) and torch.equal(heights0, heights1)


def _save_project(client, job: str, image: str, active: list[dict]) -> dict:
    heightmap = client.get(f"/api/project/heightmap?job_id={job}")
    assert heightmap.status_code == 200, heightmap.text
    sliders = client.get(f"/api/sliders/from-optimizer?job_id={job}").json()["sliders"]
    base = client.get(f"/api/sliders/base?job_id={job}").json()["base"]
    return {
        "heightmap": heightmap.json()["heightmap"],
        "alpha": heightmap.json()["alpha"],
        "settings": {"input_image": image, **RUN_SETTINGS},
        "sliders": sliders,
        "active_filaments": active,
        "background_color": base["color"],
        "base": base,
    }


def test_a_loaded_project_can_be_pruned(client):
    """A project from another machine has no job on this server: pruning
    starts from its heightmap and color layers."""
    from autoforge.webui.helpers.result_store import ResultUnavailable  # noqa: F401
    from autoforge.webui.services.optimization_service import get_optimization_service

    image, active = _setup(client)
    job = _run(client, image)
    stack0, heights0 = _solution(job)
    project = _save_project(client, job, image, active)

    # Another machine: no history, no results.
    _restart_server()
    import shutil
    import os
    from autoforge.webui.config import config

    shutil.rmtree(os.path.join(config.checkpoints_path, job))
    r = client.post("/api/project/heightmap", json=project)
    assert r.status_code == 200, r.text

    status = _prune(
        client, job_id="__init__", settings=project["settings"], sliders=project["sliders"],
        active_filaments=active, background_color=project["background_color"], base=project["base"],
    )
    assert status["status"] == "completed", status
    assert status["input_image"] == image
    assert status["result_colors"] <= PRUNE["pruning_max_colors"]

    # It started from the project's own solution, not a new one.
    assert get_optimization_service().get_pipeline_result(status["job_id"]) is not None
    from autoforge.webui.helpers.result_store import load_solution, rebuild_pipeline_result, solution_from_sliders
    from autoforge.webui.services.image_service import get_image_service

    restored = solution_from_sliders(
        heights0.numpy(), project["sliders"], active, {"input_image": image, **RUN_SETTINGS},
        background_color=project["background_color"], base=project["base"],
    )
    rebuilt = rebuild_pipeline_result(restored, get_image_service().get_path(image), str(config.checkpoints_path))
    stack1, heights1 = rebuilt["optimizer"].get_discretized_solution(best=True)
    assert torch.equal(heights0, heights1.cpu().long())
    assert torch.equal(stack0, stack1.cpu())

    # The pruned result is saved like any other.
    assert load_solution(os.path.join(config.checkpoints_path, status["job_id"])) is not None


def test_pruning_the_preview_needs_color_layers(client):
    image, active = _setup(client)
    job = _run(client, image)
    project = _save_project(client, job, image, active)
    _restart_server()
    assert client.post("/api/project/heightmap", json=project).status_code == 200

    r = client.post("/api/pruning/start", json={
        **PRUNE, "job_id": "__init__", "settings": project["settings"], "sliders": [], "active_filaments": active,
    })
    assert r.status_code == 400
    assert "color layers" in r.json()["detail"]


def test_a_loaded_projects_heightmap_survives_a_restart(client, monkeypatch):
    """After a restart the preview of a loaded project used to be rebuilt
    from the photo — a different surface than the project's."""
    import autoforge.webui.api.init as init_api

    image, active = _setup(client)
    job = _run(client, image)
    project = _save_project(client, job, image, active)
    assert client.post("/api/project/heightmap", json=project).status_code == 200
    saved = client.get("/api/project/heightmap?job_id=__init__").json()

    _restart_server()

    def _no_photo_build(*_a, **_k):
        raise AssertionError("built a new preview from the photo")

    monkeypatch.setattr(init_api, "_run_init_sync", _no_photo_build)
    r = client.post("/api/init/run", json=project["settings"])
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "ready"
    assert client.get("/api/project/heightmap?job_id=__init__").json()["heightmap"] == saved["heightmap"]

    # A new upload / new project forgets it, even for the same photo.
    assert client.post("/api/init/reset?forget=true").status_code == 200
    built = []
    monkeypatch.setattr(init_api, "_run_init_sync", lambda *a, **k: built.append(True) or (_ for _ in ()).throw(RuntimeError("stop")))
    client.post("/api/init/run", json=project["settings"])
    assert built == [True]


def test_old_results_without_a_saved_solution_explain_why(client):
    from autoforge.webui.services.optimization_service import get_optimization_service

    svc = get_optimization_service()
    job = svc.create_job({"iterations": 10, "input_image": "a.png"})
    svc.update_status(job.job_id, "completed")
    r = client.post("/api/preview/render-with-sliders", json={"job_id": job.job_id, "sliders": []})
    assert r.status_code == 409
    assert "restarted" in r.json()["detail"]
