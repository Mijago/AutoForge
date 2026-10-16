"""Height guidance views for Heights mode (see helpers/guidance_views.py):
the targets, a quick real preview run, and how a result followed them."""

import asyncio
import logging
import os
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from ..config import config
from ..models import OptimizationSettings
from ..services.filament_service import get_filament_service
from ..services.image_service import get_image_service
from ..services.optimization_service import get_optimization_service
from ..helpers.guidance_views import followed_view, quick_mesh_path, quick_preview, targets_view
from ..helpers.pipeline_runner import friendly_error_message
from ..helpers.result_store import ResultUnavailable, using_result

logger = logging.getLogger(__name__)
router = APIRouter()


def _paths(settings: OptimizationSettings) -> tuple[str, Optional[str]]:
    if not settings.input_image:
        raise HTTPException(400, "Upload an input image first.")
    image_path = get_image_service().get_path(settings.input_image)
    if image_path is None:
        raise HTTPException(404, f"Input image not found: {settings.input_image}")
    regions_path = None
    if settings.height_regions:
        regions_path = get_image_service().get_path(settings.height_regions)
        if regions_path is None:
            raise HTTPException(404, f"Height regions not found: {settings.height_regions}")
    return image_path, regions_path


async def _run(fn, *args):
    try:
        return await asyncio.to_thread(fn, *args)
    except HTTPException:
        raise
    except (ValueError, FileNotFoundError, ResultUnavailable) as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        logger.exception("Height guidance view failed")
        raise HTTPException(500, friendly_error_message(e))


@router.post("/targets")
async def guidance_targets(settings: OptimizationSettings):
    """Where the guidance pulls each part of the picture (no run)."""
    image_path, regions_path = _paths(settings)
    return await _run(targets_view, image_path, settings.model_dump(), regions_path)


@router.post("/quick-preview")
async def guidance_quick_preview(settings: OptimizationSettings):
    """A small, short real run with the current guidance (a GPU job: not
    while an optimization or a prune runs)."""
    image_path, regions_path = _paths(settings)
    active = get_filament_service().get_active()
    if not active:
        raise HTTPException(400, "Add at least one active filament first.")
    busy = get_optimization_service().get_any_active_job()
    if busy is not None:
        raise HTTPException(409, f"An optimization is {busy.status}. Let it finish before previewing.")
    from .init import is_init_building

    if is_init_building():
        raise HTTPException(409, "The preview of the image is still being prepared; try again in a moment.")
    filaments = [
        {"color": f.color, "td": f.td, "name": f"{f.brand} - {f.name}", "uuid": f.uuid}
        for f in active
    ]
    out = await _run(quick_preview, image_path, filaments, settings.model_dump(), regions_path, _quick_dir())
    # A new name per preview, so the 3D view never shows a cached older one.
    out["mesh_url"] = f"/api/guidance/quick-preview/mesh?v={int(os.path.getmtime(quick_mesh_path(_quick_dir())) * 1000)}"
    return out


def _quick_dir() -> str:
    return os.path.join(config.checkpoints_path, "_quick_preview")


@router.get("/quick-preview/mesh")
async def guidance_quick_preview_mesh():
    path = quick_mesh_path(_quick_dir())
    if not os.path.isfile(path):
        raise HTTPException(404, "No quick preview yet.")
    return FileResponse(path, media_type="application/octet-stream")


@router.post("/followed/{job_id}")
async def guidance_followed(job_id: str, settings: OptimizationSettings):
    """How the result of ``job_id`` follows the guidance the settings ask
    for now."""
    _image_path, regions_path = _paths(settings)

    def work():
        with using_result(job_id) as result:
            return followed_view(result, settings.model_dump(), regions_path)

    return await _run(work)
