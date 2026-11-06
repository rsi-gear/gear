"""Real Supervisor/GNU-timeout tests with an explicitly controlled CPU engine.

These test the process-management protocol, not SGLang, GPU loading or Harbor.
CI installs Gear's deployment extra; the suite fails rather than silently skips
if Supervisor or GNU timeout is missing. macOS may set GEAR_TEST_TIMEOUT.
"""

from __future__ import annotations

import copy
import importlib.metadata
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import psutil

from gear.training.runtime.native_deployment import NativeDeploymentService, process_identity
from gear.training.storage.content import (
    ContentStore,
    ContractError,
    atomic_json,
    digest_file,
    digest_json,
)
from gear.training.storage.snapshots import seal_directory
from gear.training.storage.state import load

CPU_ENGINE = """
import argparse,json,os,signal,subprocess,sys
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
p=argparse.ArgumentParser()
p.add_argument('--model-path');p.add_argument('--host');p.add_argument('--port',type=int)
p.add_argument('--tp-size');p.add_argument('--served-model-name');p.add_argument('--api-key')
a,_=p.parse_known_args()
child=subprocess.Popen([sys.executable,'-c','import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(600)'])
with open(os.environ['GEAR_NATIVE_TEST_CHILDREN'],'a') as f:
 f.write(json.dumps({'pid':child.pid,'parent':os.getpid()})+'\\n')
class H(BaseHTTPRequestHandler):
 def do_POST(self):
  data=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))))
  status=200 if self.headers.get('Authorization')=='Bearer '+a.api_key else 401
  if status==200 and data.get('model')!=a.served_model_name:status=404
  body=json.dumps({'model':a.served_model_name,'choices':[{'message':{'content':'controlled CPU response'}}]}).encode()
  self.send_response(status);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(body)
 def log_message(self,*args):pass
ThreadingHTTPServer((a.host,a.port),H).serve_forever()
"""


def iso(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat()


class NativeSupervisorTests(unittest.TestCase):
    def setUp(self):
        self.assertEqual(importlib.metadata.version("supervisor"), "4.3.0")
        timeout = (
            os.environ.get("GEAR_TEST_TIMEOUT")
            or shutil.which("timeout")
            or shutil.which("gtimeout")
        )
        self.assertIsNotNone(
            timeout,
            "install GNU coreutils or set GEAR_TEST_TIMEOUT; native manager tests cannot be skipped",
        )
        self.timeout = str(timeout)
        temporary = tempfile.TemporaryDirectory(prefix="gn-", dir="/tmp")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        fixture = self.root / "fixtures" / "sglang"
        fixture.mkdir(parents=True)
        (fixture / "__init__.py").write_text("")
        (fixture / "launch_server.py").write_text(CPU_ENGINE)
        self.child_file = self.root / "children.jsonl"
        environment = patch.dict(
            os.environ,
            {
                "PYTHONPATH": str(fixture.parent) + os.pathsep + os.environ.get("PYTHONPATH", ""),
                "GEAR_NATIVE_TEST_CHILDREN": str(self.child_file),
            },
        )
        environment.start()
        self.addCleanup(environment.stop)
        # GPU and engine-environment observations are deliberately controlled;
        # the actual Supervisor, timeout, child processes, CAS and HTTP are real.
        for target, value in (("gpu_processes", []), ("gpu_inventory", ["GPU-eval"])):
            mocked = patch("gear.training.runtime.native_deployment." + target, return_value=value)
            mocked.start()
            self.addCleanup(mocked.stop)
        self.real_runtime = NativeDeploymentService.runtime
        runtime = patch.object(NativeDeploymentService, "runtime", return_value=None)
        runtime.start()
        self.addCleanup(runtime.stop)
        self.identity = {"nodeId": "cpu-test-node", "generation": "test-boot"}
        with socket.socket() as available:
            available.bind(("127.0.0.1", 0))
            self.port = available.getsockname()[1]
        self.profile = {
            "schemaVersion": 1,
            "name": "cpu-controlled",
            "nodeRef": "test",
            "node": self.identity,
            "backend": "supervisor",
            "resourceGroup": "reserved-eval",
            "gpuUuids": ["GPU-eval"],
            "trainingGpuUuids": ["GPU-train"],
            "tensorParallelSize": 1,
            "python": sys.executable,
            "supervisorPython": sys.executable,
            "engineArgs": [],
            "runtimeLock": {
                "environmentDigest": digest_json("controlled-runtime"),
                "pythonVersion": "controlled",
                "sglangVersion": "controlled-cpu-fixture",
                "supervisorVersion": "4.3.0",
                "timeoutBinary": self.timeout,
                "timeoutDigest": digest_file(self.timeout),
            },
            "endpoint": {"nodePort": self.port, "localPort": self.port},
            "minFreeDiskBytes": 0,
            "startupTimeoutSeconds": 10,
            "stopTimeoutSeconds": 2,
            "maxRuntimeSeconds": 60,
            "maxDeploymentAttempts": 2,
        }
        self.config = {
            "nodeRoot": str(self.root / "node"),
            "nativeDeploymentProfiles": {self.profile["name"]: self.profile},
        }
        self.store = ContentStore(self.root / "cas")
        model = self.root / "model"
        model.mkdir()
        (model / "config.json").write_text(
            json.dumps(
                {
                    "architectures": ["Qwen2ForCausalLM"],
                    "model_type": "qwen2",
                    "torch_dtype": "float32",
                }
            )
        )
        (model / "tokenizer_config.json").write_text(
            json.dumps({"chat_template": "{{ messages }}"})
        )
        (model / "tokenizer.json").write_text("{}")
        header = json.dumps(
            {"weight": {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]}}
        ).encode()
        (model / "model.safetensors").write_bytes(
            struct.pack("<Q", len(header)) + header + struct.pack("<f", 1)
        )
        self.snapshot = seal_directory(self.store, model, serving=True)
        self.model_ref = self.store.put_json({"hfSnapshotRef": self.snapshot})
        self.owner = "experiment-cpu"
        self.intent = self.new_intent()
        self.managers = []
        self.addCleanup(self.shutdown)

    def new_intent(self, *, hard_seconds=45):
        now = time.time()
        incarnation = uuid.uuid4().hex
        identity = {
            "owner": self.owner,
            "modelRef": self.model_ref,
            "snapshotRef": self.snapshot,
            "profileDigest": digest_json(self.profile),
            "runId": "test-run",
        }
        return {
            "intentDigest": digest_json(identity),
            "modelRef": self.model_ref,
            "snapshotRef": self.snapshot,
            "runId": "test-run",
            "incarnation": incarnation,
            "wireModel": "gear-" + incarnation,
            "authKey": uuid.uuid4().hex + uuid.uuid4().hex,
            "attempt": 1,
            "createdAt": iso(now),
            "startupDeadlineAt": iso(now + min(10, hard_seconds)),
            "hardDeadlineAt": iso(now + hard_seconds),
        }

    def service(self, *, action="start", sequence=1, intent=None, extra=None, owner=None):
        selected = intent or self.intent
        payload = {
            "profileRef": self.profile["name"],
            "profileDigest": digest_json(self.profile),
            "owner": owner or self.owner,
            "control": {"sequence": sequence, "action": action},
            "deadlineAt": iso(time.time() + 60),
            "intent": selected,
            "intentDigest": selected["intentDigest"],
            "incarnation": selected["incarnation"],
            **(extra or {}),
        }
        service = NativeDeploymentService(self.config, self.identity, self.store, payload)
        self.managers.append(service.manager)
        return service

    def shutdown(self):
        for manager in reversed(self.managers):
            try:
                if manager.observe_manager():
                    manager.rpc.stopAllProcesses(False)
                    manager.rpc.shutdown()
            except (OSError, ContractError):
                pass
            finally:
                manager.close()
        # Only fixture children with exact recorded identity and this test's
        # private environment are cleaned if a failure interrupted assertions.
        if self.child_file.exists():
            for line in self.child_file.read_text().splitlines():
                child = json.loads(line)
                for pid in (child["pid"], child["parent"]):
                    try:
                        process = psutil.Process(pid)
                        if process.environ().get("GEAR_NATIVE_TEST_CHILDREN") == str(
                            self.child_file
                        ):
                            process.kill()
                    except (psutil.NoSuchProcess, psutil.AccessDenied, SystemError):
                        pass
        # Reap supervisors before TemporaryDirectory handles immutable snapshots.
        time.sleep(0.08)
        for path in self.root.rglob("*"):
            if path.is_dir():
                path.chmod(0o700)
            elif path.is_file() and not path.is_symlink():
                path.chmod(0o600)

    def ready(self, service):
        try:
            service.ensure()
        except ContractError as error:
            if error.code != "deployment-process-unverified":
                raise
        deadline = time.time() + 5
        while time.time() < deadline:
            try:
                observed = service.observe()
                if observed.get("verified"):
                    ready = service.ready()
                    self.request(
                        service.payload["intent"]["authKey"], service.payload["intent"]["wireModel"]
                    )
                    return ready
            except (ContractError, OSError):
                pass
            time.sleep(0.025)
        self.fail("real Supervisor CPU fixture did not become verified/ready")

    def request(self, key, wire):
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/v1/chat/completions",
            data=json.dumps({"model": wire}).encode(),
            headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=1) as response:
            return json.load(response)

    def test_real_supervisor_owns_command_snapshot_and_term_ignoring_child_group(self):
        service = self.service()
        first = self.ready(service)
        self.assertTrue(first["verified"])
        state = load(service.path)
        record = state["deployments"][self.intent["intentDigest"]]
        self.assertEqual(record["modelArgv"][1:3], ["-m", "sglang.launch_server"])
        self.assertIn(self.snapshot["digest"][7:], record["snapshotPath"])
        self.assertEqual(service.ensure()["incarnation"], first["incarnation"])
        children = list(record["processes"])
        stopped = self.service(action="pause", sequence=2).retire()
        self.assertEqual(stopped, {"status": "released"})
        for child in children:
            try:
                current = psutil.Process(child["pid"])
                self.assertTrue(
                    current.create_time() != child["createdAt"]
                    or current.status() == psutil.STATUS_ZOMBIE
                )
            except psutil.NoSuchProcess:
                pass

    def test_two_consumers_drain_atomically_without_single_cancel_stopping_other_task(self):
        service = self.service()
        self.ready(service)
        for identifier in ("task-a", "task-b"):
            self.service(
                extra={
                    "consumer": {
                        "id": identifier,
                        "experimentId": self.owner,
                        "runId": "test-run",
                        "evaluationKey": identifier,
                    },
                    "acquiredAt": iso(time.time()),
                }
            ).consumer()
        self.service(extra={"consumer": {"id": "task-a"}, "releasedAt": iso(time.time())}).consumer(
            release=True
        )
        self.assertEqual(
            self.service().retire(), {"status": "draining", "reason": "active-consumers"}
        )
        self.assertEqual(
            self.request(self.intent["authKey"], self.intent["wireModel"])["model"],
            self.intent["wireModel"],
        )
        with self.assertRaises(ContractError) as denied:
            self.service(
                extra={
                    "consumer": {
                        "id": "late",
                        "experimentId": self.owner,
                        "runId": "test-run",
                        "evaluationKey": "late",
                    },
                    "acquiredAt": iso(time.time()),
                }
            ).consumer()
        self.assertEqual(denied.exception.code, "deployment-draining")
        self.service(extra={"consumer": {"id": "task-b"}, "releasedAt": iso(time.time())}).consumer(
            release=True
        )
        self.assertEqual(self.service().retire(), {"status": "released"})

    def test_offline_hard_deadline_kills_parent_and_child_without_controller(self):
        self.intent = self.new_intent(hard_seconds=2)
        service = self.service()
        self.ready(service)
        record = load(service.path)["deployments"][self.intent["intentDigest"]]
        time.sleep(
            max(0, datetime.fromisoformat(self.intent["hardDeadlineAt"]).timestamp() - time.time())
            + 0.25
        )
        observed = service.observe()
        self.assertFalse(observed["verified"])
        self.assertTrue(observed["deathProven"])
        self.assertEqual(observed["failure"], "deployment-hard-deadline-exceeded")
        self.assertEqual(service.retire(), {"status": "released"})
        self.assertTrue(record["processes"])

    def test_start_reply_lost_before_state_update_recovers_same_incarnation(self):
        service = self.service()
        start = service.manager.start

        def lost_reply(name):
            start(name)
            time.sleep(0.1)
            raise OSError("simulated SSH/request process loss after Supervisor accepted start")

        with patch.object(service.manager, "start", side_effect=lost_reply):
            with self.assertRaises(OSError):
                service.ensure()
        pending = load(service.path)["deployments"][self.intent["intentDigest"]]
        self.assertEqual(pending["status"], "preparing")
        self.assertIn("launchRequestedAt", pending)
        recovered = self.service()
        observed = recovered.ensure()
        self.assertTrue(observed["verified"])
        self.assertEqual(observed["incarnation"], self.intent["incarnation"])
        self.assertEqual(self.ready(recovered)["incarnation"], self.intent["incarnation"])
        self.assertEqual(len(self.child_file.read_text().splitlines()), 1)

    def test_new_incarnation_reuses_port_but_rejects_old_auth_and_wire_model(self):
        service = self.service()
        self.ready(service)
        self.assertEqual(service.retire(), {"status": "released"})
        next_intent = {**self.intent, "incarnation": uuid.uuid4().hex, "attempt": 2}
        next_intent["wireModel"] = "gear-" + next_intent["incarnation"]
        next_intent["authKey"] = uuid.uuid4().hex + uuid.uuid4().hex
        self.ready(self.service(intent=next_intent))
        with self.assertRaises(urllib.error.HTTPError) as stale:
            self.request(self.intent["authKey"], self.intent["wireModel"])
        self.assertEqual(stale.exception.code, 401)
        with self.assertRaises(urllib.error.HTTPError) as wrong_wire:
            self.request(next_intent["authKey"], self.intent["wireModel"])
        self.assertEqual(wrong_wire.exception.code, 404)
        self.assertEqual(self.service().retire(), {"status": "released"})
        self.assertEqual(self.service(intent=next_intent).observe()["status"], "ready")

    def test_pause_fences_start_during_slow_snapshot_and_negative_retire_fences_late_ssh(self):
        service = self.service()
        prepare = service.prepare_snapshot

        def pause_during_verification(record):
            prepare(record)
            self.service(action="pause", sequence=2).fence()

        with patch.object(service, "prepare_snapshot", side_effect=pause_during_verification):
            with self.assertRaises(ContractError) as stopped:
                service.ensure()
        self.assertEqual(stopped.exception.code, "deployment-fenced")
        self.assertEqual(self.service(action="pause", sequence=2).retire(), {"status": "released"})
        fresh = self.new_intent()
        fresh["runId"] = "other-run"
        fresh["intentDigest"] = digest_json(
            {
                "owner": self.owner,
                "modelRef": self.model_ref,
                "snapshotRef": self.snapshot,
                "profileDigest": digest_json(self.profile),
                "runId": "other-run",
            }
        )
        self.assertEqual(
            self.service(action="pause", sequence=2, intent=fresh).retire(), {"status": "released"}
        )
        with self.assertRaises(ContractError) as late:
            self.service(sequence=3, intent=fresh).ensure()
        self.assertEqual(late.exception.code, "deployment-fenced")

    def test_changed_actual_process_or_snapshot_blocks_cleanup_without_killing_foreign_process(
        self,
    ):
        service = self.service()
        self.ready(service)
        state = load(service.path)
        record = state["deployments"][self.intent["intentDigest"]]
        record["argv"][-1] = "changed-command"
        atomic_json(service.path, state)
        with self.assertRaises(ContractError) as mismatch:
            service.retire()
        self.assertEqual(mismatch.exception.code, "deployment-process-ownership")
        self.assertEqual(
            self.request(self.intent["authKey"], self.intent["wireModel"])["model"],
            self.intent["wireModel"],
        )
        record["argv"][-1] = self.intent["authKey"]
        atomic_json(service.path, state)
        target = Path(record["snapshotPath"]) / "tokenizer.json"
        target.chmod(0o644)
        target.write_text('{"mutated":true}')
        with self.assertRaises(ContractError) as snapshot:
            service.observe()
        self.assertEqual(snapshot.exception.code, "deployment-snapshot-drift")

    def test_group_handoff_requires_explicit_terminal_release_and_rejects_old_owner(self):
        service = self.service()
        self.ready(service)
        service.retire()
        with self.assertRaises(ContractError) as occupied:
            self.service(owner="next-experiment").fence()
        self.assertEqual(occupied.exception.code, "deployment-owner-conflict")
        self.assertEqual(service.releaseOwnership(), {"released": True})
        self.assertEqual(self.service(owner="next-experiment").fence()["control"]["sequence"], 1)
        final = self.service(action="pause", sequence=9).fence()
        self.assertTrue(final["ownerRetired"])
        self.assertEqual(load(service.path)["owner"], "next-experiment")
        self.assertEqual(load(service.path)["control"], {"sequence": 1, "action": "start"})
        self.assertEqual(service.retire(), {"status": "released"})
        self.assertEqual(service.releaseOwnership(), {"released": True})
        with self.assertRaises(ContractError) as retired:
            service.ensure()
        self.assertEqual(retired.exception.code, "deployment-owner-retired")

    def test_trusted_profiles_reject_overlapping_distinct_resource_groups(self):
        conflicting = copy.deepcopy(self.profile)
        conflicting["name"] = "other"
        conflicting["resourceGroup"] = "other-group"
        self.config["nativeDeploymentProfiles"]["other"] = conflicting
        with self.assertRaises(ContractError) as overlap:
            self.service()
        self.assertEqual(overlap.exception.code, "native-static-group-overlap")

    def test_actual_evaluation_interpreter_lock_and_deadline_binary_digest_are_checked(self):
        from gear.training.runtime.node_runtime import observe_runtime

        observed = observe_runtime()
        self.profile["runtimeLock"].update(
            environmentDigest=digest_json(observed), pythonVersion=observed["pythonVersion"]
        )
        service = self.service()
        with patch(
            "gear.training.runtime.node_runtime.package_version",
            return_value="controlled-cpu-fixture",
        ):
            self.real_runtime(service)
            self.profile["runtimeLock"]["timeoutDigest"] = digest_json("modified deadline utility")
            with self.assertRaises(ContractError) as binary:
                self.real_runtime(service)
            self.assertEqual(binary.exception.code, "native-deadline-tool-drift")
            self.profile["runtimeLock"]["environmentDigest"] = digest_json(
                "another Python environment"
            )
            with self.assertRaises(ContractError) as environment:
                self.real_runtime(service)
            self.assertEqual(environment.exception.code, "native-runtime-lock-drift")

    def test_foreign_gpu_owner_and_listening_port_are_never_stopped(self):
        foreign = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        self.addCleanup(foreign.wait)
        self.addCleanup(foreign.terminate)
        service = self.service()
        with patch(
            "gear.training.runtime.native_deployment.gpu_processes",
            return_value=[{"gpuUuid": "GPU-eval", "pid": foreign.pid}],
        ):
            with self.assertRaises(ContractError) as occupied:
                service.ensure()
            self.assertEqual(occupied.exception.code, "native-resource-conflict")
            self.assertIsNone(foreign.poll())
            self.assertEqual(
                service.retire(), {"status": "released", "reason": "foreign-resource-conflict"}
            )
            self.assertIsNone(foreign.poll())
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", self.port))
            listener.listen()
            with self.assertRaises(ContractError) as port:
                service.preflight()
            self.assertEqual(port.exception.code, "native-port-conflict")

    def test_insufficient_disk_and_corrupt_snapshot_fail_before_supervisor_start(self):
        service = self.service()
        record = service.request_record()
        with patch(
            "gear.training.runtime.native_deployment.shutil.disk_usage",
            return_value=shutil._ntuple_diskusage(1, 1, 0),
        ):
            with self.assertRaises(ContractError) as disk:
                service.prepare_snapshot(record)
            self.assertEqual(disk.exception.code, "native-insufficient-disk")
        weight = next(
            item
            for item in self.store.read_json(self.snapshot)["files"]
            if item["path"].endswith(".safetensors")
        )
        self.store.path(weight["sha256"]).write_bytes(b"corrupt")
        with self.assertRaises(ContractError) as snapshot:
            service.prepare_snapshot(record)
        self.assertEqual(snapshot.exception.code, "corrupt-content")
        self.assertFalse(service.manager.socket.exists())

    def test_owned_dead_manager_stale_socket_recovers_and_live_unverified_pid_blocks(self):
        service = self.service()
        service.manager.ensure_manager()
        manager_pid = service.manager.rpc.getPID()
        psutil.Process(manager_pid).kill()
        deadline = time.time() + 3
        while psutil.pid_exists(manager_pid) and time.time() < deadline:
            time.sleep(0.025)
        self.assertFalse(psutil.pid_exists(manager_pid))
        self.assertTrue(service.manager.socket.exists())
        service.manager.ensure_manager()
        self.assertNotEqual(service.manager.rpc.getPID(), manager_pid)
        self.assertTrue(service.manager.observe_manager())

    def test_process_history_retains_detached_child_and_blocks_unproven_release(self):
        service = self.service()
        self.ready(service)
        orphan = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            start_new_session=True,
            env={**os.environ, "GEAR_NATIVE_INCARNATION": self.intent["incarnation"]},
        )
        self.addCleanup(orphan.wait)
        self.addCleanup(orphan.terminate)
        identity = process_identity(psutil.Process(orphan.pid))
        state = load(service.path)
        record = state["deployments"][self.intent["intentDigest"]]
        record["processes"].append(identity)
        original_count = len(record["processes"])
        atomic_json(service.path, state)
        # The current model's child tree no longer contains the detached child.
        service.observe()
        service.observe()
        remembered = load(service.path)["deployments"][self.intent["intentDigest"]]
        self.assertIn(identity, remembered["processes"])
        self.assertEqual(len(remembered["processes"]), original_count)
        self.assertEqual(
            service.retire(), {"status": "blocked", "reason": "deployment-stop-unproven"}
        )
        remembered = load(service.path)["deployments"][self.intent["intentDigest"]]
        self.assertIn(identity, remembered["processes"])
        self.assertIsNone(orphan.poll())
        orphan.terminate()
        orphan.wait(timeout=3)
        self.assertEqual(service.retire(), {"status": "released"})

    def test_process_group_lookup_exit_race_is_a_typed_unverified_observation(self):
        service = self.service()
        self.ready(service)
        record = load(service.path)["deployments"][self.intent["intentDigest"]]
        info = service.manager.inspect(record["program"])
        with patch(
            "gear.training.runtime.native_deployment.os.getpgid", side_effect=ProcessLookupError
        ):
            with self.assertRaises(ContractError) as raced:
                service.running_identity(record, info)
        self.assertEqual(raced.exception.code, "deployment-process-unverified")


if __name__ == "__main__":
    unittest.main()
