"""RRSI parent policy: continue from the current champion."""

from ..contracts import ParentInput, ParentPlan, RandomSource


def select_parent(view: ParentInput, rng: RandomSource) -> ParentPlan:
    if not view.eligible:
        return ParentPlan.abstain("no eligible parent")
    champion = next(
        (option for option in view.eligible if option.candidate_id == view.champion_id),
        None,
    )
    return ParentPlan.single(
        rng.choice((champion or view.eligible[0],), key="rrsi-champion"),
        view.candidate_limit,
    )
