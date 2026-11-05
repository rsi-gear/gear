"""RRSI selection equations plus the Gear evidence ranking adapter."""

from __future__ import annotations

from dataclasses import dataclass

from ..contracts import Evidence, RankingInput, RankingPlan
from ..evidence import complete_scope_mean
from .config import RRSIConfig
from .history import STRUCTURAL_COMPONENTS, novelty

__all__ = [
    "STRUCTURAL_COMPONENTS",
    "RRSIRanker",
    "admissible",
    "cost_rule",
    "novelty",
    "rank_candidates",
    "relative_cost",
    "relative_cost_change",
]


def relative_cost(candidate: str, evidence: tuple[Evidence, ...]) -> float | None:
    values: list[float] = []
    for cell in evidence:
        if cell.candidate_id != candidate or not isinstance(cell.raw_metrics, dict):
            continue
        value = cell.raw_metrics.get("policy_tokens")
        if isinstance(value, dict):
            value = value.get("value")
        if isinstance(value, (int, float)):
            values.append(float(value))
    return sum(values) / len(values) if values else None


def relative_cost_change(candidate_cost: float | None, incumbent_cost: float | None) -> float:
    """Delta C = (C' - C_t) / C_t; 0.0 when either side has no token count."""
    if not candidate_cost or not incumbent_cost:
        return 0.0
    return (candidate_cost - incumbent_cost) / incumbent_cost


def cost_rule(
    delta_score: float,
    delta_cost: float,
    novelty_value: int,
    *,
    noise_delta: float,
    beta0: float,
    beta1: float,
    score_weight: float,
    cost_weight: float,
    novelty_weight: float,
) -> bool:
    if delta_score > noise_delta:
        return delta_cost <= beta0 + beta1 * delta_score
    return (
        score_weight * delta_score - cost_weight * delta_cost + novelty_weight * novelty_value > 0
    )


def admissible(
    score: float,
    incumbent_score: float,
    score_star: float,
    delta_score: float,
    delta_cost: float,
    novelty_value: int,
    *,
    noise_delta: float,
    beta0: float,
    beta1: float,
    score_weight: float,
    cost_weight: float,
    novelty_weight: float,
) -> bool:
    if score < score_star - noise_delta:
        return False
    return cost_rule(
        delta_score,
        delta_cost,
        novelty_value,
        noise_delta=noise_delta,
        beta0=beta0,
        beta1=beta1,
        score_weight=score_weight,
        cost_weight=cost_weight,
        novelty_weight=novelty_weight,
    )


def rank_candidates(view: RankingInput) -> RankingPlan:
    """Rank complete scopes; runtime admission remains independently trusted."""
    return complete_scope_mean(view)


@dataclass(frozen=True)
class RRSIRanker:
    config: RRSIConfig = RRSIConfig()
    score_star: float | None = None
    candidate_novelty: dict[str, int] | None = None

    def __post_init__(self) -> None:
        if isinstance(self.config, dict):
            object.__setattr__(self, "config", RRSIConfig(**self.config))

    def __call__(self, view: RankingInput) -> RankingPlan:
        baseline = complete_scope_mean(view)
        scores = dict(baseline.scores)
        incumbent_score = scores.get(view.anchor_id)
        if incumbent_score is None:
            return baseline
        incumbent_cost = relative_cost(view.anchor_id, view.evidence)
        s_star = self.score_star if self.score_star is not None else incumbent_score
        novelty_map = self.candidate_novelty or {}

        admissible_ids: list[str] = []
        disqualified = set(baseline.disqualified)
        for candidate in baseline.candidate_ids:
            if candidate == view.anchor_id:
                continue
            candidate_cost = relative_cost(candidate, view.evidence)
            delta_cost = relative_cost_change(candidate_cost, incumbent_cost)
            delta_score = scores[candidate] - incumbent_score
            nov = novelty_map.get(candidate, 0)
            if not admissible(
                scores[candidate],
                incumbent_score,
                s_star,
                delta_score,
                delta_cost,
                nov,
                noise_delta=self.config.noise_delta,
                beta0=self.config.beta0,
                beta1=self.config.beta1,
                score_weight=self.config.score_weight,
                cost_weight=self.config.cost_weight,
                novelty_weight=self.config.novelty_weight,
            ):
                disqualified.add(candidate)
                continue
            admissible_ids.append(candidate)

        admissible_ids = sorted(
            admissible_ids, key=lambda candidate: (-scores[candidate], candidate)
        )
        if view.anchor_id in scores and view.anchor_id not in disqualified:
            admissible_ids.append(view.anchor_id)
        return RankingPlan(
            tuple(admissible_ids),
            tuple((candidate, scores[candidate]) for candidate in admissible_ids),
            baseline.incomplete,
            tuple(sorted(disqualified)),
        )
