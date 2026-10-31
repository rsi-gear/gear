"""Project frozen trial scopes onto objectives and per-task protection rules."""

from __future__ import annotations

from fractions import Fraction
from typing import Any

from gear.canonical import digest

from .assertions import assertion_rows, project_assertions
from .objective import (
    aggregate_metrics,
    comparison_key,
    decimal,
    finite,
    numeric,
    score_objective,
    weighted_mean,
)
from .verifier import summarize_verifiers


def scope(input: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, float], bool]:
    tasks, repetitions = input["task_ids"], input["repetitions"]
    if len(set(tasks)) != len(tasks) or type(repetitions) is not int or repetitions < 1:
        raise ValueError("invalid objective task/repetition scope")
    weights = input.get("weights")
    if weights is None:
        weights = {task: 1 for task in tasks}
    if (
        set(weights) != set(tasks)
        or any(not finite(weight) or weight < 0 for weight in weights.values())
        or tasks
        and not any(weights.values())
    ):
        raise ValueError("objective weights must cover the frozen task scope")
    cells = [
        cell
        for cell in input["evidence"]
        if cell["candidate_id"] == input["candidate_id"] and cell["task_id"] in tasks
    ]
    slots = {(cell["task_id"], cell["repetition"]): cell for cell in cells}
    complete = (
        bool(tasks)
        and len(slots) == len(cells) == len(tasks) * repetitions
        and all(
            (task, repetition) in slots
            and slots[task, repetition]["status"] in ("valid", "task_failed")
            and finite(slots[task, repetition]["score"])
            for task in tasks
            for repetition in range(repetitions)
        )
    )
    return cells, weights, complete


def raw_scope(input: dict[str, Any]) -> dict[str, Any]:
    cells, weights, _ = scope(input)
    if not input["task_ids"]:
        return {}
    contracts = input["objective"]["metrics"]
    pass_contract = next(item for item in contracts if item["id"] == "pass_rate")
    records = []
    for cell in cells:
        raw = dict(cell.get("raw_metrics") or {})
        available = cell["status"] in ("valid", "task_failed") and finite(cell["score"])
        # Core binds real observations to candidate/provider/data identities. The
        # derived predicate also supports pure CPU fixtures with no provider.
        raw.setdefault(
            "pass_rate",
            {
                "contractDigest": pass_contract["digest"],
                "unit": "ratio",
                "status": "available" if available else "invalid",
                "evidenceRefs": [
                    digest(
                        {
                            key: cell[key]
                            for key in ("candidate_id", "task_id", "repetition", "score", "status")
                        }
                    )
                ],
                **({"value": int(cell["score"] == 1)} if available else {}),
            },
        )
        record = {"taskId": cell["task_id"], "repetition": cell["repetition"], "metrics": raw}
        records.append({**record, "digest": digest(record)})
    if len({(cell["task_id"], cell["repetition"]) for cell in cells}) != len(cells):
        # Ambiguous evidence invalidates this projection, not other candidates.
        return {
            contract["id"]: {
                "contractDigest": contract["digest"],
                "unit": contract["unit"],
                "status": "invalid",
                "evidenceRefs": sorted({record["digest"] for record in records}),
                "reason": "duplicate evidence in frozen task/repetition scope",
            }
            for contract in contracts
        }
    return aggregate_metrics(
        {
            "contracts": contracts,
            "tasks": [
                {
                    "id": task,
                    "repetitions": list(range(input["repetitions"])),
                    "weight": weights[task],
                }
                for task in input["task_ids"]
            ],
            "records": records,
        }
    )


def protected_tasks(input: dict[str, Any]) -> list[dict[str, Any]]:
    configuration = input["objective"]
    protection = []
    for rule in configuration.get("protection", []):
        if rule["task_id"] not in input["task_ids"] or rule["partition"] != input.get(
            "partition", "seed"
        ):
            continue
        local = {**input, "task_ids": [rule["task_id"]], "weights": {rule["task_id"]: 1}}
        current = raw_scope(local).get(rule["metric"])
        reference = raw_scope(
            {**local, "candidate_id": input.get("anchor_id") or input["candidate_id"]}
        ).get(rule["metric"])
        contract = next(item for item in configuration["metrics"] if item["id"] == rule["metric"])
        outcome = "unavailable"
        if (
            current
            and current["status"] == "available"
            and (rule["rule"] == "minimum" or reference and reference["status"] == "available")
        ):
            value = current["value"]
            if rule["rule"] == "no_new_violation":
                assert reference is not None
                passed = reference["value"] != 1 or value == 1
            else:
                if rule["rule"] == "minimum":
                    boundary = decimal(rule["value"])
                else:
                    assert reference is not None
                    boundary = decimal(reference["value"]) + decimal(
                        (-1 if contract["direction"] == "maximize" else 1)
                        * rule.get("tolerance", 0)
                    )
                difference = comparison_key(
                    value, contract["comparisonPrecision"]
                ) - comparison_key(boundary, contract["comparisonPrecision"])
                passed = difference >= 0 if contract["direction"] == "maximize" else difference <= 0
            outcome = "passed" if passed else "failed"
        protection.append({**rule, "status": outcome})
    return protection


def project_candidate(input: dict[str, Any]) -> dict[str, Any]:
    """One frozen scope; missing observations never shrink the denominator."""
    cells, weights, complete = scope(input)
    configuration = input.get("objective")
    summary: dict[str, Any] = {
        "score": None,
        "observed": len(cells),
        "expected": len(input["task_ids"]) * input["repetitions"],
        "complete": complete,
        "constraints_passed": False,
        "metrics": {},
        "protection": [],
    }
    if configuration and configuration.get("assertions"):
        summary["assertions"] = assertion_rows(input)
    if any(cell.get("verifier") for cell in cells):
        summary["verifier"] = summarize_verifiers(cells, weights, input["repetitions"])
    if not configuration:
        if complete:
            values = [
                (
                    sum(
                        (decimal(cell["score"]) for cell in cells if cell["task_id"] == task),
                        Fraction(),
                    )
                    / input["repetitions"],
                    weight,
                )
                for task, weight in weights.items()
            ]
            summary.update(score=numeric(weighted_mean(values)), constraints_passed=True)
        return summary
    if not input["task_ids"]:
        return summary
    metrics = raw_scope(input)
    baseline = None
    if input.get("anchor_id"):
        baseline_metrics = raw_scope({**input, "candidate_id": input["anchor_id"]})
        baseline = {"metrics": baseline_metrics, "digest": digest(baseline_metrics)}
    projected = score_objective(
        {"objective": configuration["definition"], "metrics": metrics, "baseline": baseline}
    )
    protection = protected_tasks(input)
    assertion_protection = project_assertions(input)
    if assertion_protection:
        summary["assertion_protection"] = assertion_protection
    summary.update(
        metrics=metrics,
        objective=projected,
        protection=protection,
        score=projected.get("score") if complete else None,
        complete=complete
        and projected["status"] == "available"
        and all(item["status"] != "unavailable" for item in protection + assertion_protection),
    )
    summary["constraints_passed"] = summary["complete"] and all(
        item["status"] == "passed"
        for item in projected["constraintResults"] + protection + assertion_protection
    )
    return summary


def compare_candidates(input: dict[str, Any]) -> dict[str, Any]:
    candidate = project_candidate(input)
    baseline = project_candidate({**input, "candidate_id": input["anchor_id"]})
    complete = candidate["complete"] and baseline["complete"]
    quantum = (
        input["objective"]["definition"]["comparisonPrecision"] if input.get("objective") else 1e-9
    )
    gain = (
        numeric(
            (
                comparison_key(candidate["score"], quantum)
                - comparison_key(baseline["score"], quantum)
            )
            * decimal(quantum)
        )
        if complete
        else None
    )
    return {
        "complete": complete,
        "gain": gain,
        "constraints_passed": candidate["constraints_passed"],
    }
