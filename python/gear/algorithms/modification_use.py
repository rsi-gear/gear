"""Pure exact evidence matching for changed resources; absence requires complete sources.

These observations describe recorded reads/injections. They do not prove execution of a
changed branch or that a change caused an evaluation outcome.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from typing import Any

from gear.canonical import digest

VERSION = "gear-modification-use-v2"
STATUSES = ("observed", "attempted-failure", "not-observed", "unknown")
MAX_ACTIONS = 4
MAX_TRIAL_ACTIONS = 16
TOOLS = {"skill", "read", "read_file", "fs.read"}


def obj(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def texts(value: Any, depth: int = 0) -> list[str]:
    if depth > 12:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        # Text blocks may carry metadata; metadata is not visible resource content.
        text = value.get("text")
        return [text] if value.get("type", "text") == "text" and isinstance(text, str) else []
    values = value if isinstance(value, list) else []
    return [text for child in values for text in texts(child, depth + 1)]


def skill_content_body(value: str, name: str) -> str | None:
    escaped = name.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;")
    prefix = f'<skill_content name="{escaped}">\n<skill_resources>\n'
    end, suffix = "\n</skill_resources>", "\n</skill_instructions>\n</skill_content>"
    if not value.startswith(prefix) or not value.endswith(suffix):
        return None
    position = value.find(end, len(prefix))
    if position < 0:
        return None
    position += len(end)
    instructions = re.match(r"(?:\r?\n)+<skill_instructions>\r?\n", value[position:])
    return None if instructions is None else value[position + instructions.end() : -len(suffix)]


def tool_result(event: dict[str, Any]) -> tuple[str, Any, bool] | None:
    if event.get("type") != "tool/result":
        return None
    message = obj(obj(event.get("data")).get("message"))
    source = obj(message.get("source"))
    call_id = source.get("callId")
    if source.get("kind") != "tool" or not isinstance(call_id, str):
        return None
    content = message.get("content")
    if not isinstance(content, list):
        return None
    # Format v1+ flattens the tool-result block into the tool message.
    if message.get("role") == "tool" and message.get("toolCallId") == call_id:
        return call_id, content, message.get("isError") is True
    blocks = [
        block
        for block in content
        if obj(block).get("type") == "tool-result" and block.get("toolCallId") == call_id
    ]
    if len(blocks) != 1:
        return None
    return call_id, blocks[0].get("content"), blocks[0].get("isError") is True


def retain_event(event: dict[str, Any]) -> dict[str, Any] | None:
    """Bounded reader keeps only inputs that this matcher can interpret."""
    data = obj(event.get("data"))
    kind = event["type"]
    if kind == "tool/call":
        if isinstance(data.get("name"), str) and data["name"] in TOOLS:
            return event
        # Retain other call identities to detect duplicates across tool names.
        return {"type": kind, "seq": event["seq"], "data": {"callId": data.get("callId")}}
    if kind == "tool/result":
        source = obj(obj(data.get("message")).get("source"))
        # A result preceding its call can still make a later pair ambiguous.
        return (
            event
            if source.get("kind") == "tool" and isinstance(source.get("callId"), str)
            else None
        )
    if kind == "user/message" and obj(data.get("source")).get("kind") == "skill-invocation":
        return event
    if kind == "request/header" and "system" in obj(data.get("header")):
        return {
            "type": kind,
            "seq": event["seq"],
            "data": {"header": {"system": data["header"]["system"]}},
        }
    if (
        kind == "system/message"
        and obj(obj(data.get("message")).get("source")).get("kind") == "system-prompt"
    ):
        return event
    return None


def overall(artifacts: list[dict[str, Any]]) -> str:
    return next(
        (
            status
            for status in ("observed", "attempted-failure", "unknown")
            if any(item["status"] == status for item in artifacts)
        ),
        "not-observed" if artifacts else "unknown",
    )


def trial_use(artifacts: list[dict[str, Any]], trace: dict[str, Any]) -> dict[str, Any]:
    files = trace.get("files", [])
    results = []
    remaining = MAX_TRIAL_ACTIONS
    indexed = []
    for file in files:
        if file.get("retained_complete") is False:
            # A dropped duplicate could invalidate an otherwise successful pair.
            continue
        calls = Counter(
            obj(event.get("data")).get("callId")
            for event in file["events"]
            if event["type"] == "tool/call"
            and isinstance(obj(event.get("data")).get("callId"), str)
        )
        pairs: dict[str, list[tuple[dict[str, Any], Any, bool]]] = {}
        result_counts: Counter[str] = Counter()
        for event in file["events"]:
            source = obj(obj(obj(event.get("data")).get("message")).get("source"))
            if (
                event["type"] == "tool/result"
                and source.get("kind") == "tool"
                and isinstance(source.get("callId"), str)
            ):
                result_counts[source["callId"]] += 1
            parsed = tool_result(event)
            if parsed is not None:
                pairs.setdefault(parsed[0], []).append((event, parsed[1], parsed[2]))
        indexed.append((file, calls, pairs, result_counts))
    for artifact in artifacts:
        actions: list[dict[str, Any]] = []
        observed = failed = 0
        uncertain = False
        name, body, content = (
            artifact.get("skill_name"),
            artifact.get("skill_body"),
            artifact.get("content"),
        )
        for file, calls, pairs, result_counts in indexed:

            def action(
                event: dict[str, Any], outcome: str, match: str, result_seq: int | None = None
            ) -> None:
                nonlocal observed, failed
                observed += int(outcome == "completed")
                failed += int(outcome == "errored")
                if len(actions) >= MAX_ACTIONS:
                    return
                data = obj(event.get("data"))
                actions.append(
                    {
                        "action": "read" if event["type"] == "tool/call" else "injected",
                        "outcome": outcome,
                        "match": match,
                        "source_path": file["source_path"],
                        "source_digest": file["source_digest"],
                        "session_id": file["session_id"],
                        "delegation_depth": file["delegation_depth"],
                        "call_seq": event["seq"],
                        **({"result_seq": result_seq} if result_seq is not None else {}),
                        **(
                            {"call_id_digest": digest(data["callId"]), "tool_name": data["name"]}
                            if event["type"] == "tool/call"
                            and isinstance(obj(event.get("data")).get("callId"), str)
                            else {}
                        ),
                    }
                )

            for event in file["events"]:
                data, kind = obj(event.get("data")), event["type"]
                if (
                    kind == "request/header"
                    and bool(content)
                    and content in texts(obj(data.get("header")).get("system"))
                ):
                    action(event, "completed", "artifact-content")
                elif (
                    kind == "system/message"
                    and obj(obj(data.get("message")).get("source")).get("kind") == "system-prompt"
                    and bool(content)
                    and content in texts(obj(data.get("message")).get("content"))
                ):
                    action(event, "completed", "artifact-content")
                elif (
                    kind == "user/message"
                    and name
                    and body is not None
                    and obj(data.get("source")).get("kind") == "skill-invocation"
                    and obj(data.get("source")).get("name") == name
                ):
                    if any(
                        skill_content_body(value, name) == body
                        for value in texts(data.get("content"))
                    ):
                        action(event, "completed", "skill-name-and-body")
                if kind != "tool/call":
                    continue
                args = data.get("arguments")
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except ValueError:
                        args = None
                args = obj(args)
                skill = bool(name and data.get("name") == "skill" and args.get("name") == name)
                read = data.get("name") in ("read", "read_file", "fs.read") and any(
                    args.get(key) in artifact.get("read_paths", [artifact["path"]])
                    for key in ("path", "filePath", "file_path")
                )
                if not skill and not read:
                    continue
                call_id = data.get("callId")
                if not isinstance(call_id, str):
                    uncertain = True
                    continue
                matches = pairs.get(call_id, [])
                # Duplicate IDs cannot unambiguously bind one source/result pair.
                if (
                    calls[call_id] != 1
                    or result_counts[call_id] != 1
                    or len(matches) != 1
                    or matches[0][0]["seq"] <= event["seq"]
                ):
                    uncertain = True
                    continue
                result, value, errored = matches[0]
                if errored:
                    action(
                        event,
                        "errored",
                        "skill-name-attempt" if skill else "artifact-path-attempt",
                        result["seq"],
                    )
                elif (
                    any(skill_content_body(text, name) == body for text in texts(value))
                    if skill and body is not None and isinstance(name, str)
                    else not skill and content is not None and content in texts(value)
                ):
                    action(
                        event,
                        "completed",
                        "skill-name-and-body" if skill else "artifact-path-and-content",
                        result["seq"],
                    )
                else:
                    uncertain = True
        removed = artifact.get("candidate_digest") is None
        negative = (
            trace.get("coverage") == "listed-files-complete"
            and name
            and body is not None
            and not removed
        )
        status = (
            "observed"
            if observed
            else "attempted-failure"
            if failed
            else "unknown"
            if uncertain or not negative
            else "not-observed"
        )
        examples = actions[:remaining]
        remaining -= len(examples)
        results.append(
            {
                "path": artifact["path"],
                "status": status,
                "observed_actions": observed,
                "failed_actions": failed,
                "actions": examples,
                "omitted_actions": observed + failed - len(examples),
                **(
                    {
                        "reason": "removed-artifact"
                        if removed
                        else "unverified-content"
                        if uncertain or name or trace.get("coverage") != "listed-files-complete"
                        else "unsupported-artifact"
                    }
                    if status == "unknown"
                    else {}
                ),
            }
        )
    return {
        "version": VERSION,
        "status": overall(results),
        "artifacts": results,
        "source": {key: value for key, value in trace.items() if key != "files"},
    }


def summarize_use(
    trials: list[dict[str, Any]], evidence: list[dict[str, Any]], parent_id: str, candidate_id: str
) -> dict[str, Any]:
    by_slot = {
        (cell["candidate_id"], cell["task_id"], cell["repetition"]): cell for cell in evidence
    }
    counts = {status: 0 for status in STATUSES}
    paired: dict[str, list[tuple[str, float, float]]] = {status: [] for status in STATUSES}
    for trial in trials:
        status = trial["status"]
        counts[status] += 1
        before = by_slot.get((parent_id, trial["task_id"], trial["repetition"]), {})
        after = by_slot.get((candidate_id, trial["task_id"], trial["repetition"]), {})
        if all(
            cell.get("status") in ("valid", "task_failed") and cell.get("score") is not None
            for cell in (before, after)
        ):
            paired[status].append((trial["task_id"], before["score"], after["score"]))
    return {
        "version": VERSION,
        "candidate_trials": len(trials),
        "status_counts": counts,
        "conditioned_results": [
            {
                "status": status,
                "valid_pairs": len(values),
                "task_count": len({value[0] for value in values}),
                "parent_mean": sum(value[1] for value in values) / len(values) if values else None,
                "candidate_mean": sum(value[2] for value in values) / len(values)
                if values
                else None,
                "mean_reward_delta": sum(value[2] - value[1] for value in values) / len(values)
                if values
                else None,
            }
            for status, values in paired.items()
        ],
    }


def modification_observations(input: dict[str, Any]) -> dict[str, Any]:
    """Keep every accepted candidate trial, including explicit source unavailability."""
    artifacts = [
        {"path": file["path"], "candidate_digest": obj(file.get("after")).get("digest")}
        for file in input["changes"]
    ]
    available = {
        (trial["task_id"], trial["repetition"]): trial for trial in input.get("trials", [])
    }
    trials = []
    for cell in sorted(input["evidence"], key=lambda cell: (cell["task_id"], cell["repetition"])):
        if cell["candidate_id"] != input["candidate_id"]:
            continue
        trial = available.get((cell["task_id"], cell["repetition"]))
        if trial is None:
            trial = {
                "task_id": cell["task_id"],
                "repetition": cell["repetition"],
                "source_ref": None,
                **trial_use(
                    artifacts,
                    {
                        "kind": "unavailable",
                        "coverage": "unavailable",
                        "reason": "source-unavailable",
                        "listed_files": 0,
                        "verified_files": 0,
                        "verified_bytes": 0,
                    },
                ),
            }
        trials.append(trial)
    summary = summarize_use(trials, input["evidence"], input["parent_id"], input["candidate_id"])
    summary["expected_trials"] = len(input["task_ids"]) * input["repetitions"]
    summary["missing_observations"] = max(0, summary["expected_trials"] - len(trials))
    summary["source_coverage"] = dict(
        sorted(Counter(trial["source"]["coverage"] for trial in trials).items())
    )
    return {"summary": summary, "trials": trials}
