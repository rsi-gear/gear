"""Random search compares every candidate on the complete seed scope."""

from ..contracts import RandomSource, SamplingInput, SamplingPlan


def sample_tasks(view: SamplingInput, rng: RandomSource) -> SamplingPlan:
    ids = tuple(sorted(task.id for task in view.tasks))
    return SamplingPlan(ids, tuple((key, 1 / len(ids)) for key in ids), "full seed comparison")
