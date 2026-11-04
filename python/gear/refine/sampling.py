"""Exact task quotas shared by admitted and author-facing sampling policies."""

from __future__ import annotations

import math

from .objective import decimal, finite


def ceiling_count(size: int, ratio: float) -> int:
    if type(size) is not int or size < 1 or not finite(ratio) or not 0 <= ratio <= 1:
        raise ValueError("scope size must be positive and ratio must be between zero and one")
    return math.ceil(size * decimal(ratio))
