"""The heightmap a saved project file carries.

A project file is meant to be shared, so it can't point at anything only
this server has (a job id, an uploaded file). What makes a result a result
is its per-pixel layer count: with it, the color layers re-render exactly as
they looked when the project was saved, on any machine. Without it, a
loaded project fell back to a fresh auto-preview heightmap of the photo — a
different surface, with the result's color layers painted onto it.

The heightmap travels as a 16-bit grayscale PNG (one value per pixel: the
number of printed layers), the alpha mask as an 8-bit one.
"""

from __future__ import annotations

import base64
from types import SimpleNamespace
from typing import Any, Optional

import cv2
import numpy as np
import torch

from autoforge.Helper.FilamentHelper import hex_to_rgb
from .slider_render import _alpha_matching_shape

# Far above any real print (max_layers tops out in the hundreds) — a bound
# against a crafted file asking for a huge allocation, not a feature limit.
MAX_HEIGHTMAP_PIXELS = 4096 * 4096


def _png_b64(image: np.ndarray) -> str:
    ok, buf = cv2.imencode(".png", image)
    if not ok:
        raise ValueError("could not encode PNG")
    return base64.b64encode(buf.tobytes()).decode("ascii")


def _decode_png(b64: str, what: str) -> np.ndarray:
    try:
        data = base64.b64decode(b64, validate=True)
    except (ValueError, TypeError):
        raise ValueError(f"{what} is not valid base64")
    image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
    if image is None:
        raise ValueError(f"{what} is not a PNG image")
    if image.ndim == 3:
        image = image[:, :, 0]
    if image.shape[0] * image.shape[1] > MAX_HEIGHTMAP_PIXELS:
        raise ValueError(f"{what} is too large")
    return image


def encode_heightmap(pipeline_result: dict[str, Any]) -> Optional[dict[str, Any]]:
    """The result's discrete heightmap (and alpha mask) as PNGs, or None
    when the result has no discretized solution."""
    optimizer = pipeline_result["optimizer"]
    _disc_global, disc_height_image = optimizer.get_discretized_solution(best=True)
    if disc_height_image is None:
        return None
    layers = disc_height_image.detach().cpu().numpy()
    layers = np.clip(np.rint(layers), 0, 65535).astype(np.uint16)
    alpha = _alpha_matching_shape(pipeline_result, layers.shape[:2])
    alpha_b64 = None
    if alpha is not None:
        alpha = np.asarray(alpha)
        if alpha.ndim == 3:
            alpha = alpha[:, :, 0]
        if alpha.dtype == bool or (alpha.dtype.kind == "f" and alpha.max(initial=0) <= 1.0):
            alpha = alpha.astype(np.float32) * 255.0
        alpha_b64 = _png_b64(np.clip(alpha, 0, 255).astype(np.uint8))
    return {
        "heightmap": _png_b64(layers),
        "alpha": alpha_b64,
        "width": int(layers.shape[1]),
        "height": int(layers.shape[0]),
        "max_layer": int(layers.max(initial=0)),
    }


class SavedHeightmap:
    """Stands in for the optimizer of a pipeline result: everything that
    renders the color layers only asks it for the discrete solution."""

    def __init__(self, layers: torch.Tensor, max_layers: int):
        self.max_layers = int(max_layers)
        self._layers = layers
        self._global = torch.zeros(self.max_layers, dtype=torch.long, device=layers.device)

    def get_discretized_solution(self, best: bool = True):
        return self._global, self._layers


def restored_pipeline_result(
    heightmap_b64: str,
    alpha_b64: Optional[str],
    settings: dict[str, Any],
    device: torch.device,
) -> dict[str, Any]:
    """A pipeline result built from a saved heightmap — enough for the
    slider render, the layer range and the base color (see api/init.py)."""
    layers_np = _decode_png(heightmap_b64, "heightmap")
    alpha_np = _decode_png(alpha_b64, "alpha mask") if alpha_b64 else None
    if alpha_np is not None and alpha_np.shape != layers_np.shape:
        raise ValueError("alpha mask and heightmap differ in size")

    max_layer = int(layers_np.max(initial=0))
    max_layers = max(int(settings.get("max_layers") or 0), max_layer, 1)
    layers = torch.as_tensor(layers_np.astype(np.int64), device=device)
    background_color = str(settings.get("background_color") or "#000000")
    try:
        background_rgb = hex_to_rgb(background_color)
    except (AttributeError, TypeError, ValueError):
        background_color, background_rgb = "#000000", (0.0, 0.0, 0.0)

    args = SimpleNamespace(
        layer_height=float(settings.get("layer_height") or 0.04),
        background_height=float(settings.get("background_height") or 0.0),
        background_color=background_color,
        auto_background_color=False,
        stl_output_size=float(settings.get("stl_output_size") or 150.0),
        edge_bleed=float(settings.get("edge_bleed", 0.25)),
        max_layers=max_layers,
    )
    return {
        "optimizer": SavedHeightmap(layers, max_layers),
        "args": args,
        "background": torch.tensor(background_rgb, dtype=torch.float32, device=device),
        "alpha_proc": alpha_np[:, :, None] if alpha_np is not None else None,
        "alpha": None,
        "device": device,
        "material_uuids": [],
        "colors_list": [],
    }
