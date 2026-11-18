"""Composable search policies and flows."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from gear.canonical import JSON
from gear.core._json import json_object, json_value
from gear.core.calls import Call, CandidateRef
from gear.core.wire import validate_v2


@dataclass(frozen=True)
class Terminal:
    kind: Literal["nominate", "stop"]
    candidate: CandidateRef | None = None
    outcome: JSON = None

    def __post_init__(self) -> None:
        if self.kind not in ("nominate", "stop") or (self.kind == "nominate") != (
            self.candidate is not None
        ):
            raise ValueError("invalid terminal decision")
        json_value(self.outcome)


@dataclass(frozen=True)
class Decision:
    state: Any
    calls: tuple[Call[Any], ...] = ()
    reason: str = ""
    terminal: Terminal | None = None
    records: tuple[dict[str, JSON], ...] = ()

    def __post_init__(self) -> None:
        if not self.reason.strip() or bool(self.calls) == (self.terminal is not None):
            raise ValueError("decision requires calls or an exclusive terminal and a reason")
        if len(self.calls) > 256 or len({call.key for call in self.calls}) != len(self.calls):
            raise ValueError("decision has duplicate or too many calls")
        if any(call.effect["kind"] == "stream" for call in self.calls) and len(self.calls) != 1:
            raise ValueError("task completion must be an exclusive call")
        if len(self.records) > 64:
            raise ValueError("too many decision records")
        encoded = json_object(self.state)
        if (
            set(encoded) != {"version", "data"}
            or type(encoded["version"]) is not int
            or encoded["version"] < 1
            or not isinstance(encoded["data"], dict)
        ):
            raise ValueError("invalid algorithm state")
        validate_v2("Decision", self.to_dict())

    def to_dict(self) -> dict[str, JSON]:
        return {
            "state": json_value(self.state),
            "calls": [call.to_dict() for call in self.calls],
            "reason": self.reason,
            "terminal": json_value(self.terminal),
            "records": json_value(self.records),
        }
