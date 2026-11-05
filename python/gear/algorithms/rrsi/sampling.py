"""RRSI evaluates every candidate on one complete, weighted seed scope."""

from ..contracts import RandomSource, SamplingInput, SamplingPlan


def sample_tasks(view: SamplingInput, rng: RandomSource) -> SamplingPlan:
    del rng
    ids = tuple(sorted(task.id for task in view.tasks))
    if not ids:
        return SamplingPlan((), (), "empty seed scope")
    return SamplingPlan(
        ids,
        tuple((task_id, 1 / len(ids)) for task_id in ids),
        "complete evolve scope",
    )
