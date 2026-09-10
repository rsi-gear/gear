import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gear_training.content import ContractError, atomic_json
from gear_training.device_lease import NodeDeviceLedger
from gear_training.node_generation import record_generation
from gear_training.recovery import process_identity, stop_owned


class DeviceLeaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.node = {"nodeId": "model-node", "generation": "boot-1"}
        identity = {**self.node, "bootIdentity": "os-boot-1"}
        atomic_json(Path(self.tmp.name) / "identity.json", identity)
        record_generation(self.tmp.name, identity)
        self.ledger = NodeDeviceLedger(self.tmp.name, self.node)
        self.probe = patch("gear_training.device_lease.gpu_processes", return_value=[]).start()
        self.addCleanup(patch.stopall)

    def test_training_eval_mutual_exclusion_and_disconnect_usage(self):
        with patch("gear_training.device_lease.time.time", return_value=100): self.ledger.acquire("training/job-1", ["GPU-1"])
        with self.assertRaisesRegex(ContractError, "another training/evaluation"): self.ledger.acquire("inference/service-1", ["GPU-1"])
        with patch("gear_training.device_lease.time.time", return_value=160):
            self.assertEqual(self.ledger.inspect("training/job-1")["gpuSeconds"], 60)
            self.ledger.fence("training/job-1"); self.assertTrue(self.ledger.release("training/job-1"))
        with patch("gear_training.device_lease.time.time", return_value=180):
            self.assertEqual(self.ledger.inspect("training/job-1")["gpuSeconds"], 60)
            self.ledger.acquire("inference/service-1", ["GPU-1"])
        with self.assertRaisesRegex(ContractError, "cannot revive"): self.ledger.acquire("training/job-1", ["GPU-1"])

    def test_live_process_and_unknown_gpu_use_prevent_release(self):
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        self.addCleanup(lambda: child.poll() is None and child.kill()); self.addCleanup(lambda: child.poll())
        identity = process_identity(child.pid)
        self.ledger.acquire("training/job-1", ["GPU-1"])
        self.ledger.track("training/job-1", [identity], launching=True)
        with self.assertRaisesRegex(ContractError, "fence process launches"): self.ledger.release("training/job-1")
        self.ledger.fence("training/job-1"); self.assertFalse(self.ledger.release("training/job-1"))
        with self.assertRaisesRegex(ContractError, "fenced"): self.ledger.track("training/job-1", [identity], launching=True)
        # A reused numeric PID does not authorize a signal to a different process.
        stop_owned([{**identity, "createdAt": identity["createdAt"] - 1}]); self.assertIsNone(child.poll())
        child.terminate(); child.wait(timeout=5)
        self.probe.return_value = [{"device": "GPU-1", "pid": 999}]
        self.assertFalse(self.ledger.release("training/job-1"))
        self.probe.side_effect = OSError("node driver disconnected")
        with self.assertRaises(OSError): self.ledger.release("training/job-1")
        self.assertNotIn("releasedAt", self.ledger.inspect("training/job-1"))
        self.probe.side_effect = None; self.probe.return_value = []
        self.assertTrue(self.ledger.release("training/job-1"))

    def test_old_generation_cannot_touch_new_processes(self):
        self.ledger.acquire("training/old-boot", ["GPU-1"])
        next_node = {**self.node, "generation": "boot-2"}
        identity = {**next_node, "bootIdentity": "os-boot-2"}
        atomic_json(Path(self.tmp.name) / "identity.json", identity)
        record_generation(self.tmp.name, identity)
        with self.assertRaisesRegex(ContractError, "generation"): self.ledger.fence("training/old-boot")
        newer = NodeDeviceLedger(self.tmp.name, next_node)
        with self.assertRaisesRegex(ContractError, "still reserves"): newer.acquire("training/new-boot", ["GPU-1"])
        newer.reconcile_previous_generation(); newer.acquire("training/new-boot", ["GPU-1"])

    def test_generation_change_without_distinct_archived_boot_cannot_release(self):
        self.ledger.acquire("training/old-boot", ["GPU-1"])
        next_node = {**self.node, "generation": "boot-2"}
        atomic_json(Path(self.tmp.name) / "identity.json", {**next_node, "bootIdentity": "os-boot-1"})
        newer = NodeDeviceLedger(self.tmp.name, next_node)
        with self.assertRaisesRegex(ContractError, "distinct archived OS boot"): newer.reconcile_previous_generation()
        with self.assertRaisesRegex(ContractError, "distinct archived OS boot"): newer.release_previous_owner("training/old-boot", self.node)


if __name__ == "__main__": unittest.main()
