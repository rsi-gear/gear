"""Typed, immutable declarations. Constructing a call never executes it."""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Generic, Literal, Protocol, TypeVar, cast, overload

from gear.canonical import JSON, digest

from ._json import json_object, json_value
from .schema import validate_schema
from .wire import validate_v2

T = TypeVar("T", covariant=True)
DecodedT = TypeVar("DecodedT")
InputT = TypeVar("InputT", contravariant=True)
OutputT = TypeVar("OutputT", covariant=True)
EffectKind = Literal["meta", "candidate", "read", "execute", "score", "library", "stream"]
EFFECTS = frozenset(("meta", "candidate", "read", "execute", "score", "library", "stream"))
SHA_PATTERN = re.compile(r"sha256:[a-f0-9]{64}\Z")
MAX_CALL_BYTES = 2 * 1024 * 1024


def checked_digest(value: str) -> str:
    if not isinstance(value, str) or SHA_PATTERN.fullmatch(value) is None:
        raise ValueError("expected a canonical content digest")
    return value


def checked_name(value: str) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 512
        or any(ord(char) < 32 or ord(char) == 127 for char in value)
    ):
        raise ValueError("expected a nonempty bounded name")
    value.encode("utf-8", errors="strict")
    return value


@dataclass(frozen=True)
class CandidateRef:
    run_id: str
    candidate_id: str
    digest: str

    def __post_init__(self) -> None:
        checked_name(self.run_id)
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", self.candidate_id):
            raise ValueError("invalid candidate ID")
        checked_digest(self.digest)


@dataclass(frozen=True)
class ArtifactRef:
    run_id: str
    kind: str
    digest: str
    visibility: Literal["agent", "optimization", "evaluation_private", "mixed"] = "optimization"

    def __post_init__(self) -> None:
        checked_name(self.run_id)
        checked_name(self.kind)
        checked_digest(self.digest)
        if self.visibility not in ("agent", "optimization", "evaluation_private", "mixed"):
            raise ValueError("unknown artifact visibility")


@dataclass(frozen=True)
class CallRef:
    key: str
    request_digest: str

    def __post_init__(self) -> None:
        checked_name(self.key)
        checked_digest(self.request_digest)

    @classmethod
    def parse(cls, value: CallRef | dict[str, Any]) -> CallRef:
        if isinstance(value, cls):
            return value
        if not isinstance(value, dict) or set(value) != {"key", "request_digest"}:
            raise ValueError("invalid call reference")
        return cls(**value)


@dataclass(frozen=True, init=False)
class Call(Generic[T]):
    _encoded: str

    def __init__(
        self,
        key: str,
        operator_ref: dict[str, Any],
        effect: dict[str, Any],
        output_schema: dict[str, Any] | None = None,
    ) -> None:
        checked_name(key)
        operator = json_object(operator_ref)
        if set(operator) != {"entrypoint", "configuration_digest"}:
            raise ValueError("invalid operator reference")
        checked_name(operator["entrypoint"])  # type: ignore[arg-type]
        checked_digest(operator["configuration_digest"])  # type: ignore[arg-type]
        request = json_object(effect)
        if (
            set(request) != {"kind", "input"}
            or not isinstance(request["kind"], str)
            or request["kind"] not in EFFECTS
            or not isinstance(request["input"], dict)
        ):
            raise ValueError("invalid effect request")
        schema = json_object(output_schema if output_schema is not None else {})
        validate_schema(schema)
        body = {
            "key": key,
            "operator_ref": operator,
            "effect": request,
            "output_schema_ref": {"digest": digest(schema), "schema": schema},
        }
        validate_v2("Call", body)
        encoded = json.dumps(body, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        if len(encoded.encode()) > MAX_CALL_BYTES:
            raise ValueError("call exceeds the author request byte limit")
        object.__setattr__(self, "_encoded", encoded)

    def to_dict(self) -> dict[str, JSON]:
        return cast(dict[str, JSON], json.loads(self._encoded))

    @property
    def key(self) -> str:
        return self.to_dict()["key"]  # type: ignore[return-value]

    @property
    def effect(self) -> dict[str, JSON]:
        return self.to_dict()["effect"]  # type: ignore[return-value]

    @property
    def operator_ref(self) -> dict[str, JSON]:
        return self.to_dict()["operator_ref"]  # type: ignore[return-value]

    @property
    def ref(self) -> CallRef:
        return CallRef(self.key, digest(self.to_dict()))

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> Call[Any]:
        if set(value) != {"key", "operator_ref", "effect", "output_schema_ref"}:
            raise ValueError("invalid call fields")
        schema = value["output_schema_ref"]
        if (
            not isinstance(schema, dict)
            or set(schema) != {"digest", "schema"}
            or digest(schema["schema"]) != schema["digest"]
        ):
            raise ValueError("call schema digest mismatch")
        return cls(value["key"], value["operator_ref"], value["effect"], schema["schema"])


class EffectOperator(Protocol[InputT, OutputT]):
    def __call__(self, value: InputT, *, key: str) -> Call[OutputT]: ...


@dataclass(frozen=True, init=False)
class CallResult(Generic[T]):
    _encoded: str
    _codec: Callable[[JSON], Any] | None

    def __init__(
        self,
        ref: CallRef,
        status: Literal["succeeded", "failed", "cancelled"],
        value: T | None = None,
        *,
        error: dict[str, Any] | None = None,
        artifacts: tuple[ArtifactRef, ...] = (),
        usage: dict[str, Any] | None = None,
    ) -> None:
        if status not in ("succeeded", "failed", "cancelled"):
            raise ValueError("call result must be terminal")
        if (
            status == "succeeded"
            and error is not None
            or status != "succeeded"
            and value is not None
        ):
            raise ValueError("call result value and error contradict its status")
        body = json_object(
            {
                "ref": CallRef.parse(ref),
                "status": status,
                "value": value,
                "error": error,
                "artifacts": artifacts,
                "usage": usage,
            }
        )
        validate_v2("CallResult", body)
        object.__setattr__(self, "_encoded", json.dumps(body, ensure_ascii=False, allow_nan=False))
        object.__setattr__(self, "_codec", None)

    def to_dict(self) -> dict[str, JSON]:
        return cast(dict[str, JSON], json.loads(self._encoded))

    @property
    def ref(self) -> CallRef:
        return CallRef.parse(self.to_dict()["ref"])  # type: ignore[arg-type]

    @property
    def status(self) -> str:
        return self.to_dict()["status"]  # type: ignore[return-value]

    @property
    def value(self) -> T | None:
        value = self.to_dict()["value"]
        if self._codec is not None and self.status == "succeeded":
            return cast(T, self._codec(value))
        return cast(T | None, value)

    def decode(self, codec: Callable[[JSON], DecodedT]) -> CallResult[DecodedT]:
        """Decode with a pure author component; wire bytes and other views stay unchanged."""
        result = CallResult.from_dict(self.to_dict())
        object.__setattr__(result, "_codec", codec)
        return result

    @property
    def error(self) -> JSON:
        return self.to_dict()["error"]

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> CallResult[Any]:
        if set(value) != {"ref", "status", "value", "error", "artifacts", "usage"}:
            raise ValueError("invalid call result fields")
        return cls(
            CallRef.parse(value["ref"]),
            value["status"],
            value["value"],
            error=value["error"],
            artifacts=tuple(ArtifactRef(**item) for item in value["artifacts"]),
            usage=value["usage"],
        )


class Results:
    """Only already-projected, terminal results; this object has no I/O capability."""

    def __init__(self, values: tuple[CallResult[Any], ...] = ()) -> None:
        self._values: dict[str, CallResult[Any]] = {}
        for value in values:
            previous = self._values.get(value.ref.key)
            if previous is not None and previous.to_dict() != value.to_dict():
                raise ValueError("conflicting terminal results for one call key")
            self._values[value.ref.key] = value

    @overload
    def require(
        self, ref: CallRef | dict[str, Any], *, decode: Callable[[JSON], DecodedT]
    ) -> CallResult[DecodedT]: ...

    @overload
    def require(self, ref: CallRef | dict[str, Any]) -> CallResult[Any]: ...

    def require(
        self, ref: CallRef | dict[str, Any], *, decode: Callable[[JSON], Any] | None = None
    ) -> CallResult[Any]:
        reference = CallRef.parse(ref)
        result = self._values.get(reference.key)
        if result is None or result.ref != reference:
            raise ValueError("call result is unavailable in this view")
        return result.decode(decode) if decode is not None else result

    def to_dict(self) -> list[JSON]:
        return [value.to_dict() for value in self._values.values()]


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
