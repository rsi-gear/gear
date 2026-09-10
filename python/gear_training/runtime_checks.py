"""Read-only model-node diagnostics. These checks never issue GPU probe evidence."""
from __future__ import annotations

import importlib.metadata
import json
import os
import re
import subprocess
from pathlib import Path
from .content import digest_bytes, digest_json, require


def command(args, *, cwd=None):
    return subprocess.run(args, cwd=cwd, capture_output=True, timeout=15, check=True).stdout


def source_observation(directory, kind):
    require(isinstance(directory, str) and Path(directory).is_absolute(), "source-path-unavailable", "runtime source requires an absolute checkout path")
    root = Path(directory).resolve()
    actual_root = command(["git", "rev-parse", "--show-toplevel"], cwd=root).decode().strip()
    require(Path(actual_root).resolve() == root, "source-root-mismatch", "runtime source cannot borrow an enclosing repository identity")
    commit = command(["git", "rev-parse", "HEAD"], cwd=root).decode().strip()
    require(re.fullmatch(r"[a-f0-9]{40}", commit), "source-commit-unavailable", "runtime source commit is unavailable")
    patch = command(["git", "diff", "HEAD", "--binary"], cwd=root)
    untracked = command(["git", "ls-files", "--others", "--exclude-standard", "--", "slime", "megatron", "src", "scripts", "train.py", "train_async.py"], cwd=root)
    result = {"commit": commit, "patchDigest": digest_bytes(patch) if patch else None, "untrackedRuntimeCode": bool(untracked.strip())}
    if kind == "slime":
        result["exportExtension"] = all("def export_hf(" in (root / filename).read_text() for filename in
            ("slime/backends/megatron_utils/actor.py", "slime/ray/actor_group.py"))
    return result


def gpu_inventory():
    output = command(["nvidia-smi", "--query-gpu=uuid,name,memory.total,driver_version", "--format=csv,noheader,nounits"]).decode()
    gpus = []
    for line in output.splitlines():
        fields = [field.strip() for field in line.split(",")]
        require(len(fields) == 4 and re.fullmatch(r"GPU-[A-Za-z0-9-]+", fields[0]) and fields[1]
                and fields[2].isdigit() and int(fields[2]) > 0 and fields[3], "gpu-inventory-invalid", "GPU inventory is incomplete")
        gpus.append({"uuid": fields[0], "name": fields[1], "memoryMiB": int(fields[2]), "driverVersion": fields[3]})
    require(gpus and len({gpu["uuid"] for gpu in gpus}) == len(gpus), "gpu-inventory-invalid", "GPU inventory is empty or duplicated")
    return gpus


def parse_gpu_process_rows(output):
    require(isinstance(output, str), "gpu-process-observation-invalid", "GPU process observation is incomplete")
    rows = []
    for line in output.splitlines():
        if not line.strip(): continue
        fields = [field.strip() for field in line.split(",")]
        require(len(fields) == 2 and re.fullmatch(r"GPU-[A-Za-z0-9-]+", fields[0]) and fields[1].isdigit()
                and int(fields[1]) > 0, "gpu-process-observation-invalid", "GPU process observation is incomplete")
        rows.append({"device": fields[0], "pid": int(fields[1])})
    return rows


def gpu_process_inventory():
    output = command(["nvidia-smi", "--query-compute-apps=gpu_uuid,pid", "--format=csv,noheader,nounits"]).decode()
    counts = {}
    for row in parse_gpu_process_rows(output):
        counts[row["device"]] = counts.get(row["device"], 0) + 1
    return counts


def inspect_model_runtime(config):
    """Probe only this model node; never execute Hitch, Harbor or Docker."""
    from .node_runtime import observe_runtime
    runtime = observe_runtime()
    report = {"schemaVersion": 2, "kind": "model-node-preflight", "runtimeDigest": digest_json(runtime),
              "checks": [], "sources": {}, "gpus": [], "hostMemory": None, "cudaVersion": None}

    def check(code, operation):
        try:
            value = operation()
            require(value is not False and value is not None, code, "model-node check failed")
            report["checks"].append({"code": code, "status": "passed"})
            return value
        except Exception:
            # Do not expose paths, environment values or subprocess diagnostics.
            report["checks"].append({"code": code, "status": "blocked"})
            return None

    for package in ("torch", "sglang", "psutil", "ray"):
        check("package-" + package, lambda package=package: importlib.metadata.version(package))
    for kind, key in (("slime", "slimePath"), ("megatron", "megatronPath")):
        source = check(kind + "-checkout", lambda key=key, kind=kind: source_observation(config.get(key), kind))
        if source:
            report["sources"][kind] = source
            check(kind + "-tracked-runtime", lambda source=source: not source["untrackedRuntimeCode"])
            if kind == "slime": check("slime-export-extension", lambda: source["exportExtension"])

    def memory():
        import psutil
        value = psutil.virtual_memory()
        return {"totalBytes": value.total, "availableBytes": value.available}

    report["hostMemory"] = check("host-memory-observation", memory)
    report["gpus"] = check("gpu-inventory", gpu_inventory) or []
    active = check("gpu-process-observation", gpu_process_inventory)
    for gpu in report["gpus"]: gpu["activeProcesses"] = active.get(gpu["uuid"], 0) if active is not None else None

    def cuda():
        import torch
        require(torch.version.cuda and torch.cuda.is_available(), "cuda-unavailable", "CUDA is unavailable")
        return torch.version.cuda

    report["cudaVersion"] = check("cuda-runtime", cuda)
    if digest_json(observe_runtime()) != report["runtimeDigest"]:
        report["checks"].append({"code": "runtime-changed-during-observation", "status": "blocked"})
    return report


def model_node_preflight(node_config, identity):
    try:
        config = json.loads(Path(node_config["jobConfigPath"]).read_text())
        valid = (isinstance(config, dict) and config.get("schemaVersion") == 2
                 and all(isinstance(config.get(key), str) and Path(config[key]).is_absolute()
                         for key in ("storeRoot", "jobsRoot", "slimePath", "megatronPath"))
                 and Path(config.get("storeRoot", "")).resolve() == Path(node_config["storeRoot"]).resolve()
                 and config.get("gatewayBindHost") == "127.0.0.1"
                 and type(config.get("gatewayPort")) is int and 1 <= config["gatewayPort"] <= 65535
                 and type(config.get("controllerTimeoutSeconds")) is int and 10 <= config["controllerTimeoutSeconds"] <= 300
                 and type(config.get("episodeTimeoutSeconds")) is int and config["episodeTimeoutSeconds"] > 0
                 and not any(key in config for key in ("hitchRoot", "hitchPath", "hitchCommand")))
    except Exception:
        config, valid = {}, False
    report = inspect_model_runtime(config if isinstance(config, dict) else {})
    report["node"] = identity
    ports = {"rollout": config.get("gatewayPort") if isinstance(config, dict) else None, "inference": node_config.get("inferencePort")}
    report["ports"] = {key: port if type(port) is int and 1 <= port <= 65535 else None for key, port in ports.items()}
    valid_ports = all(report["ports"].values()) and len(set(report["ports"].values())) == 2
    report["checks"].append({"code": "model-gateway-configuration", "status": "passed" if valid_ports else "blocked"})
    report["checks"].insert(0, {"code": "training-node-configuration", "status": "passed" if valid else "blocked"})
    return report


def validate_process_lock(request, runtime):
    lock = request["trainer"]["runtimeLock"]
    require(lock.get("schemaVersion") in (1, 2), "invalid-runtime-lock", "unknown training runtime lock")
    if lock["schemaVersion"] == 1:
        return [] if os.environ.get("GEAR_TRAINING_IMAGE_DIGEST") == lock["imageDigest"] else ["container-image-not-attested"]
    node = request.get("deployment", {}).get("modelRuntime", {})
    value = lock.get("runtime")
    require(request.get("schemaVersion") == 2 and node.get("launcher") == "process" and "imageDigest" not in lock
            and isinstance(value, dict) and set(value) == {"kind", "nodeRuntimeDigest", "outerImageDigest"}
            and value["kind"] == "python-env" and value["nodeRuntimeDigest"] == node.get("runtimeDigest")
            and (value["outerImageDigest"] is None or isinstance(value["outerImageDigest"], str)
                 and re.fullmatch(r"sha256:[a-f0-9]{64}", value["outerImageDigest"])),
            "invalid-runtime-lock", "Python runtime lock must match its frozen process model node")
    blockers = []
    if value["nodeRuntimeDigest"] != digest_json(runtime): blockers.append("model-node-runtime-drift")
    if value["outerImageDigest"] != runtime["outerImageDigest"]: blockers.append("outer-image-drift")
    return blockers


def validate_training_runtime(request, config):
    from .node_runtime import observe_runtime, package_version
    from .execution import training_devices
    lock = request["trainer"]["runtimeLock"]
    runtime = observe_runtime()
    blockers = validate_process_lock(request, runtime)
    report = inspect_model_runtime(config)
    if report["runtimeDigest"] != digest_json(runtime): blockers.append("model-node-runtime-drift")
    blockers.extend("model-node:" + item["code"] for item in report["checks"] if item["status"] == "blocked")
    for kind, field in (("slime", "slimeCommit"), ("megatron", "megatronCommit")):
        source = report["sources"].get(kind)
        if source:
            if source["commit"] != lock[field]: blockers.append(kind + "-checkout-drift")
            if source["patchDigest"] and source["patchDigest"] not in lock["patchDigests"]: blockers.append("unlocked-" + kind + "-patch")
    for package, field in (("torch", "pytorchVersion"), ("sglang", "sglangVersion")):
        if package_version(runtime, package) != lock[field]: blockers.append("runtime-package-drift:" + package)
    if runtime["pythonVersion"] != lock["pythonVersion"]: blockers.append("python-version-drift")
    if report["cudaVersion"] != lock["cudaVersion"]: blockers.append("cuda-version-drift")
    devices = training_devices(request)
    if not set(devices).issubset({gpu["uuid"] for gpu in report["gpus"]}): blockers.append("unknown-training-gpu")
    if any(gpu["uuid"] in devices and gpu["activeProcesses"] for gpu in report["gpus"]): blockers.append("training-gpu-pool-occupied")
    return sorted(set(blockers))
