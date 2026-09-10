"""Model-node control protocol. SSH transports bytes; durable state owns work.

The same protocol runs locally. JSON RPC never carries model/checkpoint bytes.
Binary CAS import/export are separate streams with a small JSON header.
"""
from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import platform
import re
import subprocess
import sys
import uuid
from pathlib import Path

from .content import ContentStore, atomic_json, digest_file, digest_json, require, sync_dir
from .state import lock, load
from .node_generation import record_generation

MAX_HEADER = 1024 * 1024
BLOCK = 8 * 1024 * 1024


def read_header(stream):
    line = stream.readline(MAX_HEADER + 1)
    require(len(line) <= MAX_HEADER and line.endswith(b"\n"), "invalid-node-header", "node stream header is missing or oversized")
    return json.loads(line)


def boot_identity():
    path = Path("/proc/sys/kernel/random/boot_id")
    if path.is_file(): return path.read_text().strip()
    # The transport itself needs no GPU/Python ML dependencies on the control
    # machine. macOS exposes a stable boot timestamp through the native sysctl.
    if platform.system() == "Darwin":
        boot = subprocess.check_output(["sysctl", "-n", "kern.boottime"], text=True, timeout=10).strip()
        require(boot, "missing-boot-identity", "operating system returned no boot identity")
        return digest_json({"machine": platform.node(), "bootTime": boot})
    require(False, "unsupported-node-platform", "model-node transport requires Linux or macOS boot identity")


class NodeService:
    def __init__(self, config):
        require(config.get("schemaVersion") == 2 and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", str(config.get("nodeId", ""))),
                "invalid-node-config", "model node requires schemaVersion 2 and nodeId")
        for key in ("nodeRoot", "storeRoot", "jobConfigPath"):
            require(isinstance(config.get(key), str) and Path(config[key]).is_absolute(), "invalid-node-config", "model node requires absolute " + key)
        self.config = config
        self.root = Path(config["nodeRoot"]); self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.store = ContentStore(config["storeRoot"])
        with lock(self.root / "identity.lock"):
            identity = load(self.root / "identity.json")
            boot = boot_identity()
            if identity:
                require(identity["nodeId"] == config["nodeId"], "node-id-conflict", "node state belongs to another nodeId")
                record_generation(self.root, identity)
            if not identity or identity["bootIdentity"] != boot:
                identity = {"nodeId": config["nodeId"], "generation": uuid.uuid4().hex, "bootIdentity": boot}
                atomic_json(self.root / "identity.json", identity)
            record_generation(self.root, identity)
        self.identity = {key: identity[key] for key in ("nodeId", "generation")}

    def validate(self, envelope, *, probe=False):
        require(isinstance(envelope, dict) and set(envelope) == {"schemaVersion", "requestId", "node", "operation", "inputDigest", "payload"},
                "invalid-node-envelope", "node envelope fields are invalid")
        require(envelope["schemaVersion"] == 2 and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", str(envelope["requestId"])), "invalid-node-envelope", "invalid node protocol version or request ID")
        require(envelope["inputDigest"] == digest_json(envelope["payload"]), "node-input-drift", "node request payload differs from its input digest")
        require((probe and envelope["node"] is None) or envelope["node"] == self.identity,
                "node-generation-drift", "model node identity/generation changed; reconcile before resubmitting work")

    def response(self, envelope, result):
        return {"schemaVersion": 2, "requestId": envelope["requestId"], "node": self.identity, "inputDigest": envelope["inputDigest"], "result": result}

    def probe(self):
        from .node_runtime import observe_runtime, package_version
        runtime = observe_runtime()
        # This is an observation, not GPU or tool-protocol validation evidence.
        try:
            output = subprocess.check_output(["nvidia-smi", "--query-gpu=uuid", "--format=csv,noheader"], text=True, timeout=15)
            gpus = [line.strip() for line in output.splitlines() if line.strip()]
        except (OSError, subprocess.SubprocessError): gpus = []
        return {**self.identity, "runtimeDigest": digest_json(runtime), "runtime": runtime, "gpuUuids": gpus,
            "launchers": ["process"] if all(package_version(runtime, p) for p in ("torch", "sglang", "psutil")) else [],
            "capabilities": {"binaryCas": True, "durableTrainingJobs": True, "durableInferenceProcesses": True, "episodeJournal": True, "orderedTrainingControl": True, "remoteCasRetention": True}}

    @staticmethod
    def package_version(name):
        try: return importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError: return None

    def rpc(self, envelope):
        operation = envelope.get("operation")
        self.validate(envelope, probe=operation == "probe")
        payload = envelope["payload"]
        if operation == "probe": result = self.probe()
        elif operation == "preflight":
            require(payload == {}, "invalid-node-preflight", "node preflight accepts no task or evaluation payload")
            from .runtime_checks import model_node_preflight
            result = model_node_preflight(self.config, self.identity)
        elif operation == "cas.stat": result = self.cas_stat(payload)
        elif operation == "cas.retain":
            from .node_artifacts import retain_graph
            result = retain_graph(self.store, self.identity, payload)
        elif operation == "cas.hfManifest":
            from .node_artifacts import hf_manifest
            result = hf_manifest(self.store, payload)
        elif operation == "cas.sealHf":
            from .artifacts import seal_hf
            require(isinstance(payload, dict) and set(payload) == {"directory"} and isinstance(payload["directory"], str)
                    and Path(payload["directory"]).is_absolute(), "invalid-model-directory", "HF sealing needs an explicit absolute node directory")
            result = seal_hf(self.store, payload["directory"])
        elif operation == "cas.dependencies":
            ref = payload["ref"]
            require(ref["uri"] == "cas:" + ref["digest"], "nonportable-content-ref", "node content must use CAS references")
            result = {"refs": dependency_refs(self.store.read_json(ref))}
        elif operation.startswith(("training.", "inference.")):
            # Mutating calls already have durable job identities. Recording an
            # envelope intent prevents a request ID from acquiring new meaning;
            # replies are live so inspect/cancel never replay stale release data.
            with lock(self.root / "rpc" / (envelope["requestId"] + ".lock")):
                path = self.root / "rpc" / (envelope["requestId"] + ".json")
                identity = {"node": self.identity, "operation": operation, "inputDigest": envelope["inputDigest"]}
                previous = load(path)
                require(previous is None or previous == identity, "node-request-conflict", "node request ID already identifies another operation")
                if previous is None: atomic_json(path, identity)
                if operation.startswith("inference."):
                    from .inference_process import ProcessService
                    service = ProcessService(self.config, self.identity)
                    action = operation.removeprefix("inference.")
                    require(action in ("prepare", "start", "inspect", "attach", "stop", "recover"), "unknown-node-operation", "unknown inference operation")
                    return self.response(envelope, getattr(service, action)(payload))
                from .job import JobService
                config = load(self.config["jobConfigPath"])
                require(config and Path(config["storeRoot"]).resolve() == self.store.root, "node-store-drift", "job and transport must use the same node CAS")
                config = {**config, "node": self.identity, "nodeRoot": str(self.root)}
                service = JobService(config)
                action = operation.removeprefix("training.")
                if action.startswith("episodes."):
                    from .episodes import EpisodeJournal
                    directory = service.directory(payload["handle"])
                    journal = EpisodeJournal(directory)
                    try:
                        operation = action.removeprefix("episodes.")
                        if operation == "list": result = journal.list(renew=payload.get("renew") is True, cursor=payload.get("cursor", 0))
                        elif operation == "ack": result = journal.acknowledge(payload["address"], payload["ack"])
                        elif operation in ("receipts", "result", "admit"):
                            stopped = service.inspect(payload["handle"])["resourcesReleased"]
                            if operation == "receipts": result = journal.receipts(payload["address"], confirmed_stopped=stopped)
                            elif operation == "admit": result = journal.admit(payload["address"], payload["result"], confirmed_stopped=stopped)
                            else: result = journal.resolve(payload["address"], payload["result"], confirmed_stopped=stopped)
                        else: require(False, "unknown-node-operation", "unknown episode operation")
                        return self.response(envelope, result)
                    finally: journal.close()
                if action == "find":
                    handle = {"schemaVersion": 1, "provider": "slime", "jobId": "job_" + digest_json(payload["idempotencyKey"])[7:39], "requestDigest": payload["requestDigest"]}
                    if not (service.root / handle["jobId"] / "identity.json").exists(): result = {"exists": False}
                    else: result = {"exists": True, "status": service.inspect(handle)}
                    return self.response(envelope, result)
                require(action in ("preflight", "submit", "inspect", "cancel", "collect", "control"), "unknown-node-operation", "unknown training operation")
                if action == "preflight":
                    from .preflight import preflight
                    result = preflight(payload["request"], config)
                elif action == "control":
                    from .job_control import control_job
                    result = control_job(service, payload["request"], payload["idempotencyKey"], payload["intent"])
                elif action == "submit": result = service.submit(payload["request"], payload["idempotencyKey"])
                else: result = getattr(service, action)(payload["handle"])
        else:
            require(False, "unknown-node-operation", "unsupported model-node operation")
        return self.response(envelope, result)

    def cas_stat(self, payload):
        path = self.store.path(payload["digest"])
        if not path.exists(): return {"present": False}
        require(path.is_file() and not path.is_symlink() and digest_file(path) == payload["digest"], "corrupt-content", "node CAS object is corrupt")
        return {"present": True, "size": path.stat().st_size}

    def import_stream(self, envelope, incoming):
        self.validate(envelope)
        require(envelope["operation"] == "cas.import", "invalid-node-operation", "binary input requires cas.import")
        payload = envelope["payload"]; path = self.store.path(payload["digest"])
        size = payload["size"]
        require(type(size) is int and 0 <= size <= 9007199254740991, "invalid-content-size", "CAS size must be an explicit non-negative safe integer")
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        # An interrupted transfer is an uncommitted temporary file. Retrying the
        # same digest never overwrites a published object or exposes partial bytes.
        temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".incoming")
        try:
            with temporary.open("xb") as output:
                remaining = size
                while remaining:
                    block = incoming.read(min(BLOCK, remaining))
                    require(block, "content-transfer-truncated", "CAS transfer ended before declared size")
                    output.write(block); remaining -= len(block)
                require(not incoming.read(1), "content-transfer-overflow", "CAS transfer exceeds declared size")
                output.flush(); os.fsync(output.fileno())
            require(digest_file(temporary) == payload["digest"], "content-digest-mismatch", "transferred object failed its digest")
            try: os.link(temporary, path)
            except FileExistsError: pass
            require(digest_file(path) == payload["digest"], "corrupt-content", "existing CAS object failed its digest")
            sync_dir(path.parent)
        finally: temporary.unlink(missing_ok=True)
        return self.response(envelope, {"present": True, "size": size})

    def export_stream(self, envelope, outgoing):
        self.validate(envelope)
        require(envelope["operation"] == "cas.export", "invalid-node-operation", "binary output requires cas.export")
        payload = envelope["payload"]; state = self.cas_stat(payload)
        require(state["present"], "missing-node-content", "required model/checkpoint object is missing on the node")
        outgoing.write((json.dumps(self.response(envelope, state), separators=(",", ":")) + "\n").encode())
        with self.store.path(payload["digest"]).open("rb") as source:
            for block in iter(lambda: source.read(BLOCK), b""): outgoing.write(block)
        outgoing.flush()


def dependency_refs(value):
    refs = {}
    def walk(item):
        if isinstance(item, dict):
            if set(item) == {"uri", "digest", "mediaType"}:
                require(item["uri"] == "cas:" + item["digest"] and re.fullmatch(r"sha256:[a-f0-9]{64}", item["digest"]),
                        "nonportable-content-ref", "distributed artifacts require portable CAS references")
                refs[item["digest"]] = item
            else:
                for child in item.values(): walk(child)
        elif isinstance(item, list):
            for child in item: walk(child)
    walk(value)
    return list(refs.values())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("rpc", "cas-import", "cas-export"))
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    try:
        node = NodeService(load(args.config))
        if args.action == "rpc": result = node.rpc(json.load(sys.stdin))
        else:
            envelope = read_header(sys.stdin.buffer)
            if args.action == "cas-import": result = node.import_stream(envelope, sys.stdin.buffer)
            else: node.export_stream(envelope, sys.stdout.buffer); return
        print(json.dumps(result, allow_nan=False, separators=(",", ":")))
    except Exception as error:
        print(json.dumps({"error": {"code": getattr(error, "code", "node-operation-failed"), "message": str(error)}}), file=sys.stdout)
        sys.exit(1)


if __name__ == "__main__": main()
