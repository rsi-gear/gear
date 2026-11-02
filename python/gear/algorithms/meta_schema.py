"""Bounded JSON Schema subset for algorithm-authored Meta results.

No references, code, regular expressions or permissive unknown keywords are accepted.
The same normalized schema is sent to the model and used to validate its result.
"""

from __future__ import annotations

import math
from typing import Any


def result_schema(value: Any) -> dict[str, Any]:
    nodes = 0

    def compile_schema(raw: Any, depth: int = 0) -> dict[str, Any]:
        nonlocal nodes
        nodes += 1
        if not isinstance(raw, dict) or depth > 16 or nodes > 256:
            raise ValueError("Meta schema must be a bounded object tree")
        kind = raw.get("type")
        fields = {
            "object": {"properties", "required", "additionalProperties"},
            "array": {"items", "minItems", "maxItems"},
            "string": {"minLength", "maxLength"},
            "integer": {"minimum", "maximum"},
            "number": {"minimum", "maximum"},
            "boolean": set(),
            "null": set(),
        }
        if not isinstance(kind, str) or kind not in fields:
            raise ValueError("Unsupported Meta schema type")
        if set(raw) - (fields[kind] | {"type", "description", "enum"}):
            raise ValueError("Unsupported Meta schema keyword")
        schema = dict(raw)
        if "description" in raw and (
            not isinstance(raw["description"], str) or len(raw["description"]) > 4096
        ):
            raise ValueError("Invalid Meta field description")
        if kind == "object":
            properties = raw.get("properties")
            required = raw.get("required")
            if (
                not isinstance(properties, dict)
                or any(not isinstance(key, str) or not key or len(key) > 256 for key in properties)
                or not isinstance(required, list)
                or any(not isinstance(key, str) for key in required)
                or len(required) != len(set(required))
                or set(required) != set(properties)
                or raw.get("additionalProperties") is not False
            ):
                raise ValueError("Meta objects require every property and forbid additional fields")
            schema["properties"] = {
                key: compile_schema(child, depth + 1) for key, child in properties.items()
            }
        elif kind == "array":
            schema["items"] = compile_schema(raw.get("items"), depth + 1)
        if kind in ("string", "array"):
            low, high, limit = (
                ("minLength", "maxLength", 16_384)
                if kind == "string"
                else ("minItems", "maxItems", 256)
            )
            minimum, maximum = raw.get(low, 0), raw.get(high, limit)
            if (
                type(minimum) is not int
                or type(maximum) is not int
                or not 0 <= minimum <= maximum <= limit
            ):
                raise ValueError("Invalid Meta string/array bounds")
            schema[high] = maximum
        elif kind in ("number", "integer"):
            for bound in ("minimum", "maximum"):
                if bound in raw and (
                    type(raw[bound]) not in (int, float) or not math.isfinite(raw[bound])
                ):
                    raise ValueError("Invalid Meta number bound")
            if raw.get("minimum", -math.inf) > raw.get("maximum", math.inf):
                raise ValueError("Invalid Meta number range")
        if "enum" in schema:
            values = schema["enum"]
            if kind in ("array", "object") or not isinstance(values, list) or not values:
                raise ValueError("Meta enum requires nonempty scalar values")
            for item in values:
                validate_result({key: val for key, val in schema.items() if key != "enum"}, item)
        return schema

    schema = compile_schema(value)
    if schema["type"] != "object":
        raise ValueError("Meta result must be an object")
    if "declined" in schema["properties"]:
        raise ValueError("declined is reserved for the Meta execution result")
    schema["properties"]["declined"] = {"type": "boolean"}
    schema["required"] = [*schema["required"], "declined"]
    return schema


def validate_result(schema: dict[str, Any], value: Any) -> None:
    kind = schema["type"]
    if kind == "object":
        if not isinstance(value, dict) or set(value) != set(schema["properties"]):
            raise ValueError("Invalid Meta result fields")
        for key, child in schema["properties"].items():
            validate_result(child, value[key])
    elif kind == "array":
        if (
            not isinstance(value, list)
            or not schema.get("minItems", 0) <= len(value) <= schema["maxItems"]
        ):
            raise ValueError("Invalid Meta result array")
        for item in value:
            validate_result(schema["items"], item)
    elif kind == "string":
        # Match the previous provider's UTF-16 length bound for non-BMP characters.
        if (
            not isinstance(value, str)
            or not schema.get("minLength", 0)
            <= len(value.encode("utf-16-le")) // 2
            <= schema["maxLength"]
        ):
            raise ValueError("Invalid Meta result string")
    elif kind in ("number", "integer"):
        if (
            type(value) not in (int, float)
            or not math.isfinite(value)
            or not schema.get("minimum", -math.inf) <= value <= schema.get("maximum", math.inf)
            or (kind == "integer" and (type(value) is not int or abs(value) > 2**53 - 1))
        ):
            raise ValueError("Invalid Meta result number")
    elif kind == "boolean":
        if type(value) is not bool:
            raise ValueError("Invalid Meta result boolean")
    elif kind == "null" and value is not None:
        raise ValueError("Invalid Meta result null")
    if "enum" in schema and not any(
        type(value) is type(item) and value == item for item in schema["enum"]
    ):
        raise ValueError("Invalid Meta result enum")
