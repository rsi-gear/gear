"""Pure seed experience records, deterministic retrieval and bounded read views."""

from __future__ import annotations

import base64
import json
import re
from typing import Any

from gear.canonical import digest

from .experience_index import VIEWS, verify_descriptor, verify_record
from .modification_use import modification_observations
from .projection import compare_candidates, project_candidate
from .verifier import unavailable

MAX_CARD_BYTES = 2048
MAX_CONTEXT_BYTES = 12 * 1024
MAX_PAGE_BYTES = 64 * 1024
EFFECTS = {"improved", "regressed", "mixed", "unchanged", "incomparable"}


def encoded_size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def text(value: str, size: int) -> str:
    raw = value.encode("utf-8")
    if len(raw) <= size:
        return value
    return raw[: max(0, size - 3)].decode("utf-8", errors="ignore") + "…"


def descriptive(value: Any) -> Any:
    """Retain projected facts without exposing provider artifact locators or raw reasons."""
    if isinstance(value, list):
        return [descriptive(item) for item in value]
    if isinstance(value, dict):
        result = {
            key: descriptive(item)
            for key, item in value.items()
            if key not in ("evidenceRefs", "reason")
        }
        if "evidenceRefs" in value:
            result["evidence_ref_digests"] = [digest(item) for item in value["evidenceRefs"]]
        return result
    return value


def experience_record(input: dict[str, Any]) -> dict[str, Any]:
    """Pair against the actual code parent on an explicit, admitted seed scope."""
    candidate, parent = input["candidate"], input["parent"]
    if candidate["parent_id"] != parent["id"]:
        raise ValueError("experience must compare the actual generation parent")
    tasks = input["task_ids"]
    if not tasks or len(set(tasks)) != len(tasks):
        raise ValueError("experience requires distinct seed tasks")
    if any(
        cell["task_id"] not in tasks or cell["candidate_id"] not in (parent["id"], candidate["id"])
        for cell in input["evidence"]
    ):
        raise ValueError("experience evidence is outside the paired seed scope")
    request = {
        "candidate_id": candidate["id"],
        "anchor_id": parent["id"],
        "repetitions": input["repetitions"],
        "objective": input["objective"],
        "evidence": input["evidence"],
        "partition": "seed",
    }
    rows = []
    for task in sorted(tasks):
        local = {**request, "task_ids": [task], "weights": {task: 1}}
        before = descriptive(project_candidate({**local, "candidate_id": parent["id"]}))
        after = descriptive(project_candidate(local))
        comparison = compare_candidates(local)
        rows.append({"task_id": task, "parent": before, "candidate": after, **comparison})
    gains = sum(row["gain"] is not None and row["gain"] > 0 for row in rows)
    losses = sum(row["gain"] is not None and row["gain"] < 0 for row in rows)
    equal = sum(row["gain"] == 0 for row in rows)
    complete = gains + losses + equal == len(tasks)
    effect = (
        "mixed"
        if gains and losses
        else "improved"
        if gains
        else "regressed"
        if losses
        else "unchanged"
        if equal
        else "incomparable"
    )
    use = modification_observations(
        {
            **input,
            "candidate_id": candidate["id"],
            "parent_id": parent["id"],
            "changes": input["change"]["files"],
            "trials": input.get("modification_trials", []),
        }
    )
    for row in rows:
        local_trials = [trial for trial in use["trials"] if trial["task_id"] == row["task_id"]]
        row["modification_use"] = {
            "status_counts": {
                status: sum(trial["status"] == status for trial in local_trials)
                for status in use["summary"]["status_counts"]
            },
            "observed_trials": len(local_trials),
            "expected_trials": input["repetitions"],
        }
    body = {
        "version": 2,
        "source": input["source"],
        "candidate": candidate,
        "parent": parent,
        "scope": {
            "partition": "seed",
            "task_ids": sorted(tasks),
            "repetitions": input["repetitions"],
        },
        "proposal": input["proposal"],
        "change": input["change"],
        "classification": {
            "effect": effect,
            "complete": complete,
            "improved_tasks": gains,
            "regressed_tasks": losses,
            "unchanged_tasks": equal,
            "unavailable_tasks": len(tasks) - gains - losses - equal,
            "constraints_passed": complete and all(row["constraints_passed"] for row in rows),
        },
        "task_results": rows,
        "modification_use": use,
        "verifier_trials": [
            {
                "candidate_id": cell["candidate_id"],
                "task_id": cell["task_id"],
                "repetition": cell["repetition"],
                "observation": cell.get("verifier")
                or unavailable("unavailable", "verifier-not-captured"),
            }
            for cell in sorted(
                input["evidence"],
                key=lambda cell: (cell["candidate_id"], cell["task_id"], cell["repetition"]),
            )
        ],
        "trajectory_refs": input.get("trajectory_refs", []),
    }
    return {**body, "digest": digest(body)}


def _records(input: dict[str, Any]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = input["records"]
    if len(records) > 4096:
        raise ValueError("experience snapshot exceeds 4096 records")
    for record in records:
        verify_record(record)
    return records


def card(record: dict[str, Any], reasons: list[str]) -> dict[str, Any]:
    paths = [item["path"] for item in record["change"]["files"]]
    classification = record["classification"]
    description = (
        f"{record['parent']['id']} → {record['candidate']['id']}: {classification['effect']}; "
        f"{classification['improved_tasks']} improved, {classification['regressed_tasks']} regressed, "
        f"{classification['unchanged_tasks']} unchanged, {classification['unavailable_tasks']} unavailable tasks. "
        "Historical seed observations are descriptive; they do not replace the current evidence gate."
    )
    value: dict[str, Any] = {
        "ref": "experience:" + record["digest"][7:],
        "candidate_id": record["candidate"]["id"],
        "parent_id": record["parent"]["id"],
        "classification": classification,
        "modification_use": record["modification_use"]["summary"]["status_counts"],
        "paths": paths[:5],
        "omitted_paths": max(0, len(paths) - 5),
        "description": text(description, 650),
        "hypothesis": text(record["proposal"].get("hypothesis", ""), 320),
        "rationale": text(record["proposal"].get("rationale", ""), 240),
        "match_reasons": [text(reason, 120) for reason in reasons[:5]],
    }
    while encoded_size(value) > MAX_CARD_BYTES:
        if value["paths"]:
            value["paths"].pop()
            value["omitted_paths"] += 1
        elif value["match_reasons"]:
            value["match_reasons"].pop()
        elif encoded_size(value["description"]) > 165:
            value["description"] = text(value["description"], 160)
        elif value["rationale"]:
            value["rationale"] = ""
        elif value["hypothesis"]:
            value["hypothesis"] = ""
        else:
            raise ValueError("experience identity exceeds the card budget")
    return value


def _query(value: dict[str, Any]) -> dict[str, Any]:
    allowed = {"query", "task_ids", "semantic_targets", "paths", "effects"}
    if set(value) - allowed:
        raise ValueError("unknown experience query field")
    query = value.get("query", "")
    if not isinstance(query, str) or len(query) > 1024:
        raise ValueError("experience query must be at most 1024 characters")
    result: dict[str, Any] = {"query": query.casefold().strip()}
    for key in sorted(allowed - {"query"}):
        items = value.get(key, [])
        if (
            not isinstance(items, list)
            or len(items) > 50
            or any(not isinstance(item, str) or not item or len(item) > 4096 for item in items)
        ):
            raise ValueError("experience query filters require at most 50 bounded strings")
        result[key] = sorted({item.casefold() for item in items})
    if set(result["effects"]) - EFFECTS:
        raise ValueError("unknown experience effect")
    return result


def _rank(
    records: list[dict[str, Any]],
    query: dict[str, Any],
    parent_id: str | None,
) -> list[tuple[int, dict[str, Any], list[str]]]:
    terms = sorted(set(re.findall(r"\w+", query["query"])))
    ranked = []
    for record in records:
        fields = {
            "task_ids": [item.casefold() for item in record["scope"]["task_ids"]],
            "paths": [item["path"].casefold() for item in record["change"]["files"]],
            "semantic_targets": [
                item.casefold() for item in record["proposal"].get("semantic_targets", [])
            ],
            "effects": [record["classification"]["effect"]],
        }
        if any(query[key] and not set(query[key]).intersection(fields[key]) for key in fields):
            continue
        reasons, score = [], 0
        for term in terms:
            for content, weight, label in (
                (" ".join(fields["task_ids"]), 6, "task"),
                (" ".join(fields["semantic_targets"]), 5, "semantic target"),
                (" ".join(fields["paths"]), 4, "path"),
                (record["proposal"].get("hypothesis", "").casefold(), 2, "hypothesis"),
                (record["proposal"].get("rationale", "").casefold(), 1, "rationale"),
            ):
                if term in content:
                    score += weight
                    reasons.append(f"{label}: {term}")
                    break
        if terms and not score:
            continue
        for key, weight in (("task_ids", 6), ("semantic_targets", 5), ("paths", 4), ("effects", 2)):
            if query[key]:
                score += weight
                reasons.append(key + " filter")
        if record["candidate"]["id"] == parent_id:
            score += 3
            reasons.append("direct lineage parent")
        if record["classification"]["effect"] in ("mixed", "regressed"):
            score += 1
        ranked.append((score, record, sorted(set(reasons))))
    return sorted(
        ranked, key=lambda item: (-item[0], item[1]["candidate"]["id"], item[1]["digest"])
    )


def _offset(cursor: Any, binding: dict[str, Any], size: int) -> int:
    if cursor is None:
        return 0
    if not isinstance(cursor, str) or len(cursor) > 4096:
        raise ValueError("invalid experience cursor")
    try:
        value = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
    except (ValueError, UnicodeError) as error:
        raise ValueError("invalid experience cursor") from error
    if not isinstance(value, dict) or set(value) != {"binding", "offset"}:
        raise ValueError("invalid experience cursor")
    offset = value["offset"]
    if value["binding"] != digest(binding) or type(offset) is not int or not 0 <= offset <= size:
        raise ValueError("experience cursor belongs to a different snapshot or query")
    return offset


def _page(
    items: list[Any],
    input: dict[str, Any],
    binding: dict[str, Any],
    maximum: int,
    reserved_bytes: int = 0,
    window_start: int = 0,
    total: int | None = None,
) -> dict[str, Any]:
    limit = input.get("limit", min(maximum, 20))
    if type(limit) is not int or not 1 <= limit <= maximum:
        raise ValueError(f"experience limit must be between 1 and {maximum}")
    size = len(items) if total is None else total
    start = _offset(input.get("cursor"), binding, size)
    if window_start != 0 and start != window_start:
        raise ValueError("experience read window does not match its cursor")
    result: list[Any] = []
    for item in items[start - window_start : start - window_start + limit]:
        if encoded_size(result + [item]) > MAX_PAGE_BYTES - 1024 - reserved_bytes:
            if not result:
                raise ValueError("experience item exceeds the bounded read size")
            break
        result.append(item)
    offset = start + len(result)
    cursor = None
    if offset < size:
        value = {"binding": digest(binding), "offset": offset}
        cursor = (
            base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode())
            .decode()
            .rstrip("=")
        )
    return {"items": result, "next_cursor": cursor, "total": size}


def experience_query(input: dict[str, Any]) -> dict[str, Any]:
    records, query = _records(input), _query(input.get("query", {}))
    parent = input.get("parent_id")
    binding = {"snapshot": input["snapshot_digest"], "query": query, "parent_id": parent}
    items = [
        {"score": score, "card": card(record, reasons)}
        for score, record, reasons in _rank(records, query, parent)
    ]
    return {
        "snapshot_digest": input["snapshot_digest"],
        "query_digest": digest(binding),
        **_page(items, input, binding, 10),
    }


def experience_context(input: dict[str, Any]) -> dict[str, Any]:
    records, parent = _records(input), input["parent_id"]
    direct = next((record for record in records if record["candidate"]["id"] == parent), None)
    failed = set(
        {
            cell["task_id"]
            for cell in input["evidence"]
            if cell["score"] != 1 or cell["status"] not in ("valid", "task_failed")
        }
    )
    cards = [card(direct, ["actual direct parent edit outcome"])] if direct else []
    focus = set(input.get("semantic_targets", []))
    ranked = []
    for record in records:
        if record is direct:
            continue
        matches = sorted(failed.intersection(record["scope"]["task_ids"]))
        targets = sorted(focus.intersection(record["proposal"].get("semantic_targets", [])))
        if not matches and not targets:
            continue
        score = len(matches) * 6 + len(targets) * 5
        if record["classification"]["effect"] in ("mixed", "regressed"):
            score += 1
        reasons = ["current failed task: " + task for task in matches]
        reasons += ["semantic target: " + target for target in targets]
        ranked.append((score, record, reasons))
    for _, record, reasons in sorted(
        ranked, key=lambda item: (-item[0], item[1]["candidate"]["id"], item[1]["digest"])
    )[: 3 - len(cards)]:
        cards.append(card(record, reasons))
    result = {
        "version": 2,
        "snapshot_digest": input["snapshot_digest"],
        "available_records": len(records),
        "cards": cards,
    }
    if encoded_size(result) > MAX_CONTEXT_BYTES:
        raise ValueError("experience context exceeds its fixed byte budget")
    return result


def experience_read(input: dict[str, Any]) -> dict[str, Any]:
    records = _records(input)
    record = next(
        (record for record in records if "experience:" + record["digest"][7:] == input["ref"]), None
    )
    if record is None:
        raise ValueError("experience ref is outside the frozen snapshot")
    view = input.get("view", "card")
    if record["version"] == 3:
        return _indexed_read(input, record)
    if view == "card":
        items = [card(record, [])]
    elif view == "task-results":
        items = record["task_results"]
    elif view == "modification-use":
        items = record["modification_use"]["trials"]
    elif view == "verifier":
        items = record["verifier_trials"]
    elif view == "trajectory":
        items = record["trajectory_refs"]
    elif view == "diff":
        items = []
        for change in record["change"]["files"]:
            metadata = {key: value for key, value in change.items() if key != "patch"}
            patch = change.get("patch")
            if not patch:
                items.append({**metadata, "patch": patch, "part": 0, "parts": 1})
                continue
            raw, chunks, start = patch.encode("utf-8"), [], 0
            while start < len(raw):
                end = min(start + 8192, len(raw))
                while end < len(raw) and raw[end] & 0xC0 == 0x80:
                    end -= 1
                chunks.append(raw[start:end].decode("utf-8"))
                start = end
            items.extend(
                {**metadata, "patch": chunk, "part": part, "parts": len(chunks)}
                for part, chunk in enumerate(chunks)
            )
    else:
        raise ValueError("unknown experience read view")
    binding = {"snapshot": input["snapshot_digest"], "record": record["digest"], "view": view}
    summary = (
        {"summary": record["modification_use"]["summary"]} if view == "modification-use" else {}
    )
    return {
        "snapshot_digest": input["snapshot_digest"],
        "ref": input["ref"],
        "view": view,
        **summary,
        **(
            {
                "availability": "available"
                if any(item["status"] == "available" for item in items)
                else "unavailable"
                if items
                else "not_captured"
            }
            if view == "trajectory"
            else {}
        ),
        **_page(items, input, binding, 50, encoded_size(summary)),
    }


def experience_read_plan(input: dict[str, Any]) -> dict[str, Any]:
    """Validate pagination before the I/O owner opens only the requested detail window."""
    record = next(
        (item for item in _records(input) if "experience:" + item["digest"][7:] == input["ref"]),
        None,
    )
    if record is None:
        raise ValueError("experience ref is outside the frozen snapshot")
    view = input.get("view", "card")
    if record["version"] != 3 or view not in ("card", *VIEWS):
        raise ValueError("unknown experience read view or encoding")
    limit = input.get("limit", 20)
    if type(limit) is not int or not 1 <= limit <= 50:
        raise ValueError("experience limit must be between 1 and 50")
    metadata: dict[str, Any] = {}
    if view == "card":
        total = 1
    else:
        descriptor = input["descriptor"]
        verify_descriptor(descriptor, record)
        total = sum(ref["count"] for ref in descriptor["views"][view])
        if view == "modification-use":
            metadata["summary"] = record["modification_use"]["summary"]
        if view == "trajectory":
            metadata["availability"] = descriptor["trajectory_availability"]
    binding = {"snapshot": input["snapshot_digest"], "record": record["digest"], "view": view}
    return {
        "start": _offset(input.get("cursor"), binding, total),
        "limit": limit,
        "total": total,
        "binding": binding,
        "metadata": metadata,
    }


def _indexed_read(input: dict[str, Any], record: dict[str, Any]) -> dict[str, Any]:
    plan = experience_read_plan(input)
    view = input.get("view", "card")
    items = (
        [card(record, [])][plan["start"] : plan["start"] + plan["limit"]]
        if view == "card"
        else input["page_items"]
    )
    if not isinstance(items, list) or len(items) != min(
        plan["limit"], plan["total"] - plan["start"]
    ):
        raise ValueError("experience detail window is incomplete")
    return {
        "snapshot_digest": input["snapshot_digest"],
        "ref": input["ref"],
        "view": view,
        **plan["metadata"],
        **_page(
            items,
            input,
            plan["binding"],
            50,
            encoded_size({"summary": plan["metadata"]["summary"]})
            if "summary" in plan["metadata"]
            else 0,
            window_start=plan["start"],
            total=plan["total"],
        ),
    }
