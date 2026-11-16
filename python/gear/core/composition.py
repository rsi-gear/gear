"""Basic callable components and operations."""

from __future__ import annotations

import inspect
from dataclasses import dataclass
from typing import Any, Generic, Protocol, TypeVar

from gear.canonical import JSON, digest
from gear.core._json import json_value
from gear.core.base import Module
from gear.core.calls import Call
from gear.core.random import RandomSource

ResultT = TypeVar("ResultT")


InputT = TypeVar("InputT", contravariant=True)


@dataclass(frozen=True)
class ModuleStep(Generic[ResultT]):
    state: JSON
    calls: tuple[Call[Any], ...] = ()
    done: bool = False
    result: ResultT | None = None

    def __post_init__(self) -> None:
        json_value(self.state)
        if self.done == bool(self.calls) or not self.done and self.result is not None:
            raise ValueError("module step must finish or expose a nonempty pending call batch")


class StepModule(Protocol[InputT, ResultT]):
    def __call__(
        self, value: InputT, *, view: Any, state: JSON, key: str
    ) -> ModuleStep[ResultT]: ...


class Sequential(Module):
    def __init__(self, steps: tuple[Any, ...]):
        self.steps = steps

    def __call__(self, value: Any, *, rng: RandomSource | None = None) -> Any:
        for index, step in enumerate(self.steps):
            parameters = inspect.signature(step).parameters
            child_rng = ScopedRandom(rng, f"steps/{index}") if rng is not None else None
            value = step(value, rng=child_rng) if "rng" in parameters else step(value)
            if isinstance(value, Call) or inspect.isawaitable(value):
                raise TypeError("Sequential only composes immediate pure computations")
        return value


class ScopedRandom:
    """Child draws use an explicit namespace and never consume a shared cursor."""

    def __init__(self, parent: RandomSource, path: str):
        self.parent = parent
        self.path = path

    def value(self, key: str, index: int = 0) -> float:
        return self.parent.value(digest([self.path, key]), index)

    def choice(self, options: tuple[Any, ...], *, key: str, index: int = 0) -> Any:
        # Preserve the parent's optional choice API without owning search types
        # or selection rules; this adapter only namespaces the explicit key.
        return getattr(self.parent, "choice")(options, key=digest([self.path, key]), index=index)
