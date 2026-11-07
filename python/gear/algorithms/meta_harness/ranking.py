"""Rank candidates on the uniform full seed scope."""

from ..contracts import RankingInput, RankingPlan
from ..evidence import complete_scope_mean


def rank_candidates(view: RankingInput) -> RankingPlan:
    return complete_scope_mean(view)
