"""Bounded, pure validation of generated v2 wire contracts."""

from __future__ import annotations

import math
import re
from typing import Any, cast

from ._json import json_value
from ._wire_schema import DEFINITIONS


def validate_v2(name: str, value: Any) -> None:
    item = json_value(value)
    remaining = 1_000_000
    definitions = cast(dict[str, dict[str, Any]], DEFINITIONS)

    def check(schema: dict[str, Any], item: Any, path: str, depth: int = 0) -> None:
        nonlocal remaining
        remaining -= 1
        if remaining < 0 or depth > 192:
            raise ValueError("wire validation exceeds its bounds")
        if "$ref" in schema:
            return check(definitions[schema["$ref"].split("/")[-1]], item, path, depth + 1)
        if "const" in schema:
            if type(item) is not type(schema["const"]) or item != schema["const"]:
                raise ValueError(path + ": unsupported constant")
            return
        if "enum" in schema:
            if not any(type(item) is type(choice) and item == choice for choice in schema["enum"]):
                raise ValueError(path + ": unsupported enum")
            return
        if "anyOf" in schema:
            for choice in schema["anyOf"]:
                try:
                    check(choice, item, path, depth + 1)
                    return
                except ValueError:
                    pass
            raise ValueError(path + ": invalid union")
        kind = schema["type"]
        if kind == "null" and item is None or kind == "boolean" and type(item) is bool:
            return
        if kind == "string" and isinstance(item, str):
            if not schema.get("minLength", 0) <= len(item) <= schema.get("maxLength", math.inf) or (
                "pattern" in schema and re.search(schema["pattern"], item) is None
            ):
                raise ValueError(path + ": invalid string")
            return
        if kind in ("number", "integer") and type(item) in (int, float) and math.isfinite(item):
            if kind == "integer" and (type(item) is not int or abs(item) > 2**53 - 1):
                raise ValueError(path + ": invalid integer")
            if not schema.get("minimum", -math.inf) <= item <= schema.get("maximum", math.inf):
                raise ValueError(path + ": numeric bound exceeded")
            return
        if kind == "array" and isinstance(item, list):
            if not schema.get("minItems", 0) <= len(item) <= schema.get("maxItems", math.inf):
                raise ValueError(path + ": invalid array size")
            for index, child in enumerate(item):
                check(schema["items"], child, f"{path}[{index}]", depth + 1)
            return
        if kind == "object" and isinstance(item, dict):
            if not set(schema.get("required", ())).issubset(item):
                raise ValueError(path + ": missing fields")
            for key, child in item.items():
                field = schema.get("properties", {}).get(
                    key, schema.get("additionalProperties", False)
                )
                if field is False:
                    raise ValueError(path + ": unknown field " + key)
                check(field, child, path + "." + key, depth + 1)
            return
        raise ValueError(path + ": invalid " + kind)

    if name not in DEFINITIONS:
        raise ValueError("unknown v2 contract " + name)
    check(definitions[name], item, name)
