"""Failure-family proposals; diagnosis is requested through an explicit operation."""

from ..contracts import ProposalInput, ProposalPlan


def plan_workflow_proposals(view: ProposalInput, min_cluster_size: int = 2) -> ProposalPlan:
    """
    Proposes modular, reusable workflows synthesized across multi-task failure clusters.
    
    Prevents single-task overfitting by requiring at least min_cluster_size task failures
    within a task family before proposing a generalized workflow.
    """
    failures = {cell.task_id for cell in view.failures if cell.score is not None}
    task_map = {task.id: task for task in view.tasks}

    # Group failed tasks by family
    family_failures: dict[str, list[str]] = {}
    for task_id in failures:
        task = task_map.get(task_id)
        if task:
            family_failures.setdefault(task.family, []).append(task_id)

    # Filter families with systematic failure patterns
    valid_clusters = {
        family: task_ids
        for family, task_ids in sorted(family_failures.items(), key=lambda item: (-len(item[1]), item[0]))
        if len(task_ids) >= min_cluster_size
    }

    hypotheses: list[str] = []
    selected_tasks: list[str] = []

    for family, task_ids in valid_clusters.items():
        sample_ids = ", ".join(sorted(task_ids)[:4])
        hypotheses.append(
            f"Synthesize reusable workflow for family '{family}' addressing failure pattern across {len(task_ids)} tasks "
            f"({sample_ids}). Place procedure in workflows/<id>.md with trigger criteria in catalog."
        )
        selected_tasks.extend(task_ids)

    # Fallback if no family meets the multi-task cluster threshold
    if not hypotheses:
        return plan_proposals(view)

    return ProposalPlan(
        tuple(dict.fromkeys(hypotheses))[: view.candidate_limit],
        tuple(sorted(set(selected_tasks))),
        "reusable-workflow-synthesis",
    )


def plan_proposals(view: ProposalInput) -> ProposalPlan:
    failures = {cell.task_id for cell in view.failures if cell.score is not None}
    hypotheses: list[str] = []
    selected = failures
    if isinstance(view.diagnosis, dict):
        clusters = view.diagnosis.get("clusters", [])
        if isinstance(clusters, list):
            for cluster in clusters:
                if not isinstance(cluster, dict):
                    continue
                ids, raw = cluster.get("task_ids"), cluster.get("hypotheses")
                if isinstance(ids, list) and isinstance(raw, list):
                    scoped = {value for value in ids if isinstance(value, str)} & failures
                    proposed = [value for value in raw if isinstance(value, str) and value.strip()]
                    if scoped and proposed:
                        selected, hypotheses = scoped, proposed
                        break
        if not hypotheses:
            raw = view.diagnosis.get("hypotheses", [])
            if isinstance(raw, list):
                hypotheses = [value for value in raw if isinstance(value, str) and value.strip()]
            families = {task.family for task in view.tasks if task.id in failures}
            if families:
                family = min(
                    families,
                    key=lambda name: (
                        -sum(task.id in failures and task.family == name for task in view.tasks),
                        name,
                    ),
                )
                selected = {
                    task.id for task in view.tasks if task.id in failures and task.family == family
                }
    if not hypotheses and failures:
        hypotheses = ["Correct the observed seed failures while preserving successful behavior."]
    return ProposalPlan(
        tuple(dict.fromkeys(hypotheses))[: view.candidate_limit],
        tuple(sorted(selected)),
        "failure-family proposals",
    )
