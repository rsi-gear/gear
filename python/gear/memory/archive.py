"""Explicit records and knowledge operations."""

from __future__ import annotations

from dataclasses import dataclass

from gear.canonical import JSON
from gear.core._json import json_object
from gear.core.base import Module
from gear.core.calls import checked_name


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
