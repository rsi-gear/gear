"""Meta-Harness uses Gear's shared finite-run and objective stopping checks."""

from ..contracts import AlgorithmState, SearchView
from ..stopping import bounded_run


def stop_reason(view: SearchView, state: AlgorithmState) -> str | None:
    return bounded_run(view, state)
