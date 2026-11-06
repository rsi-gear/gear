"""Declared Harbor deadlines shared by compilation, rendering and operator plans."""

from __future__ import annotations

import math
from pathlib import Path

from .source import BenchmarkError


def template_timeouts(rule: dict) -> dict:
    verifier = rule["scorer"]["limits"]["timeout_seconds"] + 15 if rule["kind"] == "llm" else 60
    return {
        "agent_seconds": 600,
        "verifier_seconds": verifier,
        "environment_build_seconds": 600,
        "verifier_build_seconds": 600,
    }


def native_timeouts(config: dict, location: str) -> dict:
    result = {}
    for label, parts in {
        "agent_seconds": ("agent", "timeout_sec"),
        "verifier_seconds": ("verifier", "timeout_sec"),
        "environment_build_seconds": ("environment", "build_timeout_sec"),
        "verifier_build_seconds": ("verifier", "environment", "build_timeout_sec"),
    }.items():
        value = config
        for part in parts:
            if not isinstance(value, dict):
                raise BenchmarkError("timeout section must be a TOML table", location)
            value = value.get(part)
            if value is None:
                break
        if value is not None and (
            type(value) not in (int, float)
            or not math.isfinite(value)
            or value <= 0
            or value > 2**53 - 1
        ):
            raise BenchmarkError("timeout must be a positive finite number of seconds", location)
        result[label] = value
    return result


def source_bytes() -> bytes:
    return Path(__file__).read_bytes()
