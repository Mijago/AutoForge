import asyncio
import json
import os
import threading
from types import SimpleNamespace
from typing import Any, Optional

import cv2
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from autoforge.Helper.FilamentHelper import hex_to_rgb
from autoforge.Helper.OtherHelper import get_device
from ..models import OptimizationSettings, ProjectState
from ..config import config
from ..services.filament_service import get_filament_service
from ..services.image_service import get_image_service
from ..services.optimization_service import get_optimization_service
from ..services.project_service import atomic_write_json
from ..helpers.colored_mesh import generate_colored_preview_mesh
from ..helpers.project_heightmap import encode_heightmap, restored_pipeline_result
from ..helpers.result_store import ResultUnavailable, using_result
from ..helpers.slider_render import compute_slider_render, write_slider_ply
from ..helpers.sliders import derive_base_from_result, derive_layer_range_from_result
from .init import (
    current_generation,
    get_init_pipeline_result,
    init_mesh_path,
    install_init_result,
    is_init_building,
)

router = APIRouter()

_state = ProjectState()


def _state_file() -> str:
    return os.path.join(config.checkpoints_path, "project_state.json")


@router.get("/state")
async def get_project_state():
    global _state
    path = _state_file()
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict):
                # A non-object top level (e.g. an old-format file that was a
                # bare list) — nothing to restore from.
                raise TypeError("project_state.json is not an object")
            _state = ProjectState(**data)
        except (json.JSONDecodeError, IOError, ValueError, TypeError):
            # ValueError: pydantic validation of an outdated/invalid file.
            pass
    return _state.model_dump()


@router.post("/state")
async def save_project_state(state: ProjectState):
    global _state
    _state = state
    path = _state_file()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    atomic_write_json(path, state.model_dump())
    return {"status": "ok"}


# Mirrors api/preview.py's INIT_JOB_SENTINEL: the pre-run auto-preview.
INIT_JOB_SENTINEL = "__init__"


@router.get("/heightmap")
async def get_heightmap(job_id: str):
    """The per-pixel layer counts of a result (or of the auto-preview), for
    a project file to carry — see helpers/project_heightmap.py."""
    if job_id == INIT_JOB_SENTINEL:
        result = get_init_pipeline_result()
        if not result:
            raise HTTPException(404, "The preview of the image isn't ready; the project is saved without its heightmap.")
        encoded = await asyncio.to_thread(encode_heightmap, result)
    else:
        job = get_optimization_service().get_job(job_id)
        if not job or job.status != "completed":
            raise HTTPException(404, "There's no finished result to take the heightmap from.")

        def _encode():
            with using_result(job_id) as result:
                return encode_heightmap(result)

        try:
            encoded = await asyncio.to_thread(_encode)
        except ResultUnavailable as e:
            raise HTTPException(404, f"{e} The project is saved without its heightmap.")
    if encoded is None:
        raise HTTPException(404, "This result has no heightmap yet.")
    return encoded


class RestoreHeightmapRequest(BaseModel):
    heightmap: str
    alpha: Optional[str] = None
    settings: OptimizationSettings
    sliders: list[dict[str, Any]] = Field(default_factory=list)
    active_filaments: list[dict[str, Any]] = Field(default_factory=list)
    background_color: Optional[str] = None
    # The base as the saved project showed it (which filament, auto or not);
    # the heightmap alone only knows its color.
    base: Optional[dict[str, Any]] = None


def _write_restored_mesh(result: dict, body: RestoreHeightmapRequest, background_rgb) -> None:
    """The mesh the 3D view loads first: colored by the saved layers, or —
    with none assigned — draped with the photo, like a fresh auto-preview."""
    filament_lookup = {f.uuid: f.model_dump() for f in get_filament_service().list()}
    for f in body.active_filaments:
        uuid_ = str(f.get("uuid", ""))
        if uuid_ and uuid_ not in filament_lookup:
            filament_lookup[uuid_] = f
    render = compute_slider_render(result, body.sliders, filament_lookup, background_rgb=background_rgb)
    out_dir = os.path.dirname(init_mesh_path())
    if render is not None:
        write_slider_ply(render, out_dir, os.path.basename(init_mesh_path()))
        return

    _global, layers = result["optimizer"].get_discretized_solution(best=True)
    h, w = int(layers.shape[0]), int(layers.shape[1])
    image_path = get_image_service().get_path(body.settings.input_image or "")
    image = cv2.imread(image_path, cv2.IMREAD_COLOR) if image_path else None
    if image is None:
        raise ValueError("The project's image isn't on this server.")
    image = cv2.cvtColor(cv2.resize(image, (w, h), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
    args = result["args"]
    alpha = result.get("alpha_proc")
    mesh = generate_colored_preview_mesh(
        height_map=layers.detach().cpu().numpy().astype("float32") * float(args.layer_height),
        color_image=image,
        background_height=float(args.background_height),
        maximum_x_y_size=float(args.stl_output_size),
        alpha_mask=alpha,
    )
    os.makedirs(out_dir, exist_ok=True)
    tmp = f"{init_mesh_path()}.{os.getpid()}.{threading.get_ident()}.tmp.ply"
    mesh.export(tmp, encoding="binary")
    os.replace(tmp, init_mesh_path())


def _saved_restore_file() -> str:
    # Not under _init/: resetting the auto-preview clears that directory's mesh.
    return os.path.join(config.checkpoints_path, "_project", "restored_heightmap.json")


def forget_saved_heightmap() -> None:
    try:
        os.remove(_saved_restore_file())
    except OSError:
        pass


async def restore_saved_heightmap(input_image: str) -> Optional[dict]:
    """A loaded project's heightmap, shown again for its image.

    It can't be rebuilt from the photo — it came with the project file — so
    without this a server restart (or a run, which releases the preview)
    turned the loaded project back into a fresh auto-preview of the photo.
    None when the last loaded project wasn't for ``input_image``."""
    path = _saved_restore_file()
    if not input_image or not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            body = RestoreHeightmapRequest(**json.load(f))
    except (OSError, ValueError, TypeError):
        forget_saved_heightmap()
        return None
    if body.settings.input_image != input_image or get_image_service().get_path(input_image) is None:
        return None
    return await _restore(body, remember=False)


@router.post("/heightmap")
async def restore_heightmap(body: RestoreHeightmapRequest):
    """Show a loaded project's saved heightmap as the auto-preview, instead
    of building a new one from the photo."""
    return await _restore(body, remember=True)


async def _restore(body: RestoreHeightmapRequest, remember: bool) -> dict:
    if is_init_building():
        raise HTTPException(400, "Already initializing")
    if get_optimization_service().get_any_active_job() is not None:
        raise HTTPException(409, "An optimization is running. Let it finish or cancel it before loading a project.")
    try:
        background_rgb = tuple(hex_to_rgb(body.background_color)) if body.background_color else None
    except (AttributeError, TypeError, ValueError):
        raise HTTPException(400, f"Invalid background_color: {body.background_color!r} (expected #RRGGBB)")
    generation = current_generation()
    settings = body.settings.model_dump()
    if body.background_color:
        settings["background_color"] = body.background_color

    def _build():
        device = get_device(SimpleNamespace(device=settings.get("device")))
        result = restored_pipeline_result(body.heightmap, body.alpha, settings, device)
        _write_restored_mesh(result, body, background_rgb)
        range_info = derive_layer_range_from_result(result) or {"min_layer": 0, "max_layer": int(settings["max_layers"])}
        return result, range_info, body.base or derive_base_from_result(result)

    try:
        result, range_info, base = await asyncio.to_thread(_build)
    except ValueError as e:
        raise HTTPException(400, f"Could not restore the project's heightmap: {e}")
    if not install_init_result(result, range_info, base, generation):
        raise HTTPException(409, "Auto-preview was reset while the project was being loaded.")
    if remember:
        path = _saved_restore_file()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        atomic_write_json(path, body.model_dump())
    return {"status": "ready", **range_info, "base": base}
