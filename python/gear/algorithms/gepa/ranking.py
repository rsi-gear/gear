"""GEPA ranks complete scopes using their frozen bucket weights and Pareto complexity awareness."""

from __future__ import annotations

import math
from typing import Mapping

from ..contracts import RankingInput, RankingPlan
from ..evidence import complete_scope_mean, task_scores


def rank_candidates(view: RankingInput) -> RankingPlan:
    return complete_scope_mean(view)


def rank_candidates_pareto(
    view: RankingInput,
    complexity_penalties: Mapping[str, float] | None = None,
    complexity_weight: float = 0.05,
) -> RankingPlan:
    """
    Ranks candidates using a multi-objective Pareto trade-off between task performance
    and prompt/harness bloat.
    
    Candidates with identical accuracy are ranked by their compactness (lowest complexity penalty).
    """
    base_plan = complete_scope_mean(view)
    if not complexity_penalties:
        return base_plan

    penalties = dict(complexity_penalties)
    adjusted_scores = []
    
    for candidate, score in base_plan.scores:
        penalty = max(0.0, float(penalties.get(candidate, 0.0)))
        adjusted = score - (complexity_weight * penalty)
        adjusted_scores.append((candidate, adjusted, penalty, score))

    # Sort descending by adjusted score, then ascending by penalty (lowest bloat wins ties), then candidate ID
    adjusted_scores.sort(key=lambda item: (-item[1], item[2], item[0]))

    ranked_ids = tuple(item[0] for item in adjusted_scores)
    final_scores = tuple((item[0], item[3]) for item in adjusted_scores)

    return RankingPlan(
        ranked_ids,
        final_scores,
        base_plan.incomplete,
        base_plan.disqualified,
    )
