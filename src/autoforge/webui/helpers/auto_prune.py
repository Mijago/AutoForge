"""Automatic pruning: tighten the limits pass by pass until the picture gets
too far from the original, then keep the last pass that was still good enough.

This module is only the bookkeeping (what limits to try next, when to stop),
so it can be tested without a GPU. The passes themselves run in
``api/pruning.py``.
"""
from __future__ import annotations

from typing import Optional

# "Loss" is the discrete loss the pruning dialog already shows (lower is
# closer to the input image). The presets are the user-facing quality levels.
AUTO_PRUNE_PRESETS: dict[str, float] = {
    "extremely_good": 10.0,
    "very_good": 20.0,
    "good": 30.0,
    "acceptable": 40.0,
}

# A pass is minutes of GPU work at worst; this only guards against a loop
# that can't make progress for some reason we didn't foresee. The fine phase
# needs about log2 of each count's range on top of the coarse one.
AUTO_PRUNE_MAX_PASSES = 30

# A good pass whose loss reaches this fraction of the target counts as "near
# the target": from there on each count is tuned on its own.
NEAR_TARGET = 0.75

KEYS = ("colors", "swaps", "layers")

Counts = dict  # {"colors": int, "swaps": int, "layers": int}


class AutoPruneSearch:
    """How far to reduce: first all three counts together, then each one on
    its own.

    **Coarse phase.** The reduction is one number, a *level* from 0 (the
    result as it is) up to ``n`` (the fewest colors, swaps and layers there
    can be); every level maps to limits for all three counts, scaled
    together. Bisection on that level: a pass under the loss target moves the
    good end up to it, one over it moves the bad end down, the next pass tries
    the middle of what is left.

    **Fine phase.** Scaled together, the counts all stop where the *most*
    sensitive one runs out of loss budget — dropping colors costs far more
    than dropping layers, so the layers stopped long before they had to. Once
    a pass gets near the target (``NEAR_TARGET``), goes over it, or the coarse
    search has converged, every count gets its own bisection from the last
    good result, the others held where they are. The three take turns, one
    step each, so a cheap count goes far while an expensive one narrows in,
    and no single count spends the whole budget before the others are tried.
    A value that went over stays bad (lowering the other counts only adds
    loss), so nothing is tried twice.

    Usage: ``limits = search.propose(counts)`` (counts of the last good
    result); run the pass; then ``search.accept(loss)`` if its loss was
    within the target, or ``search.reject(loss)`` if it went over.
    ``propose`` returns None once the search is finished, and ``outcome``
    says why.
    """

    def __init__(
        self,
        start_counts: Counts,
        min_layers: int = 1,
        max_passes: int = AUTO_PRUNE_MAX_PASSES,
        target: Optional[float] = None,
    ):
        self.start = {k: int(start_counts[k]) for k in KEYS}
        self.min_layers = max(1, int(min_layers))
        self.floor = {
            "colors": min(self.start["colors"], 1),
            "swaps": min(self.start["swaps"], 0),
            "layers": min(self.start["layers"], self.min_layers),
        }
        self.n = max(self.start[k] - self.floor[k] for k in self.start)
        # Level `lo` is known good (0 is the start itself), `hi` known bad;
        # n + 1 stands for "not tried yet" beyond the fewest-everything level.
        self.lo, self.hi = 0, self.n + 1
        self.max_passes = max_passes
        self.target = target
        self.passes = 0
        self.outcome: Optional[str] = None
        self.phase = "coarse"
        self._level: Optional[int] = None
        # Fine phase: the smallest value of each count known to go over, the
        # count the pending pass tries, and whose turn is next.
        self.bad: dict[str, Optional[int]] = {k: None for k in KEYS}
        self._trying: Optional[tuple[str, int]] = None
        self._turn = 0
        self._went_over = False

    def limits_at(self, level: int) -> Counts:
        """The limits of a level. Never below what the others still need:
        n colors need n-1 swaps, and every swap needs a layer."""
        t = level / self.n if self.n else 1.0
        scaled = {k: self.start[k] - round((self.start[k] - self.floor[k]) * t) for k in self.start}
        colors = max(1, scaled["colors"])
        swaps = max(colors - 1, scaled["swaps"])
        layers = max(self.min_layers, swaps, scaled["layers"])
        return {
            "colors": min(self.start["colors"], colors),
            "swaps": min(self.start["swaps"], swaps),
            "layers": min(self.start["layers"], layers),
        }

    def floor_of(self, key: str, good: Counts) -> int:
        """The lowest ``key`` can go with the other counts where they are."""
        if key == "colors":
            return 1
        if key == "swaps":
            return max(0, int(good["colors"]) - 1)
        return max(self.min_layers, int(good["swaps"]))

    def propose(self, good_counts: Counts) -> Optional[Counts]:
        if self.outcome is not None:
            return None
        if self.passes >= self.max_passes:
            self.outcome = "pass_limit"
            return None
        if self.phase == "coarse":
            limits = self._propose_coarse(good_counts)
            if limits is not None:
                return limits
            self.phase = "fine"
        return self._propose_fine(good_counts)

    def _propose_coarse(self, good_counts: Counts) -> Optional[Counts]:
        while self.hi - self.lo > 1:
            level = (self.lo + self.hi) // 2
            limits = self.limits_at(level)
            # The last good result may already be at or below this level
            # (pruning often overshoots its limits): nothing to run.
            if all(int(good_counts[k]) <= limits[k] for k in limits):
                self.lo = level
                continue
            self._level = level
            self.passes += 1
            return limits
        return None

    def _propose_fine(self, good_counts: Counts) -> Optional[Counts]:
        good = {k: int(good_counts[k]) for k in KEYS}
        for i in range(len(KEYS)):
            key = KEYS[(self._turn + i) % len(KEYS)]
            # Bisect between the good value and the known-bad one (or one
            # below the floor while nothing below has been tried).
            below = self.bad[key] if self.bad[key] is not None else self.floor_of(key, good) - 1
            value = (good[key] + below) // 2
            if value >= good[key] or value <= below:
                continue
            self._turn = (self._turn + i + 1) % len(KEYS)
            self._trying = (key, value)
            self.passes += 1
            return {**good, key: value}
        # Nothing ever went over: every count is down as far as it goes.
        self.outcome = "limit_reached" if self._went_over else "nothing_left"
        return None

    def _near(self, loss: Optional[float]) -> bool:
        return loss is not None and self.target is not None and loss >= NEAR_TARGET * self.target

    def accept(self, loss: Optional[float] = None) -> None:
        """The pass stayed within the loss target."""
        if self.phase == "coarse":
            if self._level is not None:
                self.lo = self._level
            if self._near(loss):
                self.phase = "fine"
        self._trying = None

    def reject(self, loss: Optional[float] = None) -> None:
        """The pass went over the target."""
        self._went_over = True
        if self.phase == "coarse":
            if self._level is not None:
                self.hi = self._level
            # The edge is close: tune each count from the last good result.
            self.phase = "fine"
        elif self._trying is not None:
            key, value = self._trying
            if self.bad[key] is None or value > self.bad[key]:
                self.bad[key] = value
        self._trying = None
