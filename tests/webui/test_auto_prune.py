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


def test_a_good_pass_halves_what_is_left_far_from_the_target():
    search = _search({"colors": 8, "swaps": 8, "layers": 8}, target=30.0)
    search.propose(search.start)
    first = search._level
    search.accept(5.0)  # far under the target: keep going together
    assert search.phase == "coarse"
    search.propose(search.limits_at(first))
    assert search._level > first


def test_a_bad_pass_or_a_near_one_switches_to_tuning_each_count():
    search = _search(target=30.0)
    search.propose(search.start)
    search.accept(25.0)  # 25 >= 0.75 * 30
    assert search.phase == "fine"

    search = _search(target=30.0)
    search.propose(search.start)
    search.reject(35.0)
    assert search.phase == "fine"
    # From the last good result (the start), one count at a time.
    limits = search.propose(search.start)
    changed = [k for k in limits if limits[k] != search.start[k]]
    assert len(changed) == 1


def _cost_run(search, cost, target, counts=None):
    """Drive a search with a loss of ``cost(limits)``. Returns (limits
    tried, last good counts)."""
    counts = dict(counts or search.start)
    tried = []
    while (limits := search.propose(counts)) is not None:
        tried.append(limits)
        loss = cost(limits)
        if loss <= target:
            counts = dict(limits)
            search.accept(loss)
        else:
            search.reject(loss)
    return tried, counts


def test_cheap_counts_go_further_than_the_expensive_one():
    """Colors are expensive, layers almost free: scaled together, the layers
    stopped where the colors ran out of budget."""
    start = {"colors": 10, "swaps": 20, "layers": 40}

    def cost(c):
        return 3.0 * (10 - c["colors"]) + 0.2 * (20 - c["swaps"]) + 0.05 * (40 - c["layers"])

    search = _search(start, target=20.0)
    tried, good = _cost_run(search, cost, 20.0)
    assert cost(good) <= 20.0
    # Joint scaling alone ends near 6 colors / 12 swaps / 24 layers.
    joint = _search(start)
    joint_good = max(
        (joint.limits_at(level) for level in range(joint.n + 1) if cost(joint.limits_at(level)) <= 20.0),
        key=lambda c: -c["layers"],
    )
    assert good["layers"] < joint_good["layers"] - 10
    # Nothing left on the table: one more of any count goes over.
    for k in good:
        if good[k] > search.floor_of(k, good):
            assert cost({**good, k: good[k] - 1}) > 20.0
    assert search.outcome == "limit_reached"
    assert len(tried) <= 25


def test_a_value_that_went_over_is_never_tried_again():
    search = _search(target=10.0)
    tried, _good = _cost_run(search, lambda c: 2.0 * (10 - c["colors"]) + 0.01 * (40 - c["layers"]), 10.0)
    seen = [tuple(sorted(t.items())) for t in tried]
    assert len(seen) == len(set(seen))


def test_fine_limits_respect_what_the_other_counts_need():
    search = _search({"colors": 6, "swaps": 10, "layers": 12}, min_layers=3, target=10.0)
    tried, _good = _cost_run(search, lambda c: 0.5 * (6 - c["colors"]) + 0.5 * (10 - c["swaps"]), 10.0)
    for t in tried:
        assert t["swaps"] >= t["colors"] - 1
        assert t["layers"] >= max(3, t["swaps"])


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
