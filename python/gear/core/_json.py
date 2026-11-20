"""Basic callable components and operations."""

from __future__ import annotations

from dataclasses import fields, is_dataclass
from typing import Any, cast

from gear.canonical import JSON, canonical


def json_value(value: Any) -> JSON:
    active: set[int] = set()
    remaining = 1_000_000

    def visit(item: Any, depth: int) -> JSON:
        nonlocal remaining
        remaining -= 1
        if depth > 64 or remaining < 0:
            raise ValueError("operator value exceeds JSON bounds")
        if item is None or type(item) in (str, bool, int, float):
            return cast(JSON, item)
        identity = id(item)
        if identity in active:
            raise ValueError("operator value contains a cycle")
        active.add(identity)
        try:
            if isinstance(item, (list, tuple)):
                return [visit(child, depth + 1) for child in item]
            if isinstance(item, dict):
                if not all(type(key) is str for key in item):
                    raise TypeError("operator JSON keys must be strings")
                return {key: visit(child, depth + 1) for key, child in item.items()}
            method = getattr(item, "to_dict", None)
            if callable(method):
                return visit(method(), depth + 1)
            if is_dataclass(item) and not isinstance(item, type):
                return {
                    field.name: visit(getattr(item, field.name), depth + 1)
                    for field in fields(item)
                }
            raise TypeError("operator value is not JSON or a declared value type")
        finally:
            active.remove(identity)

    result = visit(value, 0)
    canonical(result)  # UTF-8, finite numbers and cross-language integer precision.
    return result


def json_object(value: Any) -> dict[str, JSON]:
    result = json_value(value)
    if not isinstance(result, dict):
        raise TypeError("expected an operator JSON object")
    return result
