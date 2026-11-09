"""Meta-Harness compares each candidate on the complete seed task set."""

from ..contracts import RandomSource, SamplingInput, SamplingPlan


def sample_all_tasks(view: SamplingInput, rng: RandomSource) -> SamplingPlan:
    del rng
    task_ids = tuple(sorted(task.id for task in view.tasks))
    if not task_ids:
        return SamplingPlan((), (), "no seed tasks are available")
    return SamplingPlan(
        task_ids,
        tuple((task_id, 1 / len(task_ids)) for task_id in task_ids),
        "complete seed evaluation for Meta-Harness history comparison",
    )
