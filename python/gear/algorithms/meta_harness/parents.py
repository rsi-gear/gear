"""Sample a seed-evaluated Pareto parent instead of fixing the scalar-score winner."""

from __future__ import annotations

from ..contracts import ParentInput, ParentPlan, RandomSource
from ..gepa.parents import frontier_options


def select_frontier_parent(view: ParentInput, rng: RandomSource) -> ParentPlan:
    if not view.eligible or view.candidate_limit < 1:
        return ParentPlan.abstain("no candidate has complete global seed evidence")
    options = frontier_options(view)
    if not options:
        return ParentPlan.abstain("no candidate is on the comparable seed frontier")
    selection = rng.choice(options, key="meta_harness_parent")
    return ParentPlan.single(selection, 1)
