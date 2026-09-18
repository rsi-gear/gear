import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gear_training.content import ContractError, atomic_json, digest_json
from gear_training.job import JobService, device_owner
from gear_training.device_lease import NodeDeviceLedger
from gear_training.node_generation import generation_path
from gear_training.job_control import control_job
from gear_training.node import NodeService
from gear_training.state import load


class JobControlTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.node_config = {"schemaVersion": 2, "nodeId": "control-node", "nodeRoot": str(root / "node"),
                            "storeRoot": str(root / "cas"), "jobConfigPath": str(root / "job.json")}
        self.node = NodeService(self.node_config)
        self.config = {"schemaVersion": 2, "storeRoot": str(root / "cas"), "jobsRoot": str(root / "jobs"),
                       "slimePath": "/unused", "megatronPath": "/unused", "gatewayBindHost": "127.0.0.1", "gatewayPort": 31000,
                       "controllerTimeoutSeconds": 30, "episodeTimeoutSeconds": 60}
        atomic_json(root / "job.json", self.config)
        self.service = JobService({**self.config, "node": self.node.identity, "nodeRoot": self.node_config["nodeRoot"]})
        self.request = {"schemaVersion": 2, "deployment": {"modelRuntime": self.node.identity},
                        "trainingDevices": [{"nodeId": self.node.identity["nodeId"], "gpuUuid": "GPU-1"}]}
        self.key = "same-original-job"
        self.handle = {"schemaVersion": 1, "provider": "slime", "jobId": "job_" + digest_json(self.key)[7:39], "requestDigest": digest_json(self.request)}
        self.directory = self.service.root / self.handle["jobId"]
        self.preflight = patch("gear_training.job.preflight", return_value={"blockers": []}).start()
        self.launch = patch.object(JobService, "ensure_worker").start()
        patch("gear_training.job.gpu_processes", return_value=[]).start()
        self.addCleanup(patch.stopall)

    def control(self, sequence, action, request=None, service=None):
        return control_job(service or self.service, request or self.request, self.key,
                           {"schemaVersion": 2, "sequence": sequence, "action": action})

    def test_pause_before_submission_creates_no_worker_or_gpu_claim_and_survives_restart(self):
        with patch("gear_training.job.gpu_processes", side_effect=AssertionError("no device was admitted")):
            stopped = self.control(1, "pause")
            self.assertTrue(stopped["resourcesReleased"]); self.assertEqual(stopped["usage"]["gpuSeconds"], 0)
            restarted = JobService(self.service.config)
            self.assertEqual(self.control(1, "pause", service=restarted), stopped)
            with self.assertRaisesRegex(ContractError, "newer control intent"): self.control(0, "start", service=restarted)
        self.assertFalse((self.directory / "worker.json").exists())
        self.preflight.assert_not_called(); self.launch.assert_not_called()
        self.assertEqual(stopped["handle"], self.handle)

    def test_only_a_new_start_can_resume_and_late_cancellation_cannot_stop_it(self):
        self.control(1, "pause")
        original_identity = (self.directory / "identity.json").read_bytes()
        started = self.control(2, "start"); incarnation = load(self.directory / "worker.json")["incarnation"]
        self.assertEqual(started["execution"], "running"); self.assertFalse(started["resourcesReleased"])
        self.assertEqual(self.control(2, "start")["handle"], self.handle)
        self.assertEqual(load(self.directory / "worker.json")["incarnation"], incarnation)
        with self.assertRaisesRegex(ContractError, "newer control intent"): self.control(1, "pause")
        self.assertFalse((self.directory / "cancel.json").exists())
        self.assertEqual((self.directory / "identity.json").read_bytes(), original_identity)
        self.control(3, "pause")
        with self.assertRaisesRegex(ContractError, "newer control intent"): self.control(2, "start")
        self.assertEqual(load(self.directory / "worker.json")["incarnation"], incarnation)

    def test_duplicate_applied_start_does_not_restart_an_interrupted_incarnation(self):
        self.control(0, "start")
        worker = load(self.directory / "worker.json"); worker["pending"] = False
        atomic_json(self.directory / "worker.json", worker)
        self.assertEqual(self.control(0, "start")["execution"], "interrupted")
        self.assertEqual(load(self.directory / "worker.json"), worker)
        self.control(1, "start")
        self.assertNotEqual(load(self.directory / "worker.json")["incarnation"], worker["incarnation"])

    def test_new_start_cannot_replace_a_pause_while_physical_release_is_unconfirmed(self):
        self.control(0, "start")
        original = load(self.directory / "worker.json")
        with patch("gear_training.job.gpu_processes", return_value=[{"device": "GPU-1", "pid": 123}]):
            self.assertFalse(self.control(1, "pause")["resourcesReleased"])
            with self.assertRaisesRegex(ContractError, "release before a new start"): self.control(2, "start")
        self.assertEqual(load(self.directory / "control.json")["intent"]["sequence"], 1)
        self.assertEqual(load(self.directory / "worker.json"), original)
        self.assertTrue(self.control(1, "pause")["resourcesReleased"])
        self.control(2, "start")
        self.assertNotEqual(load(self.directory / "worker.json"), original)

    def test_rejects_conflicting_requests_sequences_generation_and_legacy_mutations(self):
        self.control(1, "pause")
        with self.assertRaisesRegex(ContractError, "cannot change its meaning"): self.control(1, "start")
        changed = copy.deepcopy(self.request); changed["trainingDevices"][0]["gpuUuid"] = "GPU-2"
        with self.assertRaisesRegex(ContractError, "another frozen request"): self.control(2, "start", request=changed)
        changed = copy.deepcopy(self.request); changed["deployment"]["modelRuntime"]["generation"] = "another-boot"
        with self.assertRaisesRegex(ContractError, "another model node generation"): self.control(2, "start", request=changed)
        with self.assertRaisesRegex(ContractError, "versioned control"): self.service.submit(self.request, self.key)
        with self.assertRaisesRegex(ContractError, "versioned pause"): self.service.cancel(self.handle)

    def test_start_reply_loss_after_launch_intent_does_not_create_another_incarnation(self):
        self.launch.side_effect = OSError("RPC reply lost")
        with self.assertRaises(OSError): self.control(0, "start")
        first = load(self.directory / "worker.json")
        self.assertEqual(load(self.directory / "control.json")["phase"], "applied")
        self.launch.side_effect = None
        self.control(0, "start", service=JobService(self.service.config))
        self.assertEqual(load(self.directory / "worker.json"), first)

    def test_actual_node_rpc_keeps_one_identity_and_rejects_a_replayed_old_envelope(self):
        def envelope(sequence, action):
            payload = {"request": self.request, "idempotencyKey": self.key, "intent": {"schemaVersion": 2, "sequence": sequence, "action": action}}
            return {"schemaVersion": 2, "requestId": "ordered-" + str(sequence), "node": self.node.identity,
                    "operation": "training.control", "inputDigest": digest_json(payload), "payload": payload}
        pause = envelope(1, "pause")
        self.assertEqual(self.node.rpc(pause)["result"]["handle"], self.handle)
        restarted = NodeService(self.node_config)
        self.assertTrue(restarted.rpc(pause)["result"]["resourcesReleased"])
        self.assertEqual(restarted.rpc(envelope(2, "start"))["result"]["handle"], self.handle)
        with self.assertRaisesRegex(ContractError, "newer control intent"): restarted.rpc(pause)

    def reboot(self):
        with patch("gear_training.node.boot_identity", return_value="next-os-boot"):
            node = NodeService(self.node_config)
        service = JobService({**self.service.config, "node": node.identity})
        request = copy.deepcopy(self.request)
        request["deployment"]["modelRuntime"] = node.identity
        return service, request

    def submit_new_experiment(self, service, request):
        return control_job(service, request, "new-experiment",
                           {"schemaVersion": 2, "sequence": 0, "action": "start"})

    def test_prior_boot_pause_tombstone_does_not_block_a_new_experiment(self):
        self.control(1, "pause")
        original = (self.directory / "identity.json").read_bytes()
        service, request = self.reboot()
        started = self.submit_new_experiment(service, request)
        self.assertEqual(started["execution"], "running")
        self.assertEqual((self.directory / "identity.json").read_bytes(), original)
        with self.assertRaisesRegex(ContractError, "another model node/generation"):
            service.inspect(self.handle)
        with self.assertRaisesRegex(ContractError, "another model node generation"):
            self.control(2, "start", service=service)

    def test_prior_boot_interruption_before_worker_registration_does_not_block_new_jobs(self):
        def interrupt_worker_write(path, value):
            if path.name == "worker.json": raise OSError("OS stopped before worker registration")
            return atomic_json(path, value)

        with patch("gear_training.job.atomic_json", side_effect=interrupt_worker_write):
            with self.assertRaisesRegex(OSError, "before worker registration"):
                self.control(0, "start")
        original = {name: (self.directory / name).read_bytes() for name in ("identity.json", "request.json", "config.json")}
        self.assertFalse((self.directory / "worker.json").exists())
        self.assertFalse((Path(self.node_config["nodeRoot"]) / "device-leases.json").exists())
        self.assertFalse(load(self.directory / "control.json")["admissionOnly"])
        self.assertFalse(load(self.directory / "status.json")["resourcesReleased"])
        self.launch.assert_not_called()
        service, request = self.reboot()
        with patch("gear_training.job.owned_alive", side_effect=AssertionError("old PID must not be inspected")):
            for occupants in ([{"device": "GPU-1", "pid": 123}], OSError("driver unavailable")):
                with self.subTest(occupants=occupants), patch("gear_training.job.gpu_processes",
                        **({"side_effect": occupants} if isinstance(occupants, Exception) else {"return_value": occupants})):
                    with self.assertRaises((ContractError, OSError)):
                        self.submit_new_experiment(service, request)
                    self.assertFalse(load(self.directory / "status.json")["resourcesReleased"])
                    self.launch.assert_not_called()
            self.assertEqual(self.submit_new_experiment(service, request)["execution"], "running")
        status = load(self.directory / "status.json")
        self.assertTrue(status["resourcesReleased"])
        self.assertEqual(status["execution"], "interrupted")
        self.assertEqual(status["usage"]["gpuSeconds"], 0)
        self.assertEqual({name: (self.directory / name).read_bytes() for name in original}, original)
        with self.assertRaisesRegex(ContractError, "another model node/generation"):
            service.inspect(self.handle)

    def test_prior_boot_worker_requires_physical_release_without_reading_old_pids(self):
        self.control(0, "start")
        worker = load(self.directory / "worker.json")
        owner = device_owner(self.directory, worker["incarnation"])
        devices = NodeDeviceLedger(self.node_config["nodeRoot"], self.node.identity)
        with patch("gear_training.device_lease.gpu_processes", return_value=[]):
            devices.acquire(owner, ["GPU-1"])
        worker.update(pending=False, process={"pid": 123, "createdAt": 1})
        atomic_json(self.directory / "worker.json", worker)
        original = (self.directory / "config.json").read_bytes()
        service, request = self.reboot()
        with patch("gear_training.job.owned_alive", side_effect=AssertionError("old PID must not be inspected")), \
             patch("gear_training.device_lease.owned_alive", side_effect=AssertionError("old PID must not be inspected")):
            for occupants in ([{"device": "GPU-1", "pid": 123}], OSError("driver unavailable")):
                with self.subTest(occupants=occupants), patch("gear_training.device_lease.gpu_processes",
                        **({"side_effect": occupants} if isinstance(occupants, Exception) else {"return_value": occupants})):
                    with self.assertRaises((ContractError, OSError)):
                        self.submit_new_experiment(service, request)
                    self.assertFalse(load(self.directory / "status.json")["resourcesReleased"])
            with patch("gear_training.device_lease.gpu_processes", return_value=[]):
                self.assertEqual(self.submit_new_experiment(service, request)["execution"], "running")
        status = load(self.directory / "status.json")
        self.assertTrue(status["resourcesReleased"])
        self.assertEqual(status["execution"], "interrupted")
        self.assertGreater(status["usage"]["gpuSeconds"], 0)
        self.assertEqual((self.directory / "config.json").read_bytes(), original)

    def test_missing_boot_or_launched_device_evidence_still_blocks_new_submission(self):
        self.control(0, "start")
        worker = load(self.directory / "worker.json")
        worker.update(pending=False, process={"pid": 123, "createdAt": 1})
        atomic_json(self.directory / "worker.json", worker)
        service, request = self.reboot()
        with self.assertRaisesRegex(ContractError, "no confirmed device release"):
            self.submit_new_experiment(service, request)
        (self.directory / "worker.json").unlink()
        with self.assertRaises(ContractError) as raised:
            self.submit_new_experiment(service, request)
        self.assertEqual(raised.exception.code, "previous-resources-not-released")
        generation_path(self.node_config["nodeRoot"], self.node.identity).unlink()
        with self.assertRaisesRegex(ContractError, "distinct archived OS boot identity"):
            self.submit_new_experiment(service, request)

    def test_missing_worker_with_device_history_is_not_an_unstarted_admission(self):
        self.control(0, "start")
        worker = load(self.directory / "worker.json")
        devices = NodeDeviceLedger(self.node_config["nodeRoot"], self.node.identity)
        owner = device_owner(self.directory, worker["incarnation"])
        with patch("gear_training.device_lease.gpu_processes", return_value=[]):
            devices.acquire(owner, ["GPU-1"])
        (self.directory / "worker.json").unlink()
        control = load(self.directory / "control.json")
        control["phase"] = "intent"
        atomic_json(self.directory / "control.json", control)
        original = devices.path.read_bytes()
        service, request = self.reboot()
        with self.assertRaisesRegex(ContractError, "no confirmed unstarted admission"):
            self.submit_new_experiment(service, request)
        self.assertFalse(load(self.directory / "status.json")["resourcesReleased"])
        self.assertEqual(devices.path.read_bytes(), original)


if __name__ == "__main__": unittest.main()
