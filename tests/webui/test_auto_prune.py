"""Automatic pruning: lower the limits pass by pass until the loss would go
over the target, then keep the last pass that was under it."""

import argparse
import time

import pytest
import torch
from fastapi.testclient import TestClient

from autoforge.webui.helpers.auto_prune import AUTO_PRUNE_PRESETS, AutoPruneSearch
from autoforge.webui.server import create_app


# ---- the search bookkeeping -------------------------------------------------


def test_presets_are_the_documented_levels():
    assert AUTO_PRUNE_PRESETS == {"extremely_good": 10, "very_good": 20, "good": 30, "acceptable": 40}


def _search(start=None, **kw):
    return AutoPruneSearch(start or {"colors": 10, "swaps": 20, "layers": 40}, **kw)


def _run(search, good_under, counts=None):
    """Drive a search where a pass is good iff its limits are all >= good_under.
    Returns the limits tried, in order."""
    counts = dict(counts or search.start)
    tried = []
    while (limits := search.propose(counts)) is not None:
        tried.append(limits)
        if all(limits[k] >= good_under[k] for k in limits):
            counts = dict(limits)
            search.accept()
        else:
            search.reject()
    return tried


def test_first_pass_tries_the_middle_of_the_range():
    search = _search()
    limits = search.propose(search.start)
    assert limits == {"colors": 5, "swaps": 10, "layers": 20}


def test_a_good_pass_halves_what_is_left_and_a_bad_one_goes_back_up():
    search = _search({"colors": 8, "swaps": 8, "layers": 8})
    search.propose(search.start)
    first = search._level
    search.accept()
    search.propose(search.limits_at(first))
    second = search._level
    assert second > first  # good: keep going down
    search.reject()
    search.propose(search.limits_at(first))
    assert first < search._level < second  # bad: between the two


def test_finds_the_exact_edge_in_logarithmically_many_passes():
    # Anything down to 7 colors / 14 swaps / 27 layers is fine, no further.
    edge = {"colors": 7, "swaps": 14, "layers": 27}
    search = _search()
    tried = _run(search, edge)
    assert search.outcome == "limit_reached"
    assert len(tried) <= 7  # n = 39 levels
    best = [t for t in tried if all(t[k] >= edge[k] for k in t)][-1]
    # The best good level is the one right above the bad one: one level apart.
    assert search.hi - search.lo == 1
    assert best == search.limits_at(search.lo)
    assert not all(search.limits_at(search.hi)[k] >= edge[k] for k in edge)


def test_everything_good_ends_at_the_fewest_possible():
    search = _search()
    tried = _run(search, {"colors": 0, "swaps": 0, "layers": 0})
    assert tried[-1] == {"colors": 1, "swaps": 1 - 1, "layers": 1}
    assert search.outcome == "nothing_left"


def test_limits_respect_what_the_other_counts_need():
    search = _search({"colors": 6, "swaps": 30, "layers": 40}, min_layers=5)
    for level in range(search.n + 1):
        limits = search.limits_at(level)
        assert limits["swaps"] >= limits["colors"] - 1
        assert limits["layers"] >= max(5, limits["swaps"])
    # Strictly fewer layers/swaps/colors than the start as the level rises.
    levels = [search.limits_at(i) for i in range(search.n + 1)]
    assert all(levels[i + 1]["layers"] <= levels[i]["layers"] for i in range(search.n))


def test_a_result_already_below_a_level_skips_that_pass():
    search = _search()
    # The last good result is already tiny: no pass can reduce it further.
    assert search.propose({"colors": 1, "swaps": 0, "layers": 1}) is None
    assert search.passes == 0 and search.outcome == "nothing_left"


def test_pass_limit_stops_the_search():
    search = _search({"colors": 300, "swaps": 400, "layers": 900}, max_passes=2)
    counts = search.start
    for _ in range(2):
        counts = search.propose(counts)
        search.accept()
    assert search.propose(counts) is None
    assert search.outcome == "pass_limit"


# ---- the API ---------------------------------------------------------------


@pytest.fixture
def client():
    return TestClient(create_app())


def _wait_for_status(client, job_id, status, timeout=15.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = client.get(f"/api/optimize/status/{job_id}")
        if r.is_success and r.json().get("status") == status:
            return r.json()
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} never reached {status!r}")


class _Optimizer:
    """Pruning here just clamps the counts to the limits it is given; the
    loss rises as they fall."""

    def __init__(self, colors=10, swaps=20, layers=40):
        self.best_params = {"counts": torch.tensor([colors, swaps, layers])}
        self.pixel_height_logits = torch.zeros(2, 2)
        self.max_layers = layers
        self.best_seed = 0
        self._prune_runs = 0
        self._full_res_height_restored = True
        self.preview_callback = None
        self.prune_step_callback = None

    @property
    def counts(self):
        return [int(v) for v in self.best_params["counts"]]

    def loss(self):
        colors, swaps, layers = self.counts
        return 5 + 2 * (10 - colors) + 0.1 * (20 - swaps) + 0.05 * (40 - layers)

    def solution_snapshot(self):
        return {
            "best_params": {k: v.clone() for k, v in self.best_params.items()},
            "pixel_height_logits": self.pixel_height_logits,
            "max_layers": self.max_layers,
            "best_seed": self.best_seed,
        }

    def restore_solution_snapshot(self, snapshot):
        self.best_params = snapshot["best_params"]
        self.pixel_height_logits = snapshot["pixel_height_logits"]
        self.max_layers = snapshot["max_layers"]
        self.best_seed = snapshot["best_seed"]

    def get_discretized_solution(self, best=True):
        return torch.zeros(self.max_layers, dtype=torch.long), torch.ones(4, 4)

    def get_best_discretized_image(self):
        return torch.full((4, 4, 3), 200.0)


@pytest.fixture
def fake_pipeline(monkeypatch):
    """A completed result with a fake optimizer, and the export that prunes it.
    Returns (job_id, optimizer, calls)."""
    import autoforge.Helper.PruningHelper as pruning_helper
    import autoforge.webui.api.pruning as pruning_api
    import autoforge.webui.api.ws as ws
    import autoforge.webui.helpers.pipeline_runner as pipeline_runner
    import autoforge.webui.helpers.sliders as sliders
    from autoforge.webui.services.optimization_service import get_optimization_service

    def make(optimizer):
        svc = get_optimization_service()
        done = svc.create_job({"iterations": 10, "input_image": "a.png"})
        svc.update_status(done.job_id, "completed")
        svc.set_pipeline_result(done.job_id, {
            "optimizer": optimizer,
            "alpha": None,
            "args": argparse.Namespace(
                spike_removal=False, layer_height=0.04, background_height=0.4, stl_output_size=50.0,
                min_layers=1, perform_pruning=False, pruning_max_colors=100, pruning_max_swaps=100,
                pruning_max_layer=75,
            ),
        })
        return done.job_id

    calls = {"passes": [], "writes": []}

    monkeypatch.setattr(pruning_helper, "_compute_loss_for_heightmap", lambda opt, *_a, **_k: opt.loss())
    monkeypatch.setattr(
        pruning_api, "result_counts_from_optimizer",
        lambda opt: dict(zip(("colors", "swaps", "layers"), opt.counts)),
    )
    monkeypatch.setattr(
        sliders, "derive_sliders_from_result",
        lambda result: {"sliders": [{"layer": 4}], "min_layer": 0, "max_layer": 4},
    )
    monkeypatch.setattr(ws, "broadcast_preview", lambda *a, **k: calls.setdefault("broadcasts", []).append(k.get("job_id")))

    def export(result, cancel_event=None, pause_event=None, apply_spike_removal=True, prune_only=False, **_kw):
        opt, args = result["optimizer"], result["args"]
        if args.perform_pruning:
            colors, swaps, layers = opt.counts
            opt.best_params["counts"] = torch.tensor([
                min(colors, args.pruning_max_colors),
                min(swaps, args.pruning_max_swaps),
                min(layers, args.pruning_max_layer),
            ])
            calls["passes"].append((tuple(opt.counts), opt.loss()))
        if not prune_only:
            calls["writes"].append((args.perform_pruning, tuple(opt.counts), opt.loss()))
        return {"pruning_completed": True}

    monkeypatch.setattr(pipeline_runner, "export_results", export)
    return make, calls


def test_keeps_the_last_pass_that_was_under_the_limit(client, fake_pipeline):
    make, calls = fake_pipeline
    optimizer = _Optimizer()
    job_id = make(optimizer)

    r = client.post("/api/pruning/start", json={"job_id": job_id, "mode": "auto", "target_loss": 12})
    assert r.status_code == 200, r.text
    done = _wait_for_status(client, r.json()["job_id"], "completed")

    log = done["auto_passes"]
    assert any(p["kept"] for p in log) and any(not p["kept"] for p in log)
    kept = [p for p in log if p["kept"]]
    assert all(p["loss"] <= 12 for p in kept)
    assert all(p["loss"] > 12 for p in log if not p["kept"])
    # What is left is exactly the last good pass, not the one that went over.
    last_good = kept[-1]
    assert optimizer.counts == [last_good["colors"], last_good["swaps"], last_good["layers"]]
    assert optimizer.loss() <= 12
    assert (done["result_colors"], done["result_swaps"], done["result_layers"]) == tuple(optimizer.counts)
    assert done["loss"] == pytest.approx(optimizer.loss())
    assert done["auto_outcome"] == "limit_reached"
    # Files are written once, for that solution, without pruning again.
    assert calls["writes"] == [(False, tuple(optimizer.counts), optimizer.loss())]


def test_a_result_already_over_the_limit_is_left_alone(client, fake_pipeline):
    make, calls = fake_pipeline
    optimizer = _Optimizer(colors=4)  # loss 17
    job_id = make(optimizer)

    r = client.post("/api/pruning/start", json={"job_id": job_id, "mode": "auto", "target_loss": 10})
    done = _wait_for_status(client, r.json()["job_id"], "completed")

    assert done["auto_outcome"] == "start_above_limit"
    assert calls["passes"] == []
    assert optimizer.counts == [4, 20, 40]


def test_every_pass_is_previewed(client, fake_pipeline):
    make, calls = fake_pipeline
    job_id = make(_Optimizer())
    r = client.post("/api/pruning/start", json={"job_id": job_id, "mode": "auto", "target_loss": 12})
    done = _wait_for_status(client, r.json()["job_id"], "completed")
    assert len(calls["broadcasts"]) >= len(done["auto_passes"])


def test_cancel_goes_back_to_the_start(client, fake_pipeline, monkeypatch):
    import autoforge.webui.helpers.pipeline_runner as pipeline_runner

    make, calls = fake_pipeline
    optimizer = _Optimizer()
    job_id = make(optimizer)
    real_export = pipeline_runner.export_results
    state = {}

    def export(result, cancel_event=None, **kw):
        out = real_export(result, cancel_event=cancel_event, **kw)
        if len(calls["passes"]) == 2:
            cancel_event.set()
        return out

    monkeypatch.setattr(pipeline_runner, "export_results", export)
    r = client.post("/api/pruning/start", json={"job_id": job_id, "mode": "auto", "target_loss": 12})
    _wait_for_status(client, r.json()["job_id"], "cancelled")
    assert optimizer.counts == [10, 20, 40]
    assert calls["writes"] == []


def test_auto_without_a_target_is_rejected(client, fake_pipeline):
    make, _calls = fake_pipeline
    job_id = make(_Optimizer())
    r = client.post("/api/pruning/start", json={"job_id": job_id, "mode": "auto"})
    assert r.status_code == 422
