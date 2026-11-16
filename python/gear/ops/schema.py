"""A bounded JSON-schema subset shared by author declarations and result checks."""

from __future__ import annotations

import json
import math
from typing import Any

from gear.canonical import digest

from ._json import json_object, json_value

_TYPES = {"null", "boolean", "integer", "number", "string", "array", "object"}
_KEYS = {
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "minItems",
    "maxItems",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "enum",
    "const",
    "anyOf",
    "allOf",
    "oneOf",
    "$ref",
    "$defs",
    "title",
    "description",
}


def _resolve(root: dict[str, Any], reference: str) -> Any:
    if reference == "#":
        return root
    if not reference.startswith("#/"):
        raise ValueError("schemas only support document-local references")
    value: Any = root
    for part in reference[2:].split("/"):
        key = part.replace("~1", "/").replace("~0", "~")
        if not isinstance(value, dict) or key not in value:
            raise ValueError("unresolved schema reference")
        value = value[key]
    if not isinstance(value, (dict, bool)):
        raise ValueError("reference does not resolve to a schema")
    return value


def validate_schema(value: dict[str, Any]) -> None:
    root = json_object(value)
    if len(json.dumps(root, ensure_ascii=False).encode()) > 128 * 1024:
        raise ValueError("output schema exceeds 128 KiB")
    remaining = 1024
    references: list[str] = []
    seen: set[int] = set()

    def visit(schema: Any, depth: int = 0) -> None:
        nonlocal remaining
        remaining -= 1
        if remaining < 0 or depth > 32:
            raise ValueError("output schema exceeds supported bounds")
        if type(schema) is bool:
            return
        if not isinstance(schema, dict) or set(schema) - _KEYS:
            raise ValueError("unsupported output schema keyword")
        if id(schema) in seen:
            return
        seen.add(id(schema))
        for key, item in schema.items():
            if key == "type":
                names = item if isinstance(item, list) else [item]
                if (
                    not names
                    or any(not isinstance(name, str) or name not in _TYPES for name in names)
                    or len(set(names)) != len(names)
                ):
                    raise ValueError("invalid schema type")
            elif key in ("properties", "$defs"):
                if not isinstance(item, dict):
                    raise ValueError("schema properties/definitions must be objects")
                for child in item.values():
                    visit(child, depth + 1)
            elif key in ("additionalProperties", "items"):
                visit(item, depth + 1)
            elif key in ("anyOf", "oneOf", "allOf"):
                if not isinstance(item, list) or not item:
                    raise ValueError("schema alternatives must be nonempty arrays")
                for child in item:
                    visit(child, depth + 1)
            elif key == "required":
                if (
                    not isinstance(item, list)
                    or any(not isinstance(name, str) for name in item)
                    or len(set(item)) != len(item)
                ):
                    raise ValueError("invalid required property names")
            elif key in ("minItems", "maxItems", "minLength", "maxLength"):
                if type(item) is not int or item < 0:
                    raise ValueError("schema size bounds must be nonnegative integers")
            elif key in ("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"):
                if type(item) not in (int, float) or not math.isfinite(item):
                    raise ValueError("schema numeric bounds must be finite numbers")
            elif key == "enum":
                if (
                    not isinstance(item, list)
                    or not item
                    or len({digest(entry) for entry in item}) != len(item)
                ):
                    raise ValueError("invalid schema enumeration")
            elif key in ("$ref", "title", "description"):
                if not isinstance(item, str):
                    raise ValueError("schema reference and descriptions must be strings")
                if key == "$ref":
                    references.append(item)

    visit(root)
    for reference in references:
        visit(_resolve(root, reference))


def validate_output(schema: dict[str, Any], value: Any) -> None:
    validate_schema(schema)
    root = json_object(schema)
    value = json_value(value)
    remaining = 100000

    def check(rule: Any, item: Any, path: str, depth: int = 0) -> None:
        nonlocal remaining
        remaining -= 1
        if remaining < 0 or depth > 128:
            raise ValueError("output validation exceeds supported bounds")
        if rule is True:
            return
        if rule is False:
            raise ValueError("output does not match schema at " + path)
        if "$ref" in rule:
            check(_resolve(root, rule["$ref"]), item, path, depth + 1)
        for key in ("anyOf", "oneOf", "allOf"):
            if key not in rule:
                continue
            matches = 0
            for choice in rule[key]:
                try:
                    check(choice, item, path, depth + 1)
                    matches += 1
                except ValueError:
                    pass
            if (
                key == "anyOf"
                and matches == 0
                or key == "oneOf"
                and matches != 1
                or key == "allOf"
                and matches != len(rule[key])
            ):
                raise ValueError("output alternative mismatch at " + path)
        if "const" in rule and digest(item) != digest(rule["const"]):
            raise ValueError("output constant mismatch at " + path)
        if "enum" in rule and digest(item) not in {digest(choice) for choice in rule["enum"]}:
            raise ValueError("output enumeration mismatch at " + path)
        kind = (
            "null"
            if item is None
            else "boolean"
            if type(item) is bool
            else "number"
            if type(item) in (int, float)
            else "string"
            if isinstance(item, str)
            else "array"
            if isinstance(item, list)
            else "object"
        )
        names = rule.get("type", list(_TYPES))
        names = names if isinstance(names, list) else [names]
        if kind not in names and not (
            kind == "number" and "integer" in names and float(item).is_integer()
        ):
            raise ValueError("output type mismatch at " + path)
        if kind == "number":
            if (
                not rule.get("minimum", -math.inf) <= item <= rule.get("maximum", math.inf)
                or item <= rule.get("exclusiveMinimum", -math.inf)
                or item >= rule.get("exclusiveMaximum", math.inf)
            ):
                raise ValueError("output numeric bound exceeded at " + path)
        if kind == "string" and not rule.get("minLength", 0) <= len(item) <= rule.get(
            "maxLength", math.inf
        ):
            raise ValueError("output string bound exceeded at " + path)
        if kind == "array":
            if not rule.get("minItems", 0) <= len(item) <= rule.get("maxItems", math.inf):
                raise ValueError("output array bound exceeded at " + path)
            for index, child in enumerate(item):
                check(rule.get("items", True), child, f"{path}[{index}]", depth + 1)
        if kind == "object":
            if not set(rule.get("required", ())).issubset(item):
                raise ValueError("missing output properties at " + path)
            for name, child in item.items():
                check(
                    rule.get("properties", {}).get(name, rule.get("additionalProperties", True)),
                    child,
                    path + "." + name,
                    depth + 1,
                )

    check(root, value, "result")
