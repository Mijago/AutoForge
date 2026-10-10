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
# that can't make progress for some reason we didn't foresee.
AUTO_PRUNE_MAX_PASSES = 20

Counts = dict  # {"colors": int, "swaps": int, "layers": int}


class AutoPruneSearch:
    """Bisection on how far to reduce.

    The reduction is one number, a *level* from 0 (the result as it is) up to
    ``n`` (the fewest colors, swaps and layers there can be); every level maps
    to limits for all three counts, scaled together. The first pass tries the
    middle of that range. A pass that stays under the loss target moves the
    good end up to it, one that goes over moves the bad end down to it, and
    the next pass tries the middle of what is left — so the best level is
    found in about log2(n) passes instead of one small step at a time.

    Usage: ``limits = search.propose(counts)`` (counts of the last good
    result); run the pass; then ``search.accept()`` if its loss was within
    the target, or ``search.reject()`` if it went over. ``propose`` returns
    None once the search is finished, and ``outcome`` says why.
    """

    def __init__(self, start_counts: Counts, min_layers: int = 1, max_passes: int = AUTO_PRUNE_MAX_PASSES):
        self.start = {k: int(start_counts[k]) for k in ("colors", "swaps", "layers")}
        floor_colors = 1
        floor_swaps = 0
        floor_layers = max(1, int(min_layers))
        self.floor = {
            "colors": min(self.start["colors"], floor_colors),
            "swaps": min(self.start["swaps"], floor_swaps),
            "layers": min(self.start["layers"], floor_layers),
        }
        self.n = max(self.start[k] - self.floor[k] for k in self.start)
        self.min_layers = max(1, int(min_layers))
        # Level `lo` is known good (0 is the start itself), `hi` known bad;
        # n + 1 stands for "not tried yet" beyond the fewest-everything level.
        self.lo, self.hi = 0, self.n + 1
        self.max_passes = max_passes
        self.passes = 0
        self.outcome: Optional[str] = None
        self._level: Optional[int] = None

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

    def propose(self, good_counts: Counts) -> Optional[Counts]:
        if self.outcome is not None:
            return None
        while True:
            if self.hi - self.lo <= 1:
                self.outcome = "nothing_left" if self.hi > self.n else "limit_reached"
                return None
            if self.passes >= self.max_passes:
                self.outcome = "pass_limit"
                return None
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

    def accept(self) -> None:
        """The pass stayed within the loss target."""
        if self._level is not None:
            self.lo = self._level

    def reject(self) -> None:
        """The pass went over the target."""
        if self._level is not None:
            self.hi = self._level
