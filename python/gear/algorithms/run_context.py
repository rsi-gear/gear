"""Async algorithm authoring over the existing durable decision protocol."""

from __future__ import annotations

import json
from collections.abc import Coroutine, Generator, Mapping, Sequence
from dataclasses import asdict, dataclass
from typing import Any, cast

from gear.canonical import JSON, digest

from .contracts import (
    AlgorithmState,
    Budget,
    Candidate,
    Decision,
    Evidence,
    Operation,
    OperationResult,
    ResearchRecord,
    SearchView,
    Task,
)
from .random import DeterministicRandom


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
class RunData:
    seed: tuple[Task, ...]


@dataclass(frozen=True)
class RoleResult:
    operation: OperationResult
    data: JSON
    candidate: Candidate | None = None

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
class WorkflowResult:
    selected: str | None
    reason: str


@dataclass(frozen=True)
class _Request:
    key: str
    operation: Operation

    def __await__(self) -> Generator[_Request, OperationResult, OperationResult]:
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
    ) -> RoleResult:
        role = self._roles[name]
        parent = self._context._candidate(candidate or self._context.inputs.anchor)
        payload: dict[str, JSON] = {
            "meta": {"prompt": role.prompt, "schema": role.schema},
            "inputs": inputs,
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
        result = await _Request(key, operation)
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
        self.data = RunData(view.tasks)
        self.random = DeterministicRandom(view.seed)
        self.roles = RoleAccess(self, roles)
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
        result = await _Request(
            key,
            Operation("evaluate_seed", candidate_id=candidate_id, task_ids=task_ids, scope=scope),
        )
        evidence = self.evidence.for_candidate(candidate_id, key=key + "/evidence", tasks=task_ids)
        expected = {
            (task, repetition) for task in task_ids for repetition in range(self.inputs.repetitions)
        }
        complete = {(cell.task_id, cell.repetition) for cell in evidence} == expected
        return EvaluationResult(result, evidence, complete)

    def record(self, record: ResearchRecord, *, key: str) -> None:
        _, fresh = self._event(key, {"record": _json(asdict(record))})
        if fresh:
            self._research.append(record)

    def result(
        self, *, selected: Candidate | str | None = None, reason: str = "workflow complete"
    ) -> WorkflowResult:
        return WorkflowResult(
            self._candidate(selected).id if selected is not None else None, reason
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

    def _resolve(self, request: _Request) -> OperationResult | None:
        event, fresh = self._event(request.key, _json(asdict(request.operation)))
        if fresh:
            event["cursor"] = len(self._view.completed)
            return None
        operation_id = event.get("operation_id")
        if operation_id is None:
            cursor = event["cursor"]
            if cursor >= len(self._view.completed):
                raise ValueError("workflow operation has no completion: " + request.key)
            result = self._view.completed[cursor]
            event["operation_id"] = result.operation_id
        else:
            result = self._completed[operation_id]
        if (
            result.kind != request.operation.kind
            or result.candidate_id != request.operation.candidate_id
        ):
            raise ValueError("workflow completion does not match its request: " + request.key)
        return OperationResult(**asdict(result))

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
                        if selected is not None and selected != view.anchor_id
                        else Operation("stop", rationale=result.reason)
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
                        (request.operation,),
                        request.operation.rationale or request.key,
                        tuple(context._research),
                    )
        finally:
            coroutine.close()
