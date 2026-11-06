"""Pure verification and bounded diagnosis of provider verifier observations.

Process scores remain independent of task reward. Failure codes support hypotheses,
not root-cause claims or promotion decisions. Private source payloads never leave
this projection for the algorithm or Meta.
"""

from __future__ import annotations

import json
import math
import re
from fractions import Fraction
from typing import Any

from gear.canonical import digest

from .objective import decimal, numeric, weighted_mean

SHA = re.compile(r"sha256:[a-f0-9]{64}")
IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}")
MAX_BYTES = 16 * 1024


def size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode())


def obj(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("invalid-object")
    return value


def exact(value: dict[str, Any], fields: str) -> None:
    if set(value) - set(fields.split()):
        raise ValueError("unknown-field")


def number(value: Any) -> float:
    if type(value) not in (int, float) or not math.isfinite(value):
        raise ValueError("invalid-number")
    return float(value)


def integer(value: Any) -> int:
    if type(value) is not int or not 0 <= value <= 9007199254740991:
        raise ValueError("invalid-count")
    return value


def identifier(value: Any) -> str:
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise ValueError("invalid-identifier")
    return value


def checksum(value: Any) -> str:
    if not isinstance(value, str) or not SHA.fullmatch(value):
        raise ValueError("invalid-digest")
    return value


def same(left: Any, right: Any) -> bool:
    return abs(number(left) - number(right)) <= 1e-12


def excerpt(value: str, maximum: int) -> str:
    raw = value.encode()
    return value if len(raw) <= maximum else raw[: maximum - 3].decode(errors="ignore") + "…"


def unavailable(status: str, reason: str, source: Any = None) -> dict[str, Any]:
    try:
        source_digest = digest(source) if source is not None else None
    except (TypeError, ValueError, OverflowError):
        source_digest = None
    return {
        "version": 1,
        "status": status,
        "reason": reason,
        "source_digest": source_digest,
        "result_digest": None,
        "primary_score": None,
        "detail_status": None,
        "process": None,
        "feedback": [],
        "omitted_feedback": 0,
        "failure_codes": [],
        "omitted_failure_codes": 0,
    }


def refs(value: Any) -> None:
    if value is None:
        return
    if not isinstance(value, list):
        raise ValueError("invalid-trajectory-refs")
    for item in value:
        item = obj(item)
        exact(item, "run_id seq_start seq_end")
        if not isinstance(item.get("run_id"), str) or not re.fullmatch(
            r"run_[a-f0-9]{32}", item["run_id"]
        ):
            raise ValueError("invalid-trajectory-ref")
        for name in ("seq_start", "seq_end"):
            if name in item:
                integer(item[name])
        if "seq_start" in item and "seq_end" in item and item["seq_end"] < item["seq_start"]:
            raise ValueError("invalid-trajectory-range")


def process_evidence(value: Any) -> dict[str, Any]:
    value = obj(value)
    exact(value, "schema_version metric score detail_status passed total excluded components")
    if value.get("schema_version") != "1":
        raise ValueError("invalid-process-version")
    metric, score = identifier(value.get("metric")), number(value.get("score"))
    detail = value.get("detail_status")
    result: dict[str, Any] = {
        "metric": metric,
        "score": score,
        "detail_status": detail,
        "passed": None,
        "total": None,
        "excluded": None,
        "components": [],
        "omitted_components": 0,
    }
    if detail == "aggregate-only":
        if set(value).intersection({"passed", "total", "excluded", "components"}):
            raise ValueError("aggregate-has-components")
        return result
    if detail != "components" or not isinstance(value.get("components"), list):
        raise ValueError("invalid-process-detail")
    seen: set[str] = set()
    components = []
    numerator = denominator = Fraction(0)
    counts = {"passed": 0, "failed": 0, "excluded": 0}
    for raw in value["components"]:
        raw = obj(raw)
        exact(
            raw, "id category status weight code public_details private_details_ref trajectory_refs"
        )
        name, category, status = (
            identifier(raw.get("id")),
            identifier(raw.get("category")),
            raw.get("status"),
        )
        weight = number(raw.get("weight"))
        if name in seen or status not in counts or weight <= 0:
            raise ValueError("invalid-process-component")
        seen.add(name)
        counts[status] += 1
        if status != "excluded":
            denominator += Fraction(str(weight))
        if status == "passed":
            numerator += Fraction(str(weight))
        code = identifier(raw["code"]) if "code" in raw else None
        details = obj(raw["public_details"]) if "public_details" in raw else None
        if "private_details_ref" in raw:
            path = raw["private_details_ref"]
            if (
                not isinstance(path, str)
                or "\\" in path
                or any(part in ("", ".", "..") for part in path.split("/"))
            ):
                raise ValueError("invalid-private-reference")
        refs(raw.get("trajectory_refs"))
        components.append(
            {
                "id": name,
                "category": category,
                "status": status,
                "weight": weight,
                "code": code,
                "public_details": details if details is not None and size(details) <= 256 else None,
                "details_omitted": details is not None and size(details) > 256,
            }
        )
    passed, total, excluded = (integer(value.get(name)) for name in ("passed", "total", "excluded"))
    if (passed, total, excluded) != (
        counts["passed"],
        counts["passed"] + counts["failed"],
        counts["excluded"],
    ):
        raise ValueError("inconsistent-component-counts")
    if not same(score, float(numerator / denominator) if denominator else 0):
        raise ValueError("inconsistent-process-score")
    result.update(passed=passed, total=total, excluded=excluded, components=components)
    return result


def feedback_evidence(value: Any, process: dict[str, Any] | None) -> list[dict[str, Any]]:
    if value is None:
        return []
    value = obj(value)
    exact(value, "schema_version items")
    if value.get("schema_version") != "1" or not isinstance(value.get("items"), list):
        raise ValueError("invalid-feedback-version")
    known = {item["id"] for item in process["components"]} if process else set()
    items = []
    for raw in value["items"]:
        raw = obj(raw)
        exact(raw, "code severity message component_ids trajectory_refs")
        code, severity, message = (
            identifier(raw.get("code")),
            raw.get("severity"),
            raw.get("message"),
        )
        if (
            severity not in ("error", "warning", "info")
            or not isinstance(message, str)
            or len(message) > 16 * 1024
        ):
            raise ValueError("invalid-feedback-item")
        ids = raw.get("component_ids", [])
        if not isinstance(ids, list) or any(
            not isinstance(name, str) or name not in known for name in ids
        ):
            raise ValueError("unknown-feedback-component")
        refs(raw.get("trajectory_refs"))
        items.append(
            {
                "code": code,
                "severity": severity,
                "message": excerpt(message, 512),
                "message_truncated": len(message.encode()) > 512,
                "component_ids": sorted(set(ids))[:16],
                "omitted_component_ids": max(0, len(set(ids)) - 16),
            }
        )
    return items


def checked(input: dict[str, Any]) -> dict[str, Any]:
    source, trial = obj(input["source"]), obj(input["trial"])
    if not isinstance(trial.get("run_id"), str) or not re.fullmatch(
        r"run_[a-f0-9]{32}", trial["run_id"]
    ):
        raise ValueError("invalid-run-identity")
    exact(source, "schema_version kind run_id parent observation verifier redactions")
    if (source.get("schema_version"), source.get("kind"), source.get("run_id")) != (
        "1",
        "verifier-evidence",
        trial.get("run_id"),
    ):
        raise ValueError("source-identity-mismatch")
    parent = obj(source.get("parent"))
    exact(parent, "eval_id trial_id attempt")
    if (parent.get("eval_id"), parent.get("trial_id"), parent.get("attempt")) != (
        input["eval_id"],
        trial.get("trial_id"),
        trial.get("attempt"),
    ) or not isinstance(parent.get("trial_id"), str):
        raise ValueError("source-parent-mismatch")
    observation, value = obj(source.get("observation")), obj(source.get("verifier"))
    exact(observation, "status reward invalid_reason verifier_result_ref")
    exact(
        value,
        "status result result_sha256 scores process feedback structured_artifacts diagnostics issues",
    )
    if observation.get("status") != trial.get("observation_status"):
        raise ValueError("source-observation-mismatch")
    if observation.get("status") != "valid":
        return unavailable("invalid", "invalid-original-observation", source)
    if not same(observation.get("reward"), trial.get("reward")) or observation.get(
        "verifier_result_ref"
    ) != trial.get("verifier_result_ref"):
        raise ValueError("source-observation-mismatch")
    status = value.get("status")
    if status in ("corrupt", "missing"):
        return unavailable(
            "invalid" if status == "corrupt" else "missing", "verifier-" + status, source
        )
    if status not in ("complete", "result_only") or "result" not in value:
        raise ValueError("invalid-verifier-status")
    result_digest = checksum(value.get("result_sha256"))
    scores, rewards = obj(value.get("scores")), obj(obj(value["result"]).get("rewards"))
    exact(scores, "total_score process_score normalization")
    normalization = scores.get("normalization")
    total = number(scores.get("total_score"))
    if not same(total, trial.get("reward")) or not same(rewards.get("reward"), total):
        raise ValueError("source-score-mismatch")
    if normalization == "standard":
        if not same(rewards.get("total_score"), total):
            raise ValueError("source-score-mismatch")
    elif (
        normalization != "legacy-reward"
        or any(name in rewards for name in ("total_score", "process_score"))
        or "process_score" in scores
        or "process" in value
        or "feedback" in value
    ):
        raise ValueError("invalid-score-normalization")
    if "scores" in trial and trial["scores"] != scores:
        raise ValueError("source-score-mismatch")
    process = process_evidence(value["process"]) if "process" in value else None
    if (process is not None) != ("process_score" in scores) or ("process_score" in scores) != (
        "process_score" in rewards
    ):
        raise ValueError("missing-process-channel")
    if process and (
        not same(process["score"], scores["process_score"])
        or not same(process["score"], rewards["process_score"])
    ):
        raise ValueError("source-process-mismatch")
    artifacts = obj(value.get("structured_artifacts", {}))
    exact(artifacts, "process feedback")
    for name, maximum in (("process", 4 * 1024 * 1024), ("feedback", 1024 * 1024)):
        if (name in value) != (name in artifacts):
            raise ValueError("missing-structured-source")
        if name in artifacts:
            artifact = obj(artifacts[name])
            exact(artifact, "ref bytes sha256")
            if (
                artifact.get("ref") != "verifier/" + name + ".json"
                or integer(artifact.get("bytes")) > maximum
            ):
                raise ValueError("invalid-structured-source")
            checksum(artifact.get("sha256"))
    if process:
        process["artifact_digest"] = artifacts["process"]["sha256"]
    feedback = feedback_evidence(value.get("feedback"), process)
    diagnostics = obj(value.get("diagnostics", {}))
    has_diagnostics = (
        diagnostics.get("ctrf") is not None
        or bool(diagnostics.get("stdout"))
        or bool(diagnostics.get("stderr"))
    )
    if (status == "complete") != has_diagnostics:
        raise ValueError("inconsistent-diagnostic-availability")
    codes = sorted(
        {
            *[
                item["code"] or item["id"]
                for item in (process or {}).get("components", [])
                if item["status"] == "failed"
            ],
            *[item["code"] for item in feedback if item["severity"] == "error"],
        }
    )
    codes = [
        code for code in codes if code.casefold() not in {"error", "failed", "unknown", "failure"}
    ]
    components = sorted(
        (process or {}).get("components", []),
        key=lambda item: ({"failed": 0, "passed": 1, "excluded": 2}[item["status"]], item["id"]),
    )
    feedback.sort(
        key=lambda item: (
            {"error": 0, "warning": 1, "info": 2}[item["severity"]],
            item["code"],
            item["message"],
        )
    )
    if process:
        process["components"] = []
        process["omitted_components"] = len(components)
    result = {
        "version": 1,
        "status": "available",
        "reason": None,
        "source_digest": digest(source),
        "result_digest": result_digest,
        "primary_score": total,
        "detail_status": status,
        "process": process,
        "feedback": [],
        "omitted_feedback": len(feedback),
        "failure_codes": [],
        "omitted_failure_codes": len(codes),
    }
    for values, target, maximum, counter, owner in (
        (codes, result["failure_codes"], 32, "omitted_failure_codes", result),
        (components, process["components"] if process else [], 32, "omitted_components", process),
        (feedback, result["feedback"], 16, "omitted_feedback", result),
    ):
        for item in values[:maximum]:
            target.append(item)
            if size(result) > MAX_BYTES - 256:
                target.pop()
                break
            assert owner is not None
            owner[counter] -= 1
    return result


def project_verifier(input: dict[str, Any]) -> dict[str, Any]:
    source = input.get("source")
    if source is None:
        status = "unsupported" if input.get("unsupported") else "unavailable"
        return unavailable(
            status,
            "verifier-api-unsupported"
            if status == "unsupported"
            else "verifier-source-unavailable",
        )
    try:
        return checked(input)
    except (KeyError, TypeError, ValueError, OverflowError):
        return unavailable("invalid", "verifier-source-invalid", source)


def verifier_feedback(input: dict[str, Any]) -> str:
    observation = input.get("verifier")
    base: str = input["feedback"]
    if not observation or observation["status"] != "available":
        return base
    process = observation["process"]
    if process:
        base += f"; process {process['metric']}={process['score']} ({process['detail_status']})"
    codes = observation["failure_codes"]
    if codes:
        base += "; investigate verifier codes: " + ", ".join(codes)
        base += ". Codes support hypotheses, not established root causes."
    return excerpt(base, 2048)


def bind_verifier_channels(input: dict[str, Any]) -> dict[str, Any]:
    """An unavailable provider namespace preserves why its declared channels lack evidence."""
    cell: dict[str, Any] = input["evidence"]
    observation = cell.get("verifier")
    if (
        not observation
        or observation["status"] == "available"
        or cell["status"] not in ("valid", "task_failed")
    ):
        return cell
    status = observation["status"]
    status = status if status in ("invalid", "unsupported") else "missing"
    result = dict(cell)
    for field, contracts in (
        ("raw_metrics", input.get("metrics") or []),
        ("assertions", input.get("assertions") or []),
    ):
        selected = {
            item["id"] for item in contracts if item["source"]["path"].startswith("verifier.")
        }

        def bind(key: str, value: dict[str, Any]) -> dict[str, Any]:
            if key not in selected or value["status"] != "missing":
                return value
            return {**value, "status": status, "reason": observation["reason"]}

        if field == "raw_metrics" and field in cell:
            result[field] = {key: bind(key, value) for key, value in cell[field].items()}
        elif field in cell:
            result[field] = [bind(value["id"], value) for value in cell[field]]
    return result


def summarize_verifiers(
    cells: list[dict[str, Any]], weights: dict[str, float], repetitions: int
) -> dict[str, Any]:
    """Describe the explicit scope; incomplete channels cannot acquire a full-scope score."""
    statuses = {
        name: 0
        for name in (
            "available",
            "missing",
            "invalid",
            "unsupported",
            "unavailable",
            "not_captured",
        )
    }
    groups: dict[str, list[tuple[str, int, float]]] = {}
    for cell in cells:
        observation = cell.get("verifier")
        status = observation["status"] if observation else "not_captured"
        if status == "available" and cell["status"] not in ("valid", "task_failed"):
            status = "invalid"
        statuses[status] += 1
        process = observation.get("process") if observation and status == "available" else None
        if process:
            groups.setdefault(process["metric"], []).append(
                (cell["task_id"], cell["repetition"], process["score"])
            )
    required = {(task, repetition) for task in weights for repetition in range(repetitions)}
    metrics = []
    for name, values in sorted(groups.items()):
        slots = {(task, repetition) for task, repetition, score in values}
        complete = bool(required) and slots == required and len(values) == len(required)
        value = None
        if complete:
            per_task = [
                (
                    sum(
                        (decimal(score) for task_id, _, score in values if task_id == task),
                        Fraction(),
                    )
                    / repetitions,
                    weight,
                )
                for task, weight in weights.items()
            ]
            value = numeric(weighted_mean(per_task))
        metrics.append(
            {
                "metric": name,
                "observed": len(values),
                "expected": len(required),
                "complete": complete,
                "value": value,
                "observed_trial_mean": numeric(
                    sum((decimal(score) for _, _, score in values), Fraction()) / len(values)
                ),
            }
        )
    return {
        "status_counts": statuses,
        "missing_trials": max(0, len(required) - len(cells)),
        "process_metrics": metrics,
    }
