"""Height guidance in the WebUI backend: the settings, the painted regions
file, the preview endpoint and what a saved result keeps."""

import argparse
import base64
import os
import time

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from autoforge.webui.server import create_app


@pytest.fixture
def client():
    return TestClient(create_app())


COLORS = {"hg-black": "#000000", "hg-white": "#ffffff", "hg-red": "#cc2020"}


def _active_filaments(client):
    for uuid, color in COLORS.items():
        fil = {"brand": "HG", "name": uuid, "color": color, "td": 2.0, "filament_type": "PLA", "uuid": uuid}
        client.post("/api/filaments", json=fil)
        client.post("/api/filaments/active", json=fil)


def _upload_png(client, name, image):
    ok, png = cv2.imencode(".png", image)
    assert ok
    r = client.post("/api/images/upload", files={"file": (name, png.tobytes(), "image/png")})
    assert r.status_code == 200, r.text
    return r.json()["filename"]


def _picture():
    img = np.zeros((40, 60, 3), np.uint8)
    img[:, :20] = (20, 20, 20)
    img[:, 20:40] = (32, 32, 204)  # BGR red
    img[:, 40:] = (240, 240, 240)
    return img


def _regions():
    r = np.zeros((40, 60, 4), np.uint8)  # BGRA
    r[:10] = (0, 0, 255, 255)  # red = raise
    return r


def _wait_for_status(client, job_id, statuses, timeout=10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = client.get(f"/api/optimize/status/{job_id}")
        if r.is_success and r.json().get("status") in statuses:
            return r.json()
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} never reached {statuses!r}")


GUIDANCE = {"strength": 2, "order": "dark_to_light", "pins": [{"uuid": "hg-red", "position": 0.8}],
            "depth": False, "colors": [{"color": "#ffffff", "tolerance": 10, "direction": "lower"}]}


def test_run_passes_the_guidance_and_resolves_the_regions(client, monkeypatch):
    import autoforge.webui.api.optimization as opt_api

    _active_filaments(client)
    image = _upload_png(client, "hg-picture.png", _picture())
    regions = _upload_png(client, "hg-regions.png", _regions())
    seen = {}

    def fake_run_pipeline(**kwargs):
        seen["settings"] = kwargs["settings"]
        return {"cancelled": True, "device": None, "optimizer": object()}

    monkeypatch.setattr(opt_api, "_run_pipeline", fake_run_pipeline)
    r = client.post("/api/optimize/start", json={
        "input_image": image, "iterations": 10, "height_guidance": GUIDANCE, "height_regions": regions,
    })
    assert r.status_code == 200, r.text
    _wait_for_status(client, r.json()["job_id"], {"cancelled", "failed"})
    s = seen["settings"]
    path = s["height_regions"]
    assert os.path.isabs(path) and os.path.basename(path) == regions
    assert s["height_guidance"]["pins"] == [{"uuid": "hg-red", "position": 0.8}]
    assert s["height_guidance"]["colors"][0]["direction"] == "lower"


def test_run_with_missing_regions_fails_with_a_message(client, monkeypatch):
    import autoforge.webui.api.optimization as opt_api

    _active_filaments(client)
    image = _upload_png(client, "hg-picture.png", _picture())
    monkeypatch.setattr(opt_api, "_run_pipeline", lambda **k: pytest.fail("must not run"))
    r = client.post("/api/optimize/start", json={"input_image": image, "iterations": 10, "height_regions": "gone.png"})
    assert r.status_code == 200, r.text
    status = _wait_for_status(client, r.json()["job_id"], {"failed"})
    assert "Height regions not found" in status["error"]


def _png(b64):
    return cv2.imdecode(np.frombuffer(base64.b64decode(b64), np.uint8), cv2.IMREAD_UNCHANGED)


def test_invalid_guidance_is_rejected_up_front(client):
    r = client.post("/api/guidance/targets", json={"input_image": "x.png", "height_guidance": {"order": "sideways"}})
    assert r.status_code == 422
    r = client.post("/api/guidance/targets", json={"input_image": "x.png", "height_guidance": {"pins": [{"uuid": "a", "position": 2}]}})
    assert r.status_code == 422


def test_targets_show_where_pixels_are_pulled(client):
    image = _upload_png(client, "hg-picture.png", _picture())
    regions = _upload_png(client, "hg-regions.png", _regions())
    r = client.post("/api/guidance/targets", json={"input_image": image, "height_guidance": GUIDANCE, "height_regions": regions})
    assert r.status_code == 200, r.text
    out = r.json()
    target = _png(out["target"])
    assert target.shape == (40, 60, 4)
    # The painted strip (raised: light) and the white picked color (lowered:
    # dark) are pulled; the rest is clear.
    assert target[:10, :, 3].min() == 255
    assert target[20:, :20, 3].max() == 0
    assert target[:10, :40, :3].mean() > target[20:, 40:, :3].mean()
    # Only pins and order: nothing pulls pixels.
    r = client.post("/api/guidance/targets", json={"input_image": image, "height_guidance": {"pins": [{"uuid": "hg-red", "position": 0.5}]}})
    assert r.status_code == 200 and r.json()["target"] is None


def test_views_need_an_image(client):
    r = client.post("/api/guidance/targets", json={"input_image": "", "height_guidance": GUIDANCE})
    assert r.status_code == 400
    r = client.post("/api/guidance/targets", json={"input_image": "nope.png", "height_guidance": GUIDANCE})
    assert r.status_code == 404
    r = client.post("/api/guidance/quick-preview", json={"input_image": "nope.png"})
    assert r.status_code == 404


def test_quick_preview_is_a_real_small_run(client, monkeypatch):
    """The preview is the pipeline itself (made small and short), and shows
    its heights, its colors and how they follow the targets."""
    import autoforge.webui.helpers.guidance_views as gv
    from autoforge.webui.helpers import pipeline_runner

    _active_filaments(client)
    image = _upload_png(client, "hg-picture.png", _picture())
    seen = {}
    real = pipeline_runner.run_pipeline

    def spy(path, fil, out, settings, **kw):
        seen["settings"] = settings
        return real(path, fil, out, {**settings, "iterations": 60, "discrete_check": 20}, **kw)

    monkeypatch.setattr(pipeline_runner, "run_pipeline", spy)
    monkeypatch.setattr(gv, "QUICK_ITERATIONS", 60)
    r = client.post("/api/guidance/quick-preview", json={
        "input_image": image, "max_layers": 20, "stl_output_size": 150,
        "height_guidance": {"strength": 1, "colors": [{"color": "#ffffff", "direction": "raise"}]},
    })
    assert r.status_code == 200, r.text
    out = r.json()
    s = seen["settings"]
    assert s["stl_output_size"] == gv.QUICK_SIZE_MM and s["intermediate_search_start"] == gv.QUICK_SEARCH_START
    assert s["height_guidance"]["colors"][0]["direction"] == "raise"
    relief, colors, followed = _png(out["relief"]), _png(out["colors"]), _png(out["followed"])
    assert relief.shape == colors.shape == followed.shape
    assert 0.0 <= out["share"] <= 1.0
    assert out["report"] is not None
    # Its mesh, for the 3D view.
    mesh = client.get(out["mesh_url"])
    assert mesh.status_code == 200 and mesh.content[:3] == b"ply"


def test_quick_preview_waits_for_a_running_job(client, monkeypatch):
    from autoforge.webui.services.optimization_service import get_optimization_service

    _active_filaments(client)
    image = _upload_png(client, "hg-picture.png", _picture())
    monkeypatch.setattr(get_optimization_service(), "get_any_active_job", lambda: type("J", (), {"status": "running"})())
    r = client.post("/api/guidance/quick-preview", json={"input_image": image})
    assert r.status_code == 409


def test_followed_compares_a_result_with_the_targets():
    from autoforge.webui.helpers.guidance_views import followed_view
    import torch

    class Opt:
        def get_discretized_solution(self, best=True):
            z = torch.zeros(4, 6, dtype=torch.long)
            z[:, 3:] = 10  # right half at the top
            return None, z

    img = torch.zeros(4, 6, 3)
    img[:, 3:] = 255.0  # right half white
    result = {"optimizer": Opt(), "output_target": img, "processing_target": img}
    raise_white = {"height_guidance": {"strength": 1, "colors": [{"color": "#ffffff", "tolerance": 10, "direction": "raise"}]}}
    out = followed_view(result, raise_white)
    assert out["share"] == pytest.approx(1.0)
    lower_white = {"height_guidance": {"strength": 1, "colors": [{"color": "#ffffff", "tolerance": 10, "direction": "lower"}]}}
    out = followed_view(result, lower_white)
    assert out["share"] == pytest.approx(0.0)
    f = _png(out["followed"])
    assert f[:, :3, 3].max() == 0 and f[:, 3:, 3].min() > 0  # only the guided half is drawn


def test_a_saved_result_keeps_its_guidance():
    from autoforge.webui.helpers.result_store import _args_dict

    args = argparse.Namespace(height_guidance=GUIDANCE, height_regions="/tmp/r.png", iterations=5)
    saved = _args_dict(args)
    assert saved["height_guidance"] == GUIDANCE and saved["height_regions"] == "/tmp/r.png"


def test_followed_leaves_out_transparent_pixels():
    from autoforge.webui.helpers.guidance_views import followed_view
    import torch

    class Opt:
        def get_discretized_solution(self, best=True):
            return None, torch.full((4, 6), 10, dtype=torch.long)  # everything at the top

    img = torch.full((4, 6, 3), 255.0)
    alpha = np.full((4, 6), 255, np.uint8)
    alpha[:, :3] = 0  # left half transparent (and printed at the top here)
    result = {"optimizer": Opt(), "output_target": img, "processing_target": img, "alpha": alpha}
    lower_white = {"height_guidance": {"strength": 1, "colors": [{"color": "#ffffff", "tolerance": 10, "direction": "lower"}]}}
    out = followed_view(result, lower_white)
    f = _png(out["followed"])
    assert f[:, :3, 3].max() == 0 and f[:, 3:, 3].min() > 0


def test_runs_and_prunes_wait_for_a_quick_preview(client):
    """A quick preview is a GPU run of its own (not a job): starting an
    optimization or a prune meanwhile put two runs on the GPU."""
    import autoforge.webui.helpers.guidance_views as gv

    _active_filaments(client)
    image = _upload_png(client, "hg-picture.png", _picture())
    with gv._quick_lock:
        r = client.post("/api/optimize/start", json={"input_image": image, "iterations": 10})
        assert r.status_code == 409 and "quick preview" in r.json()["detail"]
        r = client.post("/api/pruning/start", json={"pruning_max_colors": 3, "pruning_max_swaps": 3, "pruning_max_layer": 10, "job_id": "x"})
        assert r.status_code == 409 and "quick preview" in r.json()["detail"]
