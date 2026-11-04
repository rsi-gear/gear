"""GEPA's native async search, using the shared durable workflow SDK."""

from __future__ import annotations

import json
from dataclasses import replace
from typing import Any, Literal, cast

from gear.canonical import JSON

from ..contracts import (
    AlgorithmState,
    CandidateRanker,
    Decision,
    Operation,
    ParentPolicy,
    ProposalPlanner,
    ResearchRecord,
    SearchView,
    StopRule,
    TaskSampler,
)
from ..run_context import RunContext, WorkflowAlgorithm, WorkflowResult
from ..workflow import StagedSearch
from .parents import select_parent
from .proposal import plan_proposals
from .ranking import rank_candidates
from .sampling import sample_tasks
from .stopping import stop_reason


def _json(value: Any) -> JSON:
    return cast(JSON, json.loads(json.dumps(value, allow_nan=False)))


class GEPA(WorkflowAlgorithm, StagedSearch):
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
        StagedSearch.__init__(
            self,
            parent_policy,
            sampler,
            proposal_planner,
            ranker,
            stop_rule,
            ("local", "bridge", "global"),
            promotion_widths,
            global_gate,
        )
        self._policy_state: dict[str, JSON] = {}

    def step(self, view: SearchView, state: AlgorithmState) -> Decision:
        # Old phase journals keep their original state-machine semantics.
        if state.data and "workflow" not in state.data:
            return StagedSearch.step(self, view, state)
        policy_state = cast(dict[str, JSON], state.data.get("policy_state", {}))
        reason = self.stop_rule(view, AlgorithmState(data=policy_state))
        if reason:
            return Decision(state, (Operation("stop", rationale=reason),), reason)
        decision = WorkflowAlgorithm.step(self, view, state)
        return replace(
            decision,
            state=AlgorithmState(
                data={
                    **decision.state.data,
                    "policy_state": self._policy_state,
                }
            ),
        )

    async def run(self, ctx: RunContext) -> WorkflowResult:
        data: dict[str, JSON] = {"phase": "parents", "round": 0}
        tasks = tuple(sorted(task.id for task in ctx.data.seed))
        ctx.record(
            ResearchRecord(
                "scope",
                "global",
                tasks,
                (ctx.inputs.anchor.id,),
                {
                    "stage": "baseline",
                    "round": 0,
                    "weights": {task: 1 / len(tasks) for task in tasks},
                },
            ),
            key="baseline/record",
        )
        self._policy_state = data
        await ctx.perform(
            (Operation("evaluate_seed", candidate_id=ctx.inputs.anchor.id, task_ids=tasks),),
            key="baseline",
            reason="comparable baseline",
        )

        for round_id in range(ctx.inputs.rounds):
            prefix = f"round/{round_id}"
            parents = cast(
                dict[str, Any],
                ctx.compute(lambda: self._parent_batches(ctx._view, data), key=prefix + "/parents"),
            )
            if parents.get("record") is not None:
                ctx.record(self._research(parents["record"]), key=prefix + "/parents/record")
            if parents.get("finish"):
                return self._finish_workflow(ctx, data, parents["finish"], prefix + "/finish")
            batches = parents["batches"]
            data = {
                **data,
                "batches": batches,
                "batch_index": 0,
                "parent_reason": parents["reason"],
            }
            for index, batch in enumerate(batches):
                key = f"{prefix}/batch/{index}"
                diagnosed = cast(
                    dict[str, Any],
                    ctx.compute(lambda: self._diagnosis(ctx._view, batch), key=key + "/cases"),
                )
                if diagnosed.get("finish"):
                    return self._finish_workflow(ctx, data, diagnosed["finish"], key + "/finish")
                if not diagnosed["tasks"]:
                    continue
                parent = batch["parent"]
                data = {
                    **data,
                    "batch_index": index,
                    "phase": "proposals",
                    "parent": parent,
                    "limit": batch["count"],
                    "failures": diagnosed["tasks"],
                }
                self._policy_state = data
                (diagnosis,) = await ctx.perform(
                    (
                        Operation(
                            "diagnose_seed",
                            candidate_id=parent,
                            task_ids=tuple(diagnosed["tasks"]),
                            rationale=parents["reason"],
                        ),
                    ),
                    key=key + "/diagnose",
                    reason="diagnose selected parent",
                )
                proposal = cast(
                    dict[str, Any],
                    ctx.compute(
                        lambda: self._proposal(ctx._view, batch, diagnosis, diagnosed["tasks"]),
                        key=key + "/proposals",
                    ),
                )
                if proposal.get("finish"):
                    return self._finish_workflow(ctx, data, proposal["finish"], key + "/finish")
                hypotheses = proposal.get("hypotheses", [])
                if not hypotheses:
                    data = {
                        **data,
                        "batch_index": index + 1,
                        "last_batch_reason": proposal["reason"],
                    }
                    continue
                ids = tuple(f"r{round_id}-b{index}-candidate-{j}" for j in range(len(hypotheses)))
                data = {
                    **data,
                    "phase": "generated",
                    "planned": list(ids),
                    "failures": proposal["tasks"],
                }
                self._policy_state = data
                generated = await ctx.perform(
                    tuple(
                        Operation(
                            "generate_candidate",
                            candidate_id=candidate,
                            parent_id=parent,
                            task_ids=tuple(proposal["tasks"]),
                            payload={"hypothesis": hypothesis},
                            rationale=proposal["reason"],
                        )
                        for candidate, hypothesis in zip(ids, hypotheses)
                    ),
                    key=key + "/generate",
                    reason=proposal["reason"],
                )
                candidates = tuple(
                    result.candidate_id
                    for result in generated
                    if result.status == "complete" and result.candidate_id is not None
                )
                if not candidates:
                    data = {
                        **data,
                        "batch_index": index + 1,
                        "last_batch_reason": "no candidate was generated",
                    }
                    continue
                for stage_index, stage in enumerate(self.stages):
                    stage_key = key + "/" + stage
                    scope = cast(
                        dict[str, Any],
                        ctx.compute(
                            lambda: self._scope(ctx._view, data, candidates, stage_index),
                            key=stage_key + "/scope",
                        ),
                    )
                    if scope.get("finish"):
                        return self._finish_workflow(
                            ctx, data, scope["finish"], stage_key + "/finish"
                        )
                    if not scope["tasks"]:
                        data = {
                            **data,
                            "batch_index": index + 1,
                            "last_batch_reason": scope["reason"],
                        }
                        break
                    data = {
                        **data,
                        "phase": "rank",
                        "stage_index": stage_index,
                        "scope_tasks": scope["tasks"],
                        "scope_weights": scope["weights"],
                        "scope_id": scope["id"],
                        "sampling": scope["sampling"],
                        "participants": scope["participants"],
                    }
                    ctx.record(self._research(scope["record"]), key=stage_key + "/record")
                    self._policy_state = data
                    await ctx.perform(
                        tuple(
                            Operation(
                                "evaluate_seed",
                                candidate_id=candidate,
                                task_ids=tuple(scope["tasks"]),
                                scope=scope["id"],
                                rationale=scope["reason"],
                            )
                            for candidate in scope["participants"]
                        ),
                        key=stage_key + "/evaluate",
                        reason=scope["reason"],
                    )
                    ranking = cast(
                        dict[str, Any],
                        ctx.compute(
                            lambda: self._ranking(ctx._view, data), key=stage_key + "/ranking"
                        ),
                    )
                    ctx.record(self._research(ranking["record"]), key=stage_key + "/ranking/record")
                    data = {**data, **ranking["state"]}
                    candidates = tuple(ranking["next"])
                    if not candidates:
                        data = {
                            **data,
                            "batch_index": index + 1,
                            "last_batch_reason": ranking["reason"],
                        }
                        break
            transition = cast(
                dict[str, Any],
                ctx.compute(
                    lambda: {
                        "continue": round_id + 1 < ctx.inputs.rounds
                        and ctx._view.budget.candidates_remaining > 0,
                    },
                    key=prefix + "/transition",
                ),
            )
            data = {**data, "phase": "parents", "round": round_id + 1}
            if not transition["continue"]:
                return self._finish_workflow(
                    ctx, data, "configured rounds complete", prefix + "/finish"
                )
            self._policy_state = data
            await ctx.perform(
                (
                    Operation(
                        "evaluate_seed",
                        candidate_id=ctx.inputs.anchor.id,
                        task_ids=tasks,
                        rationale="reuse admitted baseline for the next round",
                    ),
                ),
                key=prefix + "/next",
                reason="next round",
            )
        return self._finish_workflow(ctx, data, "configured rounds complete", "finish")

    def _finish_workflow(
        self, ctx: RunContext, data: dict[str, JSON], reason: str, key: str
    ) -> WorkflowResult:
        candidate = cast(str, ctx.compute(lambda: self._finish_candidate(ctx._view), key=key))
        self._policy_state = {**data, "phase": "done"}
        return ctx.result(selected=candidate, reason=reason)
