"""Read only pinned native sources and verified Target content; never execute a provider."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import stat
from collections import Counter
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from gear.algorithms.modification_use import obj, retain_event, trial_use
from gear.canonical import digest

MAIN = "trajectory/provider/deepseek-session.jsonl"
CHILD = re.compile(r"trajectory/provider/deepseek-child-session-[1-9][0-9]*\.jsonl")
SHA = re.compile(r"sha256:[a-f0-9]{64}")
IDENTIFIER = re.compile(r"[A-Za-z0-9._:-]{1,256}")
DEFAULT_LIMITS = {
    "runs": 1024,
    "files": 16,
    "manifest_bytes": 1024 * 1024,
    "file_bytes": 32 * 1024 * 1024,
    "run_bytes": 64 * 1024 * 1024,
    "snapshot_bytes": 1024 * 1024 * 1024,
    "retained_bytes": 8 * 1024 * 1024,
    "resource_bytes": 8 * 1024 * 1024,
}


class SourceError(ValueError):
    pass


def sha(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def identity(value: os.stat_result) -> tuple[int, ...]:
    return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns


@contextmanager
def source_file(root: Path, relative: str, maximum: int) -> Iterator[Any]:
    """Open beneath an explicit root using directory FDs; no symlinks or hardlinks."""
    parts = relative.split("/")
    if not parts or any(part in ("", ".", "..") for part in parts):
        raise SourceError("source-path-invalid")
    descriptors = [os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)]
    handle = None
    try:
        for part in parts[:-1]:
            descriptors.append(
                os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptors[-1])
            )
        descriptor = os.open(
            parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptors[-1]
        )
        handle = os.fdopen(descriptor, "rb")
        before = os.fstat(handle.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > maximum:
            raise SourceError("source-file-invalid")
        yield handle
        after = os.fstat(handle.fileno())
        current = os.stat(parts[-1], dir_fd=descriptors[-1], follow_symlinks=False)
        if identity(before) != identity(after) or identity(before) != identity(current):
            raise SourceError("source-changed-during-read")
    finally:
        if handle is not None:
            handle.close()
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def skill_body(content: str, name: str) -> str | None:
    # Parsing the resource format is adapter I/O preparation, not an import-time dependency.
    import yaml

    lines = content.splitlines(keepends=True)
    if not lines or lines[0].rstrip("\r\n") != "---":
        return None
    end = next(
        (index for index, line in enumerate(lines[1:], 1) if line.rstrip("\r\n") == "---"), None
    )
    if end is None:
        return None
    try:
        metadata = yaml.safe_load("".join(lines[1:end]))
    except yaml.YAMLError:
        return None
    return "".join(lines[end + 1 :]).strip() if obj(metadata).get("name") == name else None


def changed_resources(
    root: Path, changes: list[dict[str, Any]], adapter: str, maximum: int
) -> list[dict[str, Any]]:
    output = []
    remaining = maximum
    for change in changes:
        path = change["path"]
        after = change.get("after")
        artifact: dict[str, Any] = {
            "path": path,
            "candidate_digest": after["digest"] if after else None,
            "read_paths": [path, ("/opt/gear-target/" if adapter == "dsh" else "/app/") + path],
        }
        if after:
            try:
                with source_file(root, path, remaining) as handle:
                    allowance = remaining
                    raw = handle.read(allowance + 1)
                    # Invalid bytes still consumed I/O; a bad digest must not renew the budget.
                    remaining = max(0, remaining - len(raw))
                    info = os.fstat(handle.fileno())
                    if (
                        len(raw) > allowance
                        or digest(base64.b64encode(raw).decode()) != after["digest"]
                        or bool(info.st_mode & 0o111) != after["executable"]
                    ):
                        raise SourceError("target-resource-changed")
                if b"\0" not in raw:
                    artifact["content"] = raw.decode("utf8")
            except (OSError, ValueError):
                # Content cannot be proved; exact positive/negative matches remain unknown.
                pass
        match = (
            re.fullmatch(r"skills/([a-z0-9]+(?:-[a-z0-9]+)*)/SKILL\.md", path)
            if adapter == "dsh"
            else None
        )
        if match:
            artifact["skill_name"] = match[1]
            if "content" in artifact:
                artifact["skill_body"] = skill_body(artifact["content"], match[1])
        output.append(artifact)
    return output


class NativeReader:
    def __init__(
        self, root: str, limits: dict[str, int] | None = None, budget: dict[str, int] | None = None
    ):
        self.root = Path(root).resolve(strict=True)
        self.limits = {**DEFAULT_LIMITS, **(limits or {})}
        if set(self.limits) != set(DEFAULT_LIMITS) or any(
            type(value) is not int or value <= 0 for value in self.limits.values()
        ):
            raise ValueError("invalid native reader limits")
        self.remaining = self.limits["snapshot_bytes"]
        self.runs = 0
        if budget is not None:
            maximums = {"remaining_bytes": self.remaining, "remaining_runs": self.limits["runs"]}
            if set(budget) != set(maximums) or any(
                type(value) is not int or not 0 <= value <= maximums[key]
                for key, value in budget.items()
            ):
                raise ValueError("invalid native reader budget")
            self.remaining = budget["remaining_bytes"]
            self.runs = self.limits["runs"] - budget["remaining_runs"]

    def budget(self) -> dict[str, int]:
        return {
            "remaining_bytes": self.remaining,
            "remaining_runs": self.limits["runs"] - self.runs,
        }

    def manifest(self, source: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        run_id, expected = source.get("run_id"), source.get("native_manifest_digest")
        if not isinstance(run_id, str) or not re.fullmatch(r"run_[a-f0-9]{32}", run_id):
            raise SourceError("run-id-invalid")
        if not isinstance(expected, str) or not SHA.fullmatch(expected):
            raise SourceError("native-source-not-pinned")
        with source_file(
            self.root, f"runs/{run_id}/trajectory.ref.json", self.limits["manifest_bytes"]
        ) as handle:
            raw = handle.read(self.limits["manifest_bytes"] + 1)
            if sha(raw) != expected:
                raise SourceError("trajectory-manifest-digest-mismatch")
        value = json.loads(raw)
        if (
            not isinstance(value, dict)
            or value.get("schema_version") != "2"
            or value.get("run_id") != run_id
            or value.get("provider") != "deepseek"
            or value.get("fidelity") != "provider_native"
            or not isinstance(value.get("files"), list)
        ):
            raise SourceError("native-provider-unsupported")
        session = value.get("provider_session_id")
        if not isinstance(session, str) or not IDENTIFIER.fullmatch(session):
            raise SourceError("native-session-identity-missing")
        if source.get("content_digest") is not None and not any(
            obj(file).get("role") == "canonical_session"
            and file.get("sha256") == source["content_digest"]
            for file in value["files"]
        ):
            raise SourceError("canonical-source-mismatch")
        files = [file for file in value["files"] if obj(file).get("role") == "provider_events"]
        if not 1 <= len(files) <= self.limits["files"]:
            raise SourceError("native-file-count")
        seen = set()
        for file in files:
            path, size, content_hash = file.get("path"), file.get("bytes"), file.get("sha256")
            if (
                not isinstance(path, str)
                or not (path == MAIN or CHILD.fullmatch(path))
                or path in seen
                or type(size) is not int
                or not 0 < size <= self.limits["file_bytes"]
                or not isinstance(content_hash, str)
                or not SHA.fullmatch(content_hash)
                or file.get("media_type") != "application/x-ndjson"
            ):
                raise SourceError("native-file-identity")
            seen.add(path)
        if MAIN not in seen or sum(file["bytes"] for file in files) > self.limits["run_bytes"]:
            raise SourceError("native-run-byte-limit")
        return value, sorted(files, key=lambda file: (file["path"] != MAIN, file["path"]))

    def scan(self, run_id: str, plan: dict[str, Any], retained_limit: int) -> dict[str, Any]:
        events = []
        header = None
        count = retained = 0
        previous = -1
        complete = True
        checksum = hashlib.sha256()
        with source_file(
            self.root, f"runs/{run_id}/{plan['path']}", self.limits["file_bytes"]
        ) as handle:
            if os.fstat(handle.fileno()).st_size != plan["bytes"]:
                raise SourceError("native-source-byte-count")
            while count < plan["bytes"]:
                raw = handle.readline(plan["bytes"] - count)
                if not raw:
                    break
                count += len(raw)
                if count > plan["bytes"]:
                    raise SourceError("native-source-byte-limit")
                checksum.update(raw)
                if not raw.strip():
                    continue
                value = json.loads(raw)
                if not isinstance(value, dict):
                    raise SourceError("native-event-invalid")
                if header is None:
                    if (
                        value.get("type") != "session"
                        or type(value.get("version")) is not int
                        or value["version"] not in range(5)
                    ):
                        raise SourceError("native-session-format-unsupported")
                    header = value
                    continue
                seq = value.get("seq")
                if (
                    value.get("type") == "session"
                    or not isinstance(value.get("type"), str)
                    or type(seq) is not int
                    or not previous < seq <= 9007199254740991
                ):
                    raise SourceError("native-event-sequence-invalid")
                previous = seq
                selected = retain_event(value)
                if selected is not None:
                    size = len(json.dumps(selected, ensure_ascii=False).encode())
                    if retained + size > retained_limit:
                        complete = False
                    else:
                        events.append(selected)
                        retained += size
            if count != plan["bytes"] or "sha256:" + checksum.hexdigest() != plan["sha256"]:
                raise SourceError("native-source-digest-mismatch")
        header = header or {}
        session, depth, parent = (
            header.get("id"),
            header.get("delegationDepth"),
            header.get("parentSession"),
        )
        child = plan["path"] != MAIN
        if (
            not isinstance(session, str)
            or not IDENTIFIER.fullmatch(session)
            or type(depth) is not int
            or depth < 0
            or child != (depth > 0)
            or child
            and (not isinstance(parent, str) or not IDENTIFIER.fullmatch(parent))
        ):
            raise SourceError("native-session-identity-invalid")
        return {
            "source_path": plan["path"],
            "source_digest": plan["sha256"],
            "bytes": count,
            "session_id": session,
            "delegation_depth": depth,
            "parent_session_id": parent,
            "events": events,
            "retained_bytes": retained,
            "retained_complete": complete,
        }

    def read(self, source: dict[str, Any]) -> dict[str, Any]:
        info: dict[str, Any] = {
            "kind": "dsh-native-events",
            "trajectory_manifest_digest": source.get("native_manifest_digest"),
            "listed_files": 0,
            "verified_files": 0,
            "verified_bytes": 0,
            "main_session_files": 0,
            "child_session_files": 0,
            "coverage": "unavailable",
            "files": [],
        }
        try:
            if self.runs >= self.limits["runs"]:
                raise SourceError("snapshot-run-limit")
            self.runs += 1
            manifest, plans = self.manifest(source)
            info.update(
                listed_files=len(plans), main_session_files=1, child_session_files=len(plans) - 1
            )
            required = sum(file["bytes"] for file in plans)
            if required > self.remaining:
                raise SourceError("snapshot-byte-limit")
            self.remaining -= required
            files, failures = [], []
            retained = self.limits["retained_bytes"]
            for plan in plans:
                try:
                    file = self.scan(source["run_id"], plan, retained)
                    retained -= file["retained_bytes"]
                    files.append(file)
                except (OSError, ValueError) as error:
                    failures.append(
                        str(error)
                        if isinstance(error, SourceError)
                        else "native-source-unavailable"
                    )
            main = next((file for file in files if file["source_path"] == MAIN), None)
            if main is None or main["session_id"] != manifest["provider_session_id"]:
                raise SourceError(failures[0] if failures else "native-main-session-mismatch")
            counts = Counter(file["session_id"] for file in files)
            if counts[main["session_id"]] != 1:
                raise SourceError("native-duplicate-session")
            trusted = {main["session_id"]: main}
            while True:
                previous = len(trusted)
                for file in files:
                    parent = trusted.get(file["parent_session_id"])
                    if (
                        counts[file["session_id"]] == 1
                        and parent
                        and file["delegation_depth"] == parent["delegation_depth"] + 1
                    ):
                        trusted[file["session_id"]] = file
                if len(trusted) == previous:
                    break
            selected = sorted(trusted.values(), key=lambda file: file["source_path"])
            if len(selected) != len(files):
                failures.append("native-child-identity-invalid")
            if any(not file["retained_complete"] for file in selected):
                failures.append("native-retained-byte-limit")
            # Recheck the pinned manifest after reading every file; changing the set invalidates it.
            self.manifest(source)
            info.update(
                files=selected,
                verified_files=len(selected),
                verified_bytes=sum(file["bytes"] for file in selected),
                coverage="partial" if failures else "listed-files-complete",
            )
            if failures:
                info["reason"] = failures[0]
        except (OSError, ValueError) as error:
            info["reason"] = (
                str(error) if isinstance(error, SourceError) else "native-source-unavailable"
            )
        return info


def observe(input: dict[str, Any]) -> dict[str, Any]:
    artifacts = changed_resources(
        Path(input["target_root"]).resolve(strict=True),
        input["changes"],
        input["adapter"],
        DEFAULT_LIMITS["resource_bytes"],
    )
    reader = NativeReader(input["root"], budget=input.get("budget"))
    trials = []
    for trial in input["trials"]:
        trace = reader.read(trial["source"])
        use = trial_use(artifacts, trace)
        trials.append(
            {
                "task_id": trial["task_id"],
                "repetition": trial["repetition"],
                "source_ref": trial["source_ref"],
                **use,
            }
        )
    return {
        "trials": trials,
        "budget": reader.budget(),
        "resources_complete": all(
            artifact["candidate_digest"] is None or "content" in artifact for artifact in artifacts
        ),
    }
