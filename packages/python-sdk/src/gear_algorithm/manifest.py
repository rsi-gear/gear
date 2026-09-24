"""Typed author manifests; the host fills implementation and environment identity."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Literal

from .errors import ValidationError
from .protocol import JSONSchema, assert_schema, validate_json, validate_schema

API_VERSION = "gear.algorithm.experimental.v1"


def _check_schema(schema: JSONSchema) -> None:
    if not isinstance(schema, dict) or schema.get("type") not in (
        "any", "null", "boolean", "number", "integer", "string", "array", "object"
    ):
        raise ValidationError("manifest schema must use the Gear JSON schema subset")
    assert_schema(schema)


@dataclass(frozen=True)
class AlgorithmManifest:
    id: str
    stateSchema: JSONSchema
    configSchema: JSONSchema
    bindingSchema: dict[str, Any]
    apiVersion: str = API_VERSION
    requiredHooks: dict[str, dict[str, Any]] = field(default_factory=dict)
    requiredOperationKinds: tuple[str, ...] = ()

    def to_wire(self) -> dict[str, Any]:
        _check_schema(self.stateSchema)
        _check_schema(self.configSchema)
        for name, requirement in self.requiredHooks.items():
            if not isinstance(name, str) or not isinstance(requirement, dict):
                raise ValidationError("requiredHooks must map names to schema declarations")
            _check_schema(requirement.get("inputSchema"))
            _check_schema(requirement.get("outputSchema"))
            if requirement.get("scope") not in ("campaign", "decision"):
                raise ValidationError("hook scope must be campaign or decision")
        if (not isinstance(self.requiredOperationKinds, (tuple, list))
            or any(not isinstance(kind, str) or not kind for kind in self.requiredOperationKinds)
            or len(set(self.requiredOperationKinds)) != len(self.requiredOperationKinds)):
            raise ValidationError("requiredOperationKinds must contain unique nonempty kinds")
        result = vars(self).copy()
        result["requiredOperationKinds"] = list(self.requiredOperationKinds)
        validate_json(result)
        return result


@dataclass(frozen=True)
class ComponentManifest:
    id: str
    inputSchema: JSONSchema
    outputSchema: JSONSchema
    scope: str = "campaign"
    apiVersion: str = API_VERSION
    language: Literal["python"] = "python"
    failureSemantics: Literal["typed-error"] = "typed-error"
    capabilities: tuple[str, ...] = ()

    def to_wire(self) -> dict[str, Any]:
        if not self.id or not self.scope:
            raise ValidationError("component id and scope are required")
        _check_schema(self.inputSchema)
        _check_schema(self.outputSchema)
        result = vars(self).copy()
        result["capabilities"] = list(self.capabilities)
        validate_json(result)
        return result


@dataclass(frozen=True)
class ProviderManifest:
    kind: str
    inputSchema: JSONSchema
    outputSchema: JSONSchema
    execution: Literal["trusted-local", "external"] = "trusted-local"
    supportsInspect: Literal[True] = True
    hardLimitDimensions: tuple[str, ...] = ()
    meteredDimensions: tuple[str, ...] = ()

    def to_wire(self) -> dict[str, Any]:
        if not self.kind:
            raise ValidationError("provider kind is required")
        _check_schema(self.inputSchema)
        _check_schema(self.outputSchema)
        result = vars(self).copy()
        result["hardLimitDimensions"] = list(self.hardLimitDimensions)
        result["meteredDimensions"] = list(self.meteredDimensions)
        validate_json(result)
        return result


class Component:
    """Wrap a policy function with its input/output contract."""

    def __init__(self, manifest: ComponentManifest, function: Callable[[Any], Any]) -> None:
        self.manifest = manifest
        self.function = function

    def describe(self) -> dict[str, Any]:
        return self.manifest.to_wire()

    def invoke(self, value: Any) -> Any:
        validate_schema(self.manifest.inputSchema, value, "$.input")
        output = self.function(value)
        validate_schema(self.manifest.outputSchema, output, "$.output")
        return output


def component(*, id: str, input_schema: JSONSchema, output_schema: JSONSchema,
              scope: str = "campaign") -> Callable[[Callable[[Any], Any]], Component]:
    manifest = ComponentManifest(id, input_schema, output_schema, scope)

    def decorate(function: Callable[[Any], Any]) -> Component:
        return Component(manifest, function)

    return decorate
