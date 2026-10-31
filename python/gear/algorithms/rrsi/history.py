"""JSON-safe RRSI history summaries for the algorithm state."""

from __future__ import annotations

from gear.canonical import JSON

from ..contracts import Evidence

COMPONENTS = (
    "prompt",
    "control_flow",
    "config",
    "output_plumbing",
    "context_mgmt",
    "client_tool",
    "skill",
    "memory",
    "subagent",
)


def measured_history(
    history: list[dict[str, JSON]], evidence: tuple[Evidence, ...]
) -> list[dict[str, JSON]]:
    known = {
        str(row["candidate_id"])
        for row in history
        if isinstance(row.get("candidate_id"), str)
    }
    scores: dict[str, list[float]] = {}
    costs: dict[str, list[float]] = {}
    for cell in evidence:
        if cell.score is not None:
            scores.setdefault(cell.candidate_id, []).append(cell.score)
        if isinstance(cell.raw_metrics, dict):
            value = cell.raw_metrics.get("policy_tokens")
            if isinstance(value, dict):
                value = value.get("value")
            if isinstance(value, (int, float)):
                costs.setdefault(cell.candidate_id, []).append(float(value))
    result = list(history)
    for candidate, values in scores.items():
        if candidate in known:
            continue
        row: dict[str, JSON] = {
            "candidate_id": candidate,
            "score": sum(values) / len(values),
            "component": None,
        }
        if costs.get(candidate):
            row["cost"] = sum(costs[candidate]) / len(costs[candidate])
        result.append(row)
    return result


def tried_components(history: list[dict[str, JSON]]) -> set[str]:
    return {
        component
        for row in history
        if isinstance((component := row.get("component")), str) and component in COMPONENTS
    }


def prune_components(history: list[dict[str, JSON]]) -> list[str]:
    best: dict[str, float] = {}
    for row in history:
        component = row.get("component")
        score = row.get("delta_score")
        if isinstance(component, str) and isinstance(score, (int, float)):
            best[component] = max(best.get(component, float("-inf")), float(score))
    return sorted(component for component, score in best.items() if score <= 0)


def stalled(scores: list[float], round_index: int, window: int, delta: float) -> bool:
    return (
        round_index >= window
        and len(scores) > round_index
        and scores[round_index] - scores[round_index - window] <= delta
    )
