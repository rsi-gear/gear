"""Pure learning-asset updates and explicit immutable/CAS storage declarations."""

from __future__ import annotations

from dataclasses import dataclass

from gear.canonical import JSON, digest

from ._json import json_object, json_value
from .base import Module
from .calls import ArtifactRef, Call, checked_name
from .candidates import FileContent


@dataclass(frozen=True)
class TargetFiles:
    """Exact files to install into a sealed effective target when a library is used.

    Store ``to_dict()`` as CommitLibraryInput.data and pass the resulting
    snapshot in ExecutionInput.assets. Mutation policy and harness checks apply.
    """

    files: dict[str, FileContent]

    def to_dict(self) -> dict[str, JSON]:
        return {"kind": "target-files-v1", "files": json_object(self.files)}


@dataclass(frozen=True)
class PlaybookEntry:
    id: str
    text: str
    helpful: int = 0
    harmful: int = 0
    metadata: JSON = None

    def __post_init__(self) -> None:
        checked_name(self.id)
        if (
            not isinstance(self.text, str)
            or not self.text.strip()
            or any(type(value) is not int or value < 0 for value in (self.helpful, self.harmful))
        ):
            raise ValueError("playbook entries require text and nonnegative counters")
        json_value(self.metadata)

    @classmethod
    def create(cls, text: str, *, metadata: JSON = None) -> PlaybookEntry:
        return cls(
            "entry_" + digest({"text": text, "metadata": metadata})[7:], text, metadata=metadata
        )


@dataclass(frozen=True)
class CounterDelta:
    id: str
    helpful: int = 0
    harmful: int = 0


@dataclass(frozen=True)
class PlaybookDelta:
    add: tuple[PlaybookEntry, ...] = ()
    replace: tuple[PlaybookEntry, ...] = ()
    remove: tuple[str, ...] = ()
    counters: tuple[CounterDelta, ...] = ()


@dataclass(frozen=True)
class PlaybookInput:
    entries: tuple[PlaybookEntry, ...]
    delta: PlaybookDelta


class MergePlaybook(Module):
    def __call__(self, value: PlaybookInput) -> tuple[PlaybookEntry, ...]:
        entries = {entry.id: entry for entry in value.entries}
        if len(entries) != len(value.entries):
            raise ValueError("duplicate playbook entry IDs")
        changed = [entry.id for entry in value.delta.add + value.delta.replace] + list(
            value.delta.remove
        )
        if len(set(changed)) != len(changed):
            raise ValueError("conflicting playbook edits")
        for entry in value.delta.add:
            if entry.id in entries:
                raise ValueError("added playbook ID already exists")
            entries[entry.id] = entry
        for entry in value.delta.replace:
            if entry.id not in entries:
                raise ValueError("replaced playbook ID does not exist")
            entries[entry.id] = entry
        for name in value.delta.remove:
            if name not in entries:
                raise ValueError("removed playbook ID does not exist")
            del entries[name]
        if len({item.id for item in value.delta.counters}) != len(value.delta.counters):
            raise ValueError("duplicate playbook counter delta")
        for item in value.delta.counters:
            if item.id not in entries or any(
                type(count) is not int or count < 0 for count in (item.helpful, item.harmful)
            ):
                raise ValueError("counter delta requires an existing entry and nonnegative counts")
            old = entries[item.id]
            entries[item.id] = PlaybookEntry(
                old.id,
                old.text,
                old.helpful + item.helpful,
                old.harmful + item.harmful,
                old.metadata,
            )
        return tuple(entries[key] for key in sorted(entries))


@dataclass(frozen=True)
class ArchiveInput:
    records: tuple[dict[str, JSON], ...]
    additions: tuple[dict[str, JSON], ...]


class UpdateArchive(Module):
    """Update an algorithm's explicit state; this does not write runtime history."""

    def __call__(self, value: ArchiveInput) -> tuple[dict[str, JSON], ...]:
        records: dict[str, dict[str, JSON]] = {}
        for item in value.records + value.additions:
            record = json_object(item)
            key = checked_name(record.get("id"))  # type: ignore[arg-type]
            if key in records and records[key] != record:
                raise ValueError("archive record identity conflict")
            records[key] = record
        return tuple(records.values())


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
