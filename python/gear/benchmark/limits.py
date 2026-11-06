"""Operator preparation budgets, shared with the TypeScript import and Hitch adapters."""

from __future__ import annotations

import json
import math
import os
from pathlib import Path

from .source import BenchmarkError

LIMITS_ENV = "GEAR_BENCHMARK_LIMITS_JSON"
DEFAULT_LIMITS: dict[str, int] = json.loads(Path(__file__).with_suffix(".json").read_text())
MAX_SAFE_INTEGER = 2**53 - 1
MAX_TIMER_DELAY_MS = 2**31 - 1


def benchmark_limits() -> dict[str, int]:
    try:
        overrides = json.loads(os.environ.get(LIMITS_ENV, "{}"))
        if not isinstance(overrides, dict) or set(overrides) - DEFAULT_LIMITS.keys():
            raise ValueError("unknown limits")
        limits = {**DEFAULT_LIMITS, **overrides}
        if (
            any(
                type(value) not in (int, float)
                or not 0 < value <= MAX_SAFE_INTEGER
                or not math.isfinite(value)
                or int(value) != value
                for value in limits.values()
            )
            or limits["authorTimeoutMs"] > MAX_TIMER_DELAY_MS
        ):
            raise ValueError("invalid limit")
        return {key: int(value) for key, value in limits.items()}
    except (ValueError, TypeError) as error:
        raise BenchmarkError(
            "Benchmark limits must be a JSON object of known positive integer budgets; "
            "authorTimeoutMs must fit a Node timer",
            LIMITS_ENV,
        ) from error


def source_bytes() -> bytes:
    return Path(__file__).read_bytes() + b"\0" + Path(__file__).with_suffix(".json").read_bytes()
