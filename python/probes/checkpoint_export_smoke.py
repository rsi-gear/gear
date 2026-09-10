"""Diagnose a saved checkpoint with new export code without resuming its job.

The original frozen request and pending/commit files are never rewritten. This
is uncertified evidence for the new exporter; it cannot attest same-job recovery.
All weights and trainer files stay on the remote model node.
"""
import argparse
import json
import os
from pathlib import Path
import sys
import time

from gear_training.content import ContentStore, atomic_json, digest_json, require
from gear_training.driver import build_argv
from gear_training.export import materialize, seal_directory
from gear_training.execution import training_devices
from gear_training.gpu_visibility import slime_device_environment
from gear_training.preflight import bridge_digest, compatibility_digest, gpu_processes


def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--job", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--target-node-config", type=Path)
    options = parser.parse_args()
    job, output = options.job.resolve(), options.output.resolve()
    require(not output.exists(), "diagnostic-output-used", "export diagnostic requires a fresh output directory")
    output.mkdir(parents=True)
    request = json.loads((job / "request.json").read_text())
    config = json.loads((job / "config.json").read_text())
    pending = json.loads((job / "pending-update.json").read_text())
    require(pending["compatibilityDigest"] == compatibility_digest(request), "pending-source-drift", "original checkpoint identity differs")
    if options.target_node_config:
        # An instance-to-instance copy is an offline diagnostic input, not an
        # authorization to resume the old job on a different physical device.
        from gear_training.node import NodeService
        target_config = json.loads(options.target_node_config.read_text())
        target = NodeService(target_config)
        observed = target.probe()
        devices = observed["gpuUuids"]
        require(len(devices) == len(training_devices(request)) == 1,
                "diagnostic-device-count", "export diagnostic requires one target GPU")
        lease_root, lease_node = target.root, target.identity
    else:
        from gear_training.job import JobService
        handle = json.loads((job / "identity.json").read_text())["handle"]
        status = JobService(config).inspect(handle)
        require(status["resourcesReleased"] and status["execution"] != "running", "source-job-active", "original job must be physically released")
        devices = training_devices(request)
        lease_root, lease_node = config["nodeRoot"], config["node"]
    os.environ.update(slime_device_environment(devices))
    from gear_training.device_lease import NodeDeviceLedger
    ledger = NodeDeviceLedger(lease_root, lease_node)
    owner = "diagnostic-export/" + output.name
    ledger.acquire(owner, devices)
    started = time.monotonic(); ray = None
    report = {"kind": "checkpoint-export-diagnostic", "validated": False, "status": "running",
              "sourceRequestDigest": digest_json(request), "sourcePending": pending,
              "bridgeDigest": bridge_digest(), "devices": devices, "node": lease_node}
    try:
        store = ContentStore(config["storeRoot"])
        source = materialize(store, pending["trainerStateRef"], job / ("pending-" + pending["trainerStateRef"]["digest"][7:]))
        hf = materialize(store, request["parentModel"]["hfSnapshotRef"], job / "parent-hf")
        paths = {"load": str(source), "hf": str(hf), "reference": str(hf), "save": str(output / "unused-trainer-state")}
        argv = build_argv(request, store.read_json(request["trainer"]["hyperparametersRef"]), paths, 0)
        sys.argv = ["gear-export-diagnostic", *argv]
        from slime.utils.arguments import parse_args
        from slime.ray.placement_group import create_placement_groups
        from gear_training.checkpoint_export import checkpoint_exporter
        import ray
        args = parse_args()
        ray.init(address="local", num_gpus=len(devices), include_dashboard=False,
                 runtime_env={"env_vars": {"PYTHONPATH": os.environ.get("PYTHONPATH", "")}})
        with checkpoint_exporter(args, create_placement_groups(args), pending["committedUpdate"]) as exporter:
            exporter.export_hf(str(output / "hf"))
        ray.shutdown(); ray = None
        hf_ref = seal_directory(store, output / "hf", serving=True, verify_finite=True)
        report.update(status="passed", hfSnapshotRef=hf_ref, elapsedSeconds=time.monotonic() - started,
                      hfManifest=store.read_json(hf_ref), gpuProcesses=gpu_processes(devices))
        require(not report["gpuProcesses"], "exporter-process-remains", "export worker has not released the GPU")
    finally:
        if ray is not None: ray.shutdown()
        ledger.fence(owner)
        report.update(resourcesReleased=ledger.release(owner), usage=ledger.inspect(owner))
        if report["status"] == "running": report["status"] = "failed"
        atomic_json(output / "summary.json", report)


if __name__ == "__main__": main()
