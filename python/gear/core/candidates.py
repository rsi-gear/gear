"""Basic callable components and operations."""

from __future__ import annotations

import base64
import binascii
import hashlib
import re
from dataclasses import dataclass
from fnmatch import fnmatchcase
from typing import Any, Literal

from gear.canonical import JSON
from gear.core._json import json_object
from gear.core.artifacts import relative_path
from gear.core.base import Module
from gear.core.calls import ArtifactRef, Call, CandidateRef, checked_digest, checked_name


def content_digest(content: bytes) -> str:
    return "sha256:" + hashlib.sha256(content).hexdigest()


@dataclass(frozen=True)
class FileContent:
    content: str
    executable: bool = False
    encoding: Literal["utf-8", "base64"] = "utf-8"

    def bytes(self) -> bytes:
        if type(self.executable) is not bool or not isinstance(self.content, str):
            raise ValueError("invalid regular file content")
        if self.encoding == "utf-8":
            return self.content.encode("utf-8", errors="strict")
        if self.encoding != "base64":
            raise ValueError("unsupported file encoding")
        try:
            decoded = base64.b64decode(self.content, validate=True)
        except (binascii.Error, ValueError) as error:
            raise ValueError("invalid base64 file") from error
        if base64.b64encode(decoded).decode() != self.content:
            raise ValueError("base64 file must have canonical encoding")
        return decoded

    @property
    def digest(self) -> str:
        return content_digest(self.bytes())


@dataclass(frozen=True)
class FileEdit:
    operation: Literal["create", "replace", "delete", "patch"]
    path: str
    expected_digest: str | None
    content: FileContent | None = None
    blob: ArtifactRef | None = None
    patch: str | None = None
    executable: bool | None = None

    def __post_init__(self) -> None:
        relative_path(self.path)
        if self.operation not in ("create", "replace", "delete", "patch"):
            raise ValueError("unsupported file edit")
        if (self.operation == "create") != (self.expected_digest is None):
            raise ValueError("create requires absent; other edits require the original digest")
        if self.expected_digest is not None:
            checked_digest(self.expected_digest)
        if self.executable is not None and type(self.executable) is not bool:
            raise ValueError("invalid executable bit")
        if self.operation in ("create", "replace"):
            if (self.content is None) == (self.blob is None) or self.patch is not None:
                raise ValueError("create/replace requires exactly one content or blob")
            if self.content is not None:
                self.content.bytes()
        elif self.operation == "patch":
            if (
                not isinstance(self.patch, str)
                or not self.patch
                or self.content is not None
                or self.blob is not None
            ):
                raise ValueError("patch requires exact unified patch text")
        elif any(
            item is not None for item in (self.content, self.blob, self.patch, self.executable)
        ):
            raise ValueError("delete cannot supply replacement content or mode")


@dataclass(frozen=True)
class EditPlan:
    edits: tuple[FileEdit, ...]

    def __post_init__(self) -> None:
        if len(self.edits) > 256:
            raise ValueError("edit plan exceeds 256 edits")
        paths = [edit.path for edit in self.edits]
        if len(set(paths)) != len(paths):
            raise ValueError("an edit plan cannot edit one path twice")
        ordered = sorted(paths)
        if any(right.startswith(left + "/") for left, right in zip(ordered, ordered[1:])):
            raise ValueError("file/directory edit paths conflict")


_HUNK = re.compile(r"@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?\n?\Z")


def exact_patch(original: str, patch: str, path: str) -> str:
    """Apply unified hunks only at their stated offsets with exact context bytes."""

    def lines_of(text: str) -> list[str]:
        parts = text.split("\n")
        return [part + "\n" for part in parts[:-1]] + ([parts[-1]] if parts[-1] else [])

    lines = lines_of(patch)
    if (
        len(lines) < 3
        or lines[0].rstrip("\n") not in ("--- " + path, "--- a/" + path)
        or lines[1].rstrip("\n") not in ("+++ " + path, "+++ b/" + path)
    ):
        raise ValueError("patch headers must name the exact edited path")
    before = lines_of(original)
    result: list[str] = []
    consumed = 0
    offset = 2
    while offset < len(lines):
        header = _HUNK.fullmatch(lines[offset])
        if header is None:
            raise ValueError("invalid unified patch hunk")
        old_start, old_count, new_start, new_count = (
            int(value) if value is not None else 1 for value in header.groups()
        )
        old_index = old_start - 1 if old_count else old_start
        new_index = new_start - 1 if new_count else new_start
        if not consumed <= old_index <= len(before):
            raise ValueError("overlapping or out-of-range patch hunk")
        result.extend(before[consumed:old_index])
        if new_index != len(result):
            raise ValueError("patch output offset mismatch")
        offset += 1
        removed: list[str] = []
        added: list[str] = []
        while offset < len(lines) and not lines[offset].startswith("@@ "):
            line = lines[offset]
            offset += 1
            if not line or line[0] not in " +-" or not line.endswith("\n"):
                raise ValueError("invalid patch line or missing newline marker")
            content = line[1:]
            if offset < len(lines) and lines[offset] == "\\ No newline at end of file\n":
                content = content[:-1]
                offset += 1
            if line[0] in " -":
                removed.append(content)
            if line[0] in " +":
                added.append(content)
        if len(removed) != old_count or len(added) != new_count:
            raise ValueError("patch hunk counts do not match its contents")
        if before[old_index : old_index + old_count] != removed:
            raise ValueError("patch context mismatch; fuzzy matching is not supported")
        result.extend(added)
        consumed = old_index + old_count
    result.extend(before[consumed:])
    return "".join(result)


@dataclass(frozen=True)
class ApplyInput:
    files: dict[str, FileContent]
    plan: EditPlan
    blobs: dict[str, FileContent] | None = None


class ApplyEdits(Module):
    def __init__(
        self, *, max_file_bytes: int = 1024 * 1024, max_total_bytes: int = 16 * 1024 * 1024
    ):
        self.max_file_bytes = max_file_bytes
        self.max_total_bytes = max_total_bytes

    def __call__(self, value: ApplyInput) -> dict[str, FileContent]:
        if any(
            type(limit) is not int or limit < 1
            for limit in (self.max_file_bytes, self.max_total_bytes)
        ):
            raise ValueError("file resource limits must be positive integers")
        files = dict(value.files)
        for path, content in files.items():
            relative_path(path)
            content.bytes()
        for edit in value.plan.edits:
            replacement: FileContent | None
            original = files.get(edit.path)
            if (original.digest if original is not None else None) != edit.expected_digest:
                raise ValueError("original content precondition failed: " + edit.path)
            if edit.operation == "delete":
                del files[edit.path]
                continue
            if edit.operation == "patch":
                if original is None or edit.patch is None:
                    raise ValueError("patch requires existing content")
                replacement = FileContent(
                    exact_patch(original.bytes().decode("utf-8"), edit.patch, edit.path),
                    original.executable,
                )
            elif edit.blob is not None:
                replacement = (value.blobs or {}).get(edit.blob.digest)
                if replacement is None or replacement.digest != edit.blob.digest:
                    raise ValueError("missing or mismatched blob content")
            else:
                replacement = edit.content
            if replacement is None:
                raise ValueError("edit has no resulting file")
            if edit.executable is not None:
                replacement = FileContent(
                    replacement.content, edit.executable, replacement.encoding
                )
            files[edit.path] = replacement
        sizes = [len(content.bytes()) for content in files.values()]
        if any(size > self.max_file_bytes for size in sizes) or sum(sizes) > self.max_total_bytes:
            raise ValueError("result exceeds file resource limits")
        paths = sorted(files)
        if any(right.startswith(left + "/") for left, right in zip(paths, paths[1:])):
            raise ValueError("result has a file/directory collision")
        return files


@dataclass(frozen=True)
class EditCheckInput:
    material: ApplyInput
    complete: bool = True


@dataclass(frozen=True)
class EditCheck:
    status: Literal["allow", "reject", "insufficient_evidence"]
    reason: str
    paths: tuple[str, ...] = ()
    changed_bytes: int = 0
    labels: JSON = None


class CheckEdits(Module):
    def __init__(
        self,
        *,
        allowed_paths: tuple[str, ...] = ("*",),
        max_files: int = 32,
        max_changed_bytes: int = 1024 * 1024,
        classifier: Any = None,
    ):
        self.allowed_paths = allowed_paths
        self.max_files = max_files
        self.max_changed_bytes = max_changed_bytes
        self.classifier = classifier

    def __call__(self, value: EditCheckInput) -> EditCheck:
        if not value.complete:
            return EditCheck("insufficient_evidence", "complete edited file material is required")
        if (
            type(self.max_files) is not int
            or self.max_files < 0
            or type(self.max_changed_bytes) is not int
            or self.max_changed_bytes < 0
        ):
            raise ValueError("invalid edit check limits")
        try:
            after = ApplyEdits()(value.material)
        except (ValueError, UnicodeError) as error:
            return EditCheck("reject", str(error))
        before = value.material.files
        paths = tuple(
            sorted(
                path for path in before.keys() | after.keys() if before.get(path) != after.get(path)
            )
        )
        size = sum(
            max(
                len(before[path].bytes()) if path in before else 0,
                len(after[path].bytes()) if path in after else 0,
            )
            for path in paths
        )
        if (
            len(paths) > self.max_files
            or size > self.max_changed_bytes
            or any(
                not any(fnmatchcase(path, pattern) for pattern in self.allowed_paths)
                for path in paths
            )
        ):
            return EditCheck(
                "reject", "edit exceeds the configured file scope or budget", paths, size
            )
        labels = self.classifier(value) if self.classifier is not None else None
        return EditCheck(
            "allow", "complete edits satisfy the configured bounds", paths, size, labels
        )


@dataclass(frozen=True)
class GenerateInput:
    base: CandidateRef
    instruction: str
    task_ids: tuple[str, ...]
    sources: tuple[CandidateRef | ArtifactRef, ...] = ()
    data: JSON = None


class GenerateCandidate(Module):
    def __init__(self, *, max_tokens: int | None = None):
        self.max_tokens = max_tokens

    def __call__(self, value: GenerateInput, *, key: str) -> Call[dict[str, JSON]]:
        if (
            not value.instruction.strip()
            or not value.task_ids
            or len(set(value.task_ids)) != len(value.task_ids)
        ):
            raise ValueError("generation requires instructions and an explicit unique task scope")
        for task in value.task_ids:
            checked_name(task)
        if self.max_tokens is not None and (
            type(self.max_tokens) is not int or self.max_tokens < 1
        ):
            raise ValueError("max_tokens must be positive")
        return Call(
            key,
            self.operator_ref,
            {
                "kind": "candidate",
                "input": {"mode": "model", **json_object(value), "max_tokens": self.max_tokens},
            },
        )

    def requirements(self) -> tuple[str, ...]:
        return ("candidate_generate", "artifact_read")


@dataclass(frozen=True)
class MaterializeInput:
    base: CandidateRef
    plan: EditPlan
    sources: tuple[CandidateRef | ArtifactRef, ...] = ()


class MaterializeCandidate(Module):
    def __call__(self, value: MaterializeInput, *, key: str) -> Call[dict[str, JSON]]:
        return Call(
            key,
            self.operator_ref,
            {"kind": "candidate", "input": {"mode": "edits", **json_object(value)}},
        )

    def requirements(self) -> tuple[str, ...]:
        return ("exact_edits", "artifact_read")


@dataclass(frozen=True)
class TargetFiles:
    """Exact files to install into a sealed effective target when a library is used.

    Store ``to_dict()`` as CommitLibraryInput.data and pass the resulting
    snapshot in ExecutionInput.assets. Mutation policy and harness checks apply.
    """

    files: dict[str, FileContent]

    def to_dict(self) -> dict[str, JSON]:
        return {"kind": "target-files-v1", "files": json_object(self.files)}
