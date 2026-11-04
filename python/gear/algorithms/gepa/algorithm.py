"""GEPA: frontier parents and failure proposals, promoted local → bridge → global."""

from typing import Literal

from gear.refine.contracts import (
    CandidateRanker,
    ParentPolicy,
    ProposalPlanner,
    StopRule,
    TaskSampler,
)
from gear.refine.evidence import complete_scope_mean
from gear.refine.run_context import RunContext, WorkflowResult
from gear.refine.staged import StagedWorkflow
from gear.refine.stopping import bounded_run

from .parents import select_parent
from .proposal import plan_proposals
from .sampling import sample_tasks


class GEPA(StagedWorkflow):
    """Run staged seed comparisons through the native ``run(ctx)`` workflow."""

    stages = ("local", "bridge", "global")

    def __init__(
        self,
        *,
        parent_policy: ParentPolicy = select_parent,
        sampler: TaskSampler = sample_tasks,
        proposal_planner: ProposalPlanner = plan_proposals,
        ranker: CandidateRanker = complete_scope_mean,
        stop_rule: StopRule = bounded_run,
        promotion_widths: tuple[int, ...] = (2, 1),
        global_gate: Literal["any", "no_regression"] = "any",
    ) -> None:
        super().__init__(
            parent_policy,
            sampler,
            proposal_planner,
            ranker,
            stop_rule,
            promotion_widths,
            global_gate,
        )

    async def run(self, ctx: RunContext) -> WorkflowResult:
        # Baseline → parent/proposal rounds → staged seed comparisons → final nominee.
        data = await self._baseline(ctx)
        for round_id in range(ctx.inputs.rounds):
            data, result = await self._run_round(ctx, data, round_id, stages=self.stages)
            if result is not None:
                return result
        return self._finish_workflow(ctx, data, "configured rounds complete", "finish")
