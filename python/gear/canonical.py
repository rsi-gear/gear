"""Gear canonical v1; deliberately independent of historical training digests."""

from __future__ import annotations

import hashlib
import json
import math
import struct
from typing import TypeAlias

JSON: TypeAlias = None | bool | int | float | str | list["JSON"] | dict[str, "JSON"]


def canonical(value: JSON) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        value.encode("utf-8", errors="strict")
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, (int, float)):
        number = float(value)
        if not math.isfinite(number) or number.is_integer() and abs(number) > 2**53 - 1:
            raise ValueError("canonical numbers must be finite and integers must be safe")
        return "n" + struct.pack(">d", 0.0 if number == 0 else number).hex()
    if isinstance(value, list):
        return "[" + ",".join(canonical(item) for item in value) + "]"
    if isinstance(value, dict) and all(isinstance(key, str) for key in value):
        return (
            "{"
            + ",".join(canonical(key) + ":" + canonical(value[key]) for key in sorted(value))
            + "}"
        )
    raise TypeError("value is not canonical JSON")


def digest(value: JSON) -> str:
    return (
        "sha256:" + hashlib.sha256(("gear-canonical-v1\n" + canonical(value)).encode()).hexdigest()
    )
