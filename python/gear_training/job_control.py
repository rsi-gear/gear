"""Ordered v2 commands, separate from immutable job/checkpoint identity."""
from .content import atomic_json, digest_json, require
from .state import load, lock


def control_job(service, request, key, intent):
    require(request.get("schemaVersion") == 2 and service.config.get("schemaVersion") == 2,
            "training-control-version", "ordered job control requires a v2 request and node")
    node = service.config["node"]; binding = request.get("deployment", {}).get("modelRuntime", {})
    require(binding.get("nodeId") == node["nodeId"] and binding.get("generation") == node["generation"],
            "training-node-drift", "control request belongs to another model node generation")
    require(isinstance(key, str) and key and isinstance(intent, dict) and set(intent) == {"schemaVersion", "sequence", "action"}
            and intent["schemaVersion"] == 2 and type(intent["sequence"]) is int and 0 <= intent["sequence"] <= 9007199254740991
            and intent["action"] in ("start", "pause"), "invalid-training-control", "control requires an ordered start or pause intent")
    handle = {"schemaVersion": 1, "provider": "slime", "jobId": "job_" + digest_json(key)[7:39], "requestDigest": digest_json(request)}
    directory = service.root / handle["jobId"]; path = directory / "control.json"
    with lock(service.root / "submission.lock"):
        record = load(path); identity = load(directory / "identity.json")
        if identity:
            require(identity == {"handle": handle, "keyDigest": digest_json(key)}, "idempotency-conflict", "control key identifies another frozen request")
            service.directory(handle)
        if record:
            require(record.get("schemaVersion") == 2 and record.get("handle") == handle and record.get("node") == node
                    and record.get("phase") in ("intent", "applied") and type(record.get("admissionOnly")) is bool,
                    "training-control-drift", "ordered control identity or durable state differs")
            previous = record["intent"]
            require(intent["sequence"] >= previous["sequence"], "training-control-stale", "a newer control intent fences this request")
            require(intent["sequence"] != previous["sequence"] or intent == previous,
                    "training-control-conflict", "a control sequence cannot change its meaning")
        else:
            previous = None
            # Old v2 paused jobs have no sequence proof. A plain retry cannot
            # adopt them by deleting the already durable cancellation marker.
            require(not (identity and intent == {"schemaVersion": 2, "sequence": 0, "action": "start"}
                         and (directory / "cancel.json").exists()), "training-control-resume-required", "a cancelled legacy job needs an explicit newer resume intent")
        if previous != intent:
            if intent["action"] == "start" and identity:
                status = service.inspect(handle)
                require(status["execution"] in ("running", "completed") or status["resourcesReleased"],
                        "previous-resources-not-released", "previous incarnation must release before a new start intent")
            record = {"schemaVersion": 2, "node": node, "handle": handle, "intent": intent, "phase": "intent",
                      "admissionOnly": not identity or bool(record and record["admissionOnly"])}
            atomic_json(path, record)
        if not identity and intent["action"] == "pause":
            # Cancellation can win before CAS upload or initial preflight.
            # This identity never owned a process or device, so it needs no GPU
            # observation to establish that this admission has released nothing.
            atomic_json(directory / "request.json", request)
            atomic_json(directory / "config.json", service.config)
            atomic_json(directory / "status.json", {"schemaVersion": 1, "handle": handle, "phase": "admitted", "execution": "paused",
                        "committedUpdate": 0, "usage": {"gpuSeconds": 0, "rolloutTokens": 0, "groupResamples": 0}, "resourcesReleased": True})
            atomic_json(directory / "identity.json", {"handle": handle, "keyDigest": digest_json(key)})
        if intent["action"] == "pause":
            result = service.cancel(handle, _controlled=True)
            record["phase"] = "applied"; atomic_json(path, record)
            return result
        if record["phase"] == "intent":
            service.submit(request, key, _control=record)
        else:
            status = service.inspect(handle)
            if status["execution"] == "running": service.ensure_worker(directory)
        return service.inspect(handle)
