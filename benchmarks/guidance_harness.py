"""Height guidance benchmark: how closely a run follows the photo's depth,
and what it costs in colour.

For every image and strength (0 = no guidance) one webui pipeline run with
depth guidance; reported on the run's best solution at the solver
resolution:

* ``loss``   - the colour loss with the guidance switched off;
* ``rho``    - Spearman rank correlation of the heights with the depth
               target (1 = the print's height order is the depth order);
               with ``--mode regions``: mean height of the raised area
               minus the rest (fraction of the print height);
* ``dist``   - mean |z/top - target| (fraction of the print height);
* ``time``   - seconds.

    python benchmarks/guidance_harness.py --tag base [--strengths 0 1 3 10]
        [--images landscape tourist corgi] [--seed 42] [--log "desc"]

``--log`` appends one line per image/strength to results_guidance.tsv.
"""

import argparse
import csv
import os
import subprocess
import sys
import time

import numpy as np
import torch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))

from autoforge.Helper import HeightGuidance as hg  # noqa: E402
from autoforge.Helper.PruningHelper import _compute_loss_for_heightmap  # noqa: E402
from autoforge.webui.helpers.pipeline_runner import run_pipeline  # noqa: E402


def filaments():
    rows = list(csv.DictReader(open(os.path.join(ROOT, "benchmarks", "webui_filaments.csv"))))
    return [{"color": r["Color"], "td": float(r["TD"]), "name": r["Name"], "uuid": f"u{i}"} for i, r in enumerate(rows)]


def spearman(a: np.ndarray, b: np.ndarray, w: np.ndarray) -> float:
    keep = w > 0
    ra = np.argsort(np.argsort(a[keep], kind="stable"), kind="stable").astype(np.float64)
    rb = np.argsort(np.argsort(b[keep], kind="stable"), kind="stable").astype(np.float64)
    if ra.std() == 0 or rb.std() == 0:
        return 0.0
    return float(np.corrcoef(ra, rb)[0, 1])


def _regions_png(image: str) -> str:
    """A raised rectangle in the middle of the picture (a quarter of it),
    the rest unpainted, as the webui's painted regions."""
    import cv2

    img = cv2.imread(os.path.join(ROOT, "images", "test_images", f"{image}.jpg"))
    H, W = img.shape[:2]
    r = np.zeros((H, W, 4), np.uint8)
    r[H // 4 : 3 * H // 4, W // 4 : 3 * W // 4] = (0, 0, 255, 255)  # BGRA red = raise
    path = os.path.join(os.environ.get("HARNESS_OUT", "/tmp"), f"regions_{image}.png")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    cv2.imwrite(path, r)
    return path


LAST_ROUGH = 0.0


def run_one(image: str, strength: float, seed: int, iterations: int, size: float, mode: str = "depth", prune: bool = False):
    regions = mode == "regions"
    guidance = {"strength": strength, "depth": not regions} if strength > 0 else None
    t = time.time()
    st = run_pipeline(
        os.path.join(ROOT, "images", "test_images", f"{image}.jpg"), filaments(),
        os.path.join(os.environ.get("HARNESS_OUT", "/tmp"), f"guid_{image}_{strength}"),
        # Strength 0 is the colour-only reference: without the webui's
        # hidden default guidance either.
        dict(iterations=iterations, stl_output_size=size, num_init_rounds=1, random_seed=seed, height_guidance=guidance,
             default_height_guidance=False,
             height_regions=_regions_png(image) if regions and strength > 0 else ""),
    )
    if prune:
        # The webui's automatic first prune: an unlimited pass at the output
        # resolution (export swaps in the full-resolution heights first).
        from autoforge.webui.helpers.pipeline_runner import export_results

        st["args"].perform_pruning = True
        st["args"].pruning_max_colors = 100
        st["args"].pruning_max_swaps = 100
        st["args"].pruning_max_layer = int(st["args"].max_layers)
        export_results(st, prune_only=True)
    if torch.cuda.is_available():
        torch.cuda.synchronize()
    elapsed = time.time() - t
    opt = st["optimizer"]
    dg, z = opt.get_discretized_solution(best=True)
    saved, opt.guidance = opt.guidance, None
    loss = _compute_loss_for_heightmap(opt, dg)
    opt.guidance = saved
    # The depth target at the solver resolution (cached per image).
    img = st["output_target"].cpu().numpy().astype(np.uint8)
    if regions:
        import cv2 as _cv2

        rg = _cv2.cvtColor(_cv2.imread(_regions_png(image), _cv2.IMREAD_UNCHANGED), _cv2.COLOR_BGRA2RGBA)
        target, weight = hg.build_target_maps(hg.GuidanceSpec(), img, rg)
        # Unpainted pixels: judged as "anything but the top" (target 0, weak).
        weight = np.where(weight > 0, weight, 0.25).astype(np.float32)
    else:
        target, weight = hg.build_target_maps(hg.GuidanceSpec(depth=True), img)
    import cv2

    H, W = z.shape
    target = cv2.resize(target, (W, H), interpolation=cv2.INTER_AREA)
    weight = cv2.resize(weight, (W, H), interpolation=cv2.INTER_AREA)
    zf = z.float().cpu().numpy()
    top = max(1.0, float(zf.max()))
    global LAST_ROUGH
    # Surface roughness: mean |height step| to the 4-neighbours (layers).
    LAST_ROUGH = float((np.abs(np.diff(zf, axis=0)).mean() + np.abs(np.diff(zf, axis=1)).mean()) / 2)
    rho = spearman(zf.ravel(), target.ravel(), weight.ravel())
    dist = float((np.abs(zf / top - target) * weight).sum() / max(weight.sum(), 1e-8))
    if regions:
        # Painted regions: how much higher the raised area prints than the
        # rest (fractions of the print height), reported as "rho".
        inside = (target > 0.5) & (weight >= 0.5)
        rho = float((zf / top)[inside].mean() - (zf / top)[~inside].mean())
    return loss, rho, dist, elapsed


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--tag", required=True)
    p.add_argument("--images", nargs="+", default=["landscape", "tourist", "corgi"])
    p.add_argument("--strengths", nargs="+", type=float, default=[0, 1, 3, 10])
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--iterations", type=int, default=3000)
    p.add_argument("--size", type=float, default=50)
    p.add_argument("--log", default=None)
    p.add_argument("--mode", choices=["depth", "regions"], default="depth")
    p.add_argument("--prune", action="store_true", help="also run the automatic first prune and measure after it")
    a = p.parse_args()
    commit = subprocess.run(["git", "-C", ROOT, "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()
    rows = []
    for image in a.images:
        for s in a.strengths:
            loss, rho, dist, el = run_one(image, s, a.seed, a.iterations, a.size, a.mode, a.prune)
            rows.append((image, s, loss, rho, dist, el))
            print(f"RESULT {a.tag} {image:10s} s={s:<5g} loss {loss:8.3f} rho {rho:+.3f} dist {dist:.3f} time {el:6.1f}s", flush=True)
    for s in a.strengths:
        sel = [r for r in rows if r[1] == s]
        print(f"MEAN {a.tag} s={s:<5g} loss {np.mean([r[2] for r in sel]):8.3f} rho {np.mean([r[3] for r in sel]):+.3f} "
              f"dist {np.mean([r[4] for r in sel]):.3f} time {np.mean([r[5] for r in sel]):6.1f}s", flush=True)
    if a.log:
        path = os.path.join(ROOT, "results_guidance.tsv")
        new = not os.path.exists(path)
        with open(path, "a") as fh:
            if new:
                fh.write("git_commit\ttag\timage\tstrength\tloss\trho\tdist\ttime_s\tdescription\n")
            for image, s, loss, rho, dist, el in rows:
                fh.write(f"{commit}\t{a.tag}\t{image}\t{s:g}\t{loss:.4f}\t{rho:.4f}\t{dist:.4f}\t{el:.1f}\t{a.log}\n")


if __name__ == "__main__":
    main()
