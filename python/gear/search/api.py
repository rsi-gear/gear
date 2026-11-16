"""Composable search policies and flows."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from gear.canonical import JSON, digest
from gear.core._json import json_value
from gear.core.base import Module
from gear.core.calls import ArtifactRef, CallResult, CandidateRef, Results
from gear.core.state import StateTree
from gear.core.wire import validate_v2
from gear.evaluation.tasks import Task
from gear.search.decisions import Decision
from gear.search.random import DeterministicRandom


@dataclass(frozen=True)
class SearchView:
    run_id: str
    step_id: int
    seed: str
    tasks: tuple[Task, ...]
    candidates: tuple[CandidateRef, ...]
    results: Results
    budget: dict[str, JSON]
    anchor: CandidateRef
    objective: JSON = None
    history: ArtifactRef | None = None
    stream: JSON = None
    assets: tuple[ArtifactRef, ...] = ()
    capabilities: tuple[str, ...] = ()

    def candidate(self, candidate_id: str) -> CandidateRef:
        matches = [
            item
            for item in self.candidates
            if item.run_id == self.run_id and item.candidate_id == candidate_id
        ]
        if len(matches) != 1:
            raise ValueError("candidate is unavailable in this controlled view")
        return matches[0]

    def random(self, module_path: str, key: str) -> DeterministicRandom:
        if not module_path or not key:
            raise ValueError("randomness requires an explicit module path and call key")
        return DeterministicRandom(digest([self.seed, module_path, key]))

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> SearchView:
        validate_v2("SearchView", value)
        return cls(
            value["run_id"],
            value["step_id"],
            value["seed"],
            tuple(Task(**item) for item in value["tasks"]),
            tuple(CandidateRef(**item) for item in value["candidates"]),
            Results(tuple(CallResult.from_dict(item) for item in value["results"])),
            value["budget"],
            CandidateRef(**value["anchor"]),
            value["objective"],
            ArtifactRef(**value["history"]) if value["history"] is not None else None,
            value["stream"],
            tuple(ArtifactRef(**item) for item in value["assets"]),
            tuple(value["capabilities"]),
        )

    def to_dict(self) -> dict[str, JSON]:
        # Results deliberately exposes only already-projected terminal values.
        return {
            "run_id": self.run_id,
            "step_id": self.step_id,
            "seed": self.seed,
            "tasks": json_value(self.tasks),
            "candidates": json_value(self.candidates),
            "results": self.results.to_dict(),
            "budget": json_value(self.budget),
            "anchor": json_value(self.anchor),
            "objective": json_value(self.objective),
            "history": json_value(self.history),
            "stream": json_value(self.stream),
            "assets": json_value(self.assets),
            "capabilities": json_value(self.capabilities),
        }


class SearchAlgorithm(Protocol):
    protocol_version: int

    def step(self, view: SearchView, state: StateTree) -> Decision: ...


class Algorithm(Module):
    """Optional root base that explicitly opts into protocol v2."""

    protocol_version = 2

    def step(self, view: SearchView, state: StateTree) -> Decision:
        raise NotImplementedError
