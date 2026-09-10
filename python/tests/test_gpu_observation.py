import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from gear_training.content import ContractError, atomic_json
from gear_training.device_lease import NodeDeviceLedger
from gear_training.preflight import gpu_processes


class GpuObservationTests(unittest.TestCase):
    def test_malformed_or_unobservable_process_rows_cannot_prove_free_devices(self):
        for output in ("Insufficient permission\n", "GPU-1, 0\n", "GPU-1, not-a-pid\n", "GPU-1, 12, extra\n", "GPU-2, 12\nunknown output\n"):
            with self.subTest(output=output), patch("gear_training.preflight.subprocess.run", return_value=SimpleNamespace(stdout=output)), self.assertRaises(ContractError):
                gpu_processes(["GPU-1"])

    def test_failed_release_keeps_billing_one_physical_gpu_until_verified_handoff(self):
        with tempfile.TemporaryDirectory() as directory, patch("gear_training.preflight.subprocess.run", return_value=SimpleNamespace(stdout="")) as query, \
             patch("gear_training.device_lease.time.time", return_value=100) as clock:
            node = {"nodeId": "model", "generation": "boot-1"}
            atomic_json(Path(directory) / "identity.json", node)
            ledger = NodeDeviceLedger(directory, node)
            ledger.acquire("training/job/first", ["GPU-1"])
            clock.return_value = 110; ledger.fence("training/job/first")
            query.return_value.stdout = "GPU observation unavailable\n"
            with self.assertRaises(ContractError): ledger.release("training/job/first")
            clock.return_value = 130
            with self.assertRaisesRegex(ContractError, "still reserves"): ledger.acquire("inference/eval", ["GPU-1"])
            self.assertEqual(ledger.gpu_seconds("training/job/"), 30)
            self.assertNotIn("releasedAt", ledger.inspect("training/job/first"))
            query.return_value.stdout = ""; clock.return_value = 140
            self.assertTrue(ledger.release("training/job/first"))
            clock.return_value = 150; ledger.acquire("inference/eval", ["GPU-1"])
            self.assertEqual(ledger.gpu_seconds("training/job/"), 40)
            clock.return_value = 160
            self.assertEqual(ledger.inspect("inference/eval")["gpuSeconds"], 10)
            self.assertEqual(ledger.gpu_seconds("training/job/"), 40)


if __name__ == "__main__": unittest.main()
