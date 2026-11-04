"""Start native built-ins with already admitted baseline evidence."""

from dataclasses import replace

from gear.algorithms import AlgorithmState, Candidate, Evidence
from gear.canonical import digest
from gear.refine.contracts import OperationResult


def decision_after_baseline(algorithm, view):
    """Complete the real baseline checkpoint without inventing an internal phase."""
    baseline = algorithm.step(view, AlgorithmState())
    assert len(baseline.operations) == 1
    operation = baseline.operations[0]
    assert operation.kind == "evaluate_seed" and operation.candidate_id == view.anchor_id
    result = OperationResult(f"{view.step_id}:0", "evaluate_seed", "complete", view.anchor_id)
    resumed = replace(view, step_id=view.step_id + 1, completed=view.completed + (result,))
    return algorithm.step(resumed, baseline.state)


def advance(view, operations, *, failing=None, score=None, raw_metrics=None, diagnosis=None):
    failing = failing or (lambda operation: False)
    for index, operation in enumerate(operations):
        failed = failing(operation)
        result = OperationResult(
            f"{view.step_id}:{index}",
            operation.kind,
            "failed" if failed else "complete",
            operation.candidate_id,
        )
        if operation.kind == "diagnose_seed":
            result = replace(
                result,
                data=diagnosis if diagnosis is not None else {
                    "hypotheses": [
                        "Improve correctness.",
                        "Preserve formatting.",
                        "Check calculations.",
                        "Retry safely.",
                    ]
                },
            )
        elif operation.kind == "generate_candidate" and not failed:
            view = replace(
                view,
                candidates=view.candidates
                + (
                    Candidate(
                        operation.candidate_id, digest(operation.candidate_id), operation.parent_id
                    ),
                ),
                budget=replace(
                    view.budget, candidates_remaining=view.budget.candidates_remaining - 1
                ),
            )
        elif operation.kind == "evaluate_seed":
            existing = {(x.candidate_id, x.task_id, x.repetition) for x in view.evidence}
            cells = []
            for task in operation.task_ids:
                for repetition in range(view.budget.repetitions):
                    if (operation.candidate_id, task, repetition) in existing:
                        continue
                    value = (
                        score(operation, task)
                        if score
                        else (0.25 if operation.candidate_id == "anchor" else 0.75)
                    )
                    cells.append(
                        Evidence(
                            operation.candidate_id,
                            task,
                            repetition,
                            value,
                            "scoring_failed" if value is None else "valid",
                            operation.scope,
                            raw_metrics=raw_metrics,
                        )
                    )
            view = replace(
                view,
                evidence=view.evidence + tuple(cells),
                budget=replace(
                    view.budget,
                    evaluations_remaining=view.budget.evaluations_remaining - len(cells),
                ),
            )
        view = replace(view, completed=view.completed + (result,))
    return replace(view, step_id=view.step_id + 1)
