"""Global exploratory search; diagnosis is optional for custom proposal planners."""

from gear.search.contracts_v1 import (
    CandidateRanker,
    ParentPolicy,
    ProposalPlanner,
    StopRule,
    TaskSampler,
)
from gear.search.parents import select_uniform_parent as select_parent
from gear.search.proposal import plan_exploratory_proposals as plan_proposals
from gear.search.ranking import rank_candidates
from gear.search.sampling import sample_all_tasks as sample_tasks
from gear.search.stopping import stop_reason
from gear.search.workflow import StagedSearch


class RandomSearch(StagedSearch):
    def __init__(
        self,
        *,
        parent_policy: ParentPolicy = select_parent,
        sampler: TaskSampler = sample_tasks,
        proposal_planner: ProposalPlanner = plan_proposals,
        ranker: CandidateRanker = rank_candidates,
        stop_rule: StopRule = stop_reason,
        diagnose: bool = False,
    ) -> None:
        super().__init__(
            parent_policy,
            sampler,
            proposal_planner,
            ranker,
            stop_rule,
            ("global",),
            (),
            diagnose=diagnose,
        )
