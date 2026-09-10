"""JSON subprocess RPC and durable, private Slime job supervision."""
from __future__ import annotations

import argparse
import asyncio
from contextlib import nullcontext
import json
import os
import secrets
import signal
import subprocess
import sys
import time
from pathlib import Path
from .content import ContentStore, ContractError, atomic_json, digest_json, require
from .ledger import Ledger
from .recovery import reconcile_slots, process_identity, owned_alive, stop_owned
from .preflight import preflight, gpu_processes
from .state import load, lock
from .execution import training_devices

RESOURCE_RELEASE_PENDING = "training GPU processes remain; resources are not released"


def alive(pid):
    if type(pid) is not int or pid <= 0: return False
    try: os.kill(pid, 0); return True
    except ProcessLookupError: return False


def worker_alive(worker):
    return owned_alive(worker["process"]) if worker.get("process") else alive(worker.get("pid"))


def device_ledger(config):
    if not config.get("node"): return None
    from .device_lease import NodeDeviceLedger
    return NodeDeviceLedger(config["nodeRoot"], config["node"])


def device_owner(directory, incarnation):
    return "training/" + Path(directory).name + "/" + incarnation


class JobService:
    def __init__(self, config):
        self.config = config
        require(config.get("schemaVersion") in (1, 2), "invalid-job-config", "unsupported job configuration")
        keys = ["storeRoot", "jobsRoot", "slimePath", "megatronPath", "gatewayBindHost"]
        if config["schemaVersion"] == 1: keys += ["hitchRoot", "hitchPath", "gatewayAdvertisedHost"]
        else:
            require(config.get("node") and config.get("nodeRoot") and config["gatewayBindHost"] == "127.0.0.1"
                    and type(config.get("gatewayPort")) is int and 1 <= config["gatewayPort"] <= 65535
                    and type(config.get("controllerTimeoutSeconds")) is int and 10 <= config["controllerTimeoutSeconds"] <= 300,
                    "invalid-v2-job-config", "v2 jobs require a pinned node, loopback gatewayPort and controllerTimeoutSeconds")
            require(not any(key in config for key in ("hitchRoot", "hitchPath", "hitchCommand")), "gpu-hitch-dependency", "v2 model node must not depend on controller Hitch paths or CLI")
        for key in keys:
            require(isinstance(config.get(key), str) and config[key], "invalid-job-config", "missing " + key)
        require(type(config.get("episodeTimeoutSeconds")) is int and config["episodeTimeoutSeconds"] > 0, "invalid-job-config", "episode timeout must be explicit")
        self.root = Path(config["jobsRoot"]).resolve(); self.root.mkdir(parents=True, exist_ok=True, mode=0o700)

    def directory(self, handle):
        import re
        require(handle.get("schemaVersion") == 1 and handle.get("provider") == "slime" and re.fullmatch(r"job_[a-f0-9]{32}", str(handle.get("jobId"))), "invalid-job-handle", "invalid Slime job handle")
        directory = self.root / handle["jobId"]
        identity = load(directory / "identity.json")
        require(identity and identity["handle"] == handle, "job-identity-mismatch", "job handle does not match its durable request")
        require(load(directory / "config.json", {}).get("node") == self.config.get("node"),
                "job-node-generation-drift", "job belongs to another model node/generation")
        return directory

    def submit(self, request, key, *, _control=None):
        require(isinstance(key, str) and key, "missing-idempotency-key", "training submission requires an idempotency key")
        handle = {"schemaVersion": 1, "provider": "slime", "jobId": "job_" + digest_json(key)[7:39], "requestDigest": digest_json(request)}
        directory = self.root / handle["jobId"]
        with (lock(self.root / "submission.lock") if _control is None else nullcontext()):
            require(_control is not None or not (directory / "control.json").exists(),
                    "training-control-required", "ordered jobs require a versioned control intent")
            identity = load(directory / "identity.json")
            if identity:
                require(identity["handle"] == handle and identity["keyDigest"] == digest_json(key), "idempotency-conflict", "submission key already identifies another frozen request")
                status = self.inspect(handle)
                if status["execution"] in ("running", "pausing", "completed"):
                    if _control is not None:
                        _control["phase"] = "applied"; atomic_json(directory / "control.json", _control)
                    if status["execution"] == "running": self.ensure_worker(directory)
                    return handle
                require(status["resourcesReleased"], "previous-resources-not-released", "do not restart while the previous incarnation still owns GPUs")
            else:
                for other in self.root.glob("job_*/identity.json"):
                    other_handle = load(other)["handle"]
                    old_config = load(other.parent / "config.json", {})
                    status = (self.inspect(other_handle) if old_config.get("node") == self.config.get("node")
                              else self._reconcile_previous_job(other.parent, other_handle, old_config))
                    require(status["resourcesReleased"] and status["execution"] not in ("running", "pausing"), "training-job-active", "synchronous training permits one job per service")
            if identity:
                if request["schemaVersion"] == 2:
                    from .episodes import EpisodeJournal
                    journal = EpisodeJournal(directory)
                    try: journal.reconcile_stopped()
                    finally: journal.close()
                else: asyncio.run(reconcile_slots(directory, request, self.config))
            caps = preflight(request, self.config)
            require(not caps["blockers"], "training-preflight-blocked", "; ".join(caps["blockers"]))
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            if not identity:
                atomic_json(directory / "request.json", request)
                atomic_json(directory / "config.json", self.config)
                atomic_json(directory / "status.json", {"schemaVersion": 1, "handle": handle, "phase": "admitted", "execution": "running",
                    "committedUpdate": 0, "usage": {"gpuSeconds": 0, "rolloutTokens": 0, "groupResamples": 0}, "resourcesReleased": False})
                atomic_json(directory / "identity.json", {"handle": handle, "keyDigest": digest_json(key)})
            (directory / "cancel.json").unlink(missing_ok=True)
            (directory / "outcome.json").unlink(missing_ok=True)
            incarnation = secrets.token_hex(16)
            with lock(directory / "launch.lock"):
                if _control is not None:
                    _control["admissionOnly"] = False; atomic_json(directory / "control.json", _control)
                atomic_json(directory / "worker.json", {"incarnation": incarnation, "pending": True})
                status = load(directory / "status.json")
                status.update(execution="running", resourcesReleased=False)
                atomic_json(directory / "status.json", status)
                if _control is not None:
                    _control.update(phase="applied", admissionOnly=False)
                    atomic_json(directory / "control.json", _control)
            self.ensure_worker(directory)
        return handle

    def _reconcile_previous_job(self, directory, handle, config):
        """Drain historical ownership without adopting the old job identity."""
        from .node_generation import previous_boot_proof
        require(directory.name == handle["jobId"] and config.get("nodeRoot") == self.config.get("nodeRoot"),
                "job-node-generation-drift", "historical job belongs to another node root")
        devices = device_ledger(self.config)
        require(devices, "job-node-generation-drift", "historical jobs require node device ownership evidence")
        with lock(directory / "launch.lock"):
            previous_boot_proof(devices.root, self.config["node"], config.get("node"))
            status = load(directory / "status.json")
            require(status and status["handle"] == handle, "invalid-job-status", "historical job status is missing or mismatched")
            worker = load(directory / "worker.json", {})
            if not worker:
                control = load(directory / "control.json", {})
                if control.get("admissionOnly") and status["execution"] == "paused" and status["resourcesReleased"]:
                    return status
                # Identity can be durable before worker registration. Recover
                # only an admission with no launch or device ownership history.
                require(status["phase"] == "admitted" and status["committedUpdate"] == 0
                        and (not control or control.get("phase") == "intent")
                        and not load(directory / "owned-processes.json", [])
                        and not devices.has_owners(device_owner(directory, ""))
                        and not gpu_processes(training_devices(load(directory / "request.json"))),
                        "previous-resources-not-released", "historical job has no confirmed unstarted admission")
            else:
                owner = device_owner(directory, worker["incarnation"])
                # An unspawned intent may precede device acquisition. A launched
                # worker must retain its device ledger even across an OS restart.
                unspawned = worker.get("pending") is True and not worker.get("process") and not load(directory / "owned-processes.json", [])
                if not devices.exists(owner):
                    require(unspawned and not gpu_processes(training_devices(load(directory / "request.json"))),
                            "previous-resources-not-released", "historical job has no confirmed device release")
                devices.release_previous_owner(owner, config["node"], allow_missing=unspawned)
            status["resourcesReleased"] = True
            status["usage"]["gpuSeconds"] = max(status["usage"]["gpuSeconds"], devices.gpu_seconds("training/" + directory.name + "/"))
            if status["execution"] in ("running", "pausing"):
                status["execution"] = "interrupted"
            atomic_json(directory / "status.json", status)
            return status

    def ensure_worker(self, directory):
        with lock(directory / "launch.lock"):
            worker = load(directory / "worker.json", {})
            if not worker.get("pending") or (directory / "cancel.json").exists(): return
            devices = device_ledger(self.config)
            if devices: devices.acquire(device_owner(directory, worker["incarnation"]), training_devices(load(directory / "request.json")))
            with (directory / "supervisor.log").open("ab") as log:
                subprocess.Popen([sys.executable, "-m", "gear_training.job", "_worker", "--job-dir", str(directory), "--incarnation", worker["incarnation"]],
                                         stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)

    def inspect(self, handle):
        directory = self.directory(handle)
        with lock(directory / "launch.lock"):
            return self.inspect_locked(directory, handle)

    def inspect_locked(self, directory, handle):
        status = load(directory / "status.json")
        require(status and status["handle"] == handle, "invalid-job-status", "job status is missing or mismatched")
        worker = load(directory / "worker.json", {})
        control = load(directory / "control.json")
        if control and control.get("admissionOnly"):
            require(not worker and status["execution"] == "paused" and status["resourcesReleased"],
                    "training-control-drift", "an admission tombstone cannot own a worker")
            return status
        devices = device_ledger(self.config)
        owner = device_owner(directory, worker["incarnation"]) if worker.get("incarnation") else None
        reserved = devices is not None and owner is not None and devices.exists(owner)
        pending = worker.get("pending") and not (directory / "cancel.json").exists()
        if status["execution"] in ("running", "pausing") and not pending and not worker_alive(worker):
            request = load(directory / "request.json")
            try: released = not any(owned_alive(i) for i in load(directory / "owned-processes.json", [])) and not gpu_processes(training_devices(request))
            except Exception: released = False
            status = {**status, "execution": "interrupted", "resourcesReleased": released, "message": "supervisor exited; resume from the last complete update commit"}
            atomic_json(directory / "status.json", status)
        if status["execution"] not in ("running", "pausing"):
            try:
                status["resourcesReleased"] = not any(owned_alive(i) for i in load(directory / "owned-processes.json", [])) and not gpu_processes(training_devices(load(directory / "request.json")))
            except Exception: status["resourcesReleased"] = False
            if reserved:
                devices.fence(owner)
                try: status["resourcesReleased"] = devices.release(owner)
                except Exception: status["resourcesReleased"] = False
            if status["resourcesReleased"] and status.get("message") == RESOURCE_RELEASE_PENDING:
                status.pop("message")
            atomic_json(directory / "status.json", status)
        if devices:
            status["usage"]["gpuSeconds"] = max(status["usage"]["gpuSeconds"], devices.gpu_seconds("training/" + directory.name + "/"))
            atomic_json(directory / "status.json", status)
        return status

    def cancel(self, handle, *, _controlled=False):
        if not _controlled:
            with lock(self.root / "submission.lock"):
                directory = self.directory(handle)
                require(not (directory / "control.json").exists(),
                        "training-control-required", "ordered jobs require a versioned pause intent")
                return self.cancel(handle, _controlled=True)
        directory = self.directory(handle)
        with lock(directory / "launch.lock"):
            atomic_json(directory / "cancel.json", {"requestedAt": time.time()})
            worker = load(directory / "worker.json", {})
            devices = device_ledger(self.config)
            owner = device_owner(directory, worker["incarnation"]) if worker.get("incarnation") else None
            if devices and owner and devices.exists(owner): devices.fence(owner)
        if not worker_alive(worker):
            identities = devices.inspect(owner)["processes"] if devices and owner and devices.exists(owner) else load(directory / "owned-processes.json", [])
            stop_owned(identities)
        status = self.inspect(handle)
        if status["execution"] in ("running", "pausing"):
            return {**status, "execution": "pausing", "resourcesReleased": False}
        return status

    def collect(self, handle):
        directory = self.directory(handle); status = self.inspect(handle)
        require(status["execution"] == "completed" and status["phase"] != "inconclusive", "artifacts-not-ready", "no completed candidate is available")
        body = load(directory / "artifacts.body.json")
        require(body, "missing-training-artifacts", "completed job has no sealed artifacts")
        return {"schemaVersion": 1, "handle": handle, **body, "usage": status["usage"], "resourcesReleased": status["resourcesReleased"]}


def worker(directory, incarnation):
    directory = Path(directory)
    with lock(directory / "worker.lock"):
        request, config = load(directory / "request.json"), load(directory / "config.json")
        devices = device_ledger(config); owner = device_owner(directory, incarnation)
        with lock(directory / "launch.lock"):
            registration = load(directory / "worker.json", {})
            if registration.get("incarnation") != incarnation or not registration.get("pending") or (directory / "cancel.json").exists(): return
            identity = process_identity(os.getpid())
            if devices: devices.track(owner, [identity], launching=True)
            atomic_json(directory / "worker.json", {"incarnation": incarnation, "process": identity, "pid": identity["pid"], "pending": False})
        handle = load(directory / "identity.json")["handle"]
        previous = load(directory / "status.json")
        ledger = Ledger(directory / "ledger.sqlite")
        from .gpu_visibility import slime_device_environment
        env = {**os.environ, **slime_device_environment(training_devices(request)), "GEAR_TRAINING_JOB": str(directory),
               "PYTHONPATH": os.pathsep.join([str(Path(__file__).resolve().parent.parent), config["slimePath"], os.environ.get("PYTHONPATH", "")])}
        env.pop("RAY_ADDRESS", None)
        started = time.monotonic(); last_tick = started; tick = 0; cancelling_at = None
        with (directory / f"slime-{incarnation}.log").open("ab") as log:
            process = subprocess.Popen([sys.executable, "-m", "gear_training.job", "_driver", "--job-dir", str(directory), "--incarnation", incarnation], env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
            owned = {}
            while True:
                import psutil
                try:
                    parent = psutil.Process(process.pid)
                    for p in [parent, *parent.children(recursive=True)]:
                        identity = process_identity(p.pid)
                        if identity: owned[(identity["pid"], identity["createdAt"])] = identity
                except psutil.NoSuchProcess: pass
                atomic_json(directory / "owned-processes.json", list(owned.values()))
                if devices: devices.track(owner, list(owned.values()))
                now = time.monotonic(); elapsed = now - last_tick; last_tick = now; tick += 1
                ledger.charge(f"gpu/{incarnation}/{tick}", gpu_seconds=elapsed * len(request["trainingDevices"]))
                usage = ledger.usage()
                if devices: usage["gpuSeconds"] = max(usage["gpuSeconds"], devices.gpu_seconds("training/" + directory.name + "/"))
                progress = load(directory / "progress.json", {"phase": "admitted", "committedUpdate": previous["committedUpdate"]})
                budget_end = usage["gpuSeconds"] >= request["budgets"]["totalGpuSeconds"] or usage["rolloutTokens"] >= request["budgets"]["maxRolloutTokens"]
                if budget_end and not (directory / "cancel.json").exists(): atomic_json(directory / "cancel.json", {"reason": "budget-exhausted"})
                cancelled = (directory / "cancel.json").exists()
                if cancelled and cancelling_at is None: cancelling_at = now
                status = {"schemaVersion": 1, "handle": handle, "phase": progress["phase"], "execution": "pausing" if cancelled else "running",
                          "committedUpdate": progress["committedUpdate"], "usage": usage, "resourcesReleased": False}
                if progress.get("latestCommitRef"): status["latestCommitRef"] = progress["latestCommitRef"]
                atomic_json(directory / "status.json", status)
                if process.poll() is not None: break
                if cancelling_at is not None and now - cancelling_at > 30:
                    try: os.killpg(process.pid, signal.SIGTERM)
                    except ProcessLookupError: pass
                    if now - cancelling_at > 45:
                        try: os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError: pass
                time.sleep(1)
        stop_owned(list(owned.values()))
        # The driver can commit or finish recovered export between our last
        # one-second progress sample and process exit. SQLite is authoritative.
        latest = ledger.db.execute("SELECT update_number,ref FROM commits ORDER BY update_number DESC LIMIT 1").fetchone()
        if latest:
            status.update(committedUpdate=latest["update_number"], latestCommitRef=json.loads(latest["ref"]))
        outcome = load(directory / "outcome.json", {})
        try: released = not any(owned_alive(i) for i in owned.values()) and not gpu_processes(training_devices(request))
        except Exception: released = False
        if process.returncode == 0 and outcome.get("outcome") == "completed": status.update(execution="completed", phase="checkpointed")
        elif outcome.get("outcome") == "inconclusive": status.update(execution="completed", phase="inconclusive", message="no complete GRPO batch within budget")
        elif cancelled: status.update(execution="paused", message="paused at the last complete checkpoint; uncommitted optimizer state is discarded")
        else: status.update(execution="failed", message="Slime job failed; inspect the private job log and resume only from a complete commit")
        if devices:
            devices.fence(owner)
            released = False  # The supervisor is still alive; inspect confirms after it exits.
        status["resourcesReleased"] = released
        if not released: status["message"] = RESOURCE_RELEASE_PENDING
        atomic_json(directory / "status.json", status)
        ledger.close()


def driver(directory, incarnation):
    directory = Path(directory)
    with lock(directory / "launch.lock"):
        registration = load(directory / "worker.json", {})
        require(registration.get("incarnation") == incarnation and worker_alive(registration) and not (directory / "cancel.json").exists(),
                "training-launch-fenced", "training supervisor no longer authorizes this driver")
        identity = process_identity(os.getpid())
        devices = device_ledger(load(directory / "config.json"))
        if devices: devices.track(device_owner(directory, incarnation), [identity], launching=True)
        known = load(directory / "owned-processes.json", [])
        atomic_json(directory / "owned-processes.json", [*known, identity])
    os.execv(sys.executable, [sys.executable, "-m", "gear_training.driver"])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("preflight", "submit", "inspect", "cancel", "collect", "_worker", "_driver"))
    parser.add_argument("--config"); parser.add_argument("--job-dir"); parser.add_argument("--incarnation")
    args = parser.parse_args()
    if args.action == "_worker": worker(args.job_dir, args.incarnation); return
    if args.action == "_driver": driver(args.job_dir, args.incarnation); return
    try:
        require(args.config, "missing-config", "job RPC requires --config")
        service = JobService(load(args.config)); payload = json.load(sys.stdin)
        if args.action == "preflight": result = preflight(payload["request"], service.config)
        elif args.action == "submit": result = service.submit(payload["request"], payload["idempotencyKey"])
        else: result = getattr(service, args.action)(payload["handle"])
        print(json.dumps(result, allow_nan=False, separators=(",", ":")))
    except Exception as error:
        print(json.dumps({"error": {"code": getattr(error, "code", "training-job-error"), "message": str(error)}}, allow_nan=False))
        sys.exit(1)


if __name__ == "__main__": main()
