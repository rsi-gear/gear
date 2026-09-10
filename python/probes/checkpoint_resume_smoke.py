"""Diagnose full optimizer restore without generating or repeating a backward.

The saved job is a read-only input. This deliberately separate probe does not
claim same-job recovery or runtime certification for the new implementation.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import sys
import time
import traceback

from gear_training.content import ContentStore, atomic_json, digest_json, require
from gear_training.driver import build_argv
from gear_training.export import materialize
from gear_training.gpu_visibility import slime_device_environment
from gear_training.preflight import bridge_digest, compatibility_digest, gpu_processes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job", type=Path, required=True)
    parser.add_argument("--node-config", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--timeout", type=int, default=360)
    options = parser.parse_args()
    job, output = options.job.resolve(), options.output.resolve()
    require(not output.exists(), "diagnostic-output-used", "probe requires a fresh output directory")
    request = json.loads((job / "request.json").read_text())
    config = json.loads((job / "config.json").read_text())
    pending = json.loads((job / "pending-update.json").read_text())
    require(pending["compatibilityDigest"] == compatibility_digest(request),
            "pending-source-drift", "source checkpoint compatibility differs")
    source_status = json.loads((job / "status.json").read_text())
    require(source_status["resourcesReleased"] and source_status["execution"] != "running",
            "source-job-active", "original job must have released resources")
    from gear_training.node import NodeService
    from gear_training.device_lease import NodeDeviceLedger
    node = NodeService(json.loads(options.node_config.read_text()))
    observed = node.probe()
    devices = observed["gpuUuids"]
    require(len(devices) == 1 and not gpu_processes(devices), "diagnostic-device-busy", "probe requires one idle GPU")
    store = ContentStore(config["storeRoot"])
    # Verify existing materializations before acquiring the GPU lease. Large
    # tensors stay on the model node and the original request remains immutable.
    source = materialize(store, pending["trainerStateRef"], job / ("pending-" + pending["trainerStateRef"]["digest"][7:]))
    hf = materialize(store, request["parentModel"]["hfSnapshotRef"], job / "parent-hf")
    ref = materialize(store, store.read_json(request["referenceModelRef"])["hfSnapshotRef"], job / "reference-hf")
    output.mkdir(parents=True)
    argv = build_argv(request, store.read_json(request["trainer"]["hyperparametersRef"]),
                      {"load": str(source), "hf": str(hf), "reference": str(ref), "save": str(output / "unused")}, 0)
    os.environ.update(slime_device_environment(devices))
    sys.argv = ["gear-checkpoint-resume-probe", *argv]
    from slime.utils.arguments import parse_args
    from slime.ray.placement_group import create_placement_groups, allocate_train_group
    from slime.backends.megatron_utils.actor import MegatronTrainRayActor
    import ray
    args = parse_args()
    require(not args.no_load_optim and not args.no_load_rng and not args.finetune,
            "incomplete-resume-probe", "probe must restore optimizer and RNG")
    lease_root, lease_node = str(node.root), node.identity
    owner = "diagnostic-checkpoint-resume/" + output.name

    class ResumeProbeActor(MegatronTrainRayActor):
        def init(self, *args, **kwargs):
            from gear_training.device_lease import NodeDeviceLedger
            from gear_training.recovery import process_identity
            NodeDeviceLedger(lease_root, lease_node).track(owner, [process_identity(os.getpid())], launching=True)
            return super().init(*args, **kwargs)

        def inspect_loaded_state(self):
            # Initialization ends asleep in the colocated path. Wake before
            # reading tensor storage, then restore the normal sleep boundary.
            import torch
            if self.args.offload_train:
                self.wake_up()
            try:
                optimizers = getattr(self.optimizer, "chained_optimizers", [self.optimizer])
                steps, elements, finite = [], 0, True
                for wrapper in optimizers:
                    optimizer = wrapper.optimizer
                    steps.extend(int(group["step"]) for group in optimizer.param_groups if "step" in group)
                    for state in optimizer.state.values():
                        for name in ("exp_avg", "exp_avg_sq"):
                            value = state[name]
                            elements += value.numel()
                            finite = finite and bool(torch.isfinite(value).all().item())
                return {"optimizerSteps": sorted(set(steps)), "momentElements": elements,
                        "momentsFinite": finite, "scheduler": self.opt_param_scheduler.state_dict(),
                        "peakAllocatedBytes": torch.cuda.max_memory_allocated()}
            finally:
                if self.args.offload_train:
                    self.sleep()

    ledger = NodeDeviceLedger(node.root, node.identity)
    ledger.acquire(owner, devices)
    from gear_training.recovery import process_identity
    report = {"kind": "checkpoint-resume-diagnostic", "status": "running", "validated": False,
              "sourceRequestDigest": digest_json(request), "sourceTrainerStateRef": pending["trainerStateRef"],
              "bridgeDigest": bridge_digest(), "node": node.identity, "devices": devices,
              "driverProcess": process_identity(os.getpid())}
    started, group = time.monotonic(), None
    def expired(_signum, _frame):
        raise TimeoutError("checkpoint restore diagnostic exceeded its bounded runtime")
    signal.signal(signal.SIGALRM, expired)
    signal.alarm(options.timeout)
    try:
        atomic_json(output / "summary.json", report)
        ray.init(address="local", num_gpus=1, include_dashboard=False,
                 runtime_env={"env_vars": {"PYTHONPATH": os.environ.get("PYTHONPATH", "")}})
        pgs = create_placement_groups(args)
        group = allocate_train_group(args, args.actor_num_nodes, args.actor_num_gpus_per_node,
                                     pgs["actor"], with_ref=args.kl_coef != 0 or args.use_kl_loss,
                                     actor_cls=ResumeProbeActor)
        starts = group.create()
        report["starts"] = starts
        require(starts == [pending["committedUpdate"]], "restored-cursor-drift", "loaded update differs")
        states = ray.get([actor.inspect_loaded_state.remote() for actor in group._actor_handlers])
        report["states"] = states
        for state in states:
            require(state["optimizerSteps"] == [pending["committedUpdate"]]
                    and state["momentElements"] > 0 and state["momentsFinite"],
                    "restored-optimizer-invalid", "optimizer steps or moments differ")
        report["status"] = "passed"
    except BaseException as error:
        report.update(status="failed", error=str(error), traceback=traceback.format_exc())
        raise
    finally:
        signal.alarm(0)
        try:
            if group is not None:
                group.release()
        finally:
            ray.shutdown()
            ledger.fence(owner)
            release_deadline = time.monotonic() + 30
            released = ledger.release(owner)
            while not released and time.monotonic() < release_deadline:
                time.sleep(.25)
                released = ledger.release(owner)
            completed = report["status"] == "passed"
            if completed and not released:
                report.update(status="failed", error="diagnostic GPU/process release was not confirmed")
            report.update(resourcesReleased=released, elapsedSeconds=time.monotonic() - started,
                          usage=ledger.inspect(owner), gpuProcesses=gpu_processes(devices))
            atomic_json(output / "summary.json", report)
            if completed:
                require(released, "diagnostic-release-unconfirmed", "diagnostic GPU/process release was not confirmed")


if __name__ == "__main__":
    main()
