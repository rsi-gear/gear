"""JSON-safe RRSI history summaries and component attribution."""

from __future__ import annotations

import re
from typing import Any

from gear.canonical import JSON

from ..contracts import Evidence

COMPONENTS: tuple[str, ...] = (
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

STRUCTURAL_COMPONENTS: frozenset[str] = frozenset({"client_tool", "skill", "memory", "subagent"})

GENERIC_SIGNALS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("memory", (r"\bMemory\(", r"\.remember\(", r"\.recall\(", r"_STATE_DIR")),
    (
        "skill",
        (r"skills/", r"SkillRegistry", r"skill_use", r"skill_catalog", r"upload_skills"),
    ),
    (
        "client_tool",
        (r"ToolRegistry", r"register_tool", r"tool_spec", r"CLIENT_TOOLS"),
    ),
    ("subagent", (r"\bsubcall\(", r"sub_agent", r"subagent")),
)

DOMAIN_SIGNALS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("memory", (r"TBMH_STATE_DIR",)),
    ("subagent", (r"generate_response",)),
    (
        "context_mgmt",
        (
            r"_summarize",
            r"summariz",
            r"proactive_summarization",
            r"unwind",
            r"free_tokens",
        ),
    ),
    (
        "output_plumbing",
        (
            r"_limit_output_length",
            r"terminal_output",
            r"truncat",
            r"_collapse",
            r"paste.?buffer",
            r"load-?buffer",
        ),
    ),
    (
        "control_flow",
        (
            r"_run_agent_loop",
            r"episode",
            r"is_task_complete",
            r"_pending_completion",
            r"keystrokes",
        ),
    ),
    ("config", (r"= *\d+ *#", r"threshold", r"max_bytes", r"duration")),
    (
        "prompt",
        (
            r"templates/.*\.txt",
            r"_VERIFICATION",
            r"_get_.*hint",
            r"prompt",
            r"system",
        ),
    ),
)

_STRING_LINE = re.compile(r'^[+-]\s*(?:[frb]?["\']|""")')


def text_only(diff: str) -> bool:
    """True when every changed line is a string literal or comment."""
    changed = [
        line
        for line in diff.splitlines()
        if (line.startswith("+") or line.startswith("-"))
        and not line.startswith("+++")
        and not line.startswith("---")
        and line[1:].strip()
    ]
    if not changed:
        return False
    return all(_STRING_LINE.match(line) or line[1:].lstrip().startswith("#") for line in changed)


def classify_diff(
    diff: str,
    domain_signals: list[tuple[str, list[str] | tuple[str, ...]]] | None = None,
) -> str:
    """Classify diff into primary component; default prompt."""
    if text_only(diff):
        return "prompt"
    signals = list(domain_signals or DOMAIN_SIGNALS) + list(GENERIC_SIGNALS)
    for component, pats in signals:
        if any(re.search(p, diff) for p in pats):
            return component
    return "prompt"


def has_evidence(
    component: str,
    diff: str,
    domain_signals: list[tuple[str, list[str] | tuple[str, ...]]] | None = None,
) -> bool:
    """Check if the diff carries signal for the given component."""
    signals = list(domain_signals or DOMAIN_SIGNALS) + list(GENERIC_SIGNALS)
    for comp, pats in signals:
        if comp == component and any(re.search(p, diff) for p in pats):
            return True
    return False


def normalize(
    declared: str | None,
    diff: str,
    domain_signals: list[tuple[str, list[str] | tuple[str, ...]]] | None = None,
) -> str:
    """Validate declared component against diff; recover from diff if missing/unsubstantiated."""
    declared_clean = (declared or "").strip().lower()
    if declared_clean in COMPONENTS and has_evidence(declared_clean, diff, domain_signals):
        return declared_clean
    return classify_diff(diff, domain_signals)


def novelty(
    edit_components: list[str] | tuple[str, ...],
    incumbent_counts: dict[str, int],
) -> int:
    """Number of structural components touched that never appeared in an accepted edit."""
    return sum(
        1
        for comp in set(edit_components)
        if comp in STRUCTURAL_COMPONENTS and incumbent_counts.get(comp, 0) == 0
    )


def measured_history(
    history: list[dict[str, JSON]],
    evidence: tuple[Evidence, ...],
    candidate_metadata: dict[str, dict[str, Any]] | None = None,
    t: int = 0,
) -> list[dict[str, JSON]]:
    """Synthesize measured per-edit history records from evidence and metadata."""
    known = {
        str(row["candidate_id"]) for row in history if isinstance(row.get("candidate_id"), str)
    }
    meta_map = candidate_metadata or {}
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
        cand_meta = meta_map.get(candidate, {})
        row: dict[str, JSON] = {
            "t": cand_meta.get("t", t),
            "candidate_id": candidate,
            "score": sum(values) / len(values),
            "component": cand_meta.get("component"),
            "components": cand_meta.get("components", []),
            "hypothesis": cand_meta.get("hypothesis"),
            "delta_S": cand_meta.get("delta_S"),
            "delta_C": cand_meta.get("delta_C"),
            "accepted": cand_meta.get("accepted", False),
            "outcome": cand_meta.get(
                "outcome", "ACCEPTED" if cand_meta.get("accepted") else "REJECTED"
            ),
        }
        if costs.get(candidate):
            row["cost"] = sum(costs[candidate]) / len(costs[candidate])
        result.append(row)
    return result


def tried_components(history: list[dict[str, JSON]]) -> set[str]:
    """T_t: components with at least one measured edit."""
    return {
        comp
        for row in history
        if row.get("delta_S") is not None
        and isinstance((comp := row.get("component")), str)
        and comp in COMPONENTS
    }


def accepted_edits(history: list[dict[str, JSON]]) -> dict[str, list[dict[str, JSON]]]:
    """Accepted machinery currently in the incumbent per component."""
    out: dict[str, list[dict[str, JSON]]] = {c: [] for c in COMPONENTS}
    for row in history:
        comp = row.get("component")
        if row.get("accepted") and isinstance(comp, str) and comp in out:
            out[comp].append(
                {
                    "t": row.get("t", 0),
                    "candidate_id": row.get("candidate_id"),
                    "hypothesis": row.get("hypothesis"),
                    "delta_S": row.get("delta_S"),
                }
            )
    return out


def incumbent_component_counts(history: list[dict[str, JSON]]) -> dict[str, int]:
    """Number of accepted edits in the incumbent per component."""
    return {c: len(v) for c, v in accepted_edits(history).items()}


def yield_g(history: list[dict[str, JSON]], t: int, n_prune: int) -> dict[str, float]:
    """g_t(l) for every tried component; -inf when nothing within recent window."""
    tried = tried_components(history)
    g: dict[str, float] = {c: float("-inf") for c in tried}
    for row in history:
        if row.get("delta_S") is None:
            continue
        comp = row.get("component")
        if not isinstance(comp, str) or comp not in tried:
            continue
        row_t = row.get("t", 0)
        round_t = row_t if isinstance(row_t, int) else 0
        if t - round_t <= n_prune:
            delta_s = row.get("delta_S")
            if isinstance(delta_s, (int, float)):
                g[comp] = max(g.get(comp, float("-inf")), float(delta_s))
    return g


def prune_components(history: list[dict[str, JSON]], t: int = 0, n_prune: int = 4) -> list[str]:
    """B_t: components whose recent yield within n_prune rounds is <= 0."""
    g = yield_g(history, t, n_prune)
    return sorted(comp for comp, score in g.items() if score <= 0)


def stalled(trajectory: list[float], t: int, window: int, delta: float) -> bool:
    """sigma_t = 1[S_t - S_{t-w} <= delta]; 0 while fewer than w rounds exist."""
    if t < window or t >= len(trajectory) or t - window < 0:
        return False
    return (trajectory[t] - trajectory[t - window]) <= delta
