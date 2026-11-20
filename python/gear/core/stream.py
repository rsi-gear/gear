"""Basic callable components and operations."""

from __future__ import annotations

from dataclasses import dataclass

from gear.canonical import JSON
from gear.core._json import json_object
from gear.core.base import Module
from gear.core.calls import ArtifactRef, Call, checked_name


@dataclass(frozen=True)
class CompleteTaskInput:
    task_id: str
    sample_id: str
    output: ArtifactRef
    expected_revision: str
    library_refs: tuple[ArtifactRef, ...] = ()


class CompleteTask(Module):
    def __call__(self, value: CompleteTaskInput, *, key: str) -> Call[dict[str, JSON]]:
        for name in (value.task_id, value.sample_id, value.expected_revision):
            checked_name(name)
        return Call(key, self.operator_ref, {"kind": "stream", "input": json_object(value)})

    def requirements(self) -> tuple[str, ...]:
        return ("task_stream",)
