"""A finished run must hand the UI the result's own slider stack.

The pipeline keeps changing the solution after the last training preview
(stack search, pixel refinement, limits), so the color layers used to stay
on the preview's stack — a different number of bands than the stored result
— and the next slider render rebuilt the mesh from that stale stack.
"""

import os
import time

import numpy as np
import torch
from fastapi.testclient import TestClient

from autoforge.webui.server import create_app
from autoforge.webui.services.optimization_service import get_optimization_service


class _Opt:
    h = 0.04
    best_discrete_loss = 1.0
    base_material = None

    def __init__(self, stack):
        self.stack = torch.tensor(stack, dtype=torch.long)
        self.material_colors = torch.zeros((2, 3))
        self.background = torch.zeros(3)

    def get_discretized_solution(self, best=True):
        return self.stack, torch.full((4, 4), float(len(self.stack)))

    def get_best_discretized_image(self):
        return np.zeros((4, 4, 3), np.uint8)


def test_completed_run_sends_the_result_stack_before_it_is_marked_completed(monkeypatch):
    from autoforge.webui.api import optimization as opt_api
    from autoforge.webui.config import config

    client = TestClient(create_app())
    events = []
    monkeypatch.setattr(
        opt_api, "broadcast_preview",
        lambda image, job_id, sliders=None, **kw: events.append(("sliders", [s["layer"] for s in sliders or []])),
    )
    svc = get_optimization_service()
    original_update = svc.update_status

    def recording_update(job_id, status, **kwargs):
        events.append(("status", status))
        return original_update(job_id, status, **kwargs)

    monkeypatch.setattr(svc, "update_status", recording_update)

    def fake_pipeline(**kwargs):
        # The last training preview has two bands ...
        kwargs["preview_callback"](_Opt([0, 0, 1, 1]), 5)
        # ... the finished result four.
        return {"cancelled": False, "optimizer": _Opt([0, 1, 0, 1]), "material_TDs_np": np.array([1.0, 2.0])}

    monkeypatch.setattr(opt_api, "_run_pipeline", fake_pipeline)
    monkeypatch.setattr("autoforge.webui.helpers.pipeline_runner.export_results", lambda result, **_kwargs: None)

    os.makedirs(config.uploads_path, exist_ok=True)
    with open(os.path.join(config.uploads_path, "final.png"), "wb") as f:
        f.write(b"x")
    client.put("/api/filaments/active", json=[{"uuid": "a", "name": "A", "td": 1.0}, {"uuid": "b", "name": "B", "td": 2.0}])
    job_id = client.post("/api/optimize/start", json={"input_image": "final.png", "iterations": 10}).json()["job_id"]

    deadline = time.time() + 10
    while time.time() < deadline and client.get(f"/api/optimize/status/{job_id}").json()["status"] != "completed":
        time.sleep(0.05)
    assert client.get(f"/api/optimize/status/{job_id}").json()["status"] == "completed"

    slider_events = [e for e in events if e[0] == "sliders"]
    assert slider_events[0] == ("sliders", [2, 4])
    assert slider_events[-1] == ("sliders", [1, 2, 3, 4])
    # Sent while the job is still running, so the UI's completion snapshot has it.
    assert events.index(slider_events[-1]) < events.index(("status", "completed"))
    # And it is the same stack the API derives for the stored result.
    assert [s["layer"] for s in client.get(f"/api/sliders/from-optimizer?job_id={job_id}").json()["sliders"]] == [1, 2, 3, 4]
