"""Pure model-training statistics, fixed gates and deterministic SFT record order."""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any, TypedDict


class _TaskDelta(TypedDict):
    taskId: str
    baseline: float
    candidate: float
    delta: float


def _sum(values: list[float]) -> float:
    # Preserve the established left-to-right IEEE-754 arithmetic on Python 3.12+.
    total = 0.0
    for value in values:
        total += value
    return total


def _mean(values: list[float]) -> float:
    return _sum(values) / len(values)


def training_pair(input: dict[str, Any]) -> dict[str, Any]:
    slots, errors = input["slot_count"], input["inference_errors"]
    if (
        type(slots) is not int
        or slots <= 0
        or slots != len(input["pairs"])
        or type(errors) is not int
        or not 0 <= errors <= slots
    ):
        raise ValueError("model comparison requires complete nonempty task pairs")
    grouped: dict[str, tuple[list[float], list[float]]] = {}
    for pair in input["pairs"]:
        before, after = grouped.setdefault(pair["taskId"], ([], []))
        before.append(float(pair["baselineReward"]))
        after.append(float(pair["candidateReward"]))
    if not grouped:
        raise ValueError("model comparison requires complete nonempty task pairs")
    tasks: list[_TaskDelta] = []
    # Codepoint order is stable across Python/JS hosts and locale settings.
    for task_id in sorted(grouped):
        before, after = grouped[task_id]
        baseline, candidate = _mean(before), _mean(after)
        if not math.isfinite(baseline) or not math.isfinite(candidate):
            raise ValueError("model comparison statistics exceed the finite numeric range")
        tasks.append(
            {
                "taskId": task_id,
                "baseline": baseline,
                "candidate": candidate,
                "delta": candidate - baseline,
            }
        )
    mean = _mean([task["delta"] for task in tasks])
    error = None
    if len(tasks) > 1:
        squared = []
        for task in tasks:
            deviation = task["delta"] - mean
            squared.append(deviation * deviation)
        error = math.sqrt(_sum(squared) / (len(tasks) - 1) / len(tasks))
    if not math.isfinite(mean) or error is not None and not math.isfinite(error):
        raise ValueError("model comparison statistics exceed the finite numeric range")
    return {
        "partition": input["partition"],
        "taskDeltas": tasks,
        "meanDelta": mean,
        "standardError": error,
        "inferenceErrorRate": input["inference_errors"] / input["slot_count"],
    }


def training_dev_gate(input: dict[str, Any]) -> list[str]:
    policy, dev = input["policy"], input["dev"]
    reasons = []
    if dev["meanDelta"] < policy["minDevGain"]:
        reasons.append("dev-gain-below-threshold")
    if dev["inferenceErrorRate"] > policy["maxInferenceErrorRate"]:
        reasons.append("dev-inference-error-rate")
    for task in dev["taskDeltas"]:
        if task["taskId"] in policy["requiredTaskIds"] and task["delta"] < 0:
            reasons.append("required-task-regression:" + task["taskId"])
    return reasons


def training_decide(input: dict[str, Any]) -> dict[str, Any]:
    policy, held = input["policy"], input["heldOut"]
    reasons = training_dev_gate(input)
    if held["meanDelta"] < -policy["maxHeldOutRegression"]:
        reasons.append("held-out-regression")
    if held["inferenceErrorRate"] > policy["maxInferenceErrorRate"]:
        reasons.append("held-out-inference-error-rate")
    if any(
        task["taskId"] in policy["requiredTaskIds"] and task["delta"] < 0
        for task in held["taskDeltas"]
    ):
        reasons.append("held-out-required-task-regression")
    return {
        "outcome": "rejected" if reasons else "accepted",
        "reasons": reasons,
        "dev": input["dev"],
        "heldOut": {
            "meanDelta": held["meanDelta"],
            "standardError": held["standardError"],
            "taskCount": len(held["taskDeltas"]),
            "inferenceErrorRate": held["inferenceErrorRate"],
        },
    }


def offline_window(input: dict[str, Any]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = input["records"]
    seed, position, size = input["seed"], input["position"], input["size"]
    if (
        any(type(value) is not int for value in (seed, position, size))
        or any(abs(value) > 2**53 - 1 for value in (seed, position, size))
        or position < 0
        or size < 0
    ):
        raise ValueError(
            "offline window needs an integer seed and nonnegative integer position/size"
        )
    if size and not records:
        raise ValueError("offline window requires records")
    # The seeded permutation uses canonical integer JSON, independent of record contents.
    result: list[dict[str, Any]] = []
    permutations: dict[int, list[int]] = {}
    for index in range(position, position + size):
        epoch = index // len(records)
        if epoch not in permutations:
            permutations[epoch] = sorted(
                range(len(records)),
                key=lambda i: (
                    hashlib.sha256(
                        json.dumps(
                            {"seed": seed, "epoch": epoch, "index": i},
                            sort_keys=True,
                            separators=(",", ":"),
                        ).encode()
                    ).hexdigest(),
                    i,
                ),
            )
        result.append(records[permutations[epoch][index % len(records)]])
    return result
