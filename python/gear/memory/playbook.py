"""Explicit records and knowledge operations."""

from __future__ import annotations

from dataclasses import dataclass

from gear.canonical import JSON, digest
from gear.core._json import json_value
from gear.core.base import Module
from gear.core.calls import checked_name


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
