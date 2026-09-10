import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gear_training.content import ContractError, atomic_json, digest_json
from gear_training.device_lease import NodeDeviceLedger
from gear_training.job import JobService, device_owner, driver, worker, worker_alive
from gear_training.recovery import process_identity
from gear_training.state import load


class JobOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name); self.node = {"nodeId": "node", "generation": "boot-1"}
        atomic_json(self.root / "node" / "identity.json", self.node)
        self.config = {"schemaVersion": 1, "node": self.node, "nodeRoot": str(self.root / "node"), "storeRoot": str(self.root / "cas"), "jobsRoot": str(self.root / "jobs"),
            "hitchRoot": "/unused", "hitchPath": "/unused", "slimePath": "/unused", "megatronPath": "/unused", "gatewayBindHost": "127.0.0.1", "gatewayAdvertisedHost": "127.0.0.1", "episodeTimeoutSeconds": 30}
        self.service = JobService(self.config); self.devices = NodeDeviceLedger(self.config["nodeRoot"], self.node)
        self.request = {"schemaVersion": 1, "trainingDevices": ["GPU-1"], "budgets": {"totalGpuSeconds": 100, "maxRolloutTokens": 100}}
        self.handle = {"schemaVersion": 1, "provider": "slime", "jobId": "job_" + digest_json("fixture")[7:39], "requestDigest": digest_json(self.request)}
        self.directory = self.service.root / self.handle["jobId"]; self.directory.mkdir()
        for name, value in {"request": self.request, "config": self.config, "identity": {"handle": self.handle, "keyDigest": digest_json("fixture")},
            "status": {"schemaVersion": 1, "handle": self.handle, "phase": "admitted", "execution": "running", "committedUpdate": 0,
            "resourcesReleased": False, "usage": {"gpuSeconds": 0, "rolloutTokens": 0, "groupResamples": 0}}}.items(): atomic_json(self.directory / (name + ".json"), value)
        self.incarnation = "a" * 32; self.owner = device_owner(self.directory, self.incarnation)
        atomic_json(self.directory / "worker.json", {"incarnation": self.incarnation, "pending": True})
        patch("gear_training.job.gpu_processes", return_value=[]).start()
        patch("gear_training.device_lease.gpu_processes", return_value=[]).start(); self.addCleanup(patch.stopall)

    def test_lost_spawn_does_not_release_and_cancel_fences_delayed_launch(self):
        with patch("gear_training.job.subprocess.Popen", side_effect=OSError("lost node request")):
            with self.assertRaises(OSError): self.service.ensure_worker(self.directory)
        self.assertFalse(self.service.inspect(self.handle)["resourcesReleased"])
        with self.assertRaisesRegex(ContractError, "still reserves"): self.devices.acquire("inference/eval", ["GPU-1"])
        self.assertTrue(self.service.cancel(self.handle)["resourcesReleased"])
        with patch("gear_training.job.subprocess.Popen", side_effect=AssertionError("late worker must not spawn")):
            worker(self.directory, self.incarnation)
        with self.assertRaisesRegex(ContractError, "no longer authorizes"): driver(self.directory, self.incarnation)
        self.devices.acquire("inference/eval", ["GPU-1"])

    def test_dead_supervisor_keeps_child_and_cost_until_confirmed_release(self):
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        self.addCleanup(lambda: child.poll() is None and child.kill())
        identity = process_identity(child.pid)
        self.devices.acquire(self.owner, ["GPU-1"]); self.devices.track(self.owner, [identity], launching=True)
        atomic_json(self.directory / "worker.json", {"incarnation": self.incarnation, "pending": False, "process": {**identity, "createdAt": identity["createdAt"] - 1}, "pid": child.pid})
        self.assertFalse(worker_alive(load(self.directory / "worker.json")))
        status = self.service.inspect(self.handle)
        self.assertEqual(status["execution"], "interrupted"); self.assertFalse(status["resourcesReleased"])
        self.assertGreater(status["usage"]["gpuSeconds"], 0)
        child.terminate(); child.wait(timeout=5)
        self.assertTrue(self.service.inspect(self.handle)["resourcesReleased"])
        self.devices.acquire("inference/eval", ["GPU-1"])

    def test_same_path_does_not_authorize_another_node_generation(self):
        other = JobService({**self.config, "node": {**self.node, "generation": "boot-2"}})
        with self.assertRaisesRegex(ContractError, "another model node/generation"): other.inspect(self.handle)

    def test_terminal_status_clears_only_stale_release_message_after_confirmation(self):
        pending_message = "training GPU processes remain; resources are not released"
        status = load(self.directory / "status.json")
        status.update(execution="completed", phase="checkpointed", committedUpdate=1, message=pending_message)
        atomic_json(self.directory / "status.json", status)
        self.devices.acquire(self.owner, ["GPU-1"])
        with patch("gear_training.device_lease.gpu_processes", side_effect=OSError("node observation unavailable")):
            pending = self.service.inspect(self.handle)
        self.assertFalse(pending["resourcesReleased"])
        self.assertEqual(pending["message"], pending_message)
        released = self.service.inspect(self.handle)
        self.assertTrue(released["resourcesReleased"])
        self.assertNotIn("message", released)
        self.assertNotIn("message", load(self.directory / "status.json"))
        released["message"] = "diagnostic detail must remain"
        atomic_json(self.directory / "status.json", released)
        self.assertEqual(self.service.inspect(self.handle)["message"], "diagnostic detail must remain")


if __name__ == "__main__": unittest.main()
