"""RRSI proposal planning with bounded, history-aware hypotheses."""

from __future__ import annotations

from dataclasses import dataclass

from ..contracts import ProposalInput, ProposalPlan
from .config import RRSIConfig


@dataclass(frozen=True)
class RRSIProposalPlanner:
    config: RRSIConfig = RRSIConfig()

    def __call__(self, view: ProposalInput) -> ProposalPlan:
        hypotheses: list[str] = []
        if isinstance(view.diagnosis, dict):
            raw = view.diagnosis.get("hypotheses", ())
            if isinstance(raw, list):
                hypotheses = [
                    item.strip()
                    for item in raw
                    if isinstance(item, str) and item.strip()
                ]
        if not hypotheses:
            hypotheses = ["Address the observed failures without changing successful behavior."]
        return ProposalPlan(
            tuple(dict.fromkeys(hypotheses))[: view.candidate_limit],
            view.parent.task_ids,
            f"RRSI bounded proposals (up to {view.candidate_limit} candidates)",
        )


def plan_proposals(view: ProposalInput) -> ProposalPlan:
    return RRSIProposalPlanner()(view)
