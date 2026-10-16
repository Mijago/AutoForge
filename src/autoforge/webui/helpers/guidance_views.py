"""What Heights mode shows - only things that are real:

* the targets: where depth, painted regions and picked colours pull each
  part of the picture (what the user asked for), as a shaded relief;
* a quick preview: the actual pipeline, guidance included, at a small size
  and with the stack searches early - its heights and colours are what a
  run does, at a lower resolution;
* followed: for a finished result, where its heights match the targets and
  where they don't.

(An earlier version estimated the heights with a separate stack search;
it could disagree with the run, which made it worse than nothing.)
"""

from __future__ import annotations

import base64
import os
import threading
import time
from typing import Any, Optional

import cv2
import numpy as np
import torch

from autoforge.Helper.HeightGuidance import PIXEL_TOLERANCE, build_target_maps, material_index_lookup, parse_spec
from autoforge.Helper.ImageHelper import imread, to_bgr_or_bgra_uint8

# The quick preview's print size (mm) at most, and its training: short, with
# the stack searches - where the guidance shapes the stack - from early on.
QUICK_SIZE_MM = 40.0
QUICK_ITERATIONS = 1500
QUICK_SEARCH_START = 500
QUICK_SEARCH_INTERVAL = 500
# Longest side of the targets view.
TARGETS_SIDE = 400

_quick_lock = threading.Lock()

QUICK_PREVIEW_BUSY = "A quick preview of the height suggestions is running; it takes a few seconds."


def quick_preview_running() -> bool:
    """A quick preview is on the GPU: runs and prunes wait for it."""
    return _quick_lock.locked()


def png_b64(rgba: np.ndarray) -> str:
    ok, buf = cv2.imencode(".png", cv2.cvtColor(np.ascontiguousarray(rgba), cv2.COLOR_RGBA2BGRA))
    return base64.b64encode(buf.tobytes()).decode("ascii") if ok else ""


def relief(height: np.ndarray, alpha: Optional[np.ndarray] = None) -> np.ndarray:
    """[H,W,4] uint8 relief of heights 0 (base) .. 1 (top): darker low,
    lighter high, gently lit from the top left (the light is worked out on
    a blurred copy: on the raw map every layer step and texture became a
    shadow line and drowned the shape)."""
    h = np.clip(height.astype(np.float32), 0.0, 1.0)
    span = max(h.shape) / 6.0
    soft = cv2.GaussianBlur(h, (0, 0), sigmaX=max(1.0, max(h.shape) / 150.0))
    gy, gx = np.gradient(soft * span)
    shade = np.clip(0.85 - 0.2 * (gx + gy), 0.55, 1.0)
    grey = (40 + 200 * h) * shade
    rgb = np.repeat(np.clip(grey, 0, 255)[..., None], 3, axis=2).astype(np.uint8)
    a = np.full(h.shape, 255, np.uint8) if alpha is None else np.clip(alpha, 0, 255).astype(np.uint8)
    return np.dstack([rgb, a])


def followed_colors(height: np.ndarray, target: np.ndarray, weight: np.ndarray) -> np.ndarray:
    """[H,W,4] uint8: green where a guided pixel's height (fraction of the
    print height) is within reach of its target, amber to red the further
    off it is; unguided pixels transparent."""
    off = np.clip((np.abs(height - target) - PIXEL_TOLERANCE) / 0.3, 0.0, 1.0)
    rgb = np.zeros(height.shape + (3,), np.float32)
    good = np.array([34, 197, 94], np.float32)
    mid = np.array([245, 158, 11], np.float32)
    bad = np.array([239, 68, 68], np.float32)
    t = off[..., None]
    rgb = np.where(t < 0.5, good + (mid - good) * (t / 0.5), mid + (bad - mid) * ((t - 0.5) / 0.5))
    a = (np.clip(weight, 0, 1) * 220).astype(np.uint8)
    return np.dstack([rgb.astype(np.uint8), a])


def _load_regions(path: Optional[str]) -> Optional[np.ndarray]:
    if not path:
        return None
    r = imread(path, cv2.IMREAD_UNCHANGED)
    if r is None:
        return None
    r = to_bgr_or_bgra_uint8(r)
    return cv2.cvtColor(r, cv2.COLOR_BGRA2RGBA) if r.shape[2] == 4 else None


def _load_image(path: str, side: int):
    img = imread(path, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise FileNotFoundError(path)
    img = to_bgr_or_bgra_uint8(img)
    alpha = img[:, :, 3] if img.shape[2] == 4 else None
    rgb = cv2.cvtColor(img[:, :, :3], cv2.COLOR_BGR2RGB)
    H, W = rgb.shape[:2]
    s = min(1.0, side / float(max(H, W)))
    size = (max(8, round(W * s)), max(8, round(H * s)))
    rgb = cv2.resize(rgb, size, interpolation=cv2.INTER_AREA)
    if alpha is not None:
        alpha = cv2.resize(alpha, size, interpolation=cv2.INTER_NEAREST)
    return rgb, alpha


def targets_view(image_path: str, settings: dict[str, Any], regions_path: Optional[str] = None, depth_fn=None) -> dict[str, Any]:
    """The targets as a shaded relief, as opaque as each pixel is pulled
    (unguided parts transparent); ``target`` None without pixel guidance."""
    rgb, alpha = _load_image(image_path, TARGETS_SIDE)
    raw = settings.get("height_guidance")
    spec = parse_spec(raw) if raw else None
    regions = _load_regions(regions_path)
    target, weight = (None, None)
    if (spec is not None and spec.strength > 0) or (regions is not None and (spec is None or spec.strength > 0)):
        target, weight = build_target_maps(spec, rgb, regions, alpha, depth_fn=depth_fn)
    if target is None:
        return {"target": None, "width": rgb.shape[1], "height_px": rgb.shape[0]}
    view = relief(target, alpha=(np.clip(weight, 0, 1) * 255))
    return {"target": png_b64(view), "width": rgb.shape[1], "height_px": rgb.shape[0]}


def result_heights(optimizer) -> Optional[np.ndarray]:
    """The result's heights as fractions of its top [H,W], or None."""
    _dg, z = optimizer.get_discretized_solution(best=True)
    if z is None:
        return None
    zf = z.detach().float().cpu().numpy()
    return zf / max(1.0, float(zf.max()))


def followed_view(result: dict[str, Any], settings: dict[str, Any], regions_path: Optional[str] = None, depth_fn=None) -> dict[str, Any]:
    """How a result's heights match the targets the settings ask for now:
    the followed map, the share of guided pixels within reach, and the
    result's relief."""
    optimizer = result["optimizer"]
    frac = result_heights(optimizer)
    if frac is None:
        raise ValueError("This result has no heights yet.")
    H, W = frac.shape
    at_output = frac.shape == tuple(result["output_target"].shape[:2])
    img = result["output_target"] if at_output else result["processing_target"]
    rgb = img.detach().cpu().numpy().astype(np.uint8)
    if rgb.shape[:2] != (H, W):
        rgb = cv2.resize(rgb, (W, H), interpolation=cv2.INTER_AREA)
    # Transparent pixels are never printed: not part of the comparison.
    alpha = result.get("alpha") if at_output else result.get("alpha_proc")
    if alpha is not None:
        alpha = alpha.detach().cpu().numpy() if torch.is_tensor(alpha) else np.asarray(alpha)
    raw = settings.get("height_guidance")
    spec = parse_spec(raw) if raw else None
    target, weight = build_target_maps(spec, rgb, _load_regions(regions_path), alpha, depth_fn=depth_fn)
    out: dict[str, Any] = {"relief": png_b64(relief(frac)), "width": W, "height_px": H, "followed": None, "share": None}
    if target is not None:
        out["followed"] = png_b64(followed_colors(frac, target, weight))
        within = (np.abs(frac - target) <= PIXEL_TOLERANCE + 0.05).astype(np.float32)
        out["share"] = float((within * weight).sum() / max(float(weight.sum()), 1e-8))
    return out


QUICK_MESH = "quick_preview_colored.ply"


def quick_mesh_path(output_dir: str) -> str:
    return os.path.join(output_dir, QUICK_MESH)


def quick_preview(image_path: str, filaments: list[dict[str, Any]], settings: dict[str, Any],
                  regions_path: Optional[str] = None, output_dir: Optional[str] = None) -> dict[str, Any]:
    """A real run, small and short (see module docstring): its relief, its
    colours, the followed map, the guidance report - and its 3D mesh in
    ``output_dir`` (QUICK_MESH), for the 3D view."""
    from autoforge.webui.helpers.colored_mesh import generate_colored_preview_mesh
    from autoforge.webui.helpers.pipeline_runner import run_pipeline
    from autoforge.webui.helpers.gpu_memory import release_pipeline_result
    from autoforge.webui.helpers.sliders import guidance_report_from_optimizer

    quick = dict(settings)
    quick.update(
        stl_output_size=min(float(settings.get("stl_output_size") or QUICK_SIZE_MM), QUICK_SIZE_MM),
        iterations=QUICK_ITERATIONS,
        intermediate_search_start=QUICK_SEARCH_START,
        intermediate_search_interval=QUICK_SEARCH_INTERVAL,
        num_init_rounds=1,
        height_regions=regions_path or "",
        tensorboard=False,
    )
    out_dir = output_dir or os.path.join("/tmp", "autoforge_quick_preview")
    started = time.time()
    with _quick_lock:
        state = run_pipeline(image_path, filaments, out_dir, quick)
        try:
            opt = state["optimizer"]
            comp = opt.get_best_discretized_image()
            colours = comp.detach().float().clamp(0, 255).cpu().numpy().astype(np.uint8)
            view = followed_view({**state, "output_target": state["processing_target"], "alpha": state.get("alpha_proc")}, settings, regions_path)
            report = guidance_report_from_optimizer(opt)
            _dg, z = opt.get_discretized_solution(best=True)
            args = state["args"]
            alpha = state.get("alpha_proc")
            mesh = generate_colored_preview_mesh(
                height_map=z.detach().float().cpu().numpy() * float(args.layer_height),
                color_image=colours,
                background_height=float(args.background_height),
                maximum_x_y_size=float(quick["stl_output_size"]),
                alpha_mask=alpha.detach().cpu().numpy() if alpha is not None else None,
            )
            os.makedirs(out_dir, exist_ok=True)
            tmp = f"{quick_mesh_path(out_dir)}.{os.getpid()}.tmp.ply"
            mesh.export(tmp, encoding="binary")
            os.replace(tmp, quick_mesh_path(out_dir))
        finally:
            release_pipeline_result(state)
    rgba = np.dstack([colours, np.full(colours.shape[:2], 255, np.uint8)])
    return {
        **view,
        "colors": png_b64(rgba),
        "report": report,
        "seconds": time.time() - started,
    }
