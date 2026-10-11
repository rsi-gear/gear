"""Named declarative steps. Gear's TS runtime owns execution and recovery."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Iterable, TypeVar

from .errors import ValidationError
from .protocol import AlgorithmDecision, BindingSetRef, OperationIntent

T = TypeVar("T")


@dataclass(frozen=True)
class NamedStep:
    name: str
    kind: str
    function: Callable[..., T]

    def __call__(self, *args: Any, **kwargs: Any) -> T:
        return self.function(*args, **kwargs)


@dataclass(frozen=True)
class TaskStep:
    """A named pure input builder that emits a managed operation intent."""
    name: str
    operation_kind: str
    make_input: Callable[..., Any]

    def __call__(self, *args: Any, key: str | None = None,
                 binding_set_ref: BindingSetRef | None = None,
                 limits: dict[str, float] | None = None, **kwargs: Any) -> OperationIntent:
        operation = OperationIntent(localKey=key or self.name, kind=self.operation_kind,
                                    input=self.make_input(*args, **kwargs),
                                    bindingSetRef=binding_set_ref, limits=limits)
        operation.to_wire()
        return operation


def task(name: str, *, kind: str | None = None) -> Callable[[Callable[..., Any]], TaskStep]:
    if not name:
        raise ValidationError("task name must not be empty")

    def decorate(make_input: Callable[..., Any]) -> TaskStep:
        return TaskStep(name, kind or name, make_input)

    return decorate


def decision(name: str) -> Callable[[Callable[..., T]], NamedStep]:
    if not name:
        raise ValidationError("decision name must not be empty")

    def decorate(function: Callable[..., T]) -> NamedStep:
        return NamedStep(name, "decision", function)

    return decorate


def operation(*, key: str, kind: str, input: Any,
              binding_set_ref: BindingSetRef | None = None,
              limits: dict[str, float] | None = None) -> OperationIntent:
    return OperationIntent(localKey=key, kind=kind, input=input,
                           bindingSetRef=binding_set_ref, limits=limits)


def parallel(operations: Iterable[OperationIntent]) -> tuple[OperationIntent, ...]:
    """Freeze a named batch; keys are unique and sorting is deterministic."""
    result = tuple(sorted(operations, key=lambda item: item.localKey))
    if len({item.localKey for item in result}) != len(result):
        raise ValidationError("parallel operation keys must be unique")
    for item in result:
        item.to_wire()
    return result


def advance(state: Any, *operations: OperationIntent, complete: bool = False) -> AlgorithmDecision:
    return AlgorithmDecision(nextState=state, operations=parallel(operations), complete=complete)
