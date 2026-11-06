"""Recipe contract checks, repeated independently at the TS operation boundary."""

from __future__ import annotations

import math
import re
from dataclasses import replace

from .contracts import ParentInput, ParentPlan, SamplingInput, SamplingPlan


def validate_parent_plan(view: ParentInput, plan: ParentPlan) -> None:
    if not plan.reason or sum(item.count for item in plan.allocations) > view.candidate_limit:
        raise ValueError("parent plan exceeds quota or omits its reason")
    eligible = {item.scope + ":" + item.candidate_id: item for item in view.eligible}
    for allocation in plan.allocations:
        selected = allocation.selection
        key = selected.option.scope + ":" + selected.option.candidate_id
        if (
            type(allocation.count) is not int
            or allocation.count < 1
            or key not in eligible
            or replace(selected.option, probability=1) != replace(eligible[key], probability=1)
        ):
            raise ValueError("parent plan selected an ineligible or modified option")
        probabilities = dict(selected.probabilities)
        if (
            len(probabilities) != len(selected.probabilities)
            or set(probabilities) - eligible.keys()
            or any(not math.isfinite(value) or value < 0 for value in probabilities.values())
            or probabilities.get(key, 0) <= 0
            or not math.isclose(math.fsum(probabilities.values()), 1, abs_tol=1e-9)
        ):
            raise ValueError("invalid parent sampling distribution")
        if (
            type(selected.random_index) is not int
            or selected.random_index < 0
            or not re.fullmatch(r"sha256:[0-9a-f]{64}", selected.input_digest)
        ):
            raise ValueError("invalid parent random draw provenance")


def validate_sampling_plan(view: SamplingInput, plan: SamplingPlan) -> None:
    if (
        not plan.reason
        or len(set(plan.task_ids)) != len(plan.task_ids)
        or set(plan.task_ids) - {task.id for task in view.tasks}
    ):
        raise ValueError("sampling plan contains duplicate/out-of-scope tasks or omits its reason")
    weights = dict(plan.weights)
    if (
        len(weights) != len(plan.weights)
        or set(weights) != set(plan.task_ids)
        or any(not math.isfinite(value) or value < 0 for value in weights.values())
        or not math.isclose(math.fsum(weights.values()), 1 if plan.task_ids else 0, abs_tol=1e-9)
    ):
        raise ValueError("sampling weights must cover the exact scope and sum to one")
    if plan.task_ids and set(view.required) - set(plan.task_ids):
        raise ValueError("sampling cannot drop prerequisite scope tasks")
