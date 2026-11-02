"""GEPA instantiates the shared contracts with local → bridge → global flow."""

from typing import Literal

from ..contracts import (
    CandidateRanker,
    ParentPolicy,
    ProposalPlanner,
    StopRule,
    TaskSampler,
)
from ..workflow import StagedSearch
from .parents import select_parent
from .proposal import plan_proposals
from .ranking import rank_candidates
from .sampling import sample_tasks
from .stopping import stop_reason


class GEPA(StagedSearch):
    def __init__(
        self,
        *,
        parent_policy: ParentPolicy = select_parent,
        sampler: TaskSampler = sample_tasks,
        proposal_planner: ProposalPlanner = plan_proposals,
        ranker: CandidateRanker = rank_candidates,
        stop_rule: StopRule = stop_reason,
        promotion_widths: tuple[int, ...] = (2, 1),
        global_gate: Literal["any", "no_regression"] = "any",
    ) -> None:
        super().__init__(
            parent_policy,
            sampler,
            proposal_planner,
            ranker,
            stop_rule,
            ("local", "bridge", "global"),
            promotion_widths,
            global_gate,
        )
