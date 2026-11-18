"""Execution, evidence and objective comparisons."""

from __future__ import annotations

from dataclasses import dataclass

from gear.canonical import JSON


@dataclass(frozen=True)
class Task:
    id: str
    family: str
    estimated_cost: float = 1
    input: JSON = None
