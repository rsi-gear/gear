"""RRSI finite-horizon stop rule."""

from ..contracts import AlgorithmState, SearchView
from ..stopping import bounded_run
from .config import RRSIConfig


def stop_reason(view: SearchView, state: AlgorithmState) -> str | None:
    return bounded_run(view, state)


def configured_stop_reason(
    view: SearchView, state: AlgorithmState, config: RRSIConfig
) -> str | None:
    reason = stop_reason(view, state)
    if reason:
        return reason
    round_value = state.data.get("round", 0)
    round_index = round_value if type(round_value) is int else 0
    if round_index >= config.rounds:
        return "RRSI round horizon reached"
    return None
