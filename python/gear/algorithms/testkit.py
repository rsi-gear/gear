"""CPU-only public conformance kit. No project files, Node, models or GPU required."""

from __future__ import annotations

import json
from dataclasses import asdict, replace
from typing import cast

from gear.canonical import JSON, digest
from gear.refine.protocol import validate

from .contracts import (
    AlgorithmState,
    Budget,
    Candidate,
    Decision,
    Evidence,
    OperationResult,
    ParentInput,
    ParentOption,
    ParentPlan,
    ParentPolicy,
    SearchAlgorithm,
    SearchView,
    Task,
)
from .random import DeterministicRandom


def wire(value: SearchView | Decision | ParentPlan) -> JSON:
    return cast(JSON, json.loads(json.dumps(asdict(value), allow_nan=False)))


def test_parent_policy(policy: ParentPolicy) -> dict[str, JSON]:
    options = (
        ParentOption("anchor", "all", ("a", "b"), 0.5),
        ParentOption("candidate", "all", ("a", "b"), 0.75),
    )
    view = ParentInput(options, 2, "anchor")
    first = policy(view, DeterministicRandom("toy"))
    second = policy(view, DeterministicRandom("toy"))
    if wire(first) != wire(second):
        raise ValueError("policy is not deterministic for a fixed view and seed")
    if not first.reason or sum(item.count for item in first.allocations) > view.candidate_limit:
        raise ValueError("invalid parent quota or unexplained decision")
    for item in first.allocations:
        if item.count < 1 or not any(
            (item.selection.option.candidate_id, item.selection.option.scope)
            == (option.candidate_id, option.scope)
            for option in options
        ):
            raise ValueError("policy selected an ineligible parent")
        if abs(sum(probability for _, probability in item.selection.probabilities) - 1) > 1e-9:
            raise ValueError("invalid parent sampling distribution")
    empty = policy(ParentInput((), 1, "anchor"), DeterministicRandom("toy"))
    if empty.allocations:
        raise ValueError("empty eligibility must abstain")
    return {"status": "passed", "deterministic": True, "plan": wire(first)}


def toy_round(algorithm: SearchAlgorithm) -> dict[str, JSON]:
    tasks = tuple(
        Task(name, family)
        for name, family in [
            ("a", "arithmetic"),
            ("b", "arithmetic"),
            ("c", "format"),
            ("d", "format"),
        ]
    )
    view = SearchView(
        "toy",
        0,
        "toy",
        tasks,
        (Candidate("anchor", digest("anchor")),),
        (),
        (),
        Budget(100, 2, 1),
        "anchor",
    )
    state = AlgorithmState()
    stages: list[str] = []
    for _ in range(30):
        before = digest(wire(view))
        decision = algorithm.step(view, state)
        if not isinstance(decision, Decision):
            raise ValueError("step must return Decision")
        validate("Decision", wire(decision))
        if digest(wire(view)) != before:
            raise ValueError("algorithm mutated its view")
        if wire(decision) != wire(algorithm.step(view, state)):
            raise ValueError("step is not deterministic")
        state = decision.state
        if not decision.operations:
            raise ValueError("decision must make progress")
        for index, operation in enumerate(decision.operations):
            stages.append(operation.kind + ":" + operation.scope.split(":", 1)[0])
            if set(operation.task_ids) - {task.id for task in view.tasks}:
                raise ValueError("out-of-scope task")
            if operation.kind in ("nominate", "stop"):
                return {
                    "status": "passed",
                    "steps": view.step_id + 1,
                    "nominee": operation.candidate_id,
                    "operations": list(stages),
                }
            result = OperationResult(
                f"{view.step_id}:{index}",
                operation.kind,
                "complete",
                operation.candidate_id,
            )
            if operation.kind == "diagnose_seed":
                result = replace(result, data={"hypotheses": ["Fix arithmetic and formatting."]})
            elif operation.kind == "generate_candidate":
                if operation.candidate_id is None:
                    raise ValueError("generation needs a candidate ID")
                if view.budget.candidates_remaining < 1:
                    raise ValueError("candidate budget exceeded")
                view = replace(
                    view,
                    candidates=view.candidates
                    + (
                        Candidate(
                            operation.candidate_id,
                            digest(operation.candidate_id),
                            operation.parent_id,
                        ),
                    ),
                    budget=replace(
                        view.budget,
                        candidates_remaining=view.budget.candidates_remaining - 1,
                    ),
                )
            elif operation.kind == "evaluate_seed":
                if operation.candidate_id is None:
                    raise ValueError("evaluation needs a candidate ID")
                cells = list(view.evidence)
                for task in operation.task_ids:
                    if any(
                        cell.candidate_id == operation.candidate_id and cell.task_id == task
                        for cell in cells
                    ):
                        continue
                    cells.append(
                        Evidence(
                            operation.candidate_id,
                            task,
                            0,
                            0.0 if operation.candidate_id == "anchor" else 1.0,
                            "valid",
                            operation.scope,
                        )
                    )
                cost = len(cells) - len(view.evidence)
                view = replace(
                    view,
                    evidence=tuple(cells),
                    budget=replace(
                        view.budget,
                        evaluations_remaining=view.budget.evaluations_remaining - cost,
                    ),
                )
            view = replace(view, completed=view.completed + (result,))
        view = replace(view, step_id=view.step_id + 1)
    raise ValueError("algorithm failed to terminate within toy step limit")
