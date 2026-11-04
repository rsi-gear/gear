"""Raw metric arithmetic shared by recipe ranking and immutable score projections.

The execution adapters validate provenance and seal records. This module never
reads a store, changes raw observations, chooses a denominator from available
observations, or retries a valid zero.
"""

from __future__ import annotations

import math
from fractions import Fraction
from typing import Any


def finite(value: object) -> bool:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def decimal(value: float) -> Fraction:
    if not finite(value):
        raise ValueError("metric value must be finite")
    return Fraction(str(value))


def numeric(value: Fraction) -> float:
    try:
        return float(value)
    except OverflowError:
        return math.inf if value.numerator >= 0 else -math.inf


def comparison_key(value: Fraction | float, quantum: float) -> int:
    if not finite(quantum) or quantum <= 0:
        raise ValueError("comparison quantum must be positive")
    return math.floor(
        (value if isinstance(value, Fraction) else decimal(value)) / decimal(quantum)
        + Fraction(1, 2)
    )


def score_ceiling(configuration: dict[str, Any]) -> float | None:
    """A provable linear bound; an unbounded selected metric prevents early stop."""
    total = Fraction()
    for term in configuration["definition"]["terms"]:
        if term["weight"] == 0:
            continue
        contract = next(item for item in configuration["metrics"] if item["id"] == term["metric"])
        bounds = contract.get("range")
        if bounds is None:
            return None
        value = bounds["max"] if term["weight"] > 0 else bounds["min"]
        total += decimal(value) * decimal(term["weight"]) / decimal(term["scale"])
    result = numeric(total)
    return result if finite(result) else None


def metric_utility(value: float, contract: dict[str, Any]) -> Fraction:
    """Declared fixed utility scale for outcome/process observation contracts."""
    result = decimal(value)
    bounds = contract.get("range")
    if bounds and not bounds["min"] <= value <= bounds["max"]:
        raise ValueError("metric value outside declared range")
    normalization = contract.get("normalization")
    if normalization:
        lower, upper = decimal(normalization["min"]), decimal(normalization["max"])
        if upper <= lower:
            raise ValueError("invalid metric normalization bounds")
        result = (result - lower) / (upper - lower)
    return result if contract["direction"] == "maximize" else -result


def weighted_mean(values: list[tuple[Fraction, float]]) -> Fraction:
    if not values or any(not finite(weight) or weight < 0 for _, weight in values):
        raise ValueError("invalid task weights")
    total = sum((decimal(weight) for _, weight in values), Fraction())
    if not total:
        raise ValueError("task weights cannot all be zero")
    return sum((value * decimal(weight) for value, weight in values), Fraction()) / total


def extract_metrics(input: dict[str, Any]) -> dict[str, Any]:
    metrics = {}
    for contract in input["contracts"]:
        base = {
            "contractDigest": contract["digest"],
            "unit": contract["unit"],
            "evidenceRefs": input["identity"]["originalArtifactRefs"],
        }
        metric_id = contract["id"]
        if not input["certified"]:
            metrics[metric_id] = {
                **base,
                "status": "invalid",
                "reason": "original observation is not certified",
            }
            continue
        if contract["granularity"] != "trial":
            metrics[metric_id] = {
                **base,
                "status": "unsupported",
                "reason": "dataset aggregate has no trial projection",
            }
            continue
        value = input["trial"]
        for part in contract["source"]["path"].split("."):
            value = value.get(part) if isinstance(value, dict) else None
        if value is None:
            metrics[metric_id] = {
                **base,
                "status": "missing",
                "reason": f"missing {contract['source']['path']}",
            }
            continue
        extractor = contract["source"]["extractor"]
        number = None
        if extractor == "number-v1" and finite(value):
            number = value
        elif extractor == "boolean-v1" and type(value) is bool:
            number = int(value)
        elif extractor == "equals-v1":
            expected = contract["source"]["equals"]
            if (finite(value) and finite(expected)) or type(value) is type(expected):
                number = int(value == expected)
        bounds = contract.get("range")
        if number is None or bounds and not bounds["min"] <= number <= bounds["max"]:
            metrics[metric_id] = {
                **base,
                "status": "invalid",
                "reason": "metric type or range does not match its contract",
            }
        else:
            metrics[metric_id] = {**base, "status": "available", "value": number}
    return metrics


def aggregate_metrics(input: dict[str, Any]) -> dict[str, Any]:
    contracts, tasks, records = input["contracts"], input["tasks"], input["records"]
    if (
        not tasks
        or len({task["id"] for task in tasks}) != len(tasks)
        or not any(task["weight"] > 0 for task in tasks)
    ):
        raise ValueError("invalid raw metric task scope")
    slots = {}
    for record in records:
        key = record["taskId"], record["repetition"]
        task = next((item for item in tasks if item["id"] == key[0]), None)
        if task is None or key[1] not in task["repetitions"] or key in slots:
            raise ValueError("unplanned or duplicate raw metric slot")
        slots[key] = record
    result = {}
    for contract in contracts:
        status, total, means, refs = "available", Fraction(), [], set()
        for task in tasks:
            repetitions = task["repetitions"]
            if not repetitions or len(set(repetitions)) != len(repetitions):
                raise ValueError("invalid raw metric repetitions")
            values = []
            for repetition in repetitions:
                record = slots.get((task["id"], repetition))
                metric = record["metrics"].get(contract["id"]) if record else None
                if record:
                    refs.add(record["digest"])
                if metric and metric["contractDigest"] != contract["digest"]:
                    raise ValueError("raw metric contract changed")
                if metric and metric["unit"] != contract["unit"]:
                    raise ValueError("raw metric unit changed")
                if not metric or metric["status"] != "available":
                    if metric and metric["status"] == "invalid":
                        status = "invalid"
                    elif status != "invalid":
                        status = metric["status"] if metric else "missing"
                else:
                    if not finite(metric.get("value")):
                        raise ValueError("invalid available raw value")
                    observation = decimal(metric["value"])
                    values.append(observation)
                    total += observation
            if len(values) == len(repetitions):
                means.append((sum(values, Fraction()) / len(values), task["weight"]))
        value = numeric(weighted_mean(means)) if status == "available" else None
        if value is not None and not math.isfinite(value):
            status = "invalid"
        aggregate = {
            "contractDigest": contract["digest"],
            "unit": contract["unit"],
            "status": status,
            "evidenceRefs": sorted(refs),
        }
        if status == "available":
            aggregate["value"] = value
            observation_total = numeric(total)
            if math.isfinite(observation_total):
                aggregate["observationTotal"] = observation_total
            else:
                aggregate["observationTotalExact"] = {
                    "numerator": str(total.numerator),
                    "denominator": str(total.denominator),
                }
        else:
            aggregate["reason"] = "incomplete or nonfinite frozen task/repetition scope"
        result[contract["id"]] = aggregate
    return result


def score_objective(input: dict[str, Any]) -> dict[str, Any]:
    objective, metrics, baseline = (
        input["objective"],
        input["metrics"],
        input.get("baseline"),
    )
    required = {term["metric"] for term in objective["terms"] if term["weight"] != 0} | {
        constraint["metric"] for constraint in objective["constraints"]
    }
    ids = list(
        dict.fromkeys(
            [term["metric"] for term in objective["terms"]]
            + [constraint["metric"] for constraint in objective["constraints"]]
        )
    )
    refs: set[str] = set()
    status, total, inputs, contributions = "available", Fraction(), [], []
    for metric_id in ids:
        metric = metrics.get(metric_id)
        expected = next(
            item["metricContractDigest"]
            for item in objective["terms"] + objective["constraints"]
            if item["metric"] == metric_id
        )
        if metric and metric["contractDigest"] != expected:
            raise ValueError("objective input contract mismatch")
        available = metric and metric["status"] == "available" and finite(metric.get("value"))
        if metric_id in required and not available:
            if metric and metric["status"] == "invalid":
                status = "invalid"
            elif status == "available":
                status = "missing"
        evidence_refs = metric.get("evidenceRefs", []) if metric else []
        refs.update(evidence_refs)
        inputs.append(
            {
                "metric": metric_id,
                "contractDigest": expected,
                "rawInputRefs": evidence_refs,
                **({"value": metric["value"]} if available else {}),
            }
        )
    for term in objective["terms"]:
        contribution = {
            "metric": term["metric"],
            "weight": term["weight"],
            "scale": term["scale"],
        }
        value = next(item for item in inputs if item["metric"] == term["metric"]).get("value")
        if term["weight"] == 0:
            contribution["contribution"] = 0
        elif value is not None:
            scaled = decimal(value) / decimal(term["scale"])
            amount = scaled * decimal(term["weight"])
            total += amount
            if math.isfinite(numeric(scaled)) and math.isfinite(numeric(amount)):
                contribution.update(scaledValue=numeric(scaled), contribution=numeric(amount))
            else:
                status = "invalid"
        contributions.append(contribution)
    constraints = []
    for constraint in objective["constraints"]:
        metric = metrics.get(constraint["metric"])
        reference = baseline["metrics"].get(constraint["metric"]) if baseline else None
        result = {
            "constraintDigest": constraint["digest"],
            **({"referenceDigest": baseline["digest"]} if baseline else {}),
            "evidenceRefs": (metric.get("evidenceRefs", []) if metric else [])
            + (reference.get("evidenceRefs", []) if reference else []),
        }
        if (
            not metric
            or metric["status"] != "available"
            or constraint["rule"] == "no_regression"
            and (not reference or reference["status"] != "available")
        ):
            result["status"] = "unavailable"
        else:
            if reference and reference["contractDigest"] != constraint["metricContractDigest"]:
                raise ValueError("baseline metric contract mismatch")
            if constraint["rule"] == "minimum":
                boundary = decimal(constraint["value"])
            else:
                assert reference is not None
                boundary = decimal(reference["value"]) + decimal(
                    (-1 if constraint["direction"] == "maximize" else 1)
                    * constraint.get("tolerance", 0)
                )
            difference = comparison_key(
                metric["value"], constraint["comparisonPrecision"]
            ) - comparison_key(boundary, constraint["comparisonPrecision"])
            result["status"] = (
                "passed"
                if (difference >= 0 if constraint["direction"] == "maximize" else difference <= 0)
                else "failed"
            )
        constraints.append(result)
    score = numeric(total)
    if not math.isfinite(score):
        status = "invalid"
    complete = status == "available"
    if status == "available" and any(item["status"] == "unavailable" for item in constraints):
        status = "missing"
    return {
        "status": status,
        **({"score": score} if complete else {}),
        "rawMetricsRefs": sorted(refs),
        "inputs": inputs,
        "contributions": contributions,
        "constraintResults": constraints,
    }


def score_projection(input: dict[str, Any]) -> dict[str, Any]:
    """Attach a comparison key without changing the immutable score evidence schema."""
    score = score_objective(input)
    return {
        "score": score,
        **(
            {
                "comparisonKey": str(
                    comparison_key(score["score"], input["objective"]["comparisonPrecision"])
                )
            }
            if "score" in score
            else {}
        ),
    }
