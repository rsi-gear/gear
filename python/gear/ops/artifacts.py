"""Material requests carry content references, never user-supplied host paths."""

from __future__ import annotations

from dataclasses import dataclass
import base64
import hashlib
from typing import Any, cast

from gear.canonical import JSON

from ._json import json_object
from .base import Module
from .calls import ArtifactRef, Call, CandidateRef


def decode_artifact_pages(pages: tuple[JSON, ...], *, max_bytes: int = 64 * 1024 * 1024) -> bytes:
    """Pure assembly of complete ReadArtifact pages, including raw content verification.

    Collect pages in explicit state; this helper performs no I/O. JSON artifacts
    can then be decoded with json.loads and a typed codec such as EvidenceSet.
    """
    if not pages or any(not isinstance(page, dict) for page in pages):
        raise ValueError("material requires nonempty object pages")
    values = cast(tuple[dict[str, Any], ...], pages)
    first = values[0]
    total = first.get("total_bytes")
    if type(total) is not int or type(max_bytes) is not int or not 0 <= total <= max_bytes:
        raise ValueError("material exceeds the assembly byte budget")
    chunks: list[bytes] = []
    offset = 0
    for index, page in enumerate(values):
        if (
            any(
                page.get(key) != first.get(key)
                for key in ("ref", "path", "total_bytes", "content_digest")
            )
            or page.get("offset") != offset
            or page.get("encoding") != "base64"
            or not isinstance(page.get("content"), str)
            or (page.get("complete") is True) != (index == len(values) - 1)
            or (page.get("cursor") is None) != (index == len(values) - 1)
        ):
            raise ValueError("material pages must cover one contiguous complete snapshot")
        chunk = base64.b64decode(page["content"], validate=True)
        if base64.b64encode(chunk).decode("ascii") != page["content"]:
            raise ValueError("material page is not canonical base64")
        offset += len(chunk)
        if offset > total or (not chunk and total != 0):
            raise ValueError("material page exceeds its frozen length or makes no progress")
        chunks.append(chunk)
    content = b"".join(chunks)
    if offset != total or "sha256:" + hashlib.sha256(content).hexdigest() != first.get(
        "content_digest"
    ):
        raise ValueError("material content differs from its frozen length or digest")
    return content


def relative_path(path: str) -> str:
    if (
        not isinstance(path, str)
        or not path
        or len(path) > 4096
        or "\\" in path
        or ":" in path
        or any(part in ("", ".", "..") for part in path.split("/"))
        or any(ord(char) < 32 or ord(char) == 127 for char in path)
    ):
        raise ValueError("material paths must be bounded relative file paths")
    path.encode("utf-8", errors="strict")
    return path


@dataclass(frozen=True)
class ArtifactInput:
    ref: CandidateRef | ArtifactRef
    path: str | None = None
    cursor: str | None = None


class ReadArtifact(Module):
    def __init__(self, *, max_bytes: int = 65536):
        self.max_bytes = max_bytes

    def __call__(self, value: ArtifactInput, *, key: str) -> Call[JSON]:
        if type(self.max_bytes) is not int or not 1 <= self.max_bytes <= 1024 * 1024:
            raise ValueError("invalid material page byte limit")
        if value.path is not None:
            relative_path(value.path)
        return Call(
            key,
            self.operator_ref,
            {
                "kind": "read",
                "input": {"view": "artifact", **json_object(value), "max_bytes": self.max_bytes},
            },
        )

    def requirements(self) -> tuple[str, ...]:
        return ("artifact_read",)


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
