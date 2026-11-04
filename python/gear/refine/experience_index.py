"""Pure validation of the immutable indexed experience format; no filesystem policy."""

from __future__ import annotations

import re
from typing import Any

from gear.canonical import digest

VIEWS = ("task-results", "diff", "trajectory", "modification-use", "verifier")
MAX_ITEM_BYTES = 61 * 1024
MAX_FILES = 100_000


def valid_digest(value: Any) -> bool:
    return isinstance(value, str) and re.fullmatch(r"sha256:[a-f0-9]{64}", value) is not None


def checked_digest(value: dict[str, Any], expected: str | None = None) -> None:
    actual = value["digest"]
    if (
        not valid_digest(actual)
        or (expected is not None and actual != expected)
        or digest({key: item for key, item in value.items() if key != "digest"}) != actual
    ):
        raise ValueError("experience identity mismatch")


def summary_body(record: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in record.items()
        if key not in ("summary_digest", "descriptor_digest")
    }


def verify_record(record: dict[str, Any], run_id: str | None = None) -> None:
    if record["version"] == 2:
        # Preserve the historical v2 shape; stricter metadata requirements belong to v3.
        checked_digest(record)
        source = record.get("source")
        if (
            record["scope"]["partition"] != "seed"
            or record["candidate"]["parent_id"] != record["parent"]["id"]
            or (
                run_id is not None
                and isinstance(source, dict)
                and "run_id" in source
                and source["run_id"] != run_id
            )
        ):
            raise ValueError("experience seed scope or lineage mismatch")
        return
    scope = record["scope"]
    if (
        record["version"] != 3
        or scope["partition"] != "seed"
        or not isinstance(scope["task_ids"], list)
        or not scope["task_ids"]
        or any(not isinstance(task, str) or not task for task in scope["task_ids"])
        or len(set(scope["task_ids"])) != len(scope["task_ids"])
        or type(scope["repetitions"]) is not int
        or scope["repetitions"] < 1
        or not isinstance(record["candidate"]["id"], str)
        or not isinstance(record["parent"]["id"], str)
        or record["candidate"]["parent_id"] != record["parent"]["id"]
        or not valid_digest(record["candidate"]["digest"])
        or not valid_digest(record["parent"]["digest"])
        or not isinstance(record["source"], dict)
        or not isinstance(record["source"].get("run_id"), str)
        or (run_id is not None and record["source"].get("run_id") != run_id)
        or not isinstance(record["proposal"]["rationale"], str)
        or not isinstance(record["proposal"]["hypothesis"], str)
        or not isinstance(record["proposal"]["semantic_targets"], list)
        or any(not isinstance(item, str) for item in record["proposal"]["semantic_targets"])
        or not isinstance(record["change"]["files"], list)
        or any(not isinstance(item["path"], str) for item in record["change"]["files"])
        or not isinstance(record["modification_use"]["summary"], dict)
        or not isinstance(record["classification"], dict)
    ):
        raise ValueError("experience seed scope or lineage mismatch")
    if (
        not valid_digest(record["digest"])
        or not valid_digest(record["descriptor_digest"])
        or digest(summary_body(record)) != record["summary_digest"]
    ):
        raise ValueError("experience record identity mismatch")


def verify_snapshot(snapshot: dict[str, Any]) -> None:
    checked_digest(snapshot)
    records = snapshot["records"]
    if (
        snapshot["version"] not in (2, 3)
        or (
            snapshot["version"] == 3
            and (
                not isinstance(snapshot.get("run_id"), str)
                or not valid_digest(snapshot.get("source_archive_digest"))
                or not isinstance(snapshot.get("implementation_identity"), str)
            )
        )
        or not isinstance(records, list)
        or len(records) > 4096
        or len({record["candidate"]["id"] for record in records}) != len(records)
    ):
        raise ValueError("experience snapshot identity mismatch")
    for record in records:
        if record["version"] != snapshot["version"]:
            raise ValueError("experience record encoding mismatch")
        verify_record(record, snapshot.get("run_id"))


def evidence_owner(record: dict[str, Any]) -> dict[str, Any]:
    return {
        key: record["source"].get(key)
        for key in (
            "run_id",
            "benchmark_digest",
            "evaluation_identity",
            "objective_identity",
            "objective_digest",
        )
    }


def detail_owner(record: dict[str, Any], view: str) -> dict[str, Any]:
    return {
        "run_id": record["source"]["run_id"],
        "record_digest": record["digest"],
        "summary_digest": record["summary_digest"],
        "view": view,
    }


def verify_descriptor(value: dict[str, Any], record: dict[str, Any]) -> None:
    checked_digest(value, record["descriptor_digest"])
    if (
        value["version"] != 3
        or value["kind"] != "record"
        or value["record_digest"] != record["digest"]
        or value["summary_digest"] != record["summary_digest"]
        or value["owner"] != evidence_owner(record)
        or not isinstance(value["metadata"]["change"], dict)
        or not isinstance(value["metadata"]["modification_use"], dict)
        or value["metadata"]["modification_use"]["summary"] != record["modification_use"]["summary"]
        or set(value["views"]) != set(VIEWS)
        or value["trajectory_availability"] not in ("available", "unavailable", "not_captured")
    ):
        raise ValueError("experience descriptor identity mismatch")
    files = 0
    for refs in value["views"].values():
        if not isinstance(refs, list):
            raise ValueError("invalid experience view references")
        for ref in refs:
            if (
                not valid_digest(ref["digest"])
                or type(ref["count"]) is not int
                or ref["count"] < 1
                or ref["count"] > MAX_FILES
            ):
                raise ValueError("invalid experience chunk reference")
            files += 1
    if files > MAX_FILES:
        raise ValueError("experience descriptor exceeds its file bound")


def verify_chunk(
    value: dict[str, Any], ref: dict[str, Any], record: dict[str, Any], view: str
) -> None:
    checked_digest(value, ref["digest"])
    if (
        value["version"] != 3
        or value["kind"] != "items"
        or value["view"] != view
        or not isinstance(value["items"], list)
        or len(value["items"]) != ref["count"]
        or not value["items"]
    ):
        raise ValueError("experience chunk identity mismatch")
    for item in value["items"]:
        # The canonical encoding can be larger than JSON for numbers; the file gateway also
        # enforces the exact JSON byte bound before passing items to the read policy.
        if view == "diff":
            if item["path"] not in {file["path"] for file in record["change"]["files"]}:
                raise ValueError("experience diff is outside the record")
            continue
        if item["task_id"] not in record["scope"]["task_ids"]:
            raise ValueError("experience item is outside the seed scope")
        if view != "task-results" and (
            (
                view != "modification-use"
                and item["candidate_id"] not in (record["candidate"]["id"], record["parent"]["id"])
            )
            or type(item["repetition"]) is not int
            or not 0 <= item["repetition"] < record["scope"]["repetitions"]
        ):
            raise ValueError("experience item ownership mismatch")
        if view == "trajectory" and (
            re.fullmatch(r"trajectory:[a-f0-9]{64}", item["ref"]) is None
            or item["status"] not in ("available", "unavailable")
        ):
            raise ValueError("invalid trajectory reference")
    first = value["items"][0]
    owner = (
        {
            **evidence_owner(record),
            **{key: first[key] for key in ("candidate_id", "task_id", "repetition")},
        }
        if view == "verifier"
        else detail_owner(record, view)
    )
    if (view == "verifier" and ref["count"] != 1) or value["owner"] != owner:
        raise ValueError("experience chunk ownership mismatch")
