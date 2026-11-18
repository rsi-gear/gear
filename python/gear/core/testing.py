"""Basic callable components and operations."""

from __future__ import annotations

import inspect
import sys
from contextvars import ContextVar
from typing import Any

from gear.core._json import json_value
from gear.core.base import clone, describe_module
from gear.core.calls import Call
from gear.core.schema import validate_output

_checking: ContextVar[bool] = ContextVar("gear_operator_contract_check", default=False)


_installed = False


_UNSET = object()


def _audit(event: str, args: tuple[Any, ...]) -> None:
    if _checking.get() and (event == "open" or event.startswith(("socket.", "subprocess.", "os."))):
        raise ValueError("operator contract check observed external I/O: " + event)


def check_operator(
    operator: Any,
    sample: Any,
    *,
    effect: bool = False,
    key: str = "contract-check",
    result: Any = _UNSET,
) -> dict[str, Any]:
    """Check a named component on a representative input, without executing effects.

    This is a bounded author diagnostic, not a replacement for the worker sandbox.
    A schema result can be supplied explicitly to check an effect's output contract.
    """
    global _installed
    if not _installed:
        sys.addaudithook(_audit)
        _installed = True
    token = _checking.set(True)
    try:
        description = describe_module(operator).to_dict()
        before = json_value(sample)
        fresh = clone(operator)
        if describe_module(fresh).to_dict() != description:
            raise ValueError("clone changed the component configuration")

        def invoke(component: Any) -> Any:
            output = component(sample, key=key) if effect else component(sample)
            if inspect.isawaitable(output):
                raise ValueError("operator must return synchronously")
            if isinstance(output, Call) != effect:
                raise ValueError("operator returned the wrong pure/effect kind")
            if effect and result is not _UNSET:
                validate_output(output.to_dict()["output_schema_ref"]["schema"], result)
            return json_value(output)

        first = invoke(operator)
        repeated = invoke(operator)
        reconstructed = invoke(fresh)
        if first != repeated or first != reconstructed:
            raise ValueError("operator depends on hidden state or implicit nondeterminism")
        if describe_module(operator).to_dict() != description:
            raise ValueError("operator mutated its constructor configuration")
        if json_value(sample) != before:
            raise ValueError("operator mutated the provided input")
        return {"status": "passed", "configuration": description, "result": first}
    finally:
        _checking.reset(token)
