"""Turn diagnosis into one hypothesis while directing the Meta agent to its archive."""

from dataclasses import replace

from ..contracts import ProposalInput, ProposalPlan
from ..gepa.proposal import plan_proposals as plan_gepa_proposals

HISTORY_GUIDANCE = (
    "Meta-Harness: inspect the bounded, read-only seed experience archive for prior candidate "
    "diffs, scores, and execution traces; use cross-candidate evidence to justify one focused edit. "
    "Do not inspect held-out data."
)


def plan_proposals(view: ProposalInput) -> ProposalPlan:
    plan = plan_gepa_proposals(replace(view, candidate_limit=min(1, view.candidate_limit)))
    return replace(plan, hypotheses=plan.hypotheses[:1], reason=HISTORY_GUIDANCE)
