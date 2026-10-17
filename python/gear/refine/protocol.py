"""Strict bounded JSON protocol validation, independent of author policy code."""

from __future__ import annotations

import json
import math
import re
from pathlib import Path

from gear.canonical import JSON

PROTOCOL_VERSION = 1
# Includes the UTF-8 JSON envelope and trailing newline; keep worker.ts in sync.
MAX_MESSAGE_BYTES = 64 * 1024 * 1024
DEFINITIONS = json.loads(Path(__file__).with_name("algorithm-v1.schema.json").read_text())["$defs"]


def validate(name: str, value: JSON) -> None:
    def check(schema, item, location):
        if "$ref" in schema:
            check(DEFINITIONS[schema["$ref"].split("/")[-1]], item, location)
        elif "const" in schema:
            if type(item) is not type(schema["const"]) or item != schema["const"]:
                raise ValueError(location + ": unsupported version/value")
        elif "enum" in schema:
            if item not in schema["enum"]:
                raise ValueError(location + ": unsupported enum")
        elif "anyOf" in schema:
            for choice in schema["anyOf"]:
                try:
                    check(choice, item, location)
                    return
                except (TypeError, ValueError):
                    pass
            raise ValueError(location + ": invalid union")
        else:
            kind = schema["type"]
            if kind == "null" and item is None:
                return
            if kind == "boolean" and type(item) is bool:
                return
            if kind == "string" and type(item) is str:
                item.encode("utf-8", errors="strict")
                if len(item) > schema.get("maxLength", math.inf) or (
                    "pattern" in schema and re.search(schema["pattern"], item) is None
                ):
                    raise ValueError(location + ": invalid string bound or pattern")
                return
            if kind in ("number", "integer") and type(item) in (int, float) and math.isfinite(item):
                if not schema.get("minimum", -math.inf) <= item <= schema.get("maximum", math.inf):
                    raise ValueError(location + ": numeric bound exceeded")
                if "exclusiveMinimum" in schema and item <= schema["exclusiveMinimum"]:
                    raise ValueError(location + ": exclusive numeric bound exceeded")
                if kind == "integer" and (
                    type(item) is not int
                    or not schema.get("minimum", -(2**53) + 1)
                    <= item
                    <= schema.get("maximum", 2**53 - 1)
                ):
                    raise ValueError(location + ": invalid integer")
                return
            if kind == "array" and isinstance(item, list):
                if len(item) > schema.get("maxItems", math.inf):
                    raise ValueError(location + ": array bound exceeded")
                for index, child in enumerate(item):
                    check(schema["items"], child, f"{location}[{index}]")
                return
            if kind == "object" and isinstance(item, dict):
                if not set(schema.get("required", ())).issubset(item):
                    raise ValueError(location + ": missing fields")
                for key, child in item.items():
                    if not isinstance(key, str):
                        raise ValueError(location + ": invalid key")
                    key.encode("utf-8", errors="strict")
                    field = schema.get("properties", {}).get(
                        key, schema.get("additionalProperties", False)
                    )
                    if field is False:
                        raise ValueError(location + ": unknown field " + key)
                    check(field, child, location + "." + key)
                return
            raise ValueError(location + ": invalid " + kind)

    check(DEFINITIONS[name], value, name)
