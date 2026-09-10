"""Simulated OS-boot transitions; no CUDA, model, or container execution."""
import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gear_training.content import ContractError, atomic_json, digest_json
from gear_training.device_lease import NodeDeviceLedger
from gear_training.inference_process import ProcessService
from gear_training.node import NodeService
from gear_training.state import load


class InferenceGenerationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.config = {"schemaVersion": 2, "nodeId": "model-node", "nodeRoot": str(self.root / "node"),
                       "storeRoot": str(self.root / "content"), "jobConfigPath": str(self.root / "absent.json"), "inferencePort": 30123}
        with patch("gear_training.node.boot_identity", return_value="os-boot-1"): self.old = NodeService(self.config)
        self.service_id = "inference_" + "a" * 32
        self.inference_id = digest_json("original-lock")
        self.identity = {"node": self.old.identity, "ownerId": "controller-owner", "inferenceId": self.inference_id, "inputDigest": digest_json("original-start")}
        self.directory = self.root / "node/inference" / self.service_id
        self.handle = {"schema_version": "2", "kind": "process", "node_id": self.old.identity["nodeId"], "generation": self.old.identity["generation"],
                       "service_id": self.service_id, "process": {"pid": 42, "created_at": 1.5}}
        atomic_json(self.directory / "identity.json", self.identity)
        atomic_json(self.directory / "status.json", {"schemaVersion": 2, "state": "ready", "resourcesReleased": False, "handle": self.handle})
        atomic_json(self.directory / "access.json", {"engineToken": "private-old-engine-token"})
        self.gpu = patch("gear_training.device_lease.gpu_processes", return_value=[]).start(); self.addCleanup(patch.stopall)
        self.owner = "inference/" + self.service_id
        ledger = NodeDeviceLedger(self.config["nodeRoot"], self.old.identity)
        ledger.acquire(self.owner, ["GPU-1"]); ledger.track(self.owner, [{"pid": 42, "createdAt": 1.5}], launching=True)
        with patch("gear_training.node.boot_identity", return_value="os-boot-2"): self.node = NodeService(self.config)
        self.payload = {"serviceId": self.service_id, "ownerId": "controller-owner", "inferenceId": self.inference_id,
                        "previousNode": self.old.identity, "expectedHandle": self.handle}

    def recover(self, payload=None):
        payload = self.payload if payload is None else payload
        return self.node.rpc({"schemaVersion": 2, "requestId": "recover-service", "node": self.node.identity,
                              "operation": "inference.recover", "inputDigest": digest_json(payload), "payload": payload})["result"]

    def test_release_is_replayable_preserves_source_and_does_not_interpret_old_pids(self):
        with patch("gear_training.device_lease.owned_alive", side_effect=AssertionError("old PID inspected")), \
             patch("gear_training.inference_process.stop_owned", side_effect=AssertionError("old PID signalled")):
            receipt = self.recover(); self.assertEqual(self.recover(), receipt)
        self.assertTrue(receipt["resourcesReleased"]); self.assertEqual(receipt["state"], "stopped")
        self.assertEqual(receipt["previousNode"], self.old.identity); self.assertEqual(receipt["node"], self.node.identity)
        self.assertNotEqual(receipt["previousBootDigest"], receipt["currentBootDigest"])
        self.assertNotIn("private-old-engine-token", str(receipt)); self.assertEqual(receipt["handle"], self.handle)
        self.assertEqual(load(self.directory / "identity.json"), self.identity)
        service = ProcessService(self.config, self.node.identity)
        new_payload = {"serviceId": "inference_" + "b" * 32, "ownerId": "controller-owner", "model": {"model_id": digest_json("new-model")},
                       "lock": {"inference_id": digest_json("new-lock"), "execution": {"platform": {"backend": "cuda", "device_constraint": "GPU-1"}}}}
        with patch.object(service, "prepare"), patch("gear_training.inference_process.subprocess.Popen") as launch:
            service.start(new_payload); self.assertEqual(launch.call_count, 1)
            with self.assertRaisesRegex(ContractError, "another owner or node generation"):
                service.start({**new_payload, "serviceId": self.service_id})

    def test_gpu_occupants_and_missing_ownership_keep_recovery_unconfirmed(self):
        self.gpu.return_value = [{"device": "GPU-1", "pid": 999}]
        with self.assertRaisesRegex(ContractError, "GPU occupants"): self.recover()
        self.assertIsNone(load(self.directory / "generation-release.json"))
        self.gpu.side_effect = OSError("driver unavailable")
        with self.assertRaises(OSError): self.recover()
        data = load(self.root / "node/device-leases.json")
        self.assertNotIn("releasedAt", data["owners"][digest_json(self.owner)])
        self.gpu.side_effect = None; self.gpu.return_value = []
        atomic_json(self.root / "node/device-leases.json", {"schemaVersion": 2, "owners": {}})
        with self.assertRaisesRegex(ContractError, "lost its device ownership"): self.recover()

    def test_source_handle_owner_and_lock_cannot_be_changed(self):
        service = ProcessService(self.config, self.node.identity)
        for changes in ({"ownerId": "foreign"}, {"inferenceId": digest_json("foreign")}, {"previousNode": self.node.identity},
                        {"expectedHandle": {**self.handle, "process": {"pid": 999, "created_at": 1.5}}}, {"extra": True}):
            with self.subTest(changes=changes), self.assertRaises(ContractError): service.recover({**copy.deepcopy(self.payload), **changes})
        self.assertIsNone(load(self.directory / "generation-release.json"))

    def test_unlaunched_admission_can_be_closed_without_inventing_a_process(self):
        atomic_json(self.directory / "status.json", {"schemaVersion": 2, "state": "admitting", "resourcesReleased": False})
        atomic_json(self.root / "node/device-leases.json", {"schemaVersion": 2, "owners": {}})
        payload = {**self.payload, "expectedHandle": None}
        result = self.recover(payload); self.assertTrue(result["admissionOnly"])
        self.assertIsNone(result["handle"]); self.assertEqual(result["gpuSeconds"], 0)
        self.assertEqual(self.recover(payload), result)

    def test_corrupt_release_receipt_cannot_authorize_new_admission(self):
        receipt = self.recover()
        atomic_json(self.directory / "generation-release.json", {**receipt, "admissionOnly": True})
        service = ProcessService(self.config, self.node.identity)
        with patch.object(service, "prepare"), self.assertRaisesRegex(ContractError, "immutable source"):
            service.start({"serviceId": "inference_" + "c" * 32, "ownerId": "controller-owner"})
        atomic_json(self.directory / "generation-release.json", {**receipt, "currentBootDigest": receipt["previousBootDigest"]})
        with self.assertRaisesRegex(ContractError, "OS boot transition"): self.recover()


if __name__ == "__main__": unittest.main()
