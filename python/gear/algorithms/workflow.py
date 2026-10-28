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
    ParentInput,
    ParentOption,
    ParentPolicy,
    ProposalInput,
    ProposalPlanner,
    RankingInput,
    ResearchRecord,
    SamplingInput,
    SearchView,
    StopRule,
    TaskSampler,
)
from .evidence import task_scores
from .limits import MAX_DECISION_OPERATIONS
from .objective import comparison_key, score_ceiling
from .random import DeterministicRandom
from .validation import validate_parent_plan, validate_sampling_plan


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

    def __post_init__(self) -> None:
        if (
            not isinstance(self.promotion_widths, (tuple, list))
            or len(self.promotion_widths) != len(self.stages) - 1
            or any(type(width) is not int or width < 1 for width in self.promotion_widths)
        ):
            raise ValueError("promotion_widths requires one positive integer per stage transition")
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
        if view.budget.candidates_remaining <= 0:
            return self._finish(view, state, "candidate budget exhausted")
        all_tasks = self._all_tasks(view)
        global_input = RankingInput(
            tuple(candidate.id for candidate in view.candidates),
            all_tasks,
            view.evidence,
            view.budget.repetitions,
            objective=view.objective,
            anchor_id=view.anchor_id,
        )
        reached_ceiling = False
        if isinstance(view.objective, dict):
            ceiling = score_ceiling(view.objective)
            if ceiling is not None:
                global_ranking = self.ranker(global_input)
                configuration = cast(dict[str, Any], view.objective)
                precision = configuration["definition"]["comparisonPrecision"]
                reached_ceiling = any(
                    candidate not in global_ranking.disqualified
                    and comparison_key(score, precision) >= comparison_key(ceiling, precision)
                    for candidate, score in global_ranking.scores
                )
        else:
            reached_ceiling = any(
                all(score == 1 for _, score in profile)
                for profile in task_scores(global_input).values()
            )
        if reached_ceiling:
            return self._finish(view, state, "complete seed evidence reached the score upper bound")
        manifests: list[dict[str, JSON]] = [
            {
                "scope": "global",
                "tasks": list(all_tasks),
                "weights": {task: 1 / len(all_tasks) for task in all_tasks},
            }
        ]
        manifests += objects(state.data.get("scopes", []))
        eligible: list[ParentOption] = []
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
        remaining_rounds = max(1, view.budget.rounds - integer(state.data["round"]))
        quota = max(1, view.budget.candidates_remaining // remaining_rounds)
        parent_input = ParentInput(tuple(eligible), quota, view.anchor_id)
        plan = self.parent_policy(parent_input, self._rng(view))
        validate_parent_plan(parent_input, plan)
        research = ResearchRecord(
            "parents",
            "global",
            all_tasks,
            tuple(candidate.id for candidate in view.candidates),
            {
                "round": state.data["round"],
                "eligible": json.loads(json.dumps([asdict(option) for option in eligible])),
                "plan": json.loads(json.dumps(asdict(plan))),
            },
        )
        if not plan.allocations:
            return self._record(self._finish(view, state, plan.reason), research)
        # Preserve the complete allocation while splitting transport batches.
        # Evaluation includes the parent, so reserve one operation for that pair.
        batch_capacity = MAX_DECISION_OPERATIONS - 1
        batches: list[JSON] = [
            {
                "parent": allocation.selection.option.candidate_id,
                "scope": allocation.selection.option.scope,
                "tasks": list(allocation.selection.option.task_ids),
                "count": min(batch_capacity, allocation.count - offset),
                "selection": json.loads(json.dumps(asdict(allocation.selection))),
            }
            for allocation in plan.allocations
            for offset in range(0, allocation.count, batch_capacity)
        ]
        data = {
            **state.data,
            "batches": batches,
            "batch_index": 0,
            "parent_reason": plan.reason,
        }
        return self._record(self._diagnose(view, AlgorithmState(data=data)), research)

    def _diagnose(self, view: SearchView, state: AlgorithmState) -> Decision:
        if view.budget.generation_batch_capacity == 0:
            return self._finish(view, state, "generation budget exhausted")
        batches = objects(state.data["batches"])
        batch_index = integer(state.data["batch_index"])
        failures: tuple[str, ...] = ()
        parent = ""
        while batch_index < len(batches):
            batch = batches[batch_index]
            parent, selected_tasks = str(batch["parent"]), strings(batch["tasks"])
            failures = tuple(
                sorted(
                    {
                        cell.task_id
                        for cell in view.evidence
                        if cell.candidate_id == parent
                        and cell.task_id in selected_tasks
                        and cell.score is not None
                        and cell.status in ("valid", "task_failed")
                        and (cell.score < 1 or view.objective is not None)
                    }
                )
            )
            if failures:
                break
            batch_index += 1
        if not failures:
            return self._next_round(view, state)
        batch = batches[batch_index]
        return self._decision(
            {
                **state.data,
                "batch_index": batch_index,
                "phase": "proposals",
                "parent": parent,
                "limit": batch["count"],
                "failures": list(failures),
            },
            (
                Operation(
                    "diagnose_seed",
                    candidate_id=parent,
                    task_ids=failures,
                    rationale=str(state.data["parent_reason"]),
                ),
            ),
            "diagnose selected parent",
        )

    def _proposals(self, view: SearchView, state: AlgorithmState) -> Decision:
        if view.budget.generation_batch_capacity == 0:
            return self._finish(view, state, "generation budget exhausted")
        parent_id = str(state.data["parent"])
        results = [
            result
            for result in view.completed
            if result.kind == "diagnose_seed" and result.candidate_id == parent_id
        ]
        if not results or results[-1].status != "complete":
            return self._next_batch(view, state, "diagnosis failed")
        failure_ids = strings(state.data["failures"])
        failures = tuple(
            cell
            for cell in view.evidence
            if cell.candidate_id == parent_id and cell.task_id in failure_ids
        )
        batch = objects(state.data["batches"])[integer(state.data["batch_index"])]
        selection = cast(dict[str, JSON], batch["selection"])
        option = cast(dict[str, Any], selection["option"])
        # Resume the selected option, including its scope and evidence metadata.
        parent = ParentOption(
            candidate_id=option["candidate_id"],
            scope=option["scope"],
            task_ids=tuple(option["task_ids"]),
            score=option["score"],
            probability=option["probability"],
            task_scores=tuple((task, score) for task, score in option["task_scores"]),
            weights=tuple((task, weight) for task, weight in option["weights"]),
            content_digest=option["content_digest"],
        )
        quota = min(integer(state.data["limit"]), view.budget.candidates_remaining)
        if view.budget.generation_batch_capacity is not None:
            quota = min(quota, view.budget.generation_batch_capacity)
        plan = self.proposal_planner(
            ProposalInput(parent, failures, results[-1].data, quota, view.tasks)
        )
        if (
            not plan.reason
            or len(plan.hypotheses) > quota
            or any(not item.strip() for item in plan.hypotheses)
            or set(plan.task_ids) - set(self._all_tasks(view))
        ):
            raise ValueError("invalid proposal quota, rationale or task scope")
        ids = tuple(
            f"r{state.data['round']}-b{state.data['batch_index']}-candidate-{index}"
            for index in range(len(plan.hypotheses))
        )
        operations = tuple(
            Operation(
                "generate_candidate",
                candidate_id=candidate,
                parent_id=parent_id,
                task_ids=plan.task_ids,
                payload={"hypothesis": hypothesis},
                rationale=plan.reason,
            )
            for candidate, hypothesis in zip(ids, plan.hypotheses)
        )
        if not operations:
            return self._next_batch(view, state, "no actionable proposal")
        return self._decision(
            {
                **state.data,
                "phase": "generated",
                "planned": list(ids),
                "failures": list(plan.task_ids),
            },
            operations,
            plan.reason,
        )

    def _evaluate(
        self,
        view: SearchView,
        state: AlgorithmState,
        candidates: tuple[str, ...],
        index: int,
    ) -> Decision:
        stage = self.stages[index]
        required = strings(state.data.get("scope_tasks", [])) if index else ()
        parent = str(state.data["parent"])
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
        sampling = SamplingInput(
            view.tasks, strings(state.data["failures"]), stage, required, controls
        )
        plan = self.sampler(sampling, self._rng(view))
        validate_sampling_plan(sampling, plan)
        if not plan.task_ids:
            return self._next_batch(view, state, plan.reason)
        participants = tuple(dict.fromkeys((parent, *candidates)))
        existing = {(cell.candidate_id, cell.task_id, cell.repetition) for cell in view.evidence}
        cost = sum(
            (candidate, task, repetition) not in existing
            for candidate in participants
            for task in plan.task_ids
            for repetition in range(view.budget.repetitions)
        )
        if cost > view.budget.evaluations_remaining:
            return self._finish(
                view, state, "insufficient budget for comparable " + stage + " scope"
            )
        scope: dict[str, JSON] = {
            "tasks": list(plan.task_ids),
            "weights": dict(plan.weights),
        }
        scope_id = "global" if stage == "global" else stage + ":" + digest(scope)[7:23]
        return self._decision(
            {
                **state.data,
                "phase": "rank",
                "stage_index": index,
                "scope_tasks": list(plan.task_ids),
                "scope_weights": dict(plan.weights),
                "scope_id": scope_id,
                "sampling": json.loads(json.dumps(asdict(plan))),
                "participants": list(participants),
            },
            tuple(
                Operation(
                    "evaluate_seed",
                    candidate_id=candidate,
                    task_ids=plan.task_ids,
                    scope=scope_id,
                    rationale=plan.reason,
                )
                for candidate in participants
            ),
            plan.reason,
            (
                ResearchRecord(
                    "scope",
                    scope_id,
                    plan.task_ids,
                    participants,
                    {
                        "stage": stage,
                        "round": state.data["round"],
                        "sampling": json.loads(json.dumps(asdict(plan))),
                        "weights": dict(plan.weights),
                    },
                ),
            ),
        )

    def _rank(self, view: SearchView, state: AlgorithmState) -> Decision:
        ranked = self.ranker(
            RankingInput(
                strings(state.data["participants"]),
                strings(state.data["scope_tasks"]),
                view.evidence,
                view.budget.repetitions,
                weights(state.data["scope_weights"]),
                objective=view.objective,
                anchor_id=view.anchor_id,
            )
        )
        research = ResearchRecord(
            "ranking",
            str(state.data["scope_id"]),
            strings(state.data["scope_tasks"]),
            strings(state.data["participants"]),
            {
                "round": state.data["round"],
                "weights": state.data["scope_weights"],
                "ranking": json.loads(json.dumps(asdict(ranked))),
            },
        )
        if ranked.incomplete:
            return self._record(self._next_batch(view, state, "incomplete seed evidence"), research)
        parent = str(state.data["parent"])
        candidates = tuple(
            candidate
            for candidate in ranked.candidate_ids
            if candidate != parent and candidate not in ranked.disqualified
        )
        scopes = objects(state.data.get("scopes", []))
        scope_id = str(state.data["scope_id"])
        if scope_id != "global" and not any(item["scope"] == scope_id for item in scopes):
            scopes.append(
                {
                    "scope": scope_id,
                    "tasks": state.data["scope_tasks"],
                    "weights": state.data["scope_weights"],
                }
            )
        data = {
            **state.data,
            "scopes": cast(list[JSON], scopes),
            "ranking": json.loads(json.dumps(asdict(ranked))),
        }
        next_state = AlgorithmState(data=data)
        if not candidates:
            return self._record(
                self._next_batch(view, next_state, "no eligible candidate in the comparable scope"),
                research,
            )
        index = integer(state.data["stage_index"]) + 1
        if index < len(self.stages):
            # Expansion allocates research budget; it does not replace the parent.
            # The ranker still enforces constraints and the runtime gates publication.
            width = self.promotion_widths[index - 1]
            return self._record(
                self._evaluate(view, next_state, candidates[:width], index), research
            )
        return self._record(self._next_batch(view, next_state, "batch complete"), research)

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
        candidate = next(
            (
                candidate
                for candidate in ranked.candidate_ids
                if candidate not in ranked.disqualified
            ),
            view.anchor_id,
        )
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

    @staticmethod
    def _all_tasks(view: SearchView) -> tuple[str, ...]:
        return tuple(sorted(task.id for task in view.tasks))

    @staticmethod
    def _rng(view: SearchView) -> DeterministicRandom:
        return DeterministicRandom(f"{view.seed}:{view.step_id}")
