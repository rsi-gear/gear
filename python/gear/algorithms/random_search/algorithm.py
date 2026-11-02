"""A second recipe uses the same six contracts with a single global stage."""

from ..contracts import (
    CandidateRanker,
    ParentPolicy,
    ProposalPlanner,
    StopRule,
    TaskSampler,
)
from ..meta import MetaPolicy, default_meta
from ..workflow import StagedSearch
from .parents import select_parent
from .proposal import plan_proposals
from .ranking import rank_candidates
from .sampling import sample_tasks
from .stopping import stop_reason


class RandomSearch(StagedSearch):
    def __init__(
        self,
        *,
        parent_policy: ParentPolicy = select_parent,
        sampler: TaskSampler = sample_tasks,
        proposal_planner: ProposalPlanner = plan_proposals,
        ranker: CandidateRanker = rank_candidates,
        stop_rule: StopRule = stop_reason,
        meta_policy: MetaPolicy = default_meta,
    ) -> None:
        super().__init__(
            parent_policy,
            sampler,
            proposal_planner,
            ranker,
            stop_rule,
            ("global",),
            (),
            meta_policy=meta_policy,
        )
