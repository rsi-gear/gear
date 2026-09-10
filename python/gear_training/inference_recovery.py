"""Drain immutable inference ownership across a verified OS-boot change."""
import math
import re

from .content import atomic_json, digest_json, require
from .node_generation import archived_boot_digest, previous_boot_proof
from .state import load, lock


def _handle(value, service_id, node):
    if value is None: return
    require(isinstance(value, dict) and set(value) == {"schema_version", "kind", "node_id", "generation", "service_id", "process"}
            and value["schema_version"] == "2" and value["kind"] == "process" and value["node_id"] == node["nodeId"]
            and value["generation"] == node["generation"] and value["service_id"] == service_id,
            "inference-handle-drift", "prior service process handle changed its ownership")
    process = value["process"]
    require(isinstance(process, dict) and set(process) == {"pid", "created_at"} and type(process["pid"]) is int and process["pid"] > 0
            and type(process["created_at"]) in (int, float) and math.isfinite(process["created_at"]) and process["created_at"] > 0,
            "inference-handle-drift", "prior service process identity is invalid")


def recover_previous_service(service, payload):
    require(set(payload) == {"serviceId", "ownerId", "inferenceId", "previousNode", "expectedHandle"},
            "invalid-inference-recovery", "prior-generation recovery requires an exact service, lock, node and handle")
    directory = service.directory(payload)
    with lock(service.root / "admission.lock"), lock(directory / "launch.lock"):
        identity = load(directory / "identity.json")
        require(identity and identity["node"] == payload["previousNode"] and identity["ownerId"] == payload["ownerId"]
                and identity.get("inferenceId") == payload["inferenceId"] and isinstance(payload["inferenceId"], str)
                and re.fullmatch(r"sha256:[a-f0-9]{64}", payload["inferenceId"]),
                "inference-owner-drift", "prior service is missing or belongs to another owner, lock or generation")
        previous_boot_proof(service.config["nodeRoot"], service.node, payload["previousNode"])
        status = load(directory / "status.json", {"state": "admitting"})
        handle = status.get("handle")
        _handle(handle, directory.name, payload["previousNode"])
        _handle(payload["expectedHandle"], directory.name, payload["previousNode"])
        require(payload["expectedHandle"] is None or payload["expectedHandle"] == handle,
                "inference-handle-drift", "observed prior service handle differs from the controller record")
        prior_receipt = load(directory / "generation-release.json")
        admission_only = not handle and status["state"] == "admitting"
        if prior_receipt:
            _receipt_identity(service.config["nodeRoot"], prior_receipt, identity, directory.name, handle)
            admission_only = prior_receipt["admissionOnly"]
        atomic_json(directory / "stop.json", {"reason": "generation-recovery"})
        released = service.devices.release_previous_owner(service.owner(directory.name), identity["node"], allow_missing=admission_only)
        receipt = {"schemaVersion": 2, "kind": "inference-generation-release", "serviceId": directory.name,
                   "ownerId": identity["ownerId"], "inferenceId": identity["inferenceId"], "previousNode": identity["node"], "node": service.node,
                   "sourceIdentityDigest": digest_json(identity), "handle": handle, "admissionOnly": admission_only,
                   "state": "stopped", "resourcesReleased": True, **released}
        atomic_json(directory / "generation-release.json", receipt)
        atomic_json(directory / "status.json", {**status, "state": "stopped", "resourcesReleased": True, "gpuSeconds": receipt["gpuSeconds"]})
        return receipt


def previous_service_released(service, directory, identity):
    receipt = load(directory / "generation-release.json")
    status = load(directory / "status.json")
    require(receipt and status and status["state"] == "stopped" and load(directory / "stop.json") == {"reason": "generation-recovery"},
            "inference-node-busy", "prior-generation service has no confirmed recovery receipt")
    _receipt_identity(service.config["nodeRoot"], receipt, identity, directory.name, status.get("handle"))
    previous_boot_proof(service.config["nodeRoot"], service.node, identity["node"])
    return service.devices.previous_owner_released(service.owner(directory.name), identity["node"], allow_missing=receipt["admissionOnly"])


def _receipt_identity(root, receipt, identity, service_id, handle):
    keys = {"schemaVersion", "kind", "serviceId", "ownerId", "inferenceId", "previousNode", "node", "sourceIdentityDigest", "handle", "admissionOnly",
            "state", "resourcesReleased", "devices", "gpuSeconds", "previousBootDigest", "currentBootDigest"}
    require(isinstance(receipt, dict) and set(receipt) == keys and receipt.get("schemaVersion") == 2 and receipt.get("kind") == "inference-generation-release"
            and receipt.get("serviceId") == service_id and receipt.get("ownerId") == identity["ownerId"]
            and receipt.get("inferenceId") == identity["inferenceId"] and receipt.get("previousNode") == identity["node"]
            and receipt.get("sourceIdentityDigest") == digest_json(identity) and receipt.get("handle") == handle
            and type(receipt.get("admissionOnly")) is bool and receipt.get("state") == "stopped" and receipt.get("resourcesReleased") is True
            and type(receipt.get("gpuSeconds")) in (int, float) and math.isfinite(receipt["gpuSeconds"]) and receipt["gpuSeconds"] >= 0
            and isinstance(receipt.get("devices"), list) and all(isinstance(d, str) and re.fullmatch(r"GPU-[a-fA-F0-9-]+", d) for d in receipt["devices"])
            and len(receipt["devices"]) == len(set(receipt["devices"]))
            and (not receipt["admissionOnly"] or (handle is None and not receipt["devices"] and receipt["gpuSeconds"] == 0)),
            "inference-recovery-drift", "prior-generation release receipt changed its immutable source")
    require(receipt["previousBootDigest"] == archived_boot_digest(root, identity["node"])
            and receipt["currentBootDigest"] == archived_boot_digest(root, receipt["node"])
            and receipt["previousBootDigest"] != receipt["currentBootDigest"] and receipt["node"]["nodeId"] == identity["node"]["nodeId"],
            "inference-recovery-drift", "release receipt has no matching archived OS boot transition")
