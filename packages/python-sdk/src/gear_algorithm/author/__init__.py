"""Explicit JSON state and batched execution services for algorithm authors.

A step may use normal Python libraries. Only the state returned by run() is
persistent; module globals and the Python heap are not resumed.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Generic, TypeVar

from .dto import (ArtifactRef, HarnessAgentV1 as Candidate, TaskSelectionV1 as TaskSelection,
                  EvaluationV1 as Evaluation, ProposalBatchV1 as Proposals, RoleResultV1 as RoleResult)

API_VERSION = "gear.algorithm.step.v1"
T = TypeVar("T")


@dataclass(frozen=True)
class Result(Generic[T]):
    ok: bool
    value: T | None = None
    error: dict[str, Any] | None = None


class Services:
    """These methods construct descriptions, without starting an effect."""
    @staticmethod
    def sample(source: ArtifactRef, count: int, seed: int = 0) -> dict[str, Any]:
        return {"service": "sample", "source": source, "count": count, "seed": seed}

    @staticmethod
    def tasks(selection: TaskSelection | ArtifactRef) -> dict[str, Any]:
        return {"service": "tasks", "selection": selection}

    @staticmethod
    def select(task_ids: list[str], purpose: str = "development") -> dict[str, Any]:
        return {"service": "select", "taskIds": task_ids, "purpose": purpose}

    @staticmethod
    def propose(parent: Candidate, *, role: str = "optimizer", count: int = 1,
                feedback: Evaluation | None = None) -> dict[str, Any]:
        request = {"service": "propose", "parent": parent, "role": role, "count": count}
        if feedback is not None:
            request["feedback"] = feedback
        return request

    @staticmethod
    def evaluate(candidate: Candidate, tasks: TaskSelection) -> dict[str, Any]:
        return {"service": "evaluate", "candidate": candidate, "tasks": tasks}

    @staticmethod
    def role(role: str, value: Any, candidate: Candidate | None = None) -> dict[str, Any]:
        return {"service": "role", "role": role, "input": value,
                **({"candidate": candidate} if candidate is not None else {})}

    @staticmethod
    def call(capability: str, value: Any, candidate: Candidate | None = None) -> dict[str, Any]:
        return {"service": "call", "capability": capability, "input": value,
                **({"candidate": candidate} if candidate is not None else {})}


services = Services()


class Context:
    services = services

    def __init__(self, request: dict[str, Any]):
        self.state = request["state"]
        self.results = {name: Result(**result) for name, result in request["results"].items()}
        self.config = request["config"]
        self.initial_candidate = request["initialCandidate"]
        self.task_source = request["taskSource"]
        self.budget = request["budget"]
        self.step_index = request["stepIndex"]

    def run(self, state: Any, **requests: dict[str, Any]) -> dict[str, Any]:
        return {"status": "run", "state": state, "requests": requests}

    def finish(self, *, selected: Candidate | None = None, outputs: Any = None) -> dict[str, Any]:
        result = {}
        if selected is not None:
            result["selected"] = selected
        if outputs is not None:
            result["outputs"] = outputs
        return {"status": "complete", "result": result}


class Archive(list[Candidate]):
    """An algorithm-selected reproduction pool; factual history stays in Campaign."""
    def add(self, candidate: Candidate) -> None:
        if not any(item["bindingSetRef"] == candidate["bindingSetRef"] for item in self):
            self.append(candidate)


class Algorithm:
    def __init__(self, function: Callable[[Context], dict[str, Any]], *, id: str,
                 config_schema: dict[str, Any], state_schema: dict[str, Any]):
        self.function = function
        self.id = id
        self.config_schema = config_schema
        self.state_schema = state_schema

    def describe(self) -> dict[str, Any]:
        return {"apiVersion": API_VERSION, "id": self.id, "configSchema": self.config_schema,
                "stateSchema": self.state_schema}

    def step(self, request: dict[str, Any]) -> dict[str, Any]:
        return self.function(Context(request))


def algorithm(function=None, *, id="search", config_schema=None, state_schema=None):
    """Decorate one decision step; return run(state, **requests) or finish(...)."""
    def wrap(fn):
        return Algorithm(fn, id=id, config_schema=config_schema or {"type": "object", "additionalProperties": True},
                         state_schema=state_schema or {"type": "any"})
    return wrap(function) if function is not None else wrap


__all__ = ["Algorithm", "Archive", "Candidate", "Context", "Evaluation", "Proposals", "Result",
           "RoleResult", "Services", "TaskSelection", "algorithm", "services"]
