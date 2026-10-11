"""Public provider conformance probes for deterministic local adapters."""
from __future__ import annotations

import base64
import hashlib
import json
from typing import Any, Callable

from .errors import ValidationError
from .provider import ArtifactClient, Provider


class MemoryArtifactBridge:
    def __init__(self) -> None:
        self.objects: dict[str, tuple[bytes, str, str | None]] = {}

    def call(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        if method == "artifact.put":
            data = base64.b64decode(params["contentBase64"], validate=True)
            media = params["mediaType"]
            schema = params.get("schemaId")
            digest = hashlib.sha256(json.dumps([media, schema, params["contentBase64"]], separators=(",", ":")).encode()).hexdigest()
            self.objects[digest] = (data, media, schema)
            result = {"kind": "artifact", "digest": digest, "size": len(data), "mediaType": media}
            if schema is not None:
                result["schemaId"] = schema
            return result
        if method == "artifact.get":
            ref = params["ref"]
            data, media, schema = self.objects[ref["digest"]]
            if media != ref["mediaType"] or schema != ref.get("schemaId") or len(data) != ref["size"]:
                raise ValidationError("artifact metadata mismatch")
            return {"contentBase64": base64.b64encode(data).decode("ascii")}
        raise ValidationError("unsupported artifact test method")

    def client(self) -> ArtifactClient:
        return ArtifactClient(self.call)


def check_durable_provider(factory: Callable[[], Provider], request: dict[str, Any]) -> dict[str, Any]:
    """Exercise duplicate, drift, lost reply, restart inspect and result retention."""
    first = factory()
    assert first.inspect(request)["status"] == "not-started"
    first.preflight(request)
    submitted = first.submit(request)
    assert submitted["status"] == "completed"
    assert first.submit(request) == submitted
    assert first.collect(request) == submitted["completion"]
    # Simulate dropping submit's reply: a fresh instance must inspect the same key.
    restarted = factory()
    assert restarted.inspect(request) == submitted
    assert restarted.collect(request) == submitted["completion"]
    drift = dict(request)
    drift["inputDigest"] = "0" * 64 if request["inputDigest"] != "0" * 64 else "1" * 64
    try:
        restarted.submit(drift)
    except ValidationError:
        pass
    else:
        raise AssertionError("provider accepted idempotency input drift")
    assert restarted.cancel(request) == submitted
    return submitted["completion"]


def check_repeated_usage(provider: Provider, request: dict[str, Any]) -> None:
    """Probe receipt cursor stability and cumulative monotonicity on inspect."""
    first = provider.inspect(request)
    second = provider.inspect(request)
    a, b = first.get("receipt"), second.get("receipt")
    if a is None or b is None:
        raise AssertionError("provider did not return inspect usage receipts")
    if a.get("source") != b.get("source") or a.get("scope") != b.get("scope") or a.get("operationId") != b.get("operationId"):
        raise AssertionError("receipt source/scope identity changed")
    if a.get("cursor") == b.get("cursor") and a.get("cumulative") != b.get("cumulative"):
        raise AssertionError("same usage cursor changed cumulative totals")
    for dimension, amount in a.get("cumulative", {}).items():
        if b.get("cumulative", {}).get(dimension, -1) < amount:
            raise AssertionError("usage cumulative total regressed")


def check_unreleased_cancel(provider: Provider, request: dict[str, Any]) -> None:
    """Require an ambiguous external cancel to retain its reservation."""
    status = provider.cancel(request)
    if status.get("status") == "unknown":
        return
    if status.get("status") != "cancelled" or status.get("releaseConfirmed") is not False:
        raise AssertionError("unconfirmed cancellation was reported as released")
