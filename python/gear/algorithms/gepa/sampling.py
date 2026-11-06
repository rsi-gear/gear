"""GEPA local/shared/cross buckets and bounded bridge expansion."""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass

from ..contracts import RandomSource, SamplingInput, SamplingPlan, Task
from ..sampling import ceiling_count


def stratified(
    tasks: tuple[Task, ...], ids: tuple[str, ...], rng: RandomSource, key: str
) -> list[str]:
    lookup = {task.id: task for task in tasks}
    groups: dict[str, list[str]] = defaultdict(list)
    for task_id in sorted(set(ids), key=lambda item: (rng.value(key + ":task:" + item), item)):
        groups[lookup[task_id].family].append(task_id)
    for values in groups.values():
        values.sort(key=lambda item: lookup[item].estimated_cost)
    families = sorted(groups, key=lambda item: (rng.value(key + ":family:" + item), item))
    result: list[str] = []
    expensive = False
    while any(groups.values()):
        for family in families:
            if groups[family]:
                result.append(groups[family].pop(-1 if expensive else 0))
        expensive = not expensive
    return result


@dataclass(frozen=True)
class GEPASampler:
    local_ratio: float = 0.08
    shared_ratio: float = 0.04
    cross_ratio: float = 0.03
    bridge_ratio: float = 0.4
    bucket_weights: tuple[tuple[str, float], ...] = (
        ("local", 0.6),
        ("shared", 0.25),
        ("cross", 0.15),
    )

    def __call__(self, view: SamplingInput, rng: RandomSource) -> SamplingPlan:
        tasks = {task.id: task for task in view.tasks}
        if (
            not tasks
            or set(view.failures + view.required + view.successful_controls) - tasks.keys()
        ):
            raise ValueError("sampling requires a nonempty seed universe and in-scope task IDs")
        if any(
            not math.isfinite(value) or not 0 <= value <= 1
            for value in (
                self.local_ratio,
                self.shared_ratio,
                self.cross_ratio,
                self.bridge_ratio,
            )
        ):
            raise ValueError("scope ratios must be between zero and one")
        count = len(tasks)
        ordered = stratified(view.tasks, tuple(tasks), rng, view.stage)
        if view.stage == "global":
            selected = sorted(tasks)
            return SamplingPlan(
                tuple(selected),
                tuple((key, 1 / count) for key in selected),
                "complete seed comparison",
            )
        if view.stage == "bridge":
            required = sorted(set(view.required))
            capacity = ceiling_count(count, self.bridge_ratio)
            if len(required) > capacity or not capacity:
                return SamplingPlan((), (), "required scope exceeds bridge capacity")
            selected = (
                required
                + [key for key in ordered if key not in required][: capacity - len(required)]
            )
            return SamplingPlan(
                tuple(sorted(selected)),
                tuple((key, 1 / len(selected)) for key in sorted(selected)),
                "required scope union then stratified bridge",
            )
        failures = set(view.failures)
        controls = set(view.successful_controls)
        shared = [key for key in ordered if key in controls][
            : ceiling_count(count, self.shared_ratio)
        ]
        used = set(shared)
        local_count = ceiling_count(count, self.local_ratio)
        local_controls = [key for key in ordered if key in controls - used - failures]
        control_slots = int(local_count >= 2 and bool(local_controls))
        local = [key for key in ordered if key in failures - used][
            : local_count - control_slots
        ] + local_controls[:control_slots]
        used.update(local)
        families = {tasks[key].family for key in view.failures}
        cross = [
            key
            for key in ordered
            if key not in used and key not in failures and tasks[key].family not in families
        ][: ceiling_count(count, self.cross_ratio)]
        buckets = {"shared": shared, "local": local, "cross": cross}
        selected = sorted(set(shared + local + cross + list(view.required)))
        if not selected or not failures.intersection(selected):
            return SamplingPlan((), (), "no actionable failure fits this scope")
        coefficients = dict(self.bucket_weights)
        if set(coefficients) != set(buckets) or any(
            not math.isfinite(weight) or weight < 0 for weight in coefficients.values()
        ):
            raise ValueError("bucket weights must define nonnegative local/shared/cross mass")
        denominator = math.fsum(coefficients[name] for name, ids in buckets.items() if ids)
        if denominator <= 0:
            raise ValueError("nonempty scope needs positive scoring mass")
        weights = {key: 0.0 for key in selected}
        for name, ids in buckets.items():
            for key in ids:
                weights[key] = coefficients[name] / denominator / len(ids)
        return SamplingPlan(
            tuple(selected),
            tuple(sorted(weights.items())),
            "GEPA local/shared/cross scope",
            tuple((name, tuple(ids)) for name, ids in buckets.items()),
        )


def sample_tasks(view: SamplingInput, rng: RandomSource) -> SamplingPlan:
    return GEPASampler()(view, rng)
