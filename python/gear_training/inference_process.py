"""Durable immutable SGLang process services on the selected model node.

The SSH command is only a control request. Detached supervisors own services;
workers register their PID creation time before exec, so a lost start reply or
stop racing a delayed launch cannot create an unowned engine.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from .content import ContentStore, atomic_json, digest_json, require
from .device_lease import NodeDeviceLedger
from .export import materialize, seal_directory
from .node_runtime import observe_runtime, package_version
from .preflight import gpu_processes
from .recovery import process_identity, owned_alive, stop_owned
from .state import load, lock


def runtime_matches(manifest, actual):
    require(manifest.get("schema_version") == "2" and manifest.get("engine") == "sglang"
            and manifest.get("backend") in ("cpu", "cuda") and manifest.get("package", {}).get("kind") == "python-env",
            "invalid-process-runtime", "process services require a v2 Python CPU/CUDA runtime")
    require(manifest["runtime_id"] == digest_json({k: v for k, v in manifest.items() if k != "runtime_id"}),
            "runtime-identity-drift", "runtime manifest identity differs")
    require(manifest["package"] == {"kind": "python-env", "environment_digest": digest_json(actual),
            "python_version": actual["pythonVersion"], "packages_digest": actual["packagesDigest"]}
            and manifest["sglang_version"] == package_version(actual, "sglang"),
            "node-runtime-drift", "observed Python environment differs from the immutable inference runtime")
    installed = [p for p in actual["packages"] if p["name"] == "sglang"]
    require(len(installed) == 1 and manifest.get("sglang_commit") == installed[0]["commit"],
            "node-runtime-drift", "SGLang source commit differs; wheels without VCS provenance must declare null")


def sglang_arguments(request, model_path, access):
    frozen = request["lock"]; execution = frozen["execution"]; backend = execution["platform"]; protocol = frozen["protocol"]
    args = ["--model-path", str(model_path), "--served-model-name", access["wireModel"], "--host", "127.0.0.1",
            "--port", str(access["port"]), "--api-key", access["engineToken"], "--admin-api-key", access["adminToken"],
            "--random-seed", str(frozen["generation"]["seed"]), "--tp-size", "1", "--dp-size", "1", "--pp-size", "1"]
    # Request logging defaults to false. SGLang has no --disable-request-logging.
    for name, flag in (("load_format", "load-format"), ("dtype", "dtype"), ("context_tokens_per_request", "context-length"),
            ("max_running_requests", "max-running-requests"), ("max_total_tokens", "max-total-tokens"),
            ("chunked_prefill_size", "chunked-prefill-size"), ("max_prefill_tokens", "max-prefill-tokens"),
            ("kv_cache_dtype", "kv-cache-dtype"), ("attention_backend", "attention-backend"), ("sampling_backend", "sampling-backend")):
        args += ["--" + flag, str(execution[name])]
    if execution["prefix_cache"]["mode"] == "disabled": args += ["--disable-radix-cache"]
    if not backend["overlap_schedule"]: args += ["--disable-overlap-schedule"]
    if backend["backend"] == "cuda":
        args += ["--mem-fraction-static", str(backend["mem_fraction_static"])]
        if backend["cuda_graph"] == "disabled": args += ["--disable-cuda-graph"]
    else: args += ["--device", "cpu"]
    for field in ("tool_call_parser", "reasoning_parser"):
        if protocol[field]: args += ["--" + field.replace("_", "-"), protocol[field]]
    if execution["deterministic_inference"]: args += ["--enable-deterministic-inference"]
    return args


class ProcessService:
    def __init__(self, config, node):
        self.config, self.node = config, node
        self.root = Path(config["nodeRoot"]) / "inference"
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.store = ContentStore(config["storeRoot"])
        self.devices = NodeDeviceLedger(config["nodeRoot"], node)

    def directory(self, payload):
        service_id = payload.get("serviceId")
        require(isinstance(service_id, str) and re.fullmatch(r"inference_[a-f0-9]{32}", service_id)
                and isinstance(payload.get("ownerId"), str) and payload["ownerId"], "invalid-inference-owner", "service ID and owner ID are required")
        return self.root / service_id

    def owner(self, service_id):
        return "inference/" + service_id

    def identity(self, directory, payload):
        identity = load(directory / "identity.json")
        require(identity and identity["node"] == self.node and identity["ownerId"] == payload["ownerId"],
                "inference-owner-drift", "service belongs to another owner or node generation")
        return identity

    def prepare(self, payload):
        model, frozen, runtime = payload["model"], payload["lock"], payload["runtime"]
        require(model.get("schema_version") == "1" and model.get("format") == "hf-safetensors", "invalid-model-manifest", "expected immutable HF model manifest")
        keys = ("format", "files", "architecture", "model_type", "dtype", "quantization", "context_tokens", "tokenizer_digest", "template_digest")
        require(model["model_id"] == digest_json({key: model[key] for key in keys}), "model-identity-drift", "model manifest identity differs")
        require(frozen["inference_id"] == digest_json({k: v for k, v in frozen.items() if k != "inference_id"})
                and frozen["model_id"] == model["model_id"] and frozen["runtime_id"] == runtime["runtime_id"],
                "inference-lock-drift", "inference lock does not identify the model/runtime")
        execution = frozen["execution"]
        require(frozen.get("schema_version") in ("1", "2") and frozen.get("engine") == "sglang"
                and execution["platform"]["backend"] == runtime["backend"]
                and all(execution[key] == 1 for key in ("tensor_parallel_size", "data_parallel_size", "pipeline_parallel_size"))
                and execution["load_format"] == "safetensors" and execution["quantization"] is None
                and not execution["hicache"] and not execution["speculative_decoding"] and execution["cpu_offload_gb"] == 0,
                "unsupported-process-lock", "node process supports locked dense single-device SGLang only")
        actual = observe_runtime()
        if frozen["schema_version"] == "2":
            require(frozen.get("model_node") == {"schema_version": "2", "node_id": self.node["nodeId"], "generation": self.node["generation"],
                    "runtime_digest": digest_json(actual), "launcher": "process"}, "inference-node-drift", "inference lock belongs to another model node or runtime")
        else:
            require("model_node" not in frozen, "inference-node-drift", "legacy lock cannot contain a model node")
        runtime_matches(runtime, actual)
        backend = execution["platform"]
        if backend["backend"] == "cuda":
            require(re.fullmatch(r"GPU-[A-Za-z0-9-]+", str(backend.get("device_constraint", ""))), "missing-device-uuid", "CUDA process requires a physical GPU UUID")
            known = subprocess.check_output(["nvidia-smi", "--query-gpu=uuid", "--format=csv,noheader"], text=True, timeout=15).splitlines()
            require(backend["device_constraint"] in [line.strip() for line in known], "unknown-node-gpu", "locked GPU is absent on this model node")
        files = [{**item, "contentRef": {"uri": "cas:" + item["sha256"], "digest": item["sha256"], "mediaType": "application/octet-stream"}} for item in model["files"]]
        ref = self.store.put_json({"schemaVersion": 1, "format": "hf-safetensors", "files": files})
        destination = self.root / "models" / model["model_id"][7:]
        with lock(self.root / "models" / (model["model_id"][7:] + ".lock")):
            materialize(self.store, ref, destination)
            seal_directory(self.store, destination, serving=True)
        return {"modelId": model["model_id"], "inferenceId": frozen["inference_id"], "runtimeId": runtime["runtime_id"]}

    def start(self, payload):
        directory = self.directory(payload)
        with lock(self.root / "admission.lock"):
            identity = load(directory / "identity.json")
            if identity:
                self.identity(directory, payload)
                if identity["inputDigest"] is None: return self.inspect(payload)
                require(identity["inputDigest"] == digest_json(payload), "inference-start-conflict", "service ID already identifies another immutable start request")
                status = self.inspect(payload)
                if status["state"] not in ("admitting", "starting") or status.get("handle"): return status
            else:
                self.prepare(payload)
                port = self.config.get("inferencePort")
                require(type(port) is int and 1 <= port <= 65535, "invalid-inference-port", "node configuration requires a stable inferencePort")
                for path in self.root.glob("inference_*/identity.json"):
                    other = load(path)
                    # Other generations require explicit reconciliation; never
                    # reuse their route because a new client failed to see them.
                    from .inference_recovery import previous_service_released
                    released = (self.inspect({"serviceId": path.parent.name, "ownerId": other["ownerId"]})["resourcesReleased"]
                                if other["node"] == self.node else previous_service_released(self, path.parent, other))
                    require(released,
                            "inference-node-busy", "previous model service has not released its process and route")
                directory.mkdir(mode=0o700, exist_ok=True)
                identity = {"node": self.node, "ownerId": payload["ownerId"], "inputDigest": digest_json(payload), "inferenceId": payload["lock"]["inference_id"]}
                atomic_json(directory / "identity.json", identity)
            # Every admission write is replayable after a lost RPC. The durable
            # identity prevents a partial admission from changing its meaning.
            if not (directory / "status.json").exists() or load(directory / "status.json")["state"] == "admitting":
                self.prepare(payload)
                port = self.config.get("inferencePort")
                require(type(port) is int and 1 <= port <= 65535, "invalid-inference-port", "node configuration requires a stable inferencePort")
                atomic_json(directory / "request.json", payload)
                atomic_json(directory / "config.json", self.config)
                if not (directory / "access.json").exists(): atomic_json(directory / "access.json", {"port": port, "wireModel": "hitch-" + payload["model"]["model_id"][7:23],
                            "engineToken": secrets.token_hex(32), "adminToken": secrets.token_hex(32)})
                backend = payload["lock"]["execution"]["platform"]
                self.devices.acquire(self.owner(directory.name), [backend["device_constraint"]] if backend["backend"] == "cuda" else [])
                atomic_json(directory / "status.json", {"schemaVersion": 2, "state": "starting", "resourcesReleased": False})
            with (directory / "supervisor.log").open("ab") as output:
                subprocess.Popen([sys.executable, "-m", "gear_training.inference_process", "_supervisor", "--directory", str(directory)],
                                 stdin=subprocess.DEVNULL, stdout=output, stderr=output, start_new_session=True)
        return self.inspect(payload)

    def attach(self, payload):
        from .inference_attach import attach_service
        return attach_service(self, payload)

    def inspect(self, payload):
        directory = self.directory(payload)
        if not (directory / "identity.json").exists():
            # Hitch publishes its local start intent before uploading the model.
            # Absence is pending admission, never proof that a late start is fenced.
            with lock(self.root / "admission.lock"):
                if not directory.exists() and not self.devices.exists(self.owner(directory.name)):
                    require(re.fullmatch(r"sha256:[a-f0-9]{64}", str(payload.get("inferenceId", ""))),
                            "inference-owner-drift", "an unadmitted service needs its intended inference lock")
                    return {"schemaVersion": 2, "state": "admitting", "inferenceId": payload["inferenceId"],
                            "resourcesReleased": False, "gpuSeconds": 0}
        identity = self.identity(directory, payload)
        require(not payload.get("inferenceId") or identity.get("inferenceId") == payload["inferenceId"],
                "inference-lock-drift", "service belongs to another inference lock")
        with lock(directory / "launch.lock"):
            status = load(directory / "status.json", {"schemaVersion": 2, "state": "admitting", "resourcesReleased": False})
            reserved = self.devices.exists(self.owner(directory.name))
            handle = status.get("handle")
            worker = {"pid": handle["process"]["pid"], "createdAt": handle["process"]["created_at"]} if handle else None
            if worker and not owned_alive(worker) and status["state"] in ("starting", "ready", "stopping"):
                atomic_json(directory / "stop.json", {"reason": "supervisor-exited"})
                if reserved: self.devices.fence(self.owner(directory.name))
                status.update(state="failed", error="supervisor-exited", resourcesReleased=False)
            if status["state"] in ("failed", "stopped"):
                if reserved: self.devices.fence(self.owner(directory.name))
                try: status["resourcesReleased"] = not reserved or self.devices.release(self.owner(directory.name))
                except Exception: status["resourcesReleased"] = False
            usage = self.devices.inspect(self.owner(directory.name)) if reserved else {"gpuSeconds": 0}
            status["gpuSeconds"] = usage["gpuSeconds"]
            atomic_json(directory / "status.json", status)
            # Access credentials are private control-RPC data, never CAS evidence.
            return {**status, "inferenceId": identity.get("inferenceId"), "access": load(directory / "access.json")}

    def stop(self, payload):
        directory = self.directory(payload)
        with lock(self.root / "admission.lock"):
            if not (directory / "identity.json").exists():
                # A stop can beat an in-flight start request. Persist an owner
                # tombstone so a delayed/retried start cannot revive that ID.
                directory.mkdir(mode=0o700, exist_ok=True)
                atomic_json(directory / "identity.json", {"node": self.node, "ownerId": payload["ownerId"], "inputDigest": None,
                            "inferenceId": payload.get("inferenceId")})
            identity = self.identity(directory, payload)
            require(not payload.get("inferenceId") or identity.get("inferenceId") == payload["inferenceId"],
                    "inference-lock-drift", "service belongs to another inference lock")
            self._fence(directory)
        if self.devices.exists(self.owner(directory.name)):
            entry = self.devices.inspect(self.owner(directory.name))
            stop_owned(entry["processes"])
        with lock(directory / "launch.lock"):
            status = load(directory / "status.json"); status.update(state="stopped", resourcesReleased=False)
            atomic_json(directory / "status.json", status)
        return self.inspect(payload)

    def _fence(self, directory):
        with lock(directory / "launch.lock"):
            atomic_json(directory / "stop.json", {"reason": "owner-stop"})
            if self.devices.exists(self.owner(directory.name)): self.devices.fence(self.owner(directory.name))
            status = load(directory / "status.json", {"schemaVersion": 2, "state": "admitting", "resourcesReleased": False})
            if status["state"] in ("admitting", "starting", "ready"): status.update(state="stopping", resourcesReleased=False)
            atomic_json(directory / "status.json", status)

    def recover(self, payload):
        # Recovery is explicitly a drain, never an implicit weight reload.
        if "previousNode" in payload:
            from .inference_recovery import recover_previous_service
            return recover_previous_service(self, payload)
        return self.stop(payload)


def service_for_directory(directory):
    directory = Path(directory)
    config = load(directory / "config.json"); identity = load(directory / "identity.json")
    service = ProcessService(config, identity["node"])
    service.devices._read()  # Check current boot before interpreting any PID.
    return service, directory, load(directory / "request.json")


def engine(directory):
    service, directory, request = service_for_directory(directory)
    with lock(directory / "launch.lock"):
        status = load(directory / "status.json"); handle = status["handle"]
        supervisor = {"pid": handle["process"]["pid"], "createdAt": handle["process"]["created_at"]}
        require(status["state"] == "starting" and not (directory / "stop.json").exists() and owned_alive(supervisor),
                "inference-launch-fenced", "supervisor is no longer authorizing this engine")
        identity = process_identity(os.getpid())
        service.devices.track(service.owner(directory.name), [identity], launching=True)
        atomic_json(directory / "engine.json", identity)
        access = load(directory / "access.json")
        arguments = sglang_arguments(request, service.root / "models" / request["model"]["model_id"][7:], access)
    os.execv(sys.executable, [sys.executable, "-m", "sglang.launch_server", *arguments])


def supervisor(directory):
    service, directory, request = service_for_directory(directory)
    try:
        with lock(directory / "worker.lock", blocking=False):
            with lock(directory / "launch.lock"):
                status = load(directory / "status.json")
                if status["state"] != "starting" or status.get("handle") or (directory / "stop.json").exists(): return
                identity = process_identity(os.getpid())
                service.devices.track(service.owner(directory.name), [identity], launching=True)
                status["handle"] = {"schema_version": "2", "kind": "process", "node_id": service.node["nodeId"], "generation": service.node["generation"],
                                    "service_id": directory.name, "process": {"pid": identity["pid"], "created_at": identity["createdAt"]}}
                atomic_json(directory / "status.json", status)
            run_engine(service, directory, request)
    except BlockingIOError: return


def run_engine(service, directory, request):
    process = None; owned = {}; error = None
    owner = service.owner(directory.name)
    try:
        actual = observe_runtime(); runtime_matches(request["runtime"], actual)
        backend = request["lock"]["execution"]["platform"]
        environment = {**os.environ, "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "CUDA_VISIBLE_DEVICES": backend.get("device_constraint", "")}
        if backend["backend"] == "cpu": environment.update(SGLANG_USE_CPU_ENGINE="1", OMP_NUM_THREADS=str(backend["cpu_threads"]), SGLANG_CPU_OMP_THREADS=str(backend["cpu_threads"]))
        with lock(directory / "launch.lock"):
            if load(directory / "status.json")["state"] != "starting" or (directory / "stop.json").exists(): return
            with (directory / "engine.log").open("ab") as output:
                process = subprocess.Popen([sys.executable, "-m", "gear_training.inference_process", "_engine", "--directory", str(directory)],
                                           env=environment, stdin=subprocess.DEVNULL, stdout=output, stderr=output, start_new_session=True)
            # Stop snapshots the ledger after taking this same launch fence.
            # Register the child before releasing it; the child's own check
            # still protects the Popen/registration window if we crash here.
            identity = process_identity(process.pid)
            require(identity is not None, "inference-engine-exited", "engine exited before ownership registration")
            service.devices.track(owner, [identity], launching=True)
        access = load(directory / "access.json"); deadline = time.monotonic() + request["lock"]["execution"]["startup_timeout_ms"] / 1000
        while not (directory / "stop.json").exists():
            import psutil
            try:
                parent = psutil.Process(process.pid)
                for child in [parent, *parent.children(recursive=True)]:
                    identity = process_identity(child.pid)
                    if identity: owned[digest_json(identity)] = identity
            except psutil.NoSuchProcess: pass
            service.devices.track(owner, list(owned.values()))
            if process.poll() is not None: raise RuntimeError("SGLang engine exited")
            status = load(directory / "status.json")
            if status["state"] == "starting":
                require(time.monotonic() < deadline, "inference-start-timeout", "SGLang did not become healthy within the locked timeout")
                try:
                    base = "http://127.0.0.1:" + str(access["port"])
                    with urllib.request.urlopen(base + "/health", timeout=1) as response: require(response.status == 200, "inference-not-healthy", "SGLang is not healthy")
                    query = urllib.request.Request(base + "/server_info", headers={"Authorization": "Bearer " + access["engineToken"]})
                    with urllib.request.urlopen(query, timeout=2) as response: info = json.load(response)
                    if backend["backend"] == "cuda":
                        used = gpu_processes([backend["device_constraint"]])
                        require(used and all(row["pid"] in {p["pid"] for p in owned.values()} for row in used),
                                "inference-gpu-unconfirmed", "GPU compute ownership is not confirmed for this service")
                    # Raw server_info can contain API keys. Only the private
                    # control record stores it; Hitch emits whitelisted evidence.
                    with lock(directory / "launch.lock"):
                        status = load(directory / "status.json")
                        if status["state"] == "starting" and not (directory / "stop.json").exists():
                            status.update(state="ready", runtime=actual, serverInfo=info, gpuUuid=backend.get("device_constraint"))
                            atomic_json(directory / "status.json", status)
                except urllib.error.HTTPError as exc:
                    require(exc.code not in (401, 403), "inference-authentication-failed", "SGLang rejected the service credentials")
                except (OSError, ValueError): pass
            time.sleep(0.2)
    except Exception as exc: error = getattr(exc, "code", "inference-engine-failed")
    finally:
        with lock(directory / "launch.lock"):
            atomic_json(directory / "stop.json", {"reason": error or "owner-stop"}); service.devices.fence(owner)
        # The engine self-registers before exec, including if its parent dies
        # between Popen and the first psutil enumeration.
        entry = service.devices.inspect(owner)
        stop_owned([identity for identity in entry["processes"] if identity["pid"] != os.getpid()])
        if process is not None:
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired: pass
        with lock(directory / "launch.lock"):
            status = load(directory / "status.json"); status.update(state="failed" if error else "stopped", resourcesReleased=False)
            if error: status["error"] = error
            atomic_json(directory / "status.json", status)


def main():
    parser = argparse.ArgumentParser(); parser.add_argument("action", choices=("_supervisor", "_engine")); parser.add_argument("--directory", required=True)
    args = parser.parse_args()
    (supervisor if args.action == "_supervisor" else engine)(args.directory)


if __name__ == "__main__": main()
