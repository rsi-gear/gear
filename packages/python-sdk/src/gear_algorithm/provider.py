"""Public Python provider SPI and artifact bridge for trusted local providers."""
from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass
from typing import Any, Callable, Protocol

from .errors import ValidationError
from .manifest import ProviderManifest
from .protocol import ArtifactRef, validate_artifact_ref, validate_json


class Provider(Protocol):
    def describe(self) -> ProviderManifest | dict[str, Any]: ...
    def preflight(self, request: dict[str, Any]) -> dict[str, Any]: ...
    def submit(self, request: dict[str, Any]) -> dict[str, Any]: ...
    def inspect(self, request: dict[str, Any]) -> dict[str, Any]: ...
    def cancel(self, request: dict[str, Any]) -> dict[str, Any]: ...
    def collect(self, request: dict[str, Any]) -> dict[str, Any]: ...


@dataclass
class ArtifactClient:
    """Use host-authorized artifact methods; providers never import TS stores."""
    call: Callable[[str, dict[str, Any]], Any]

    def write(self, content: bytes, *, media_type: str, schema_id: str | None = None) -> ArtifactRef:
        if not isinstance(content, bytes):
            raise ValidationError("artifact content must be bytes")
        request: dict[str, Any] = {"contentBase64": base64.b64encode(content).decode("ascii"),
                                   "mediaType": media_type}
        if schema_id is not None:
            request["schemaId"] = schema_id
        wire = self.call("artifact.put", request)
        validate_artifact_ref(wire)
        return ArtifactRef(digest=wire["digest"], size=wire["size"],
                           mediaType=wire["mediaType"], schemaId=wire.get("schemaId"))

    def read(self, ref: ArtifactRef) -> bytes:
        response = self.call("artifact.get", {"ref": ref.to_wire()})
        if not isinstance(response, dict) or not isinstance(response.get("contentBase64"), str):
            raise ValidationError("artifact.get returned invalid response")
        try:
            return base64.b64decode(response["contentBase64"], validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ValidationError("artifact.get returned invalid base64") from exc


def validate_scientific_outcome(value: Any) -> dict[str, Any]:
    validate_json(value)
    if not isinstance(value, dict) or value.get("kind") not in ("result", "no-result", "inconclusive"):
        raise ValidationError("scientific outcome kind must be result, no-result or inconclusive")
    if value["kind"] == "result" and "value" not in value:
        raise ValidationError("result requires value")
    return value


class LocalProvider:
    """Base class for synchronous, idempotent local providers.

    Implement execute(request, artifacts). The durable record must be supplied
    by the host or by a provider-owned store that survives worker restarts.
    A memory-only subclass is suitable for tests, never production recovery.
    """

    def __init__(self, manifest: ProviderManifest, artifacts: ArtifactClient | None = None) -> None:
        self.manifest = manifest
        self.artifacts = artifacts

    def bind_artifacts(self, artifacts: ArtifactClient) -> None:
        self.artifacts = artifacts

    def describe(self) -> ProviderManifest:
        return self.manifest

    def preflight(self, request: dict[str, Any]) -> dict[str, Any]:
        return {"ok": True}

    def submit(self, request: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError("provide durable submit and inspect")

    def inspect(self, request: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError("provide durable submit and inspect")

    def cancel(self, request: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError("provide cancellation status")

    def collect(self, request: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError("provide a retained result")

class DurableLocalProvider(LocalProvider):
    """Durable adapter for deterministic, synchronous local calculations only.

    The record is provider-owned and keyed by the host's stable idempotency key.
    External services and non-repeatable side effects need their own durable
    submit/inspect implementation; this helper cannot recover an unknown send.
    """

    def __init__(self, manifest: ProviderManifest, record_dir: str | None = None,
                 artifacts: ArtifactClient | None = None, metering_source: str | None = None) -> None:
        import os
        super().__init__(manifest, artifacts)
        from pathlib import Path
        location = record_dir or os.environ.get("GEAR_ALGORITHM_PROVIDER_RECORD_DIR")
        self.record_dir = Path(location).resolve() if location else None
        self.metering_source = metering_source or manifest.kind
        if self.record_dir is not None:
            self.record_dir.mkdir(parents=True, exist_ok=True)

    def execute(self, request: dict[str, Any]) -> dict[str, Any]:
        """Return a scientific outcome; override in a local provider."""
        raise NotImplementedError

    def usage_receipt(self, request: dict[str, Any], outcome: dict[str, Any]) -> dict[str, Any] | None:
        """Metered subclasses must report actual final cumulative usage, including zeroes."""
        if self.manifest.meteredDimensions:
            raise ValidationError("metered local provider must implement usage_receipt")
        return None

    def _zero_receipt(self, request: dict[str, Any]) -> dict[str, Any]:
        return {"source": self.metering_source, "scope": "operation",
                "operationId": request["operationId"], "cursor": "cancelled-before-start",
                "cumulative": {name: 0 for name in self.manifest.meteredDimensions}}

    def _path(self, request: dict[str, Any]):
        import hashlib
        key = request.get("idempotencyKey")
        if not isinstance(key, str) or not key:
            raise ValidationError("idempotencyKey is required")
        if self.record_dir is None:
            raise ValidationError("provider record directory is required")
        return self.record_dir / (hashlib.sha256(key.encode("utf-8")).hexdigest() + ".json")

    @staticmethod
    def _identity(request: dict[str, Any]) -> dict[str, str]:
        keys = ("operationId", "idempotencyKey", "inputDigest", "implementationDigest")
        result = {}
        for key in keys:
            value = request.get(key)
            if not isinstance(value, str) or not value:
                raise ValidationError(f"{key} is required")
            result[key] = value
        return result

    def _existing(self, request: dict[str, Any]):
        import json
        path = self._path(request)
        if not path.exists():
            return None
        record = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(record, dict) or record.get("identity") != self._identity(request) or record.get("status") not in ("started", "completed", "cancelled"):
            raise ValidationError("provider record identity drift or corruption")
        return record

    def _fsync_directory(self) -> None:
        import os
        directory_fd = os.open(self.record_dir, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)

    def preflight(self, request: dict[str, Any]) -> dict[str, Any]:
        from .protocol import validate_schema
        if request.get("kind") != self.manifest.kind:
            raise ValidationError("provider kind does not match manifest")
        self._identity(request)
        validate_schema(self.manifest.inputSchema, request.get("input"), "$.input")
        self._existing(request)
        return {"ok": True}

    def submit(self, request: dict[str, Any]) -> dict[str, Any]:
        import json
        import os
        import tempfile
        self.preflight(request)
        record = self._existing(request)
        if record is not None:
            if record["status"] == "started":
                raise ValidationError("started local operation has unknown outcome; inspect or reconcile")
            if record["status"] == "cancelled":
                raise ValidationError("cancelled local operation cannot be submitted")
            return {"status": "completed", "completion": record["completion"]}
        path = self._path(request)
        identity = self._identity(request)
        fd, started_temp = tempfile.mkstemp(prefix=".gear-started-", dir=self.record_dir)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as output:
                json.dump({"status": "started", "identity": identity}, output, ensure_ascii=True, separators=(",", ":"))
                output.flush()
                os.fsync(output.fileno())
            try:
                os.link(started_temp, path)
            except FileExistsError:
                return self.submit(request)
            self._fsync_directory()
        finally:
            if os.path.exists(started_temp):
                os.unlink(started_temp)
        # If execution raises or the worker dies, the started marker remains.
        # Resume reports unknown and never silently replays the operation.
        outcome = validate_scientific_outcome(self.execute(request))
        if outcome["kind"] == "result":
            from .protocol import validate_schema
            validate_schema(self.manifest.outputSchema, outcome["value"], "$.outcome.value")
        receipt = self.usage_receipt(request, outcome)
        if self.manifest.meteredDimensions and receipt is None:
            raise ValidationError("metered local provider omitted final usage receipt")
        if receipt is not None:
            validate_json(receipt)
            if (not isinstance(receipt, dict) or receipt.get("source") != self.metering_source
                or receipt.get("scope") != "operation" or receipt.get("operationId") != request["operationId"]
                or not isinstance(receipt.get("cursor"), str) or not receipt["cursor"]
                or not isinstance(receipt.get("cumulative"), dict)
                or set(receipt["cumulative"]) != set(self.manifest.meteredDimensions)
                or any(name not in receipt["cumulative"] or not isinstance(receipt["cumulative"][name], (int, float))
                       or isinstance(receipt["cumulative"][name], bool) or receipt["cumulative"][name] < 0
                       for name in self.manifest.meteredDimensions)):
                raise ValidationError("invalid final local-provider usage receipt")
        completion = {**identity, "outcome": outcome, **({"receipt": receipt} if receipt is not None else {})}
        record = {"status": "completed", "identity": identity, "completion": completion}
        fd, temporary = tempfile.mkstemp(prefix=".gear-provider-", dir=self.record_dir)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as output:
                json.dump(record, output, ensure_ascii=True, allow_nan=False, separators=(",", ":"))
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, path)
            self._fsync_directory()
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return {"status": "completed", "completion": completion}

    def inspect(self, request: dict[str, Any]) -> dict[str, Any]:
        record = self._existing(request)
        if record is None:
            return {"status": "not-started"}
        if record["status"] == "started":
            return {"status": "unknown"}
        if record["status"] == "cancelled":
            return {"status": "cancelled", "releaseConfirmed": True,
                    "receipt": self._zero_receipt(request)}
        return {"status": "completed", "completion": record["completion"]}

    def cancel(self, request: dict[str, Any]) -> dict[str, Any]:
        import json
        import os
        import tempfile
        self.preflight(request)
        status = self.inspect(request)
        if status["status"] != "not-started":
            return status
        path = self._path(request)
        fd, temporary = tempfile.mkstemp(prefix=".gear-cancelled-", dir=self.record_dir)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as output:
                json.dump({"status": "cancelled", "identity": self._identity(request)}, output,
                          ensure_ascii=True, separators=(",", ":"))
                output.flush()
                os.fsync(output.fileno())
            try:
                os.link(temporary, path)
            except FileExistsError:
                return self.cancel(request)
            self._fsync_directory()
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return {"status": "cancelled", "releaseConfirmed": True,
                "receipt": self._zero_receipt(request)}

    def collect(self, request: dict[str, Any]) -> dict[str, Any]:
        record = self._existing(request)
        if record is None or record["status"] != "completed":
            raise ValidationError("provider result is unavailable")
        return record["completion"]
