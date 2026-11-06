"""Comparable complete evidence, shared by recipes without selecting a strategy."""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import asdict

from .contracts import Evidence, RankingInput, RankingPlan
from .projection import project_candidate


def task_scores(view: RankingInput) -> dict[str, tuple[tuple[str, float], ...]]:
    if view.repetitions < 1 or not view.task_ids or len(set(view.task_ids)) != len(view.task_ids):
        raise ValueError("ranking needs a nonempty unique task set and positive repetitions")
    if view.objective:
        evidence = [asdict(cell) for cell in view.evidence]
        projected_profiles: dict[str, tuple[tuple[str, float], ...]] = {}
        for candidate in view.candidate_ids:
            projected_tasks = [
                (
                    task,
                    project_candidate(
                        {
                            "evidence": evidence,
                            "task_ids": [task],
                            "repetitions": view.repetitions,
                            "candidate_id": candidate,
                            "anchor_id": view.anchor_id or candidate,
                            "objective": view.objective,
                        }
                    ),
                )
                for task in view.task_ids
            ]
            if all(result["complete"] for _, result in projected_tasks):
                projected_profiles[candidate] = tuple(
                    (task, result["score"]) for task, result in projected_tasks
                )
        return projected_profiles
    cells: dict[tuple[str, str, int], list[Evidence]] = defaultdict(list)
    for cell in view.evidence:
        cells[cell.candidate_id, cell.task_id, cell.repetition].append(cell)
    profiles = {}
    for candidate in view.candidate_ids:
        scores: list[tuple[str, float]] = []
        for task in view.task_ids:
            values: list[float] = []
            for repetition in range(view.repetitions):
                slot = cells[candidate, task, repetition]
                if len(slot) != 1 or slot[0].status not in ("valid", "task_failed"):
                    break
                value = slot[0].score
                if value is None or not math.isfinite(value):
                    break
                values.append(value)
            if len(values) != view.repetitions:
                break
            scores.append((task, math.fsum(values) / len(values)))
        if len(scores) == len(view.task_ids):
            profiles[candidate] = tuple(scores)
    return profiles


def complete_scope_mean(view: RankingInput) -> RankingPlan:
    if view.objective:
        projections = {
            candidate: project_candidate(
                {
                    "evidence": [asdict(cell) for cell in view.evidence],
                    "task_ids": list(view.task_ids),
                    "repetitions": view.repetitions,
                    "weights": dict(view.weights) if view.weights else None,
                    "candidate_id": candidate,
                    "anchor_id": view.anchor_id or candidate,
                    "objective": view.objective,
                }
            )
            for candidate in view.candidate_ids
        }
        complete = [candidate for candidate, result in projections.items() if result["complete"]]
        complete.sort(
            key=lambda candidate: (
                not projections[candidate]["constraints_passed"],
                -projections[candidate]["score"],
                candidate,
            )
        )
        return RankingPlan(
            tuple(complete),
            tuple((candidate, projections[candidate]["score"]) for candidate in complete),
            tuple(candidate for candidate in view.candidate_ids if candidate not in complete),
            tuple(
                candidate
                for candidate in complete
                if not projections[candidate]["constraints_passed"]
            ),
        )
    weights = (
        dict(view.weights)
        if view.weights
        else {task: 1 / len(view.task_ids) for task in view.task_ids}
        if view.task_ids
        else {}
    )
    if (
        len(weights) != len(view.task_ids)
        or set(weights) != set(view.task_ids)
        or any(not math.isfinite(weight) or weight < 0 for weight in weights.values())
        or not math.isclose(math.fsum(weights.values()), 1, abs_tol=1e-9)
    ):
        raise ValueError("ranking weights must cover the exact scope and sum to one")
    profiles = task_scores(view)
    scores = [
        (candidate, math.fsum(value * weights[task] for task, value in values))
        for candidate, values in profiles.items()
    ]
    scores.sort(key=lambda item: (-item[1], item[0]))
    return RankingPlan(
        tuple(candidate for candidate, _ in scores),
        tuple(scores),
        tuple(candidate for candidate in view.candidate_ids if candidate not in profiles),
    )
