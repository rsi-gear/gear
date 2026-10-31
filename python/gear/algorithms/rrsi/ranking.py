"""RRSI selection equations plus the Gear evidence ranking adapter."""

from __future__ import annotations

from dataclasses import dataclass

from ..contracts import Evidence, RankingInput, RankingPlan
from ..evidence import complete_scope_mean
from .config import RRSIConfig

STRUCTURAL_COMPONENTS = frozenset({"client_tool", "skill", "memory", "subagent"})


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


def novelty(components: tuple[str, ...], incumbent_counts: dict[str, int]) -> int:
    return sum(
        component in STRUCTURAL_COMPONENTS and incumbent_counts.get(component, 0) == 0
        for component in set(components)
    )


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
        score_weight * delta_score
        - cost_weight * delta_cost
        + novelty_weight * novelty_value
        > 0
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
    return score >= score_star - noise_delta and cost_rule(
        score - incumbent_score,
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
    config: RRSIConfig

    def __call__(self, view: RankingInput) -> RankingPlan:
        baseline = complete_scope_mean(view)
        scores = dict(baseline.scores)
        incumbent_score = scores.get(view.anchor_id)
        if incumbent_score is None:
            return baseline
        incumbent_cost = relative_cost(view.anchor_id, view.evidence)
        admissible_ids = [view.anchor_id]
        disqualified = set(baseline.disqualified)
        for candidate in baseline.candidate_ids:
            if candidate == view.anchor_id:
                continue
            candidate_cost = relative_cost(candidate, view.evidence)
            delta_cost = (
                0.0
                if candidate_cost is None or incumbent_cost in (None, 0)
                else (candidate_cost - incumbent_cost) / incumbent_cost
            )
            if not admissible(
                scores[candidate],
                incumbent_score,
                incumbent_score,
                scores[candidate] - incumbent_score,
                delta_cost,
                0,
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
        admissible_ids[1:] = sorted(
            admissible_ids[1:], key=lambda candidate: (-scores[candidate], candidate)
        )
        return RankingPlan(
            tuple(admissible_ids),
            tuple((candidate, scores[candidate]) for candidate in admissible_ids),
            baseline.incomplete,
            tuple(sorted(disqualified)),
        )
