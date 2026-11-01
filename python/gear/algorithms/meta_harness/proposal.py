"""Turn diagnosis into one hypothesis while directing the Meta agent to its archive."""

from dataclasses import replace

from ..contracts import ProposalInput, ProposalPlan
from ..gepa.proposal import plan_proposals as plan_gepa_proposals

HISTORY_GUIDANCE = (
    "Meta-Harness: inspect the bounded, read-only seed experience archive for available prior "
    "candidate scores, complete historical candidate source (read the source view in pages), and "
    "successful and failed execution traces; use cross-candidate evidence to justify one focused "
    "edit. For the first diagnosis, inspect the reserved baseline evidence and use the baseline "
    "trajectory reader when references are available. The read-only baseline source tree is listed "
    "in the reader metadata. Keep changes generalizable: do not add task-specific hints or name "
    "benchmark tasks in the candidate implementation, comments, or prompts. Do not inspect "
    "held-out data."
)
GENERAL_PROPOSAL = (
    "Review the complete seed archive, including the baseline and successful and failed "
    "trajectories. Propose exactly one general-purpose mechanism to improve the agent; "
    "do not add task-specific hints or name benchmark tasks in the implementation, comments, or "
    "prompts; do not stop because the current frontier appears optimal."
)


def plan_proposals(view: ProposalInput) -> ProposalPlan:
    plan = plan_gepa_proposals(replace(view, candidate_limit=max(1, view.candidate_limit)))
    diagnosis = view.diagnosis
    all_tasks = tuple(sorted(task.id for task in view.tasks))
    if not isinstance(diagnosis, dict):
        if not plan.hypotheses:
            return replace(
                plan,
                hypotheses=(GENERAL_PROPOSAL,),
                task_ids=all_tasks,
                reason=HISTORY_GUIDANCE,
            )
        return replace(plan, hypotheses=plan.hypotheses[:1], reason=HISTORY_GUIDANCE)
    selected_base = diagnosis.get("base_candidate_id")
    if not isinstance(selected_base, str):
        selected_base = None

    failures = {cell.task_id for cell in view.failures if cell.score is not None}
    clusters = diagnosis.get("clusters", [])
    evidence: list[tuple[str, ...]] = []
    if isinstance(clusters, list):
        for cluster in clusters:
            if not isinstance(cluster, dict):
                continue
            hypotheses = cluster.get("hypotheses", [])
            if not isinstance(hypotheses, list):
                continue
            proposed = tuple(
                dict.fromkeys(
                    item.strip() for item in hypotheses if isinstance(item, str) and item.strip()
                )
            )
            if proposed:
                evidence.append(proposed)

    if not evidence:
        hypotheses = diagnosis.get("hypotheses", [])
        if isinstance(hypotheses, list):
            alternatives = tuple(
                dict.fromkeys(
                    item.strip() for item in hypotheses if isinstance(item, str) and item.strip()
                )
            )
            if alternatives:
                hypothesis = (
                    "Review every diagnosis hypothesis and the historical seed archive. "
                    "Choose one general mechanism to test in this candidate; do not combine "
                    "unrelated fixes. Diagnosis alternatives:\n"
                    + "\n".join(f"- {item}" for item in alternatives)
                )
                return replace(
                    plan,
                    hypotheses=(hypothesis,),
                    task_ids=tuple(sorted(failures)) or all_tasks,
                    reason=HISTORY_GUIDANCE,
                    parent_candidate_id=selected_base,
                )
        if not plan.hypotheses:
            return replace(
                plan,
                hypotheses=(GENERAL_PROPOSAL,),
                task_ids=all_tasks,
                reason=HISTORY_GUIDANCE,
                parent_candidate_id=selected_base,
            )
        return replace(
            plan,
            hypotheses=plan.hypotheses[:1],
            reason=HISTORY_GUIDANCE,
            parent_candidate_id=selected_base,
        )

    cluster_summary = "\n".join("- " + "; ".join(hypotheses) for hypotheses in evidence)
    hypothesis = (
        "Review every diagnosis cluster and the historical seed archive. Choose one "
        "general mechanism to test in this candidate; do not combine unrelated fixes. "
        "Diagnosis alternatives:\n" + cluster_summary
    )
    task_ids = tuple(sorted(failures)) or all_tasks
    return replace(
        plan,
        hypotheses=(hypothesis,),
        task_ids=task_ids,
        reason=HISTORY_GUIDANCE,
        parent_candidate_id=selected_base,
    )
