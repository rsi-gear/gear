"""Verify a same-generation engine without launching, fencing or probing tokens."""
import json
import math
import re
import urllib.request

from .content import digest_json, require
from .node_runtime import observe_runtime
from .state import load, lock


def attach_service(service, payload):
    from .inference_process import runtime_matches

    require(isinstance(payload, dict) and set(payload) == {
        "serviceId", "ownerId", "inferenceId", "inputDigest", "expectedHandle"},
        "invalid-inference-attach", "attachment requires the original request and process handle")
    directory = service.directory(payload)
    with lock(directory / "launch.lock"):
        identity = service.identity(directory, payload)
        request = load(directory / "request.json")
        require(request and identity.get("inputDigest") == payload["inputDigest"] == digest_json(request)
                and request.get("serviceId") == directory.name and request.get("ownerId") == payload["ownerId"]
                and identity.get("inferenceId") == payload["inferenceId"] == request["lock"]["inference_id"],
                "inference-attach-drift", "attachment differs from the original immutable start request")
        status = load(directory / "status.json")
        require(status and status.get("schemaVersion") == 2 and status.get("state") == "ready"
                and status.get("resourcesReleased") is False and not (directory / "stop.json").exists(),
                "inference-attach-unavailable", "only an unfenced ready service can be reattached")
        handle = payload["expectedHandle"]
        require(isinstance(handle, dict) and set(handle) == {
            "schema_version", "kind", "node_id", "generation", "service_id", "process"}
            and handle == status.get("handle") and handle["schema_version"] == "2" and handle["kind"] == "process"
            and handle["node_id"] == service.node["nodeId"] and handle["generation"] == service.node["generation"]
            and handle["service_id"] == directory.name, "inference-attach-drift", "process handle differs from the original service")
        process = handle["process"]
        require(isinstance(process, dict) and set(process) == {"pid", "created_at"}
                and type(process["pid"]) is int and process["pid"] > 0
                and type(process["created_at"]) in (int, float) and math.isfinite(process["created_at"]) and process["created_at"] > 0,
                "invalid-inference-attach", "attachment process identity is invalid")
        supervisor = {"pid": process["pid"], "createdAt": process["created_at"]}
        engine = load(directory / "engine.json")
        require(isinstance(engine, dict) and set(engine) == {"pid", "createdAt"}
                and type(engine["pid"]) is int and engine["pid"] > 0 and engine["pid"] != supervisor["pid"]
                and type(engine["createdAt"]) in (int, float) and math.isfinite(engine["createdAt"]) and engine["createdAt"] > 0,
                "inference-process-unconfirmed", "original engine identity is missing or invalid")
        backend = request["lock"]["execution"]["platform"]
        devices = [backend["device_constraint"]] if backend["backend"] == "cuda" else []
        service.devices.verify_active(service.owner(directory.name), devices, [supervisor, engine])
        actual = observe_runtime()
        runtime_matches(request["runtime"], actual)
        require(digest_json(status.get("runtime")) == digest_json(actual),
                "node-runtime-drift", "current runtime differs from the running engine's startup environment")
        access = load(directory / "access.json")
        require(isinstance(access, dict) and set(access) == {"port", "wireModel", "engineToken", "adminToken"}
                and type(access["port"]) is int and 1 <= access["port"] <= 65535
                and access["port"] == service.config["inferencePort"]
                and access["wireModel"] == "hitch-" + request["model"]["model_id"][7:23]
                and all(isinstance(access[k], str) and re.fullmatch(r"[a-f0-9]{64}", access[k]) for k in ("engineToken", "adminToken")),
                "inference-attach-drift", "private service access differs from the original launch")
        query = urllib.request.Request("http://127.0.0.1:" + str(access["port"]) + "/server_info",
                                       headers={"Authorization": "Bearer " + access["engineToken"]})
        with urllib.request.urlopen(query, timeout=5) as response:
            raw = response.read(2 * 1024 * 1024 + 1)
            require(response.status == 200 and len(raw) <= 2 * 1024 * 1024,
                    "inference-attach-unavailable", "live engine observation is unavailable")
            info = json.loads(raw)
        # The engine may have exited during the HTTP observation. Never turn
        # an attachment failure into permission to stop or replace it.
        service.devices.verify_active(service.owner(directory.name), devices, [supervisor, engine])
        return {**status, "inferenceId": identity["inferenceId"], "inputDigest": identity["inputDigest"],
                "access": access, "runtime": actual, "serverInfo": info, "gpuUuid": devices[0] if devices else None}
