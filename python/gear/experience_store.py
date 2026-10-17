"""Bounded file access for the frozen experience gateway; all retrieval stays in algorithms."""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path
from typing import Any

from gear.algorithms.experience import encoded_size
from gear.algorithms.experience_index import (
    MAX_ITEM_BYTES,
    VIEWS,
    valid_digest,
    verify_chunk,
    verify_descriptor,
    verify_snapshot,
)

MAX_LEGACY_BYTES = 12 * 1024 * 1024
MAX_INDEX_BYTES = 4 * 1024 * 1024
MAX_DESCRIPTOR_BYTES = 2 * 1024 * 1024
MAX_OBJECT_BYTES = 256 * 1024


def _directory(path: Path) -> tuple[Path, int, int]:
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise ValueError("experience directories must not be links")
    return path.parent.resolve(strict=True) / path.name, info.st_dev, info.st_ino


def _read(path: Path, maximum: int, root: Path, objects: bool = False) -> Any:
    parents = [_directory(root)]
    if objects:
        parents.append(_directory(root / "objects"))
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > maximum:
            raise ValueError("experience must be a bounded regular file")
        raw = bytearray()
        while len(raw) <= info.st_size:
            chunk = os.read(fd, info.st_size + 1 - len(raw))
            if not chunk:
                break
            raw.extend(chunk)
        after = os.fstat(fd)
        current = [_directory(root)]
        if objects:
            current.append(_directory(root / "objects"))
        if (
            len(raw) != info.st_size
            or after.st_size != info.st_size
            or after.st_nlink != 1
            or parents != current
        ):
            raise ValueError("experience changed during its bounded read")
        value = json.loads(raw.decode("utf-8", errors="strict"))
        if not isinstance(value, dict):
            raise ValueError("experience files require JSON objects")
        if not objects and value.get("version") == 3 and info.st_size > MAX_INDEX_BYTES:
            raise ValueError("experience index exceeds 4 MiB")
        return value
    finally:
        os.close(fd)


class ExperienceStore:
    def __init__(self, snapshot_path: Path):
        self.root = snapshot_path.parent
        self.snapshot: dict[str, Any] = _read(snapshot_path, MAX_LEGACY_BYTES, self.root)
        verify_snapshot(self.snapshot)
        if self.snapshot["version"] == 3 and encoded_size(self.snapshot) > MAX_INDEX_BYTES:
            raise ValueError("experience index exceeds 4 MiB")
        if snapshot_path.name != "snapshot.json" and snapshot_path.name != (
            self.snapshot["digest"][7:] + ".json"
        ):
            raise ValueError("experience snapshot path does not match its digest")

    def _object(self, digest: str, maximum: int) -> dict[str, Any]:
        if not valid_digest(digest):
            raise ValueError("invalid experience object digest")
        value: dict[str, Any] = _read(
            self.root / "objects" / (digest[7:] + ".json"), maximum, self.root, True
        )
        return value

    def record(self, ref: str) -> dict[str, Any]:
        record: dict[str, Any] | None = next(
            (
                item
                for item in self.snapshot["records"]
                if "experience:" + item["digest"][7:] == ref
            ),
            None,
        )
        if record is None:
            raise ValueError("experience ref is outside the frozen snapshot")
        return record

    def descriptor(self, record: dict[str, Any]) -> dict[str, Any]:
        value = self._object(record["descriptor_digest"], MAX_DESCRIPTOR_BYTES)
        verify_descriptor(value, record)
        return value

    def read_items(
        self,
        record: dict[str, Any],
        descriptor: dict[str, Any],
        view: str,
        start: int,
        limit: int,
    ) -> list[Any]:
        if view not in VIEWS or type(start) is not int or start < 0 or not 1 <= limit <= 50:
            raise ValueError("invalid experience read window")
        result: list[Any] = []
        offset = 0
        for ref in descriptor["views"][view]:
            if offset + ref["count"] > start and offset < start + limit:
                chunk = self._object(ref["digest"], MAX_OBJECT_BYTES)
                verify_chunk(chunk, ref, record, view)
                if any(encoded_size(item) > MAX_ITEM_BYTES for item in chunk["items"]):
                    raise ValueError("experience item exceeds its bounded read size")
                result.extend(chunk["items"][max(0, start - offset) : start + limit - offset])
            offset += ref["count"]
            if offset >= start + limit:
                break
        return result
