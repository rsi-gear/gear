"""Random search: uniform parents, independent proposals and full seed comparison."""

from gear.refine.contracts import (
    CandidateRanker,
    ParentInput,
    ParentPlan,
    ParentPolicy,
    ProposalInput,
    ProposalPlan,
    ProposalPlanner,
    RandomSource,
    SamplingInput,
    SamplingPlan,
    StopRule,
    TaskSampler,
)
from gear.refine.evidence import complete_scope_mean
from gear.refine.run_context import RunContext, WorkflowResult
from gear.refine.staged import StagedWorkflow
from gear.refine.stopping import bounded_run


def select_parent(view: ParentInput, rng: RandomSource) -> ParentPlan:
    """Choose a parent uniformly from eligible complete seed scopes."""
    if not view.eligible:
        return ParentPlan.abstain("no eligible parent")
    return ParentPlan.single(rng.choice(view.eligible, key="parent"), view.candidate_limit)


def plan_proposals(view: ProposalInput) -> ProposalPlan:
    """Explore independent alternatives without failure-family prioritization."""
    return ProposalPlan(
        tuple(
            f"Explore alternative {index + 1} using the permitted seed feedback."
            for index in range(view.candidate_limit)
        ),
        view.parent.task_ids,
        "independent exploratory proposals",
    )


def sample_tasks(view: SamplingInput, rng: RandomSource) -> SamplingPlan:
    """Compare every candidate on the complete seed scope."""
    ids = tuple(sorted(task.id for task in view.tasks))
    return SamplingPlan(ids, tuple((key, 1 / len(ids)) for key in ids), "full seed comparison")


class RandomSearch(StagedWorkflow):
    """Run one global comparison per generated cohort using native durability."""

    stages = ("global",)

    def __init__(
        self,
        *,
        parent_policy: ParentPolicy = select_parent,
        sampler: TaskSampler = sample_tasks,
        proposal_planner: ProposalPlanner = plan_proposals,
        ranker: CandidateRanker = complete_scope_mean,
        stop_rule: StopRule = bounded_run,
    ) -> None:
        super().__init__(parent_policy, sampler, proposal_planner, ranker, stop_rule, ())

    async def run(self, ctx: RunContext) -> WorkflowResult:
        # Baseline → parent/proposal rounds → staged seed comparisons → final nominee.
        data = await self._baseline(ctx)
        for round_id in range(ctx.inputs.rounds):
            data, result = await self._run_round(ctx, data, round_id, stages=self.stages)
            if result is not None:
                return result
        return self._finish_workflow(ctx, data, "configured rounds complete", "finish")
