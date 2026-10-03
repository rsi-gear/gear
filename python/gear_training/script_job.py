"""Durable CPU-friendly script jobs over the existing node JSON transport.

A start with a newer sequence resumes the same frozen loop. Pause is cooperative:
ordinary methods finish at the next stage boundary; long methods can call
runtime.check_cancel(). External updates still own operation_id idempotency.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import uuid
from pathlib import Path

from .content import ContentStore, ContractError, digest_json, require
from .loop import TrainingConfig, _copy, _bytes, _read, _write, _MISSING
from .recovery import process_identity, owned_session_alive
from .script_source import loaded_loop, source_files
from .state import lock


class ScriptRuntime:
    def __init__(self, directory, store):
        self.workspace, self.store = Path(directory), store

    def check_cancel(self):
        require(not (self.workspace / "cancel.json").exists(), "cancelled", "script job was paused")

    @property
    def hitch(self):
        raise ContractError("runtime-capability-unavailable", "Hitch requires the native training runtime")

    @property
    def slime(self):
        raise ContractError("runtime-capability-unavailable", "Slime requires the native training runtime")


class ScriptService:
    def __init__(self, config):
        self.config = config
        self.root = Path(config["nodeRoot"]).resolve() / "script-jobs"
        self.store = ContentStore(config["storeRoot"])

    def directory(self, handle):
        require(isinstance(handle, dict) and set(handle) == {"schemaVersion", "provider", "jobId", "requestDigest"}
                and handle["schemaVersion"] == 1 and handle["provider"] == "python-script"
                and isinstance(handle["jobId"], str) and len(handle["jobId"]) == 39
                and handle["jobId"].startswith("script_") and all(c in "0123456789abcdef" for c in handle["jobId"][7:]),
                "invalid-script-handle", "invalid script job identity")
        directory = self.root / handle["jobId"]
        identity = _read(directory / "identity.json")
        require(identity is not _MISSING and identity.get("handle") == handle, "script-job-not-found", "script handle differs from persisted identity")
        request = _read(directory / "request.json")
        require(request is not _MISSING and digest_json(request) == handle["requestDigest"], "script-request-drift", "frozen request changed")
        return directory

    @staticmethod
    def validate_request(request):
        require(isinstance(request, dict) and set(request) == {"schemaVersion", "script", "config"}
                and request["schemaVersion"] == 1, "invalid-script-request", "script request requires schema/script/config")
        config = request["config"]
        require(isinstance(config, dict) and set(config) == {"rounds", "initialCheckpoint", "parameters"}
                and type(config["rounds"]) is int and config["rounds"] > 0 and isinstance(config["parameters"], dict),
                "invalid-script-config", "config needs positive rounds, initialCheckpoint and parameters")
        _copy(config)

    def control(self, payload):
        require(isinstance(payload, dict) and set(payload) == {"request", "idempotencyKey", "intent"},
                "invalid-script-control", "control requires request/idempotencyKey/intent")
        request, key, intent = payload["request"], payload["idempotencyKey"], payload["intent"]
        self.validate_request(request)
        require(isinstance(key, str) and bool(key) and isinstance(intent, dict) and set(intent) == {"sequence", "action"}
                and type(intent["sequence"]) is int and 0 <= intent["sequence"] <= 9007199254740991
                and intent["action"] in ("start", "pause"), "invalid-script-control", "ordered start/pause intent required")
        handle = {"schemaVersion": 1, "provider": "python-script", "jobId": "script_" + digest_json(key)[7:39],
                  "requestDigest": digest_json(request)}
        directory = self.root / handle["jobId"]
        with lock(self.root / "submission.lock"):
            identity = _read(directory / "identity.json")
            expected = {"handle": handle, "keyDigest": digest_json(key)}
            require(identity is _MISSING or identity == expected, "idempotency-conflict", "key already identifies another frozen script request")
            previous = _read(directory / "control.json")
            if previous is not _MISSING:
                require(intent["sequence"] >= previous["sequence"], "script-control-stale", "newer intent fences this request")
                require(intent["sequence"] != previous["sequence"] or intent == previous,
                        "script-control-conflict", "sequence cannot change meaning")
                if intent == previous:
                    return self.inspect({"handle": handle})
            if identity is not _MISSING:
                status = self.inspect({"handle": handle})
                require(intent["action"] != "start" or status["resourcesReleased"],
                        "previous-resources-not-released", "previous worker must exit before resume")
            # A pause may win admission before script objects are uploaded.
            if intent["action"] == "start": source_files(self.store, request["script"])
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            if identity is _MISSING:
                _write(directory / "identity.json", expected)
                _write(directory / "request.json", request)
            else: self.directory(handle)
            _write(directory / "control.json", intent)
            if intent["action"] == "pause":
                _write(directory / "cancel.json", intent)
                status = self.inspect({"handle": handle})
                if status["execution"] not in ("completed", "failed"):
                    status["execution"] = "pausing" if not status["resourcesReleased"] else "paused"
                    _write(directory / "status.json", status)
                return self.inspect({"handle": handle})
            (directory / "cancel.json").unlink(missing_ok=True)
            old = _read(directory / "status.json")
            if old is not _MISSING and old.get("execution") == "completed":
                return self.inspect({"handle": handle})
            _write(directory / "status.json", {"handle": handle, "execution": "running", "resourcesReleased": False})
            token = uuid.uuid4().hex
            _write(directory / "worker.json", {"token": token, "sequence": intent["sequence"], "process": None})
            _write(directory / "service.json", {"nodeRoot": str(self.root.parent), "storeRoot": str(self.store.root)})
            command = [self.config.get("python", sys.executable), "-m", "gear_training.script_job", "_worker", str(directory), token]
            try:
                with (directory / "worker.log").open("ab") as log:
                    worker = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
                _write(directory / "worker.json", {"token": token, "sequence": intent["sequence"], "process": process_identity(worker.pid)})
                threading.Thread(target=worker.wait, daemon=True).start()
            except Exception as error:
                _write(directory / "status.json", {"handle": handle, "execution": "failed", "resourcesReleased": True,
                       "error": {"code": "script-launch-failed", "message": str(error)}})
                raise
            return self.inspect({"handle": handle})

    def inspect(self, payload):
        require(isinstance(payload, dict) and set(payload) == {"handle"}, "invalid-script-inspect", "inspect requires handle")
        handle = payload["handle"]; directory = self.directory(handle)
        saved = _read(directory / "status.json")
        if saved is _MISSING:
            intent = _read(directory / "control.json")
            status = {"handle": handle, "execution": "interrupted" if intent is not _MISSING and intent.get("action") == "start" else "paused", "resourcesReleased": True}
        else: status = _copy(saved)
        require(status.get("handle") == handle, "script-status-drift", "status handle changed")
        worker = _read(directory / "worker.json")
        active = worker is not _MISSING and worker.get("process") and owned_session_alive(worker["process"])
        status["resourcesReleased"] = not bool(active)
        if status["execution"] == "running" and active and (directory / "cancel.json").exists(): status["execution"] = "pausing"
        if status["execution"] in ("running", "pausing") and not active:
            status["execution"] = "paused" if (directory / "cancel.json").exists() else "interrupted"
        if status["execution"] == "completed":
            require(status.get("resultRef") and self.store.read_json(status["resultRef"]) == status.get("result"),
                    "script-result-drift", "completed result differs from sealed artifact")
        return status


def worker_run(directory, token):
    directory = Path(directory)
    service = ScriptService(_read(directory / "service.json"))
    with lock(service.root / "submission.lock"):
        identity, owner, intent = (_read(directory / name) for name in ("identity.json", "worker.json", "control.json"))
        require(owner.get("token") == token and owner.get("sequence") == intent.get("sequence")
                and intent["action"] == "start", "script-worker-fenced", "worker was superseded before registration")
        handle = identity["handle"]; service.directory(handle)
        require(owner.get("process") == process_identity(os.getpid()), "script-worker-fenced", "worker process differs")
    runtime = ScriptRuntime(directory, service.store)
    def progress(value):
        with lock(service.root / "submission.lock"):
            runtime.check_cancel()
            _write(directory / "status.json", {"handle": handle, "execution": "running", "progress": value, "resourcesReleased": False})
    try:
        runtime.check_cancel()
        request = _read(directory / "request.json")
        with loaded_loop(service.store, request["script"], _copy(request["config"]), runtime, directory / "source") as loop:
            previous_cancel, previous_progress = loop.check_cancel, loop.on_progress
            def check_cancel(): runtime.check_cancel(); previous_cancel()
            def on_progress(value): progress(value); previous_progress(value)
            loop.check_cancel, loop.on_progress = check_cancel, on_progress
            config = request["config"]
            result = loop.run(TrainingConfig(directory / "loop", config["rounds"], config["initialCheckpoint"], config["parameters"]))
        runtime.check_cancel()
        body = {"checkpoint": result.checkpoint, "history": result.history, "roundsCompleted": result.rounds_completed}
        ref = service.store.put_bytes(_bytes(body), "application/json")
        with lock(service.root / "submission.lock"):
            runtime.check_cancel()
            _write(directory / "status.json", {"handle": handle, "execution": "completed", "result": body, "resultRef": ref, "resourcesReleased": False})
    except Exception as error:
        _write(directory / "status.json", {"handle": handle, "execution": "paused" if getattr(error, "code", None) == "cancelled" else "failed",
               "error": {"code": getattr(error, "code", "script-failed"), "message": str(error)}, "resourcesReleased": False})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("control", "inspect", "_worker"))
    parser.add_argument("config_or_directory"); parser.add_argument("token", nargs="?")
    args = parser.parse_args()
    if args.operation == "_worker": return worker_run(args.config_or_directory, args.token)
    service = ScriptService(_read(args.config_or_directory))
    print(json.dumps(getattr(service, args.operation)(json.load(sys.stdin))))


if __name__ == "__main__": main()
