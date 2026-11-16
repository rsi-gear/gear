"""Composable finite-run predicates; the runtime enforces physical budgets."""

from gear.core import Module
from gear.search.contracts_v1 import AlgorithmState, SearchView, StopRule


def empty_tasks(view: SearchView, state: AlgorithmState) -> str | None:
    return "empty seed universe" if not view.tasks else None


def search_complete(view: SearchView, state: AlgorithmState) -> str | None:
    return "search complete" if state.data.get("phase") == "done" else None


def evaluation_budget_exhausted(view: SearchView, state: AlgorithmState) -> str | None:
    return "evaluation budget exhausted" if view.budget.evaluations_remaining < 0 else None


class AnyStop(Module):
    """Return the first applicable reason; order and thresholds are explicit configuration."""

    def __init__(
        self,
        rules: tuple[StopRule, ...] = (empty_tasks, search_complete, evaluation_budget_exhausted),
    ):
        self.rules = rules

    def __call__(self, view: SearchView, state: AlgorithmState) -> str | None:
        for rule in self.rules:
            reason = rule(view, state)
            if reason:
                return reason
        return None


def bounded_run(view: SearchView, state: AlgorithmState) -> str | None:
    return AnyStop()(view, state)


def stop_reason(view: SearchView, state: AlgorithmState) -> str | None:
    return bounded_run(view, state)


__all__ = [
    "AnyStop",
    "StopRule",
    "empty_tasks",
    "search_complete",
    "evaluation_budget_exhausted",
    "bounded_run",
    "stop_reason",
]
