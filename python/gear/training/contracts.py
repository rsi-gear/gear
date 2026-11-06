"""Stable, CPU-only training contracts for four plain Python stages."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Awaitable, Protocol, TypeAlias

from gear.canonical import JSON

JSONValue: TypeAlias = JSON
StageValue: TypeAlias = JSONValue | Awaitable[JSONValue]


@dataclass(frozen=True)
class TrainingConfig:
    workspace: str | Path
    rounds: int
    initial_checkpoint: JSONValue = None
    parameters: dict[str, JSONValue] = field(default_factory=dict)


@dataclass(frozen=True)
class TrainingContext:
    round_index: int
    checkpoint: JSONValue
    history: list[dict[str, JSONValue]]
    operation_id: str
    workspace: Path
    run_workspace: Path
    config: TrainingConfig


@dataclass(frozen=True)
class TrainingResult:
    checkpoint: JSONValue
    history: list[dict[str, JSONValue]]
    rounds_completed: int
    workspace: Path


class TaskSource(Protocol):
    def generate(self, ctx: TrainingContext) -> StageValue: ...


class RolloutExecutor(Protocol):
    def execute(self, ctx: TrainingContext, tasks: JSONValue) -> StageValue: ...


class DatasetBuilder(Protocol):
    def build(self, ctx: TrainingContext, trajectories: JSONValue) -> StageValue: ...


class ModelUpdater(Protocol):
    def update(self, ctx: TrainingContext, dataset: JSONValue) -> StageValue: ...
