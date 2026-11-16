"""Basic callable components and operations."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, cast

from gear.canonical import JSON
from gear.core._json import json_object


@dataclass(frozen=True, init=False)
class StateTree:
    version: int
    _encoded: str

    def __init__(self, data: dict[str, Any] | None = None, *, version: int = 1):
        if type(version) is not int or version < 1:
            raise ValueError("state version must be a positive integer")
        object.__setattr__(self, "version", version)
        object.__setattr__(
            self,
            "_encoded",
            json.dumps(
                json_object(data if data is not None else {}), ensure_ascii=False, allow_nan=False
            ),
        )

    @property
    def data(self) -> dict[str, JSON]:
        return cast(dict[str, JSON], json.loads(self._encoded))

    def updated(self, **values: Any) -> StateTree:
        return StateTree({**self.data, **values}, version=self.version)

    def state_dict(self) -> dict[str, JSON]:
        return {"version": self.version, "data": self.data}

    def to_dict(self) -> dict[str, JSON]:
        return self.state_dict()

    @classmethod
    def from_state_dict(cls, value: dict[str, JSON], *, expected_version: int = 1) -> StateTree:
        if (
            set(value) != {"version", "data"}
            or type(value["version"]) is not int
            or value["version"] != expected_version
        ):
            raise ValueError("state schema version mismatch")
        return cls(json_object(value["data"]), version=expected_version)
