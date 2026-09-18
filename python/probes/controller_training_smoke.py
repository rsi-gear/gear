"""Isolated full-driver diagnostic, never a validated runtime or public admission.

The controller supplies a parsed pending-gpu request. Only this probe bootstraps
the private supervisor before compatibility certification; the normal submit
gate is unchanged. Actual jobs, receipts, optimizer, exports and ownership then
use the production implementation. Run under an external rental watchdog.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import secrets
import sys

from gear_training.content import ContentStore, atomic_json, digest_json, require
from gear_training.job import JobService
from gear_training.node import NodeService
from gear_training.preflight import bridge_digest, generation_protocol_digest, gpu_processes


def prepare(node_config, payload):
    node = NodeService(node_config)
    request = payload["request"]
    require(payload.get("kind") == "gear-full-driver-diagnostic" and payload.get("validated") is False,
            "diagnostic-only", "this entry point accepts only isolated, uncertified diagnostics")
    lock = request["trainer"]["runtimeLock"]
    require(request["schemaVersion"] == 2 and lock["schemaVersion"] == 2 and lock["validation"] == "pending-gpu"
            and not lock["probeEvidenceRefs"] and not request.get("resumeCheckpointRef") and request["coldStart"],
            "diagnostic-only", "start from an untrained model without issuing compatibility evidence")
    observed = node.probe()
    checks = {"runtimeDigest": lock["runtime"]["nodeRuntimeDigest"] == observed["runtimeDigest"],
              "nodeId": request["deployment"]["modelRuntime"]["nodeId"] == node.identity["nodeId"],
              "generation": request["deployment"]["modelRuntime"]["generation"] == node.identity["generation"],
              "bridgeDigest": lock["bridgeDigest"] == bridge_digest()}
    atomic_json(node.root / "diagnostic-runtime-check.json", {"checks": checks, "observed": observed})
    require(all(checks.values()), "diagnostic-runtime-drift",
            "actual model node differs from the prepared request: " + ", ".join(k for k, passed in checks.items() if not passed))
    config = json.loads(Path(node_config["jobConfigPath"]).read_text())
    config.update(node=node.identity, nodeRoot=str(node.root))
    require(lock["protocolDigest"] == generation_protocol_digest(config), "diagnostic-protocol-drift", "protocol digest changed")
    service = JobService(config)
    require(not list(service.root.glob("job_*")), "diagnostic-directory-used", "use a fresh isolated diagnostic node/job root")
    devices = [d["gpuUuid"] for d in request["trainingDevices"]]
    require(len(devices) == 1 and devices[0] in observed["gpuUuids"]
            and request["deployment"]["gpuScheduling"]["actorRollout"] == "colocated"
            and type(request["trainer"]["updatesPerCandidate"]) is int
            and request["trainer"]["updatesPerCandidate"] in (1, 2), "diagnostic-layout", "this diagnostic runs one or two updates on one actual GPU")
    require(not gpu_processes(devices), "diagnostic-device-busy", "do not take an occupied GPU")
    import psutil
    memory = psutil.virtual_memory()
    require(memory.total >= 64 * 1024 ** 3 and memory.available >= 48 * 1024 ** 3,
            "diagnostic-host-memory", "the full offload diagnostic needs at least 64 GiB total and 48 GiB available RAM")
    store = ContentStore(config["storeRoot"])
    for item in payload["jsonObjects"]:
        require(store.put_json(item["value"]) == item["ref"], "diagnostic-content-drift", "controller JSON object changed")
    manifest = store.read_json(request["parentModel"]["hfSnapshotRef"])
    model = Path(payload["modelDirectory"]).resolve()
    for item in manifest["files"]:
        source = (model / item["path"]).resolve(strict=True)
        # HF snapshots may point at sibling blobs in the same repository cache.
        require(source.is_file() and store.put_file(source) == item["contentRef"], "diagnostic-model-drift", "cached HF file differs from the controller snapshot")
    require(store.read_json(request["parentModelRef"]) == request["parentModel"]
            and store.read_json(request["referenceModelRef"])["hfSnapshotRef"] == request["parentModel"]["hfSnapshotRef"],
            "diagnostic-reference-drift", "first diagnostic must use the fixed initial model as reference")
    for task in request["trainDataset"]["tasks"]:
        require(not store.path(task["taskRef"]["digest"]).exists(), "diagnostic-task-leak", "task files stay on the controller")
    key = "full-driver-diagnostic/" + secrets.token_hex(16)
    handle = {"schemaVersion": 1, "provider": "slime", "jobId": "job_" + digest_json(key)[7:39], "requestDigest": digest_json(request)}
    directory = service.root / handle["jobId"]
    atomic_json(directory / "request.json", request)
    atomic_json(directory / "config.json", config)
    atomic_json(directory / "identity.json", {"handle": handle, "keyDigest": digest_json(key)})
    atomic_json(directory / "diagnostic-control.json", {"idempotencyKey": key})
    atomic_json(directory / "status.json", {"schemaVersion": 1, "handle": handle, "phase": "admitted", "execution": "running",
                "committedUpdate": 0, "usage": {"gpuSeconds": 0, "rolloutTokens": 0, "groupResamples": 0}, "resourcesReleased": False})
    atomic_json(directory / "worker.json", {"incarnation": secrets.token_hex(16), "pending": True})
    from gear_training.driver import build_argv
    from gear_training.placement import validate_resource_args
    from gear_training.recipes.agent_grpo import validate_layout
    from slime.utils.arguments import parse_args
    from slime.backends.megatron_utils.actor import MegatronTrainRayActor
    from slime.ray.actor_group import RayTrainGroup
    require(hasattr(MegatronTrainRayActor, "export_hf") and hasattr(RayTrainGroup, "export_hf"),
            "diagnostic-export-extension", "the pinned export extension must be applied")
    paths = {"load": str(model), "reference": str(model),
             "hf": str(model), "save": str(directory / "trainer-state")}
    argv = build_argv(request, store.read_json(request["trainer"]["hyperparametersRef"]), paths, 0)
    sys.argv = ["gear-full-driver-diagnostic", *argv]
    args = parse_args()
    validate_resource_args(args, request, argv)
    validate_layout(args, request)
    atomic_json(directory / "diagnostic-prepared-argv.json", argv)
    marker = {"kind": "gear-full-driver-diagnostic", "validated": False, "handle": handle,
              "hostMemory": {"total": memory.total, "available": memory.available}, "node": node.identity}
    atomic_json(node.root / "full-driver-diagnostic.json", marker)
    return marker


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["prepare", "start"])
    parser.add_argument("--node-config", required=True)
    options = parser.parse_args()
    config = json.loads(Path(options.node_config).read_text())
    if options.action == "prepare":
        print(json.dumps(prepare(config, json.load(sys.stdin))))
    else:
        node = NodeService(config)
        marker = json.loads((node.root / "full-driver-diagnostic.json").read_text())
        require(marker["kind"] == "gear-full-driver-diagnostic" and marker["validated"] is False and marker["node"] == node.identity,
                "diagnostic-identity-drift", "prepared diagnostic belongs to another node")
        job_config = json.loads(Path(config["jobConfigPath"]).read_text())
        job_config.update(node=node.identity, nodeRoot=str(node.root))
        service = JobService(job_config)
        directory = service.directory(marker["handle"])
        require(digest_json(json.loads((directory / "request.json").read_text())) == marker["handle"]["requestDigest"],
                "diagnostic-request-drift", "prepared diagnostic request changed")
        service.ensure_worker(directory)
        print(json.dumps(marker))


if __name__ == "__main__": main()
