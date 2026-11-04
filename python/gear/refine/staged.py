"""Native staged workflow and planning shared by the built-in search recipes.

Durability belongs to RunContext. Policy-state snapshots are exposed only to
stop rules; they never dispatch a second state machine.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, replace
from typing import Any, ClassVar, Literal, cast

from gear.canonical import JSON, digest

from .contracts import (
    AlgorithmState,
    CandidateRanker,
    Decision,
    Operation,
    OperationResult,
    ParentInput,
    ParentOption,
    ParentPolicy,
    ProposalInput,
    ProposalPlanner,
    RankingInput,
    RankingPlan,
    ResearchRecord,
    SamplingInput,
    SearchView,
    StopRule,
    TaskSampler,
)
from .evidence import task_scores
from .limits import MAX_DECISION_OPERATIONS
from .objective import comparison_key, score_ceiling
from .projection import compare_candidates, project_candidate
from .random import DeterministicRandom
from .run_context import RunContext, WorkflowAlgorithm, WorkflowResult
from .validation import validate_parent_plan, validate_sampling_plan


def _json(value: Any) -> JSON:
    return cast(JSON, json.loads(json.dumps(value, allow_nan=False)))


def strings(value: JSON) -> tuple[str, ...]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError("algorithm state requires a string array")
    return cast(tuple[str, ...], tuple(value))


def objects(value: JSON) -> list[dict[str, JSON]]:
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise ValueError("algorithm state requires an object array")
    return cast(list[dict[str, JSON]], value)


def weights(value: JSON) -> tuple[tuple[str, float], ...]:
    if not isinstance(value, dict) or any(
        type(item) not in (int, float) for item in value.values()
    ):
        raise ValueError("algorithm state requires a weight map")
    return tuple((key, float(cast(float, item))) for key, item in value.items())


@dataclass
class StagedWorkflow(WorkflowAlgorithm):
    parent_policy: ParentPolicy
    sampler: TaskSampler
    proposal_planner: ProposalPlanner
    ranker: CandidateRanker
    stop_rule: StopRule
    stages: ClassVar[tuple[Literal["local", "bridge", "global"], ...]]
    promotion_widths: tuple[int, ...]
    global_gate: Literal["any", "no_regression"] = "any"

    def __post_init__(self) -> None:
        if (
            not isinstance(self.promotion_widths, (tuple, list))
            or len(self.promotion_widths) != len(self.stages) - 1
            or any(type(width) is not int or width < 1 for width in self.promotion_widths)
        ):
            raise ValueError("promotion_widths requires one positive integer per stage transition")
        if self.global_gate not in ("any", "no_regression"):
            raise ValueError("global_gate must be 'any' or 'no_regression'")
        # JSON configuration uses arrays; keep the same immutable form as SDK configuration.
        self.promotion_widths = tuple(self.promotion_widths)
        self._policy_state: dict[str, JSON] = {}

    def step(self, view: SearchView, state: AlgorithmState) -> Decision:
        if state.version != 1 or state.data and state.data.get("workflow") != 1:
            raise ValueError("unsupported workflow state")
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

    async def _baseline(self, ctx: RunContext) -> dict[str, JSON]:
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

        return data

    async def _run_round(
        self,
        ctx: RunContext,
        data: dict[str, JSON],
        round_id: int,
        *,
        stages: tuple[Literal["local", "bridge", "global"], ...],
    ) -> tuple[dict[str, JSON], WorkflowResult | None]:
        """Plan parents, diagnose, generate, and compare one round's cohorts."""
        prefix = f"round/{round_id}"
        parents = cast(
            dict[str, Any],
            ctx.compute(lambda: self._parent_batches(ctx._view, data), key=prefix + "/parents"),
        )
        if parents.get("record") is not None:
            ctx.record(self._research(parents["record"]), key=prefix + "/parents/record")
        if parents.get("finish"):
            return data, self._finish_workflow(ctx, data, parents["finish"], prefix + "/finish")
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
                return data, self._finish_workflow(ctx, data, diagnosed["finish"], key + "/finish")
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
                return data, self._finish_workflow(ctx, data, proposal["finish"], key + "/finish")
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
            for stage_index, stage in enumerate(stages):
                stage_key = key + "/" + stage
                scope = cast(
                    dict[str, Any],
                    ctx.compute(
                        lambda: self._scope(ctx._view, data, candidates, stage_index, stage),
                        key=stage_key + "/scope",
                    ),
                )
                if scope.get("finish"):
                    return data, self._finish_workflow(
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
                    ctx.compute(lambda: self._ranking(ctx._view, data), key=stage_key + "/ranking"),
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
            return data, self._finish_workflow(
                ctx, data, "configured rounds complete", prefix + "/finish"
            )
        self._policy_state = data
        await ctx.perform(
            (
                Operation(
                    "evaluate_seed",
                    candidate_id=ctx.inputs.anchor.id,
                    task_ids=self._all_tasks(ctx._view),
                    rationale="reuse admitted baseline for the next round",
                ),
            ),
            key=prefix + "/next",
            reason="next round",
        )
        return data, None

    def _finish_workflow(
        self, ctx: RunContext, data: dict[str, JSON], reason: str, key: str
    ) -> WorkflowResult:
        candidate = cast(str, ctx.compute(lambda: self._finish_candidate(ctx._view), key=key))
        self._policy_state = {**data, "phase": "done"}
        return ctx.result(selected=candidate, reason=reason)

    def _seed_champion(self, view: SearchView, ranked: RankingPlan) -> str:
        # The runtime promotes only after the run's final gate, so the anchor stays
        # the deployed champion for the whole run. Parent policies instead receive
        # the seed champion: the leading complete-seed candidate, if it satisfies
        # its constraints and strictly improves on the anchor. Ties keep the anchor.
        if self._seed_rule(view):
            return self._gated_champion(view)
        leader = next(
            (
                candidate
                for candidate in ranked.candidate_ids
                if candidate not in ranked.disqualified
            ),
            view.anchor_id,
        )
        if leader == view.anchor_id or view.anchor_id not in dict(ranked.scores):
            return view.anchor_id
        if view.anchor_id in ranked.disqualified:
            return leader
        return view.anchor_id if self._at_least(view, ranked, view.anchor_id, leader) else leader

    @staticmethod
    def _seed_rule(view: SearchView) -> dict[str, Any] | None:
        if not isinstance(view.objective, dict):
            return None
        return cast(dict[str, Any] | None, view.objective.get("seed_rule"))

    def _gated_champion(self, view: SearchView) -> str:
        # The paper's SeedGate, applied in generation order: a candidate with complete
        # global seed evidence replaces the current champion only if it satisfies its
        # constraints, regresses no declared signal and strictly improves at least one.
        evidence = [asdict(cell) for cell in view.evidence]
        champion = view.anchor_id
        for candidate in view.candidates:
            if candidate.id == view.anchor_id:
                continue
            result = compare_candidates(
                {
                    "evidence": evidence,
                    "task_ids": list(self._all_tasks(view)),
                    "repetitions": view.budget.repetitions,
                    "candidate_id": candidate.id,
                    "anchor_id": view.anchor_id,
                    "reference_id": champion,
                    "partition": "seed",
                    "objective": view.objective,
                }
            )
            if result["constraints_passed"] and result["improved"]:
                champion = candidate.id
        return champion

    def _signals_at_bound(self, view: SearchView, champion: str) -> bool:
        configuration = cast(dict[str, Any], view.objective)
        rule = configuration["seed_rule"]
        projected = project_candidate(
            {
                "evidence": [asdict(cell) for cell in view.evidence],
                "task_ids": list(self._all_tasks(view)),
                "repetitions": view.budget.repetitions,
                "candidate_id": champion,
                "anchor_id": view.anchor_id,
                "partition": "seed",
                "objective": configuration,
            }
        )
        for metric_id in (rule["outcome"], *rule["process"]):
            contract = next(item for item in configuration["metrics"] if item["id"] == metric_id)
            value, bounds = projected["metrics"].get(metric_id), contract.get("range")
            if (
                not projected["complete"]
                or not bounds
                or not value
                or value["status"] != "available"
            ):
                return False
            precision = contract["comparisonPrecision"]
            difference = comparison_key(value["value"], precision) - comparison_key(
                bounds["max" if contract["direction"] == "maximize" else "min"], precision
            )
            if difference < 0 if contract["direction"] == "maximize" else difference > 0:
                return False
        return True

    @staticmethod
    def _at_least(view: SearchView, ranked: RankingPlan, candidate: str, parent: str) -> bool:
        # Same order as the ranker: satisfying the constraints outranks any score,
        # so a candidate that repairs a constraint the parent violates is no regression.
        if parent in ranked.disqualified and candidate not in ranked.disqualified:
            return True
        scores = dict(ranked.scores)
        if isinstance(view.objective, dict):
            precision = cast(dict[str, Any], view.objective)["definition"]["comparisonPrecision"]
            return comparison_key(scores[candidate], precision) >= comparison_key(
                scores[parent], precision
            )
        return scores[candidate] >= scores[parent]

    @staticmethod
    def _all_tasks(view: SearchView) -> tuple[str, ...]:
        return tuple(sorted(task.id for task in view.tasks))

    @staticmethod
    def _rng(view: SearchView) -> DeterministicRandom:
        return DeterministicRandom(f"{view.seed}:{view.step_id}")

    def _parent_batches(self, view: SearchView, data: dict[str, JSON]) -> JSON:
        if view.budget.candidates_remaining <= 0:
            return {"finish": "candidate budget exhausted"}
        tasks = self._all_tasks(view)
        global_input = RankingInput(
            tuple(c.id for c in view.candidates),
            tasks,
            view.evidence,
            view.budget.repetitions,
            objective=view.objective,
            anchor_id=view.anchor_id,
        )
        ranked = self.ranker(global_input)
        champion = self._seed_champion(view, ranked)
        ceiling_reached = False
        if self._seed_rule(view):
            ceiling_reached = self._signals_at_bound(view, champion)
        elif isinstance(view.objective, dict):
            ceiling = score_ceiling(view.objective)
            if ceiling is not None:
                precision = cast(dict[str, Any], view.objective)["definition"][
                    "comparisonPrecision"
                ]
                ceiling_reached = any(
                    candidate not in ranked.disqualified
                    and comparison_key(score, precision) >= comparison_key(ceiling, precision)
                    for candidate, score in ranked.scores
                )
        else:
            ceiling_reached = any(
                all(score == 1 for _, score in profile)
                for profile in task_scores(global_input).values()
            )
        if ceiling_reached:
            return {"finish": "complete seed evidence reached the score upper bound"}
        manifests: list[dict[str, JSON]] = [
            {
                "scope": "global",
                "tasks": list(tasks),
                "weights": {task: 1 / len(tasks) for task in tasks},
            }
        ]
        manifests += objects(data.get("scopes", []))
        eligible = []
        for scope in manifests:
            task_ids, scope_weights = strings(scope["tasks"]), weights(scope["weights"])
            ranking = RankingInput(
                tuple(c.id for c in view.candidates),
                task_ids,
                view.evidence,
                view.budget.repetitions,
                scope_weights,
                objective=view.objective,
                anchor_id=view.anchor_id,
            )
            ranks, profiles = self.ranker(ranking), task_scores(ranking)
            for candidate, score in ranks.scores:
                if candidate in ranks.disqualified and candidate != view.anchor_id:
                    continue
                if candidate not in profiles:
                    raise ValueError("ranker selected a candidate with incomplete evidence")
                snapshot = next(item for item in view.candidates if item.id == candidate)
                eligible.append(
                    ParentOption(
                        candidate,
                        str(scope["scope"]),
                        task_ids,
                        score,
                        task_scores=profiles[candidate],
                        weights=scope_weights,
                        content_digest=snapshot.digest,
                    )
                )
        remaining_rounds = max(1, view.budget.rounds - cast(int, data["round"]))
        quota = max(1, view.budget.candidates_remaining // remaining_rounds)
        parent_input = ParentInput(tuple(eligible), quota, champion)
        plan = self.parent_policy(parent_input, self._rng(view))
        validate_parent_plan(parent_input, plan)
        record = ResearchRecord(
            "parents",
            "global",
            tasks,
            tuple(c.id for c in view.candidates),
            {
                "round": data["round"],
                "champion": champion,
                "eligible": _json([asdict(x) for x in eligible]),
                "plan": _json(asdict(plan)),
            },
        )
        if not plan.allocations:
            return {"finish": plan.reason, "record": _json(asdict(record))}
        capacity = MAX_DECISION_OPERATIONS - 1
        batches = [
            {
                "parent": item.selection.option.candidate_id,
                "scope": item.selection.option.scope,
                "tasks": list(item.selection.option.task_ids),
                "count": min(capacity, item.count - offset),
                "selection": _json(asdict(item.selection)),
            }
            for item in plan.allocations
            for offset in range(0, item.count, capacity)
        ]
        return {"batches": _json(batches), "reason": plan.reason, "record": _json(asdict(record))}

    @staticmethod
    def _diagnosis(view: SearchView, batch: dict[str, Any]) -> JSON:
        if view.budget.generation_batch_capacity == 0:
            return {"finish": "generation budget exhausted"}
        return {
            "tasks": _json(
                sorted(
                    {
                        cell.task_id
                        for cell in view.evidence
                        if cell.candidate_id == batch["parent"]
                        and cell.task_id in batch["tasks"]
                        and cell.score is not None
                        and cell.status in ("valid", "task_failed")
                        and (cell.score < 1 or view.objective is not None)
                    }
                )
            )
        }

    def _proposal(
        self,
        view: SearchView,
        batch: dict[str, Any],
        diagnosis: OperationResult,
        failure_ids: list[str],
    ) -> JSON:
        if view.budget.generation_batch_capacity == 0:
            return {"finish": "generation budget exhausted"}
        if diagnosis.status != "complete":
            return {"reason": "diagnosis failed"}
        option = batch["selection"]["option"]
        parent = ParentOption(
            candidate_id=option["candidate_id"],
            scope=option["scope"],
            task_ids=tuple(option["task_ids"]),
            score=option["score"],
            probability=option["probability"],
            task_scores=tuple(map(tuple, option["task_scores"])),
            weights=tuple(map(tuple, option["weights"])),
            content_digest=option["content_digest"],
        )
        quota = min(batch["count"], view.budget.candidates_remaining)
        if view.budget.generation_batch_capacity is not None:
            quota = min(quota, view.budget.generation_batch_capacity)
        failures = tuple(
            cell
            for cell in view.evidence
            if cell.candidate_id == parent.candidate_id and cell.task_id in failure_ids
        )
        plan = self.proposal_planner(
            ProposalInput(parent, failures, diagnosis.data, quota, view.tasks)
        )
        if (
            not plan.reason
            or len(plan.hypotheses) > quota
            or any(not x.strip() for x in plan.hypotheses)
            or set(plan.task_ids) - set(self._all_tasks(view))
        ):
            raise ValueError("invalid proposal quota, rationale or task scope")
        return {
            "hypotheses": list(plan.hypotheses),
            "tasks": list(plan.task_ids),
            "reason": plan.reason if plan.hypotheses else "no actionable proposal",
        }

    def _scope(
        self,
        view: SearchView,
        data: dict[str, JSON],
        candidates: tuple[str, ...],
        index: int,
        stage: Literal["local", "bridge", "global"],
    ) -> JSON:
        parent = str(data["parent"])
        required = strings(data.get("scope_tasks", [])) if index else ()
        controls = tuple(
            task
            for task in self._all_tasks(view)
            if all(
                any(
                    cell.candidate_id == parent
                    and cell.task_id == task
                    and cell.repetition == repetition
                    and cell.score == 1
                    and cell.status in ("valid", "task_failed")
                    for cell in view.evidence
                )
                for repetition in range(view.budget.repetitions)
            )
        )
        sampling = SamplingInput(view.tasks, strings(data["failures"]), stage, required, controls)
        plan = self.sampler(sampling, self._rng(view))
        validate_sampling_plan(sampling, plan)
        if not plan.task_ids:
            return {"tasks": [], "reason": plan.reason}
        participants = tuple(dict.fromkeys((parent, *candidates)))
        existing = {(x.candidate_id, x.task_id, x.repetition) for x in view.evidence}
        cost = sum(
            (candidate, task, repetition) not in existing
            for candidate in participants
            for task in plan.task_ids
            for repetition in range(view.budget.repetitions)
        )
        if cost > view.budget.evaluations_remaining:
            return {"finish": "insufficient budget for comparable " + stage + " scope"}
        scope: dict[str, JSON] = {"tasks": list(plan.task_ids), "weights": dict(plan.weights)}
        scope_id = "global" if stage == "global" else stage + ":" + digest(scope)[7:23]
        record = ResearchRecord(
            "scope",
            scope_id,
            plan.task_ids,
            participants,
            {
                "stage": stage,
                "round": data["round"],
                "sampling": _json(asdict(plan)),
                "weights": dict(plan.weights),
            },
        )
        return {
            **scope,
            "id": scope_id,
            "sampling": _json(asdict(plan)),
            "participants": list(participants),
            "reason": plan.reason,
            "record": _json(asdict(record)),
        }

    def _ranking(self, view: SearchView, data: dict[str, JSON]) -> JSON:
        ranked = self.ranker(
            RankingInput(
                strings(data["participants"]),
                strings(data["scope_tasks"]),
                view.evidence,
                view.budget.repetitions,
                weights(data["scope_weights"]),
                objective=view.objective,
                anchor_id=view.anchor_id,
            )
        )
        record = ResearchRecord(
            "ranking",
            str(data["scope_id"]),
            strings(data["scope_tasks"]),
            strings(data["participants"]),
            {
                "round": data["round"],
                "weights": data["scope_weights"],
                "ranking": _json(asdict(ranked)),
            },
        )
        scopes = objects(data.get("scopes", []))
        if ranked.incomplete:
            return {
                "next": [],
                "reason": "incomplete seed evidence",
                "state": {},
                "record": _json(asdict(record)),
            }
        candidates = tuple(
            candidate
            for candidate in ranked.candidate_ids
            if candidate != data["parent"] and candidate not in ranked.disqualified
        )
        if data["scope_id"] != "global" and not any(x["scope"] == data["scope_id"] for x in scopes):
            scopes.append(
                {
                    "scope": data["scope_id"],
                    "tasks": data["scope_tasks"],
                    "weights": data["scope_weights"],
                }
            )
        update = {"scopes": scopes, "ranking": _json(asdict(ranked))}
        reason = "no eligible candidate in the comparable scope"
        index = cast(int, data["stage_index"]) + 1
        if self.global_gate == "no_regression" and index == len(self.stages) - 1 and candidates:
            candidates = tuple(
                c for c in candidates if self._at_least(view, ranked, c, str(data["parent"]))
            )
            reason = "every candidate regressed on the shared scope"
        if index >= len(self.stages) and candidates:
            candidates, reason = (), "batch complete"
        elif candidates:
            candidates = candidates[: self.promotion_widths[index - 1]]
        return {
            "next": list(candidates),
            "reason": reason,
            "state": _json(update),
            "record": _json(asdict(record)),
        }

    def _finish_candidate(self, view: SearchView) -> str:
        ranked = self.ranker(
            RankingInput(
                tuple(c.id for c in view.candidates),
                self._all_tasks(view),
                view.evidence,
                view.budget.repetitions,
                objective=view.objective,
                anchor_id=view.anchor_id,
            )
        )
        return (
            self._gated_champion(view)
            if self._seed_rule(view)
            else next(
                (c for c in ranked.candidate_ids if c not in ranked.disqualified), view.anchor_id
            )
        )

    @staticmethod
    def _research(value: dict[str, Any]) -> ResearchRecord:
        return ResearchRecord(
            value["kind"],
            value["scope"],
            tuple(value["task_ids"]),
            tuple(value["candidate_ids"]),
            value["data"],
        )
