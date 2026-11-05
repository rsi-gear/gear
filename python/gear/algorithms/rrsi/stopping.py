"""RRSI finite-horizon stop rule."""

from dataclasses import dataclass

from ..contracts import AlgorithmState, SearchView
from ..stopping import bounded_run
from .config import RRSIConfig


def stop_reason(view: SearchView, state: AlgorithmState) -> str | None:
    return bounded_run(view, state)


@dataclass(frozen=True)
class RRSIStopRule:
    config: RRSIConfig = RRSIConfig()

    def __post_init__(self) -> None:
        if isinstance(self.config, dict):
            object.__setattr__(self, "config", RRSIConfig(**self.config))

    def __call__(self, view: SearchView, state: AlgorithmState) -> str | None:
        if state.data.get("phase") == "done":
            return "RRSI search completed"
        return bounded_run(view, state)
