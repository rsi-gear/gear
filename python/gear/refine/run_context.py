"""Async algorithm authoring over the existing durable decision protocol."""

from __future__ import annotations

import json
from collections.abc import Callable, Coroutine, Generator, Mapping, Sequence
from dataclasses import asdict, dataclass, replace
from typing import Any, cast

from gear.canonical import JSON, digest

from .artifacts import ArtifactAccess
from .contracts import (
    AlgorithmState,
    Budget,
    Candidate,
    Decision,
    Evidence,
    Operation,
    OperationResult,
    ResearchRecord,
    ResearchTrial,
    SearchView,
    Task,
)
from .random import DeterministicRandom
from .workspaces import WorkspaceAccess, WorkspaceRef


def _json(value: Any) -> JSON:
    return cast(JSON, json.loads(json.dumps(value, allow_nan=False)))


@dataclass(frozen=True)
class Role:
    """An algorithm-owned Meta task, executed by the project's Meta provider."""

    prompt: str
    schema: dict[str, JSON]
    edits: bool = False


@dataclass(frozen=True)
class RunInputs:
    anchor: Candidate
    rounds: int
    repetitions: int
    objective: JSON


@dataclass(frozen=True)
class TaskInstance:
    id: str
    task_id: str
    question: str | None = None


@dataclass(frozen=True)
class RunData:
    seed: tuple[Task, ...]
    train: tuple[Task, ...] = ()
    dev: tuple[Task, ...] = ()
    _sources: tuple[dict[str, Any], ...] = ()

    def question(self, task: Task | str) -> str:
        task_id = task.id if isinstance(task, Task) else task
        return cast(
            str, next(value["instruction"] for value in self._sources if value["id"] == task_id)
        )

    def expected(self, task: Task | str) -> JSON:
        task_id = task.id if isinstance(task, Task) else task
        return _json(
            next(value.get("expected") for value in self._sources if value["id"] == task_id)
        )

    def derive(self, task: Task | str, question: str, *, id: str) -> TaskInstance:
        return TaskInstance(id, task.id if isinstance(task, Task) else task, question)


@dataclass(frozen=True)
class RoleResult:
    operation: OperationResult
    data: JSON
    candidate: Candidate | None = None
    revision: WorkspaceRef | None = None

    @property
    def ok(self) -> bool:
        return self.operation.status == "complete"

    @property
    def change(self) -> JSON:
        return self.operation.candidate_change


@dataclass(frozen=True)
class EvaluationResult:
    operation: OperationResult
    evidence: tuple[Evidence, ...]
    complete: bool

    @property
    def ok(self) -> bool:
        return (
            self.operation.status == "complete"
            and self.complete
            and all(
                cell.status in ("valid", "task_failed") and cell.score is not None
                for cell in self.evidence
            )
        )


@dataclass(frozen=True)
class EvidencePage:
    operation: OperationResult
    data: JSON


@dataclass(frozen=True)
class TrialResult:
    operation: OperationResult
    observations: tuple[ResearchTrial, ...]
    complete: bool

    @property
    def ok(self) -> bool:
        return (
            self.operation.status == "complete"
            and self.complete
            and all(
                value.evidence.status in ("valid", "task_failed")
                and value.evidence.score is not None
                for value in self.observations
            )
        )


@dataclass(frozen=True)
class WorkflowResult:
    selected: str | None
    reason: str
    nominate: bool = True
    data: JSON = None
    candidates: tuple[str, ...] = ()


@dataclass(frozen=True)
class _Request:
    key: str
    operations: tuple[Operation, ...]
    reason: str

    def __await__(
        self,
    ) -> Generator[_Request, tuple[OperationResult, ...], tuple[OperationResult, ...]]:
        return (yield self)


class RoleAccess:
    def __init__(self, context: RunContext, roles: Mapping[str, Role]) -> None:
        self._context = context
        self._roles = roles

    async def call(
        self,
        name: str,
        *,
        key: str,
        inputs: JSON = None,
        candidate: Candidate | str | None = None,
        tasks: Sequence[Task | str] | None = None,
        references: Mapping[str, Candidate] | None = None,
        workspace: WorkspaceRef | None = None,
        materials: Mapping[str, Any] | None = None,
        write_paths: Sequence[str] | None = None,
    ) -> RoleResult:
        role = self._roles[name]
        if workspace is not None:
            return await self._context.workspaces.edit(
                name,
                workspace=workspace,
                key=key,
                inputs=inputs,
                tasks=tasks,
                references=references,
                materials=materials,
                write_paths=write_paths,
            )
        parent = self._context._candidate(candidate or self._context.inputs.anchor)
        payload: dict[str, JSON] = {
            "meta": {"prompt": role.prompt, "schema": role.schema},
            "inputs": inputs,
            "gear_role_v1": name,
        }
        if write_paths is not None:
            payload["gear_write_paths_v1"] = list(write_paths)
        if materials:
            payload["gear_materials_v1"] = {
                label: {
                    "operation_id": (
                        value if isinstance(value, OperationResult) else value.operation
                    ).operation_id
                }
                for label, value in materials.items()
            }
        if references:
            payload["gear_candidate_references_v1"] = {
                label: {"candidate_id": value.id, "digest": value.digest}
                for label, value in references.items()
            }
        candidate_id = (
            "workflow-" + digest([self._context.run_id, key])[7:31] if role.edits else parent.id
        )
        operation = Operation(
            "generate_candidate" if role.edits else "diagnose_seed",
            candidate_id=candidate_id,
            parent_id=parent.id if role.edits else None,
            task_ids=self._context._tasks(tasks),
            rationale=name,
            payload=payload,
        )
        result = (await self._context.perform((operation,), key=key, reason=name))[0]
        value = result.data
        if isinstance(value, dict) and "declined" in value and "data" in value:
            value = value["data"]
        generated = (
            self._context._candidate(candidate_id)
            if role.edits and result.status == "complete"
            else None
        )
        return RoleResult(result, _json(value), generated)


class BudgetAccess:
    def __init__(self, context: RunContext) -> None:
        self._context = context

    def snapshot(self, *, key: str) -> Budget:
        value = self._context._read(key, {"read": "budget"}, asdict(self._context._view.budget))
        return Budget(**cast(dict[str, Any], value))


class EvidenceAccess:
    def __init__(self, context: RunContext) -> None:
        self._context = context

    def for_candidate(
        self,
        candidate: Candidate | str,
        *,
        key: str,
        tasks: Sequence[Task | str] | None = None,
    ) -> tuple[Evidence, ...]:
        candidate_id = self._context._candidate(candidate).id
        task_ids = self._context._tasks(tasks)
        event, fresh = self._context._event(
            key, {"read": "evidence", "candidate": candidate_id, "tasks": list(task_ids)}
        )
        if fresh:
            observed = [
                cell
                for cell in self._context._candidate_evidence.get(candidate_id, ())
                if cell.task_id in task_ids
            ]
            event["slots"] = [[cell.task_id, cell.repetition] for cell in observed]
            event["value_digest"] = digest(_json([asdict(cell) for cell in observed]))
        observed = [
            self._context._evidence[(candidate_id, task_id, repetition)]
            for task_id, repetition in event["slots"]
        ]
        if digest(_json([asdict(cell) for cell in observed])) != event["value_digest"]:
            raise ValueError("workflow observed evidence changed: " + key)
        return tuple(Evidence(**asdict(cell)) for cell in observed)

    async def trajectory(
        self,
        trial: ResearchTrial | str,
        *,
        key: str,
        query: dict[str, JSON] | None = None,
    ) -> EvidencePage:
        trial_id = trial.id if isinstance(trial, ResearchTrial) else trial
        source = next(
            value for value in self._context._view.research_trials if value.id == trial_id
        )
        operation = Operation(
            "artifact_trial_read",
            candidate_id=source.candidate_id,
            task_ids=(source.task_id,),
            rationale="read authorized trial trajectory",
            payload={"gear_trial_read_v1": {"trial_id": trial_id, "query": query or {"limit": 20}}},
        )
        result = (await self._context.perform((operation,), key=key))[0]
        if result.status != "complete":
            raise ValueError("research trajectory unavailable")
        return EvidencePage(result, result.data)


class RunContext:
    def __init__(self, view: SearchView, state: AlgorithmState, roles: Mapping[str, Role]) -> None:
        self._view = view
        self._completed = {result.operation_id: result for result in view.completed}
        self._evidence = {
            (cell.candidate_id, cell.task_id, cell.repetition): cell for cell in view.evidence
        }
        self._candidate_evidence: dict[str, list[Evidence]] = {}
        for cell in view.evidence:
            self._candidate_evidence.setdefault(cell.candidate_id, []).append(cell)
        self._history = cast(list[dict[str, Any]], _json(state.data.get("history", [])))
        self._position = 0
        self._seen: set[str] = set()
        self._research: list[ResearchRecord] = []
        self.run_id = view.run_id
        self.inputs = RunInputs(
            self._candidate(view.anchor_id),
            view.budget.rounds,
            view.budget.repetitions,
            _json(view.objective),
        )
        policy = cast(dict[str, Any], view.research_data or {})
        self.data = RunData(
            view.tasks,
            tuple(task for task in view.tasks if task.id in policy.get("train", [])),
            tuple(task for task in view.tasks if task.id in policy.get("dev", [])),
            tuple(policy.get("tasks", [])),
        )
        self.random = DeterministicRandom(view.seed)
        self.roles = RoleAccess(self, roles)
        self.workspaces = WorkspaceAccess(self)
        self.artifacts = ArtifactAccess(self)
        self.budget = BudgetAccess(self)
        self.evidence = EvidenceAccess(self)

    async def evaluate(
        self,
        candidate: Candidate | str,
        *,
        key: str,
        tasks: Sequence[Task | str] | None = None,
        scope: str = "global",
    ) -> EvaluationResult:
        candidate_id = self._candidate(candidate).id
        task_ids = self._tasks(tasks)
        result = (
            await self.perform(
                (
                    Operation(
                        "evaluate_seed", candidate_id=candidate_id, task_ids=task_ids, scope=scope
                    ),
                ),
                key=key,
            )
        )[0]
        evidence = self.evidence.for_candidate(candidate_id, key=key + "/evidence", tasks=task_ids)
        expected = {
            (task, repetition) for task in task_ids for repetition in range(self.inputs.repetitions)
        }
        complete = {(cell.task_id, cell.repetition) for cell in evidence} == expected
        return EvaluationResult(result, evidence, complete)

    async def measure(
        self,
        candidate: Candidate | str,
        *,
        key: str,
        tasks: Sequence[Task | str | TaskInstance],
        group: str | None = None,
        repetitions: int = 1,
    ) -> TrialResult:
        candidate_id = self._candidate(candidate).id
        instances = [
            {"id": str(i), "task_id": item.id if isinstance(item, Task) else item}
            if not isinstance(item, TaskInstance)
            else {
                "id": item.id,
                "task_id": item.task_id,
                **({"question": item.question} if item.question is not None else {}),
            }
            for i, item in enumerate(tasks)
        ]
        trial_group = group or key
        plan = {"group": trial_group, "repetitions": repetitions, "instances": instances}
        operation = Operation(
            "evaluate_seed",
            candidate_id=candidate_id,
            task_ids=tuple(dict.fromkeys(str(item["task_id"]) for item in instances)),
            payload={"gear_trials_v1": cast(JSON, plan)},
        )
        result = (await self.perform((operation,), key=key))[0]
        order = {
            (str(item["id"]), sample): index * repetitions + sample
            for index, item in enumerate(instances)
            for sample in range(repetitions)
        }
        observations = tuple(
            sorted(
                (
                    trial
                    for trial in self._view.research_trials
                    if trial.candidate_id == candidate_id and trial.group == trial_group
                ),
                key=lambda trial: order[(trial.instance_id, trial.repetition)],
            )
        )
        observations = tuple(
            replace(
                trial,
                evidence=Evidence(**asdict(trial.evidence)),
                usage=_json(trial.usage),
                artifacts=tuple(cast(list[JSON], _json(trial.artifacts))),
            )
            for trial in observations
        )
        return TrialResult(result, observations, len(observations) == len(order))

    async def perform(
        self, operations: Sequence[Operation], *, key: str, reason: str = "workflow operation"
    ) -> tuple[OperationResult, ...]:
        if not operations or any(op.kind in ("stop", "nominate") for op in operations):
            raise ValueError("perform requires nonterminal operations")
        return await _Request(key, tuple(operations), reason)

    def compute(self, callback: Callable[[], JSON], *, key: str) -> JSON:
        event, fresh = self._event(key, {"compute": True})
        if fresh:
            event["value"] = _json(callback())
        return _json(event["value"])

    def record(self, record: ResearchRecord, *, key: str) -> None:
        _, fresh = self._event(key, {"record": _json(asdict(record))})
        if fresh:
            self._research.append(record)

    def result(
        self,
        *,
        selected: Candidate | str | None = None,
        reason: str = "workflow complete",
        nominate: bool | None = None,
        data: JSON = None,
        candidates: Sequence[Candidate | str] = (),
    ) -> WorkflowResult:
        report_only = bool(cast(dict[str, Any], self._view.research_data or {}).get("reportOnly"))
        return WorkflowResult(
            self._candidate(selected).id if selected is not None else None,
            reason,
            not report_only if nominate is None else nominate,
            _json(data),
            tuple(self._candidate(item).id for item in candidates),
        )

    def _candidate(self, candidate: Candidate | str) -> Candidate:
        candidate_id = candidate.id if isinstance(candidate, Candidate) else candidate
        selected = next((item for item in self._view.candidates if item.id == candidate_id), None)
        if selected is None:
            raise ValueError("workflow refers to an unknown candidate: " + candidate_id)
        return selected

    def _tasks(self, tasks: Sequence[Task | str] | None) -> tuple[str, ...]:
        return tuple(
            item.id if isinstance(item, Task) else item
            for item in (self.data.seed if tasks is None else tasks)
        )

    def _event(self, key: str, request: JSON) -> tuple[dict[str, Any], bool]:
        if not key or key in self._seen:
            raise ValueError("workflow keys must be nonempty and unique: " + key)
        self._seen.add(key)
        request_digest = digest(request)
        index = self._position
        self._position += 1
        if index < len(self._history):
            event = self._history[index]
            if event["key"] != key or event["digest"] != request_digest:
                raise ValueError("workflow changed a recorded request: " + key)
            return event, False
        event = {"key": key, "digest": request_digest}
        self._history.append(event)
        return event, True

    def _read(self, key: str, query: JSON, current: Any) -> JSON:
        event, fresh = self._event(key, query)
        if fresh:
            event["value"] = _json(current)
        return _json(event["value"])

    def _resolve(self, request: _Request) -> tuple[OperationResult, ...] | None:
        event, fresh = self._event(request.key, _json([asdict(op) for op in request.operations]))
        if fresh:
            event["cursor"] = len(self._view.completed)
            return None
        operation_ids = event.get("operation_ids")
        if operation_ids is None:
            cursor = event["cursor"]
            results = self._view.completed[cursor : cursor + len(request.operations)]
            if len(results) != len(request.operations):
                raise ValueError("workflow operation has no completion: " + request.key)
            event["operation_ids"] = [result.operation_id for result in results]
        else:
            results = tuple(self._completed[operation_id] for operation_id in operation_ids)
        for operation, result in zip(request.operations, results):
            if result.kind != operation.kind or result.candidate_id != operation.candidate_id:
                raise ValueError("workflow completion does not match its request: " + request.key)
        return tuple(OperationResult(**asdict(result)) for result in results)

    def _state(self) -> AlgorithmState:
        return AlgorithmState(data={"workflow": 1, "history": cast(JSON, self._history)})


class WorkflowAlgorithm:
    """Implement run(ctx); the existing runtime continues to persist each decision."""

    roles: Mapping[str, Role] = {}

    async def run(self, ctx: RunContext) -> WorkflowResult:
        raise NotImplementedError

    def step(self, view: SearchView, state: AlgorithmState) -> Decision:
        if state.version != 1 or state.data and state.data.get("workflow") != 1:
            raise ValueError("unsupported workflow state")
        context = RunContext(view, state, self.roles)
        coroutine: Coroutine[Any, Any, WorkflowResult] = self.run(context)
        completion = None
        try:
            while True:
                try:
                    request = coroutine.send(completion)
                except StopIteration as done:
                    if context._position != len(context._history):
                        raise ValueError("workflow returned before replaying its recorded requests")
                    result = done.value
                    if not isinstance(result, WorkflowResult):
                        raise TypeError("workflow must return ctx.result(...)")
                    selected = result.selected
                    operation = (
                        Operation("nominate", candidate_id=selected, rationale=result.reason)
                        if result.nominate and selected is not None and selected != view.anchor_id
                        else Operation("stop", rationale=result.reason)
                    )
                    if not result.nominate or result.data is not None or result.candidates:
                        operation = Operation(
                            **{
                                **asdict(operation),
                                "payload": {
                                    "gear_result_v1": {
                                        "selected": selected,
                                        "candidates": list(result.candidates),
                                        "data": result.data,
                                    }
                                },
                            }
                        )
                    return Decision(
                        context._state(), (operation,), result.reason, tuple(context._research)
                    )
                if not isinstance(request, _Request):
                    raise TypeError("workflow awaits must use RunContext operations")
                completion = context._resolve(request)
                if completion is None:
                    return Decision(
                        context._state(),
                        request.operations,
                        request.reason,
                        tuple(context._research),
                    )
        finally:
            coroutine.close()
