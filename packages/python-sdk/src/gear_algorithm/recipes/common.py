"""Small checked adapters between Gear operation outcomes and pure recipe decisions."""
from __future__ import annotations

import math
import re
from dataclasses import replace
from typing import Any

from gear_algorithm.errors import ValidationError
from gear_algorithm.protocol import AlgorithmDecision, BindingSetRef, OperationIntent
from gear_algorithm.steps import parallel


OPERATION_LIMITS_SCHEMA = {"type": "object", "additionalProperties": {
    "type": "object", "additionalProperties": {"type": "number"}}}
_DIMENSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


def apply_operation_limits(decision: AlgorithmDecision, config: dict[str, Any],
                           allowed_kinds: frozenset[str]) -> AlgorithmDecision:
    """Freeze host-configured per-kind reservations into every emitted intent.

    The runtime checks exact dimensions against each provider manifest and the
    Campaign budget. An omitted reservation therefore fails closed for a
    metered provider; recipes never infer a token count or disable metering.
    """
    table = config.get("operationLimits", {})
    if not isinstance(table, dict):
        raise ValidationError("operationLimits must map operation kinds to reservations")
    for kind, limits in table.items():
        if kind not in allowed_kinds or not isinstance(limits, dict):
            raise ValidationError(f"Invalid operationLimits entry {kind}")
        for dimension, amount in limits.items():
            if (not isinstance(dimension, str) or not _DIMENSION.fullmatch(dimension)
                or not isinstance(amount, (int, float)) or isinstance(amount, bool)
                or not math.isfinite(amount) or amount < 0 or amount > 2**53 - 1):
                raise ValidationError(f"Invalid reservation for {kind}.{dimension}")
    operations = []
    for item in decision.operations:
        if item.kind not in allowed_kinds:
            raise ValidationError(f"Unexpected recipe operation kind {item.kind}")
        configured = table.get(item.kind)
        if item.limits is not None and item.limits != configured:
            raise ValidationError(f"Conflicting explicit limits for {item.kind}")
        operations.append(replace(item, limits=dict(configured) if configured is not None else None))
    return replace(decision, operations=tuple(operations))


def result(context: dict[str, Any], key: str) -> Any:
    outcome = context["completed"][key]
    if outcome.get("kind") != "result":
        raise ValidationError(f"{key} did not return a result: {outcome.get('kind')}")
    return outcome["value"]


def structured(context: dict[str, Any], key: str) -> dict[str, Any]:
    value = result(context, key)
    if not isinstance(value, dict) or not isinstance(value.get("structuredResult"), dict):
        raise ValidationError(f"{key} needs a verified structured execution result")
    if not isinstance(value.get("structuredResultRef"), dict):
        raise ValidationError(f"{key} needs a sealed structured-result artifact")
    require_ref(value["structuredResultRef"], f"{key}.structuredResultRef")
    return value["structuredResult"]


def binding(ref: dict[str, Any]) -> BindingSetRef:
    if not isinstance(ref, dict) or ref.get("kind") != "binding-set":
        raise ValidationError("Expected managed BindingSetRef")
    return BindingSetRef(ref["digest"], ref["schemaId"])


def advance_state(state: dict[str, Any], operations: list[OperationIntent] | tuple[OperationIntent, ...] = (),
                  *, transition: dict[str, Any] | None = None, complete: bool = False) -> AlgorithmDecision:
    return AlgorithmDecision(nextState=state, operations=parallel(operations),
                             bindingTransition=binding(transition) if transition else None,
                             complete=complete)


def require_ref(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("kind") != "artifact" or not isinstance(value.get("digest"), str):
        raise ValidationError(f"{label} needs sealed ArtifactRef")
    return value


def require_execution(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValidationError(f"{label} needs verified execution result")
    require_ref(value.get("evidenceRef"), f"{label}.evidenceRef")
    require_ref(value.get("receiptRef"), f"{label}.receiptRef")
    return value
