"""Short-lived model-node deployment commands backed by Supervisor, not a daemon.

Only profiles pinned in the private node configuration are executable. The group
lock serializes admission/fencing; expensive file and environment checks happen
outside it and the control sequence is checked again before Supervisor starts.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import time
from datetime import datetime
from pathlib import Path

from gear.training.runtime.native_supervisor import SupervisorBackend
from gear.training.runtime.node_artifacts import hf_manifest, validate_ref
from gear.training.runtime.recovery import boot_start, identity_key, same_identity, same_process
from gear.training.storage.content import atomic_json, digest_file, digest_json, require
from gear.training.storage.snapshots import materialize
from gear.training.storage.state import load, lock


def timestamp(value):
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError, AttributeError):
        require(
            False,
            "invalid-deployment-deadline",
            "deployment deadline must be an absolute timestamp",
        )


def gpu_processes():
    from gear.training.runtime.runtime_checks import parse_gpu_process_rows

    try:
        value = subprocess.check_output(
            ["nvidia-smi", "--query-compute-apps=gpu_uuid,pid", "--format=csv,noheader,nounits"],
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        require(
            False, "native-gpu-observation-unavailable", "reserved GPU processes cannot be observed"
        )
    return [{"gpuUuid": row["device"], "pid": row["pid"]} for row in parse_gpu_process_rows(value)]


def gpu_inventory():
    try:
        value = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=uuid", "--format=csv,noheader"], text=True, timeout=10
        )
    except (OSError, subprocess.SubprocessError):
        require(
            False, "native-gpu-observation-unavailable", "reserved GPU UUIDs cannot be observed"
        )
    return [line.strip() for line in value.splitlines() if line.strip()]


def process_identity(process):
    return {
        "pid": process.pid,
        "createdAt": process.create_time(),
        **(boot_start(process.pid) or {}),
        "pgid": os.getpgid(process.pid),
    }


class NativeDeploymentService:
    def __init__(self, config, identity, store, payload):
        self.identity, self.store, self.payload = identity, store, payload
        profile = config.get("nativeDeploymentProfiles", {}).get(payload.get("profileRef"))
        require(
            isinstance(profile, dict)
            and profile.get("schemaVersion") == 1
            and profile.get("backend") == "supervisor"
            and digest_json(profile) == payload.get("profileDigest")
            and profile.get("node") == identity,
            "native-profile-drift",
            "native deployment profile is absent or differs from the trusted node profile",
        )
        require(
            profile["gpuUuids"]
            and len(set(profile["gpuUuids"])) == len(profile["gpuUuids"])
            and not set(profile["gpuUuids"]) & set(profile["trainingGpuUuids"])
            and profile["tensorParallelSize"] == len(profile["gpuUuids"]),
            "native-gpu-overlap",
            "native evaluation requires a statically disjoint GPU group",
        )
        self.profile = profile
        groups = {}
        all_training = set()
        for configured in config["nativeDeploymentProfiles"].values():
            group, devices = configured.get("resourceGroup"), set(configured.get("gpuUuids", []))
            require(
                group not in groups or groups[group] == devices,
                "native-static-group-drift",
                "profiles for one reserved group must use exactly the same GPU UUIDs",
            )
            require(
                all(group == other or not devices & assigned for other, assigned in groups.items()),
                "native-static-group-overlap",
                "distinct reserved native groups cannot overlap GPU UUIDs",
            )
            groups[group] = devices
            all_training.update(configured.get("trainingGpuUuids", []))
        require(
            not all_training & set().union(*groups.values()),
            "native-gpu-overlap",
            "all native evaluation groups must be disjoint from reserved training GPUs",
        )
        self.root = (
            Path(config["nodeRoot"])
            / "native-deployments"
            / digest_json(profile["resourceGroup"])[7:23]
        )
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        require(
            not self.root.is_symlink()
            and self.root.stat().st_uid == os.getuid()
            and self.root.stat().st_mode & 0o077 == 0,
            "unsafe-deployment-directory",
            "native deployment state must be private to its owner",
        )
        self.path, self.lock_path = self.root / "state.json", self.root / "control.lock"
        self.manager = SupervisorBackend(
            self.root,
            profile,
            "gear-" + digest_json({"node": identity, "group": profile["resourceGroup"]})[7:31],
        )

    def state(self):
        return load(
            self.path,
            {
                "schemaVersion": 1,
                "node": self.identity,
                "profileDigest": self.payload["profileDigest"],
                "owner": self.payload["owner"],
                "control": {"sequence": -1, "action": "pause"},
                "deployments": {},
                "history": {},
                "retiredOwners": {},
                "retiredIncarnations": [],
            },
        )

    def ordered(self, state, *, start=False):
        control = self.payload.get("control", {})
        owner = self.payload.get("owner")
        require(
            owner not in state["retiredOwners"],
            "deployment-owner-retired",
            "experiment explicitly relinquished this resource group; late commands are fenced",
        )
        if state.get("ownerReleased") and state["owner"] != owner:
            state.update(
                owner=owner,
                profileDigest=self.payload["profileDigest"],
                control={"sequence": -1, "action": "pause"},
                deployments={},
            )
            state.pop("current", None)
            state.pop("ownerReleased", None)
        require(
            state["node"] == self.identity
            and state["owner"] == owner
            and state["profileDigest"] == self.payload["profileDigest"],
            "deployment-owner-conflict",
            "reserved evaluation group belongs to another experiment or node generation",
        )
        require(
            set(control) == {"sequence", "action"}
            and type(control["sequence"]) is int
            and control["sequence"] >= 0
            and control["action"] in ("start", "pause"),
            "invalid-deployment-control",
            "deployment control requires an ordered start or pause",
        )
        old = state["control"]
        require(
            control["sequence"] >= old["sequence"],
            "deployment-fenced",
            "a newer deployment control intent already exists",
        )
        require(
            control["sequence"] != old["sequence"] or control == old,
            "deployment-control-conflict",
            "a deployment sequence already has another meaning",
        )
        state["control"] = control
        if start:
            require(
                control["action"] == "start",
                "deployment-fenced",
                "paused deployment cannot admit work",
            )
            require(
                timestamp(self.payload["deadlineAt"]) > time.time(),
                "deployment-deadline-expired",
                "original deployment deadline expired",
            )
        atomic_json(self.path, state)

    def fence(self):
        with lock(self.lock_path):
            state = self.state()
            if self.payload["owner"] in state["retiredOwners"]:
                return {
                    "control": state["retiredOwners"][self.payload["owner"]]["control"],
                    "ownerRetired": True,
                }
            self.ordered(state)
            return {"control": state["control"]}

    def runtime(self):
        from gear.training.runtime.node_runtime import package_version

        # Reuse the runtime observer in the explicitly selected evaluation Python.
        root = str(Path(__file__).resolve().parents[3])
        code = (
            "import json,sys;from pathlib import Path;root=" + repr(root) + ";"
            "sys.path.insert(0,root) if root not in [str(Path(p).resolve()) for p in sys.path] else None;"
            "from gear.training.runtime.node_runtime import observe_startup_runtime;"
            "print(json.dumps(observe_startup_runtime()))"
        )
        value = json.loads(
            subprocess.check_output([self.profile["python"], "-c", code], text=True, timeout=30)
        )
        expected = self.profile["runtimeLock"]
        require(
            digest_json(value) == expected["environmentDigest"]
            and value["pythonVersion"] == expected["pythonVersion"]
            and package_version(value, "sglang") == expected["sglangVersion"],
            "native-runtime-lock-drift",
            "evaluation Python environment differs from its frozen runtime lock",
        )
        version = subprocess.check_output(
            [
                self.profile["supervisorPython"],
                "-c",
                "import importlib.metadata;print(importlib.metadata.version('supervisor'))",
            ],
            text=True,
            timeout=15,
        ).strip()
        require(
            version == expected["supervisorVersion"],
            "native-runtime-lock-drift",
            "Supervisor version differs from the profile",
        )
        binary = Path(expected["timeoutBinary"])
        require(
            binary.is_file()
            and os.access(binary, os.X_OK)
            and digest_file(binary) == expected["timeoutDigest"],
            "native-deadline-tool-drift",
            "deadline utility differs from the pinned binary",
        )
        require(
            "GNU coreutils"
            in subprocess.check_output([str(binary), "--version"], text=True, timeout=5),
            "native-deadline-tool-drift",
            "native deadline enforcement requires GNU timeout",
        )

    def prepare_snapshot(self, record):
        snapshot = validate_ref(record["snapshotRef"])
        hf_manifest(
            self.store, {"snapshotRef": snapshot}
        )  # Full hash and safetensors/layout verification.
        manifest = self.store.read_json(snapshot)
        destination = self.root.parent / "snapshots" / snapshot["digest"][7:]
        needed = 0 if destination.exists() else sum(item["size"] for item in manifest["files"])
        require(
            shutil.disk_usage(self.root).free >= needed + self.profile["minFreeDiskBytes"],
            "native-insufficient-disk",
            "insufficient disk for the complete immutable snapshot",
        )
        with lock(destination.with_suffix(".lock")):
            materialize(self.store, snapshot, destination)
            for entry in destination.rglob("*"):
                entry.chmod(0o555 if entry.is_dir() else 0o444)
            destination.chmod(0o555)
        require(
            record["snapshotPath"] == str(destination),
            "deployment-snapshot-drift",
            "deployment points outside its digest-addressed snapshot",
        )
        record["snapshotProof"] = self.snapshot_stamp(destination)

    @staticmethod
    def snapshot_stamp(destination):
        root = Path(destination)
        entries = []
        for path in [root, *sorted(root.rglob("*"))]:
            require(
                not path.is_symlink() and (path.is_dir() or path.is_file()),
                "deployment-snapshot-drift",
                "immutable snapshot contains a symlink or special file",
            )
            stat = path.stat()
            require(
                stat.st_mode & 0o222 == 0,
                "deployment-snapshot-drift",
                "immutable snapshot became writable",
            )
            entries.append(
                {
                    "path": str(path.relative_to(root)),
                    "dev": str(stat.st_dev),
                    "inode": str(stat.st_ino),
                    "size": stat.st_size,
                    "mtimeNs": str(stat.st_mtime_ns),
                    "ctimeNs": str(stat.st_ctime_ns),
                    "mode": stat.st_mode,
                }
            )
        return entries

    def verify_snapshot_proof(self, record):
        require(
            record.get("snapshotProof") == self.snapshot_stamp(record["snapshotPath"]),
            "deployment-snapshot-drift",
            "previously hash-verified read-only snapshot changed",
        )

    def preflight(self):
        require(
            set(self.profile["gpuUuids"]) <= set(gpu_inventory()),
            "native-gpu-inventory-drift",
            "reserved evaluation GPU UUIDs are not present on this node",
        )
        active = [p for p in gpu_processes() if p["gpuUuid"] in self.profile["gpuUuids"]]
        require(
            not active,
            "native-resource-conflict",
            "reserved evaluation GPUs are occupied; foreign processes will not be stopped",
        )
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(("127.0.0.1", self.profile["endpoint"]["nodePort"]))
            except OSError:
                require(
                    False,
                    "native-port-conflict",
                    "evaluation port is occupied; existing listener will not be stopped",
                )

    def running_identity(self, record, info, *, stopping=False):
        import psutil

        require(
            info and info["pid"] > 0,
            "deployment-incarnation-lost",
            "Supervisor no longer has the original model instance",
        )
        try:
            wrapper = psutil.Process(info["pid"])
            require(
                wrapper.uids().real == os.getuid() and wrapper.cmdline() == record["argv"],
                "deployment-process-ownership",
                "running deadline command differs from its immutable intent",
            )
            identity = process_identity(wrapper)
            if record.get("process"):
                require(
                    same_identity(record["process"], identity),
                    "deployment-incarnation-lost",
                    "Supervisor process identity changed",
                )
            processes = [wrapper, *wrapper.children(recursive=True)]
            models = [p for p in processes if p.cmdline() == record["modelArgv"]]
            require(
                len(models) == 1 or stopping and not models,
                "deployment-process-unverified",
                "actual SGLang entry point and model path have not been verified",
            )
            env = (models[0] if models else wrapper).environ()
            require(
                env.get("GEAR_NATIVE_INCARNATION") == record["incarnation"]
                and env.get("GEAR_NATIVE_INTENT") == record["intentDigest"]
                and env.get("CUDA_VISIBLE_DEVICES") == ",".join(self.profile["gpuUuids"])
                and all(os.getpgid(p.pid) == identity["pgid"] for p in processes),
                "deployment-process-ownership",
                "model devices, incarnation or child process group differ from ownership",
            )
            return identity, [process_identity(p) for p in processes]
        except (psutil.NoSuchProcess, psutil.ZombieProcess, ProcessLookupError):
            require(False, "deployment-process-unverified", "model process is not yet observable")
        except (psutil.AccessDenied, PermissionError, SystemError):
            require(
                False, "deployment-process-ownership", "running model ownership cannot be verified"
            )

    @staticmethod
    def remember_processes(record, identity, processes):
        # A child may leave the current parent tree before the next observation.
        # Keep every previously observed PID/start-time pair for stop proof.
        observed = {identity_key(process): process for process in record.get("processes", [])}
        for process in processes:
            observed.setdefault(identity_key(process), process)
        record["process"] = identity
        record["processes"] = list(observed.values())

    def request_record(self):
        intent = self.payload["intent"]
        require(
            isinstance(intent, dict)
            and re.fullmatch(r"sha256:[0-9a-f]{64}", str(intent.get("intentDigest", "")))
            and re.fullmatch(r"[0-9a-f]{32}", str(intent.get("incarnation", "")))
            and re.fullmatch(r"gear-[0-9a-f]{32}", str(intent.get("wireModel", "")))
            and isinstance(intent.get("authKey"), str)
            and re.fullmatch(r"[0-9a-f]{64}", intent["authKey"]),
            "invalid-deployment-intent",
            "native intent requires immutable identity and per-incarnation authentication",
        )
        validate_ref(intent["modelRef"])
        snapshot = validate_ref(intent["snapshotRef"])
        identity = {
            "owner": self.payload["owner"],
            "modelRef": intent["modelRef"],
            "snapshotRef": snapshot,
            "profileDigest": self.payload["profileDigest"],
            "runId": intent.get("runId"),
        }
        require(
            digest_json(identity) == intent["intentDigest"],
            "deployment-intent-drift",
            "native intent differs from its immutable model, owner or profile",
        )
        startup, hard = timestamp(intent["startupDeadlineAt"]), timestamp(intent["hardDeadlineAt"])
        require(
            timestamp(intent["createdAt"]) <= time.time() + 5,
            "native-clock-skew",
            "controller and model-node clocks must be synchronized within five seconds",
        )
        require(
            startup <= hard <= timestamp(self.payload["deadlineAt"])
            and hard - timestamp(intent["createdAt"]) <= self.profile["maxRuntimeSeconds"] + 1,
            "deployment-deadline-drift",
            "native retry cannot refresh the original total deadline",
        )
        require(
            type(intent["attempt"]) is int
            and 1 <= intent["attempt"] <= self.profile["maxDeploymentAttempts"],
            "deployment-attempts-exhausted",
            "native deployment attempts exhausted",
        )
        snapshot_path = str(self.root.parent / "snapshots" / snapshot["digest"][7:])
        model_argv = [
            self.profile["python"],
            "-m",
            "sglang.launch_server",
            "--model-path",
            snapshot_path,
            "--host",
            "127.0.0.1",
            "--port",
            str(self.profile["endpoint"]["nodePort"]),
            "--tp-size",
            str(self.profile["tensorParallelSize"]),
            "--served-model-name",
            intent["wireModel"],
            "--api-key",
            intent["authKey"],
            *self.profile["engineArgs"],
        ]
        # GNU timeout enforces a finite offline backstop. Its entire process group
        # is also owned by Supervisor; there is no Gear watchdog process.
        argv = [
            self.profile["runtimeLock"]["timeoutBinary"],
            "--signal=KILL",
            "--kill-after=" + str(self.profile["stopTimeoutSeconds"]) + "s",
            str(max(0.001, hard - time.time())) + "s",
            *model_argv,
        ]
        return {
            **intent,
            "owner": self.payload["owner"],
            "snapshotPath": snapshot_path,
            "program": "model_" + intent["incarnation"],
            "modelArgv": model_argv,
            "argv": argv,
            "status": "preparing",
            "consumers": {},
            "admission": False,
        }

    def ensure(self):
        proposed = self.request_record()
        key = proposed["intentDigest"]
        with lock(self.lock_path):
            state = self.state()
            self.ordered(state, start=True)
            require(
                proposed["incarnation"] not in state["retiredIncarnations"],
                "deployment-fenced",
                "native instance was retired before its delayed start arrived",
            )
            current = state.get("current")
            previous = state["deployments"].get(key)
            if previous and previous["incarnation"] == proposed["incarnation"]:
                if previous["status"] != "preparing":
                    result = self.observation(previous)
                    atomic_json(self.path, state)
                    return result
                proposed = previous
                if previous.get("launchRequestedAt"):
                    info = self.manager.inspect(previous["program"])
                    require(
                        info and info["pid"] > 0,
                        "deployment-start-uncertain",
                        "interrupted launch requires proven release before retry",
                    )
                    self.running_identity(previous, info)
                    previous["status"] = "starting"
                    result = self.observation(previous)
                    atomic_json(self.path, state)
                    return result
            if current and current != key:
                occupied = state["deployments"][current]
                require(
                    occupied["status"] == "released",
                    "native-group-occupied",
                    "retire the previous owned deployment after consumers end",
                )
            if previous and previous["incarnation"] != proposed["incarnation"]:
                require(
                    previous["status"] == "released"
                    and proposed["attempt"] == previous["attempt"] + 1
                    and (
                        proposed["startupDeadlineAt"] == previous["startupDeadlineAt"]
                        or previous.get("everReady")
                        and timestamp(proposed["startupDeadlineAt"])
                        <= min(
                            timestamp(previous["hardDeadlineAt"]),
                            time.time() + self.profile["startupTimeoutSeconds"] + 1,
                        )
                    )
                    and proposed["hardDeadlineAt"] == previous["hardDeadlineAt"],
                    "deployment-retry-drift",
                    "new native instance requires proven release and the original bounded deadline",
                )
                state["history"][previous["incarnation"]] = previous
            state["deployments"][key] = proposed
            state["current"] = key
            atomic_json(self.path, state)
        try:
            self.runtime()
            self.prepare_snapshot(proposed)
            self.preflight()
            # Avoid two concurrent ensures creating two managers; this operation
            # is short and every remote start is fenced inside this same lock.
            with lock(self.lock_path):
                state = self.state()
                self.ordered(state, start=True)
                record = state["deployments"][key]
                require(
                    record["incarnation"] == proposed["incarnation"]
                    and record["status"] in ("preparing", "starting"),
                    "deployment-fenced",
                    "deployment was retired during preparation",
                )
                info = self.manager.inspect(record["program"])
                if info and info["pid"] > 0:
                    self.running_identity(record, info)
                    record["status"] = "starting"
                    atomic_json(self.path, state)
                    return self.observation(record)
                require(
                    not record.get("launchRequestedAt"),
                    "deployment-start-uncertain",
                    "original launch was interrupted; prove release before using a new incarnation",
                )
                require(
                    time.time() < timestamp(record["startupDeadlineAt"]),
                    "deployment-startup-timeout",
                    "original startup deadline expired before process launch",
                )
                remaining = min(
                    timestamp(record["hardDeadlineAt"]) - time.time(),
                    self.profile["maxRuntimeSeconds"],
                )
                require(
                    remaining > 0,
                    "deployment-deadline-expired",
                    "insufficient original deadline for a bounded process stop",
                )
                record["argv"][3] = str(remaining) + "s"
                record["snapshotProof"] = proposed["snapshotProof"]
                self.manager.ensure_manager()
                record["configDigest"] = self.manager.configure(record)
                record["launchRequestedAt"] = time.time()
                atomic_json(
                    self.path, state
                )  # Final argv and start intent precede the uncertain RPC.
                self.manager.start(record["program"])
                record["status"] = "starting"
                atomic_json(self.path, state)
        except Exception as error:
            with lock(self.lock_path):
                state = self.state()
                record = state["deployments"][key]
                record["failure"] = getattr(error, "code", "native-preparation-failed")
                atomic_json(self.path, state)
            raise
        return self.observe()

    def observation(self, record):
        result = {
            key: record[key]
            for key in (
                "intentDigest",
                "incarnation",
                "wireModel",
                "snapshotRef",
                "status",
                "admission",
                "attempt",
                "hardDeadlineAt",
                "startupDeadlineAt",
            )
        }
        result["consumers"] = record["consumers"]
        if record["status"] == "released":
            result.update(released=True, processState="RELEASED", verified=False)
            return result
        try:
            info = self.manager.inspect(record["program"])
        except (ConnectionRefusedError, FileNotFoundError):
            info = None
        result["processState"] = info["statename"] if info else "ABSENT"
        result["failure"] = record.get("failure")
        if info and info["statename"] in ("STARTING", "RUNNING"):
            identity, children = self.running_identity(record, info)
            self.remember_processes(record, identity, children)
            result["verified"] = True
            result["process"] = identity
        else:
            result["verified"] = False
            proof = self.stop_proof(record)
            result["deathProven"] = (
                not proof["remaining"] and not proof["ownedGpu"] and not proof["uncertain"]
            )
            if time.time() >= timestamp(record["hardDeadlineAt"]):
                result["failure"] = "deployment-hard-deadline-exceeded"
        return result

    def stop_proof(self, record):
        import psutil

        remaining, uncertain, reused = [], False, set()
        pgid = record.get("process", {}).get("pgid")
        known = {entry["pid"]: entry for entry in record.get("processes", [])}
        gpu = [p for p in gpu_processes() if p["gpuUuid"] in self.profile["gpuUuids"]]
        gpu_pids = {p["pid"] for p in gpu}
        for process in psutil.process_iter(["pid", "create_time", "status"]):
            candidate = process.pid in known or process.pid in gpu_pids
            try:
                owned = process.pid in known and same_process(process, known[process.pid])
                if process.pid in known and not owned:
                    reused.add(process.pid)
                same_group = bool(pgid and os.getpgid(process.pid) == pgid)
                candidate = candidate or same_group
                if not owned and process.uids().real == os.getuid():
                    owned = (
                        process.environ().get("GEAR_NATIVE_INCARNATION") == record["incarnation"]
                    )
                if (owned or same_group) and process.status() != psutil.STATUS_ZOMBIE:
                    remaining.append(process.pid)
            except (psutil.NoSuchProcess, ProcessLookupError):
                continue
            except (psutil.AccessDenied, PermissionError, SystemError):
                # Unrelated protected processes are not this experiment's
                # ownership uncertainty. A never-observed launch remains
                # conservative until its original group can be identified.
                if candidate or record.get("launchRequestedAt") and not record.get("process"):
                    uncertain = True
        owned_pids = set(remaining) | (set(known) - reused)
        return {
            "remaining": remaining,
            "ownedGpu": [p for p in gpu if p["pid"] in owned_pids],
            "gpu": gpu,
            "uncertain": uncertain,
        }

    def target(self, state):
        record = state["deployments"].get(self.payload.get("intentDigest"))
        if record and record["incarnation"] != self.payload.get("incarnation"):
            record = state["history"].get(self.payload.get("incarnation"))
        require(
            record and record["incarnation"] == self.payload.get("incarnation"),
            "deployment-incarnation-lost",
            "original native instance no longer exists",
        )
        return record

    def observe(self):
        with lock(self.lock_path):
            state = self.state()
            if self.payload["owner"] in state["retiredOwners"]:
                old = state["history"].get(self.payload.get("incarnation"))
                require(
                    old
                    and old.get("owner") == self.payload["owner"]
                    and old["status"] == "released",
                    "deployment-owner-conflict",
                    "retired owner has no release proof for this instance",
                )
                return self.observation(old)
            require(
                state["owner"] == self.payload["owner"] and state["node"] == self.identity,
                "deployment-owner-conflict",
                "deployment state belongs to another owner",
            )
            key = self.payload.get("intentDigest") or self.payload.get("intent", {}).get(
                "intentDigest"
            )
            record = state["deployments"].get(key)
            incarnation = self.payload.get("incarnation") or self.payload.get("intent", {}).get(
                "incarnation"
            )
            if record and record["incarnation"] != incarnation:
                record = state["history"].get(incarnation)
            if not record:
                if self.payload.get("incarnation") in state["retiredIncarnations"]:
                    return {"status": "released", "verified": False, "released": True}
                return {"status": "absent", "verified": False}
            require(
                record["incarnation"] == incarnation,
                "deployment-incarnation-lost",
                "original native incarnation has been replaced",
            )
            result = self.observation(record)
            atomic_json(self.path, state)
        if result.get("verified"):
            # The full closure was hashed before launch. Check every immutable
            # inode/stat stamp without rereading tens of GB on every poll.
            self.verify_snapshot_proof(record)
        return result

    def ready(self):
        with lock(self.lock_path):
            state = self.state()
            record = self.target(state)
        if record["status"] != "ready":
            self.prepare_snapshot(record)  # First readiness rechecks the complete closure.
        else:
            self.verify_snapshot_proof(record)
        with lock(self.lock_path):
            state = self.state()
            self.ordered(state, start=True)
            record = self.target(state)
            if record["status"] != "ready":
                record["snapshotProof"] = self.snapshot_stamp(record["snapshotPath"])
            require(
                record["status"] in ("starting", "ready")
                and self.observation(record).get("verified"),
                "deployment-not-ready",
                "native process identity must be verified before admission",
            )
            record["status"], record["admission"] = "ready", True
            record["everReady"] = True
            atomic_json(self.path, state)
            return self.observation(record)

    def consumer(self, release=False):
        consumer = self.payload["consumer"]
        require(
            isinstance(consumer, dict)
            and isinstance(consumer.get("id"), str)
            and len(consumer["id"]) <= 256,
            "invalid-deployment-consumer",
            "native consumer needs a stable task/attempt identity",
        )
        with lock(self.lock_path):
            state = self.state()
            if not release:
                self.ordered(state, start=True)
            record = self.target(state)
            old = record["consumers"].get(consumer["id"])
            if release:
                if old:
                    old["releasedAt"] = self.payload["releasedAt"]
            else:
                require(
                    record["status"] == "ready" and record["admission"],
                    "deployment-draining",
                    "deployment no longer admits consumers",
                )
                require(
                    consumer.get("experimentId") == state["owner"]
                    and isinstance(consumer.get("runId"), str)
                    and isinstance(consumer.get("evaluationKey"), str),
                    "invalid-deployment-consumer",
                    "native consumer must identify the owning experiment, run and evaluation",
                )
                require(
                    not old or old["consumer"] == consumer and "releasedAt" not in old,
                    "deployment-consumer-conflict",
                    "consumer identity is immutable and cannot be reopened",
                )
                require(
                    self.observation(record).get("verified"),
                    "deployment-incarnation-lost",
                    "consumer cannot bind a dead model instance",
                )
                record["consumers"][consumer["id"]] = old or {
                    "consumer": consumer,
                    "acquiredAt": self.payload["acquiredAt"],
                }
            atomic_json(self.path, state)
            return {"consumers": record["consumers"]}

    def retire(self):
        with lock(self.lock_path):
            state = self.state()
            if self.payload["owner"] in state["retiredOwners"]:
                old = state["history"].get(self.payload.get("incarnation"))
                require(
                    self.payload.get("incarnation") in state["retiredIncarnations"]
                    and (
                        not old
                        or old.get("owner") == self.payload["owner"]
                        and old["status"] == "released"
                    ),
                    "deployment-owner-conflict",
                    "retired owner has no release proof for this instance",
                )
                return {"status": "released"}
            self.ordered(state)
            if self.payload.get("intentDigest") not in state["deployments"]:
                # Persist a negative intent too: an earlier timed-out SSH start
                # may not have arrived yet. Its incarnation must never start.
                incarnation = self.payload.get("incarnation")
                require(
                    isinstance(incarnation, str) and re.fullmatch(r"[0-9a-f]{32}", incarnation),
                    "invalid-deployment-intent",
                    "retirement needs an original incarnation",
                )
                if incarnation not in state["retiredIncarnations"]:
                    state["retiredIncarnations"].append(incarnation)
                atomic_json(self.path, state)
                return {"status": "released"}
            record = self.target(state)
            if record["status"] == "released":
                return {"status": "released"}
            record["admission"] = False
            record["status"] = "draining"
            atomic_json(self.path, state)
            if any("releasedAt" not in c for c in record["consumers"].values()):
                return {"status": "draining", "reason": "active-consumers"}
            try:
                info = self.manager.inspect(record["program"])
            except (ConnectionRefusedError, FileNotFoundError):
                info = None
            if info and info["statename"] in ("STARTING", "RUNNING"):
                identity, children = self.running_identity(record, info, stopping=True)
                self.remember_processes(record, identity, children)
            record["status"] = "stopping"
            record.setdefault("stopDeadlineAt", time.time() + self.profile["stopTimeoutSeconds"])
            atomic_json(self.path, state)
            if info:
                self.manager.stop(record["program"])
        if info:
            self.manager.await_stopped(record["program"], record["stopDeadlineAt"])
        # Proof includes every previously observed descendant and every remaining
        # process in the owned group, plus reserved-GPU compute-process records.
        proof = self.stop_proof(record)
        while (proof["remaining"] or proof["ownedGpu"]) and time.time() < record["stopDeadlineAt"]:
            time.sleep(0.05)
            proof = self.stop_proof(record)
        with lock(self.lock_path):
            state = self.state()
            current = self.target(state)
            if proof["remaining"] or proof["ownedGpu"] or proof["uncertain"]:
                current["failure"] = "deployment-stop-unproven"
                atomic_json(self.path, state)
                return {"status": "blocked", "reason": "deployment-stop-unproven"}
            current["status"] = "released"
            current["releasedAt"] = time.time()
            current["foreignGpuProcesses"] = proof["gpu"]
            if current["incarnation"] not in state["retiredIncarnations"]:
                state["retiredIncarnations"].append(current["incarnation"])
            atomic_json(self.path, state)
            return {
                "status": "released",
                **({"reason": "foreign-resource-conflict"} if proof["gpu"] else {}),
            }

    def releaseOwnership(self):
        with lock(self.lock_path):
            state = self.state()
            if self.payload["owner"] in state["retiredOwners"]:
                return {"released": True}
            self.ordered(state)
            if any(
                record["status"] != "released"
                or any("releasedAt" not in c for c in record["consumers"].values())
                for record in state["deployments"].values()
            ):
                return {"released": False, "reason": "owned-deployments-or-consumers-remain"}
            state["ownerReleased"] = True
            state["retiredOwners"][state["owner"]] = {
                "control": state["control"],
                "releasedAt": time.time(),
            }
            state["history"].update(
                {record["incarnation"]: record for record in state["deployments"].values()}
            )
            atomic_json(self.path, state)
            return {"released": True}

    def execute(self, action):
        require(
            action
            in (
                "fence",
                "ensure",
                "observe",
                "ready",
                "acquireConsumer",
                "releaseConsumer",
                "retire",
                "releaseOwnership",
            ),
            "unknown-node-operation",
            "unknown native deployment operation",
        )
        if action == "acquireConsumer":
            return self.consumer()
        if action == "releaseConsumer":
            return self.consumer(release=True)
        return getattr(self, action)()
