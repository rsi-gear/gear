"""Experimental JSON protocol shared with the Gear TypeScript host.

The host owns canonical encoding, artifact sealing and digest creation. Python
never invents a Gear digest. JSON integers stay in JavaScript's exact range.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
import math
from typing import Any, Literal, Mapping

from .errors import ValidationError

MAX_SAFE_INTEGER = 2**53 - 1
JSONSchema = dict[str, Any]


def validate_json(value: Any, path: str = "$") -> Any:
    if value is None or isinstance(value, (str, bool)):
        if isinstance(value, str):
            if any(0xD800 <= ord(c) <= 0xDFFF for c in value):
                raise ValidationError("unpaired Unicode surrogate", path)
        return value
    if isinstance(value, int):
        if abs(value) > MAX_SAFE_INTEGER:
            raise ValidationError("integer exceeds exact JSON range", path)
        return value
    if isinstance(value, float):
        if not math.isfinite(value) or (value.is_integer() and abs(value) > MAX_SAFE_INTEGER):
            raise ValidationError("non-finite or unsafe number", path)
        return value
    if isinstance(value, list):
        for index, item in enumerate(value):
            validate_json(item, f"{path}[{index}]")
        return value
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValidationError("object keys must be strings", path)
            if key in ("__proto__", "prototype", "constructor") or "\0" in key:
                raise ValidationError("unsafe JSON key", f"{path}.{key}")
            validate_json(key, f"{path}.<key>")
            validate_json(item, f"{path}.{key}")
        return value
    raise ValidationError(f"unsupported JSON value {type(value).__name__}", path)


def assert_schema(schema: Mapping[str, Any], path: str = "$schema") -> None:
    if not isinstance(schema, dict):
        raise ValidationError("schema must be an object", path)
    kind = schema.get("type")
    kinds = ("any", "null", "boolean", "number", "integer", "string", "array", "object")
    if kind not in kinds:
        raise ValidationError("unsupported schema type", path)
    allowed = {"type", "enum"}
    if kind == "array":
        allowed.add("items")
    if kind == "object":
        allowed.update(("properties", "required", "additionalProperties"))
    unexpected = set(schema) - allowed
    if unexpected:
        raise ValidationError(f"unsupported schema keyword: {sorted(unexpected)[0]}", path)
    if "enum" in schema:
        choices = schema["enum"]
        if not isinstance(choices, list) or not choices:
            raise ValidationError("schema enum must be nonempty array", path)
        validate_json(choices, f"{path}.enum")
    if kind == "array":
        if "items" not in schema:
            raise ValidationError("array schema requires items", path)
        assert_schema(schema["items"], f"{path}.items")
    if kind == "object":
        props = schema.get("properties", {})
        if not isinstance(props, dict):
            raise ValidationError("schema properties must be object", path)
        for name, child in props.items():
            validate_json({name: None}, f"{path}.properties")
            assert_schema(child, f"{path}.properties.{name}")
        required = schema.get("required", [])
        if not isinstance(required, list) or any(not isinstance(name, str) or name not in props for name in required):
            raise ValidationError("required properties need matching schemas", path)
        extra = schema.get("additionalProperties", True)
        if not isinstance(extra, (bool, dict)):
            raise ValidationError("additionalProperties must be boolean or schema", path)
        if isinstance(extra, dict):
            assert_schema(extra, f"{path}.additionalProperties")


def _json_equal(left: Any, right: Any) -> bool:
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    if isinstance(left, (int, float)) or isinstance(right, (int, float)):
        return isinstance(left, (int, float)) and isinstance(right, (int, float)) and left == right
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(_json_equal(a, b) for a, b in zip(left, right))
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(_json_equal(left[key], right[key]) for key in left)
    return type(left) is type(right) and left == right


def validate_schema(schema: Mapping[str, Any], value: Any, path: str = "$") -> Any:
    """Validate the first Gear schema subset; reject unsupported keywords."""
    assert_schema(schema)
    kind = schema["type"]
    validate_json(value, path)
    if "enum" in schema and not any(_json_equal(value, choice) for choice in schema["enum"]):
        raise ValidationError("value is not in enum", path)
    if kind == "any":
        return value
    matches = {
        "null": value is None,
        "boolean": isinstance(value, bool),
        "number": isinstance(value, (int, float)) and not isinstance(value, bool),
        "integer": isinstance(value, int) and not isinstance(value, bool),
        "string": isinstance(value, str),
        "array": isinstance(value, list),
        "object": isinstance(value, dict),
    }
    if not matches[kind]:
        raise ValidationError(f"expected {kind}", path)
    if kind == "array" and "items" not in schema:
        raise ValidationError("array schema requires items", path)
    if kind == "array" and "items" in schema:
        for index, item in enumerate(value):
            validate_schema(schema["items"], item, f"{path}[{index}]")
    if kind == "object":
        props = schema.get("properties", {})
        if not isinstance(props, dict):
            raise ValidationError("schema properties must be an object", path)
        required = schema.get("required", [])
        if not isinstance(required, list) or any(not isinstance(k, str) for k in required):
            raise ValidationError("schema required must be string array", path)
        for key in required:
            if key not in props:
                raise ValidationError("required property has no schema", f"{path}.{key}")
            if key not in value:
                raise ValidationError("required property missing", f"{path}.{key}")
        extra = schema.get("additionalProperties", True)
        if not isinstance(extra, (bool, dict)):
            raise ValidationError("additionalProperties must be boolean or schema", path)
        for key, item in value.items():
            if key in props:
                validate_schema(props[key], item, f"{path}.{key}")
            elif extra is False:
                raise ValidationError("unexpected property", f"{path}.{key}")
            elif isinstance(extra, dict):
                validate_schema(extra, item, f"{path}.{key}")
    return value


@dataclass(frozen=True)
class ArtifactRef:
    digest: str
    size: int
    mediaType: str
    schemaId: str | None = None
    kind: Literal["artifact"] = field(default="artifact", init=False)

    def to_wire(self) -> dict[str, Any]:
        result = {"kind": "artifact", "digest": self.digest, "size": self.size, "mediaType": self.mediaType}
        if self.schemaId is not None:
            result["schemaId"] = self.schemaId
        validate_artifact_ref(result)
        return result


@dataclass(frozen=True)
class BindingSetRef:
    digest: str
    schemaId: str
    kind: Literal["binding-set"] = field(default="binding-set", init=False)

    def to_wire(self) -> dict[str, Any]:
        result = asdict(self)
        validate_binding_set_ref(result)
        return result


def validate_artifact_ref(value: Any, path: str = "$") -> dict[str, Any]:
    validate_schema({"type": "object", "properties": {
        "kind": {"type": "string", "enum": ["artifact"]},
        "digest": {"type": "string"}, "size": {"type": "integer"},
        "mediaType": {"type": "string"}, "schemaId": {"type": "string"}},
        "required": ["kind", "digest", "size", "mediaType"], "additionalProperties": False}, value, path)
    if value["size"] < 0 or not value["digest"] or not value["mediaType"]:
        raise ValidationError("invalid artifact metadata", path)
    return value


def validate_binding_set_ref(value: Any, path: str = "$") -> dict[str, Any]:
    validate_schema({"type": "object", "properties": {
        "kind": {"type": "string", "enum": ["binding-set"]},
        "digest": {"type": "string"}, "schemaId": {"type": "string"}},
        "required": ["kind", "digest", "schemaId"], "additionalProperties": False}, value, path)
    if not value["digest"] or not value["schemaId"]:
        raise ValidationError("invalid binding set reference", path)
    return value


@dataclass(frozen=True)
class OperationIntent:
    localKey: str
    kind: str
    input: Any
    bindingSetRef: BindingSetRef | None = None
    limits: dict[str, Any] | None = None

    def to_wire(self) -> dict[str, Any]:
        if not self.localKey or not self.kind:
            raise ValidationError("operation localKey and kind are required")
        result: dict[str, Any] = {"localKey": self.localKey, "kind": self.kind, "input": self.input}
        if self.bindingSetRef is not None:
            result["bindingSetRef"] = self.bindingSetRef.to_wire()
        if self.limits is not None:
            result["limits"] = self.limits
        validate_json(result)
        return result


@dataclass(frozen=True)
class AlgorithmDecision:
    nextState: Any
    operations: tuple[OperationIntent, ...] = ()
    bindingTransition: BindingSetRef | None = None
    complete: bool = False

    def to_wire(self) -> dict[str, Any]:
        result: dict[str, Any] = {"nextState": self.nextState, "operations": [op.to_wire() for op in self.operations]}
        if self.bindingTransition is not None:
            result["bindingTransition"] = self.bindingTransition.to_wire()
        if self.complete:
            result["complete"] = True
        validate_json(result)
        if len({op.localKey for op in self.operations}) != len(self.operations):
            raise ValidationError("duplicate operation localKey", "$.operations")
        return result


def decision_to_wire(value: AlgorithmDecision | dict[str, Any]) -> dict[str, Any]:
    if isinstance(value, AlgorithmDecision):
        return value.to_wire()
    validate_json(value)
    if not isinstance(value, dict) or "nextState" not in value:
        raise ValidationError("algorithm decision requires nextState")
    return value
