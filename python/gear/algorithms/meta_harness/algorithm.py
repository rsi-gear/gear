"""Meta-Harness adaptation using Gear's bounded seed experience operations."""

from ..contracts import CandidateRanker, ParentPolicy, ProposalPlanner, StopRule, TaskSampler
from ..workflow import StagedSearch
from .parents import select_frontier_parent
from .proposal import plan_proposals
from .ranking import rank_candidates
from .sampling import sample_all_tasks
from .stopping import stop_reason


class MetaHarness(StagedSearch):
    """Search one global candidate at a time using the available seed archive.

    The worker receives a frozen, seed-scoped experience reader, baseline
    evidence and trajectories on the first diagnosis, and read-only baseline
    source. Historical candidate source is available through bounded pages.
    The Terminal-Bench 2 mapping records the remaining search adaptations.
    """

    def __init__(
        self,
        *,
        parent_policy: ParentPolicy = select_frontier_parent,
        sampler: TaskSampler = sample_all_tasks,
        proposal_planner: ProposalPlanner = plan_proposals,
        ranker: CandidateRanker = rank_candidates,
        stop_rule: StopRule = stop_reason,
    ) -> None:
        super().__init__(
            parent_policy,
            sampler,
            proposal_planner,
            ranker,
            stop_rule,
            ("global",),
            (),
            stop_at_score_ceiling=False,
            propose_without_failures=True,
            diagnosis_scope="global",
        )
