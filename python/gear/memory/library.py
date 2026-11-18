"""Explicit records and knowledge operations."""

from __future__ import annotations

from dataclasses import dataclass

from gear.canonical import JSON
from gear.core._json import json_object
from gear.core.base import Module
from gear.core.calls import ArtifactRef, Call, checked_name


@dataclass(frozen=True)
class CommitLibraryInput:
    base: ArtifactRef | None
    assets: dict[str, ArtifactRef]
    data: JSON = None


class CommitLibrary(Module):
    def __call__(self, value: CommitLibraryInput, *, key: str) -> Call[dict[str, JSON]]:
        for name in value.assets:
            checked_name(name)
        return Call(
            key,
            self.operator_ref,
            {"kind": "library", "input": {"mode": "commit", **json_object(value)}},
        )

    def requirements(self) -> tuple[str, ...]:
        return ("library_commit",)


@dataclass(frozen=True)
class PublishLibraryInput:
    name: str
    snapshot: ArtifactRef
    expected_revision: str | None


class PublishLibrary(Module):
    def __call__(self, value: PublishLibraryInput, *, key: str) -> Call[dict[str, JSON]]:
        checked_name(value.name)
        if value.expected_revision is not None:
            checked_name(value.expected_revision)
        return Call(
            key,
            self.operator_ref,
            {"kind": "library", "input": {"mode": "publish", **json_object(value)}},
        )

    def requirements(self) -> tuple[str, ...]:
        return ("library_publish",)
