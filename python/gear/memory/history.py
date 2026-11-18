"""Explicit records and knowledge operations."""

from __future__ import annotations

from dataclasses import dataclass

from gear.canonical import JSON
from gear.core._json import json_object
from gear.core.base import Module
from gear.core.calls import ArtifactRef, Call


@dataclass(frozen=True)
class HistoryInput:
    snapshot: ArtifactRef
    query: JSON = None
    cursor: str | None = None


class QueryHistory(Module):
    def __init__(self, *, limit: int = 20):
        self.limit = limit

    def __call__(self, value: HistoryInput, *, key: str) -> Call[JSON]:
        if type(self.limit) is not int or not 1 <= self.limit <= 100:
            raise ValueError("invalid history page limit")
        return Call(
            key,
            self.operator_ref,
            {
                "kind": "read",
                "input": {"view": "history", **json_object(value), "limit": self.limit},
            },
        )

    def requirements(self) -> tuple[str, ...]:
        return ("history_read",)
