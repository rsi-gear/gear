"""GEPA ranks complete scopes using their frozen bucket weights."""

from ..contracts import RankingInput, RankingPlan
from ..evidence import complete_scope_mean


def rank_candidates(view: RankingInput) -> RankingPlan:
    return complete_scope_mean(view)
