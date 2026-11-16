"""GEPA instantiates the shared contracts with local → bridge → global flow."""

from typing import Literal

from gear.search.contracts_v1 import (
    CandidateRanker,
    ParentPolicy,
    ProposalPlanner,
    StopRule,
    TaskSampler,
)
from gear.search.parents import select_parent
from gear.search.proposal import plan_proposals
from gear.search.ranking import rank_candidates
from gear.search.sampling import sample_tasks
from gear.search.stopping import stop_reason
from gear.search.workflow import StagedSearch


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
