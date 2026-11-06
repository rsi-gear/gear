"""One-file custom policy using only the public Python algorithm contract."""

from gear.algorithms import ParentInput, ParentPlan, RandomSource


def select_parent(view: ParentInput, rng: RandomSource) -> ParentPlan:
    if not view.eligible:
        return ParentPlan.abstain("No eligible parent")
    return ParentPlan.single(rng.choice(view.eligible, key="uniform-parent"), view.candidate_limit)
