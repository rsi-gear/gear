"""Composable search policies and flows."""

from gear.search.contracts_v1 import ProposalInput, ProposalPlan
from gear.search.contracts_v1 import ProposalPlanner as ProposalPlanner


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


def plan_exploratory_proposals(view: ProposalInput) -> ProposalPlan:
    return ProposalPlan(
        tuple(
            f"Explore alternative {index + 1} using the permitted seed feedback."
            for index in range(view.candidate_limit)
        ),
        view.parent.task_ids,
        "independent exploratory proposals",
    )
