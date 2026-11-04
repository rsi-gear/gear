"""Common resumable flow; every recipe supplies its policy implementations."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, replace
from typing import Any, Literal, cast

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
from .validation import validate_parent_plan, validate_sampling_plan


def _json(value: Any) -> JSON:
    return cast(JSON, json.loads(json.dumps(value, allow_nan=False)))


def strings(value: JSON) -> tuple[str, ...]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError("algorithm state requires a string array")
    return cast(tuple[str, ...], tuple(value))


def integer(value: JSON) -> int:
    if type(value) is not int or value < 0:
        raise ValueError("algorithm state requires a nonnegative integer")
    return value


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
class StagedSearch:
    parent_policy: ParentPolicy
    sampler: TaskSampler
    proposal_planner: ProposalPlanner
    ranker: CandidateRanker
    stop_rule: StopRule
    stages: tuple[Literal["local", "bridge", "global"], ...]
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

    def step(self, view: SearchView, state: AlgorithmState) -> Decision:
        if state.version != 1 or not self.stages or self.stages[-1] != "global":
            raise ValueError("unsupported state or missing final global comparison")
        reason = self.stop_rule(view, state)
        if reason:
            return Decision(state, (Operation("stop", rationale=reason),), reason)
        phase = state.data.get("phase", "baseline")
        if phase == "baseline":
            return self._decision(
                {"phase": "parents", "round": 0},
                (
                    Operation(
                        "evaluate_seed",
                        candidate_id=view.anchor_id,
                        task_ids=self._all_tasks(view),
                    ),
                ),
                "comparable baseline",
                (
                    ResearchRecord(
                        "scope",
                        "global",
                        self._all_tasks(view),
                        (view.anchor_id,),
                        {
                            "stage": "baseline",
                            "round": 0,
                            "weights": {
                                task: 1 / len(view.tasks) for task in self._all_tasks(view)
                            },
                        },
                    ),
                ),
            )
        if phase == "parents":
            return self._parents(view, state)
        if phase == "proposals":
            return self._proposals(view, state)
        if phase == "generated":
            planned = strings(state.data["planned"])
            candidates = tuple(
                result.candidate_id
                for result in view.completed
                if result.kind == "generate_candidate"
                and result.status == "complete"
                and result.candidate_id is not None
                and result.candidate_id in planned
            )
            if not candidates:
                return self._next_batch(view, state, "no candidate was generated")
            return self._evaluate(view, state, candidates, 0)
        if phase == "rank":
            return self._rank(view, state)
        raise ValueError("unknown algorithm phase: " + str(phase))

    def _parents(self, view: SearchView, state: AlgorithmState) -> Decision:
        plan = cast(dict[str, Any], self._parent_batches(view, state.data))
        research = self._research(plan["record"]) if plan.get("record") is not None else None
        if plan.get("finish"):
            decision = self._finish(view, state, plan["finish"])
        else:
            data = {
                **state.data,
                "batches": plan["batches"],
                "batch_index": 0,
                "parent_reason": plan["reason"],
            }
            decision = self._diagnose(view, AlgorithmState(data=data))
        return self._record(decision, research) if research is not None else decision

    def _diagnose(self, view: SearchView, state: AlgorithmState) -> Decision:
        if view.budget.generation_batch_capacity == 0:
            return self._finish(view, state, "generation budget exhausted")
        batches = objects(state.data["batches"])
        index = integer(state.data["batch_index"])
        while index < len(batches):
            batch = batches[index]
            plan = cast(dict[str, Any], self._diagnosis(view, batch))
            if plan.get("finish"):
                return self._finish(view, state, plan["finish"])
            if plan["tasks"]:
                return self._decision(
                    {
                        **state.data,
                        "batch_index": index,
                        "phase": "proposals",
                        "parent": batch["parent"],
                        "limit": batch["count"],
                        "failures": plan["tasks"],
                    },
                    (
                        Operation(
                            "diagnose_seed",
                            candidate_id=str(batch["parent"]),
                            task_ids=tuple(plan["tasks"]),
                            rationale=str(state.data["parent_reason"]),
                        ),
                    ),
                    "diagnose selected parent",
                )
            index += 1
        return self._next_round(view, state)

    def _proposals(self, view: SearchView, state: AlgorithmState) -> Decision:
        if view.budget.generation_batch_capacity == 0:
            return self._finish(view, state, "generation budget exhausted")
        parent = str(state.data["parent"])
        diagnosis = [
            result
            for result in view.completed
            if result.kind == "diagnose_seed" and result.candidate_id == parent
        ]
        if not diagnosis:
            return self._next_batch(view, state, "diagnosis failed")
        batch = objects(state.data["batches"])[integer(state.data["batch_index"])]
        plan = cast(
            dict[str, Any],
            self._proposal(view, batch, diagnosis[-1], list(strings(state.data["failures"]))),
        )
        if plan.get("finish"):
            return self._finish(view, state, plan["finish"])
        hypotheses = plan.get("hypotheses", [])
        if not hypotheses:
            return self._next_batch(view, state, plan["reason"])
        ids = tuple(
            f"r{state.data['round']}-b{state.data['batch_index']}-candidate-{index}"
            for index in range(len(hypotheses))
        )
        operations = tuple(
            Operation(
                "generate_candidate",
                candidate_id=candidate,
                parent_id=parent,
                task_ids=tuple(plan["tasks"]),
                payload={"hypothesis": hypothesis},
                rationale=plan["reason"],
            )
            for candidate, hypothesis in zip(ids, hypotheses)
        )
        return self._decision(
            {**state.data, "phase": "generated", "planned": list(ids), "failures": plan["tasks"]},
            operations,
            plan["reason"],
        )

    def _evaluate(
        self, view: SearchView, state: AlgorithmState, candidates: tuple[str, ...], index: int
    ) -> Decision:
        plan = cast(dict[str, Any], self._scope(view, state.data, candidates, index))
        if plan.get("finish"):
            return self._finish(view, state, plan["finish"])
        if not plan["tasks"]:
            return self._next_batch(view, state, plan["reason"])
        data = {
            **state.data,
            "phase": "rank",
            "stage_index": index,
            "scope_tasks": plan["tasks"],
            "scope_weights": plan["weights"],
            "scope_id": plan["id"],
            "sampling": plan["sampling"],
            "participants": plan["participants"],
        }
        operations = tuple(
            Operation(
                "evaluate_seed",
                candidate_id=candidate,
                task_ids=tuple(plan["tasks"]),
                scope=plan["id"],
                rationale=plan["reason"],
            )
            for candidate in plan["participants"]
        )
        return self._decision(data, operations, plan["reason"], (self._research(plan["record"]),))

    def _rank(self, view: SearchView, state: AlgorithmState) -> Decision:
        plan = cast(dict[str, Any], self._ranking(view, state.data))
        next_state = AlgorithmState(data={**state.data, **plan["state"]})
        if not plan["next"]:
            decision = self._next_batch(view, next_state, plan["reason"])
        else:
            decision = self._evaluate(
                view, next_state, tuple(plan["next"]), integer(state.data["stage_index"]) + 1
            )
        return self._record(decision, self._research(plan["record"]))

    def _next_batch(self, view: SearchView, state: AlgorithmState, reason: str) -> Decision:
        return self._diagnose(
            view,
            AlgorithmState(
                data={
                    **state.data,
                    "batch_index": integer(state.data["batch_index"]) + 1,
                    "last_batch_reason": reason,
                }
            ),
        )

    def _next_round(self, view: SearchView, state: AlgorithmState) -> Decision:
        next_round = integer(state.data["round"]) + 1
        next_state = AlgorithmState(data={**state.data, "phase": "parents", "round": next_round})
        if next_round < view.budget.rounds and view.budget.candidates_remaining > 0:
            # Round transitions yield a committed decision, even if every selected
            # local scope is already solved. Reuse these slots without new trials.
            return self._decision(
                next_state.data,
                (
                    Operation(
                        "evaluate_seed",
                        candidate_id=view.anchor_id,
                        task_ids=self._all_tasks(view),
                        rationale="reuse admitted baseline for the next round",
                    ),
                ),
                "next round",
            )
        return self._finish(view, next_state, "configured rounds complete")

    def _finish(self, view: SearchView, state: AlgorithmState, reason: str) -> Decision:
        candidate = self._finish_candidate(view)
        operations = (
            (Operation("nominate", candidate_id=candidate, rationale=reason),)
            if candidate != view.anchor_id
            else (Operation("stop", rationale=reason),)
        )
        return self._decision({**state.data, "phase": "done"}, operations, reason)

    @staticmethod
    def _decision(
        data: dict[str, JSON],
        operations: tuple[Operation, ...],
        reason: str,
        research: tuple[ResearchRecord, ...] = (),
    ) -> Decision:
        return Decision(AlgorithmState(data=data), operations, reason, research)

    @staticmethod
    def _record(decision: Decision, record: ResearchRecord) -> Decision:
        return replace(decision, research=(record, *decision.research))

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
        self, view: SearchView, data: dict[str, JSON], candidates: tuple[str, ...], index: int
    ) -> JSON:
        stage, parent = self.stages[index], str(data["parent"])
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
