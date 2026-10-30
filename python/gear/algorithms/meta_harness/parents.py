"""Meta-Harness uses the strongest fully evaluated seed candidate as its base."""

from __future__ import annotations

from dataclasses import replace

from ..contracts import ParentInput, ParentPlan, RandomSource


def select_best_parent(view: ParentInput, rng: RandomSource) -> ParentPlan:
    if not view.eligible or view.candidate_limit < 1:
        return ParentPlan.abstain("no candidate has complete global seed evidence")
    best = min(view.eligible, key=lambda option: (-option.score, option.candidate_id))
    options = tuple(
        replace(option, probability=float(option.candidate_id == best.candidate_id))
        for option in view.eligible
    )
    selection = rng.choice(options, key="meta_harness_parent")
    return ParentPlan.single(selection, 1)
