"""Regression: a saved project file must open with its own heightmap.

The project file only pointed at server-side things (an uploaded file name)
and carried no heightmap at all, so loading it rebuilt a fresh auto-preview
from the photo — a different surface, with the saved color layers painted
onto it. It now carries the heightmap; these cover saving it
(GET /api/project/heightmap) and restoring it as the auto-preview
(POST /api/project/heightmap).
"""

import argparse
import io

import numpy as np
import torch
from fastapi.testclient import TestClient
from PIL import Image

from autoforge.webui.api import init as init_api
from autoforge.webui.helpers.project_heightmap import encode_heightmap, restored_pipeline_result
from autoforge.webui.server import create_app

FILAMENT = {"uuid": "f-red", "brand": "T", "name": "Red", "color": "#ff0000", "td": 4.0}
SLIDERS = [{"td": 4.0, "layer": 20, "depth_mm": 0.8, "filament_uuid": "f-red", "enabled": True}]


class _FakeOptimizer:
    def __init__(self, heights, max_layers=40):
        self.max_layers = max_layers
        self._h = torch.as_tensor(heights)

    def get_discretized_solution(self, best=True):
        return torch.zeros(self.max_layers, dtype=torch.long), self._h


def _heights(h=12, w=16):
    rng = np.random.default_rng(3)
    return rng.integers(0, 31, size=(h, w)).astype(np.int64)


def _result(heights, alpha=None):
    return {
        "optimizer": _FakeOptimizer(heights),
        "args": argparse.Namespace(layer_height=0.04, background_height=0.24, stl_output_size=50),
        "background": torch.zeros(3),
        "alpha": alpha,
    }


def _settings(**overrides):
    return {"layer_height": 0.04, "max_layers": 40, "background_height": 0.24, "stl_output_size": 50, **overrides}


def test_heightmap_round_trips_exactly_with_alpha():
    heights = _heights()
    alpha = np.full((12, 16, 1), 255, dtype=np.uint8)
    alpha[:3, :5] = 0
    encoded = encode_heightmap(_result(heights, alpha))
    assert encoded["width"] == 16 and encoded["height"] == 12
    assert encoded["max_layer"] == int(heights.max())

    restored = restored_pipeline_result(encoded["heightmap"], encoded["alpha"], _settings(), torch.device("cpu"))
    _g, layers = restored["optimizer"].get_discretized_solution(best=True)
    np.testing.assert_array_equal(layers.numpy(), heights)
    np.testing.assert_array_equal(restored["alpha_proc"][:, :, 0], alpha[:, :, 0])
    assert restored["optimizer"].max_layers == 40


def test_heightmap_above_255_layers_survives():
    # 8-bit storage would wrap tall prints around.
    heights = np.full((4, 4), 300, dtype=np.int64)
    encoded = encode_heightmap(_result(heights))
    restored = restored_pipeline_result(encoded["heightmap"], None, _settings(max_layers=10), torch.device("cpu"))
    _g, layers = restored["optimizer"].get_discretized_solution(best=True)
    assert int(layers.max()) == 300
    assert restored["optimizer"].max_layers == 300


def test_get_heightmap_404_without_a_result():
    client = TestClient(create_app())
    assert client.get("/api/project/heightmap?job_id=__init__").status_code == 404
    assert client.get("/api/project/heightmap?job_id=no-such-job").status_code == 404


def test_restore_makes_the_saved_heightmap_the_auto_preview():
    client = TestClient(create_app())
    heights = _heights()
    encoded = encode_heightmap(_result(heights))
    base = {"color": "#123456", "height_mm": 0.24, "layers": 6, "filament_uuid": "f-base", "auto": False}

    res = client.post("/api/project/heightmap", json={
        "heightmap": encoded["heightmap"], "alpha": None, "settings": _settings(),
        "sliders": SLIDERS, "active_filaments": [FILAMENT], "background_color": "#123456", "base": base,
    })
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["min_layer"] == int(heights.min()) and body["max_layer"] == int(heights.max())
    assert body["base"] == base

    status = client.get("/api/init/status").json()
    assert status["status"] == "ready" and status["base"] == base
    assert client.get("/api/init/mesh").status_code == 200
    # Saving the loaded project again carries the very same heightmap.
    assert client.get("/api/project/heightmap?job_id=__init__").json()["heightmap"] == encoded["heightmap"]
    # And the color layers render against it.
    render = client.post("/api/preview/render-with-sliders", json={
        "sliders": SLIDERS, "active_filaments": [FILAMENT], "job_id": "__init__", "vertex_colors": True,
    })
    assert render.status_code == 200 and render.json()["status"] == "ok"


def test_restore_without_colors_drapes_the_photo():
    client = TestClient(create_app())
    buf = io.BytesIO()
    Image.new("RGB", (32, 24), (10, 200, 30)).save(buf, format="PNG")
    filename = client.post("/api/images/upload", files={"file": ("p.png", buf.getvalue(), "image/png")}).json()["filename"]
    encoded = encode_heightmap(_result(_heights()))

    res = client.post("/api/project/heightmap", json={
        "heightmap": encoded["heightmap"], "settings": _settings(input_image=filename), "sliders": [],
    })
    assert res.status_code == 200, res.text
    assert client.get("/api/init/mesh").status_code == 200


def test_restore_rejects_a_broken_heightmap():
    client = TestClient(create_app())
    res = client.post("/api/project/heightmap", json={"heightmap": "bm90IGEgcG5n", "settings": _settings(), "sliders": SLIDERS})
    assert res.status_code == 400
    assert client.get("/api/init/status").json()["status"] == "idle"


def test_restore_loses_to_a_reset_that_landed_meanwhile():
    encoded = encode_heightmap(_result(_heights()))
    result = restored_pipeline_result(encoded["heightmap"], None, _settings(), torch.device("cpu"))
    generation = init_api.current_generation()
    init_api.reset_init_state()
    assert not init_api.install_init_result(result, {"min_layer": 0, "max_layer": 1}, {}, generation)
    assert init_api.get_init_pipeline_result() is None
