"""Shared finite-run predicates; physical budget enforcement remains in the runtime."""

from .contracts import AlgorithmState, SearchView


def bounded_run(view: SearchView, state: AlgorithmState) -> str | None:
    if not view.tasks:
        return "empty seed universe"
    if state.data.get("phase") == "done":
        return "search complete"
    if view.budget.evaluations_remaining < 0:
        return "evaluation budget exhausted"
    return None
