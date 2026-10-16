"""Height guidance loop benchmark: adherence vs colour, at the webui's
defaults (6000 iterations, 150 mm, automatic first prune).

Every image runs without guidance for ``--base-seeds`` (cached: the
unguided path is bit-identical across guidance changes - pass
``--refresh-base`` after touching it) and with depth guidance for every
``--seeds`` x strength. Per run, on the pruned result:

* ``lr``    - colour loss (guidance off) / the mean unguided loss of the
              image over the base seeds (one run moves by up to ~10%);
* ``dist``  - mean |z/top - target| over the guided pixels (fraction of
              the print height; the Targets relief the webui shows);
* ``rho``   - Spearman rank correlation of heights and target;
* ``rough`` - mean |height step| to the 4-neighbours (layers);
* ``time``  - seconds (pipeline + prune).

Summary: ``dloss%`` = mean(lr - 1) * 100, ``dist``, ``rho``, ``time`` and
``score`` = mean(lr) + mean(dist / dist0) (lower is better; dist0 = the
unguided distance). A single seed is noise-dominated: screen on seeds
42 43, confirm on 44 45 and decide on the four-seed mean.

``--regions`` adds painted-region runs (a raised centre rectangle), whose
``lift`` (mean height inside minus outside) is reported separately.

    python benchmarks/guidance_loop_harness.py --tag base [--seeds 42 43] [--log "desc"]
"""

import argparse
import json
import os
import subprocess
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "benchmarks"))

import guidance_harness as gh  # noqa: E402

IMAGES = ["tourist", "family", "corgi", "landscape", "cat", "bird"]
BASE_CACHE = os.path.join(os.environ.get("HARNESS_OUT", "/tmp"), "guidance_loop_base.json")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--tag", required=True)
    p.add_argument("--images", nargs="+", default=IMAGES)
    p.add_argument("--strengths", nargs="+", type=float, default=[1, 10])
    p.add_argument("--seeds", nargs="+", type=int, default=[42, 43])
    p.add_argument("--base-seeds", nargs="+", type=int, default=[42, 43, 44])
    p.add_argument("--iterations", type=int, default=6000)
    p.add_argument("--size", type=float, default=150)
    p.add_argument("--regions", nargs="*", default=None, help="images for painted-region runs (s=1)")
    p.add_argument("--refresh-base", action="store_true")
    p.add_argument("--log", default=None)
    a = p.parse_args()
    os.environ.setdefault("HARNESS_OUT", os.path.dirname(BASE_CACHE))
    commit = subprocess.run(["git", "-C", ROOT, "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()

    base = {}
    if os.path.exists(BASE_CACHE) and not a.refresh_base:
        base = json.load(open(BASE_CACHE))
    keyof = lambda img, seed: f"{img}|{seed}|{a.iterations}|{a.size}"  # noqa: E731
    for img in a.images:
        for seed in sorted(set(a.base_seeds) | set(a.seeds)):
            if keyof(img, seed) not in base:
                loss, rho, dist, el = gh.run_one(img, 0, seed, a.iterations, a.size, "depth", True)
                base[keyof(img, seed)] = dict(loss=loss, rho=rho, dist=dist, time=el, rough=gh.LAST_ROUGH)
                print(f"BASE {img:10s} seed {seed} loss {loss:8.3f} rho {rho:+.3f} dist {dist:.3f} time {el:6.1f}s", flush=True)
                json.dump(base, open(BASE_CACHE, "w"))
    # The unguided reference: the mean over several seeds (one run's loss
    # moves by up to ~10% with the seed).
    ref = {img: dict(loss=float(np.mean([base[keyof(img, sd)]["loss"] for sd in a.base_seeds])),
                     dist=float(np.mean([base[keyof(img, sd)]["dist"] for sd in a.base_seeds])),
                     time=float(np.mean([base[keyof(img, sd)]["time"] for sd in a.base_seeds])))
           for img in a.images}

    rows = []
    for seed in a.seeds:
      for img in a.images:
        b = ref[img]
        for s in a.strengths:
            loss, rho, dist, el = gh.run_one(img, s, seed, a.iterations, a.size, "depth", True)
            lr = loss / b["loss"]
            rows.append(dict(seed=seed, img=img, s=s, loss=loss, lr=lr, dist=dist, dr=dist / b["dist"], rho=rho, time=el,
                             rough=gh.LAST_ROUGH))
            print(f"RESULT {a.tag} {img:10s} seed {seed} s={s:<4g} loss {loss:8.3f} ({(lr - 1) * 100:+5.1f}%) "
                  f"dist {dist:.3f} rho {rho:+.3f} time {el:5.1f}s", flush=True)
    reg = []
    for img in a.regions or []:
        loss0 = None
        k = f"regions|{keyof(img, a.seeds[0])}"
        if k not in base:
            l0, lift0, _, _ = gh.run_one(img, 0, a.seeds[0], a.iterations, a.size, "regions", True)
            base[k] = dict(loss=l0, lift=lift0)
            json.dump(base, open(BASE_CACHE, "w"))
        loss0 = base[k]["loss"]
        loss, lift, dist, el = gh.run_one(img, 1, a.seeds[0], a.iterations, a.size, "regions", True)
        reg.append(dict(img=img, lr=loss / loss0, lift=lift, dist=dist, time=el))
        print(f"REGIONS {a.tag} {img:10s} loss {(loss / loss0 - 1) * 100:+5.1f}% lift {lift:+.3f} "
              f"(unguided {base[k]['lift']:+.3f}) dist {dist:.3f} time {el:5.1f}s", flush=True)

    def summary(sel):
        return dict(
            dloss=float(np.mean([r["lr"] for r in sel]) - 1) * 100,
            dist=float(np.mean([r["dist"] for r in sel])),
            rho=float(np.mean([r["rho"] for r in sel])),
            time=float(np.mean([r["time"] for r in sel])),
            rough=float(np.mean([r["rough"] for r in sel])),
            score=float(np.mean([r["lr"] for r in sel]) + np.mean([r["dr"] for r in sel])),
        )

    t0 = float(np.mean([ref[i]["time"] for i in a.images]))
    for s in a.strengths:
        m = summary([r for r in rows if r["s"] == s])
        print(f"MEAN {a.tag} s={s:<4g} dloss {m['dloss']:+6.2f}% dist {m['dist']:.4f} rho {m['rho']:+.4f} "
              f"score {m['score']:.4f} rough {m['rough']:.3f} time {m['time']:5.1f}s", flush=True)
    if len(a.seeds) > 1:
        for seed in a.seeds:
            m = summary([r for r in rows if r.get("seed") == seed])
            print(f"SEED {a.tag} {seed} dloss {m['dloss']:+6.2f}% dist {m['dist']:.4f} rho {m['rho']:+.4f} score {m['score']:.4f}")
    m = summary(rows)
    extra = ""
    if reg:
        extra = f" regions dloss {(np.mean([r['lr'] for r in reg]) - 1) * 100:+.2f}% lift {np.mean([r['lift'] for r in reg]):+.4f}"
    print(f"TOTAL {a.tag} dloss {m['dloss']:+6.2f}% dist {m['dist']:.4f} rho {m['rho']:+.4f} score {m['score']:.4f} "
          f"time {m['time']:5.1f}s (unguided {t0:5.1f}s){extra}", flush=True)

    if a.log:
        path = os.path.join(ROOT, "results_guidance_loop.tsv")
        new = not os.path.exists(path)
        with open(path, "a") as fh:
            if new:
                fh.write("git_commit\ttag\tscore\tdloss_pct\tdist\trho\tdloss_s1\tdist_s1\tdloss_s10\tdist_s10\t"
                         "reg_dloss_pct\treg_lift\ttime_s\ttime_unguided_s\tstatus\tdescription\n")
            per = {s: summary([r for r in rows if r["s"] == s]) for s in a.strengths}
            g = lambda s, f: f"{per[s][f]:.4f}" if s in per else ""  # noqa: E731
            rd = f"{(np.mean([r['lr'] for r in reg]) - 1) * 100:.2f}" if reg else ""
            rl = f"{np.mean([r['lift'] for r in reg]):.4f}" if reg else ""
            status = os.environ.get("LOOP_STATUS", "keep")
            fh.write(f"{commit}\t{a.tag}\t{m['score']:.4f}\t{m['dloss']:.2f}\t{m['dist']:.4f}\t{m['rho']:.4f}\t"
                     f"{g(1.0, 'dloss')}\t{g(1.0, 'dist')}\t{g(10.0, 'dloss')}\t{g(10.0, 'dist')}\t{rd}\t{rl}\t"
                     f"{m['time']:.1f}\t{t0:.1f}\t{status}\t{a.log}\n")


if __name__ == "__main__":
    main()
