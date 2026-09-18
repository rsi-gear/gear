"""Attachment contracts with simulated process/GPU observations, no model execution."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gear_training.content import ContractError, atomic_json, digest_json
from gear_training.inference_process import ProcessService
from gear_training.node import NodeService
from gear_training.state import load


class InferenceAttachTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.config = {"schemaVersion": 2, "nodeId": "attachment-node", "nodeRoot": str(self.root / "node"),
                       "storeRoot": str(self.root / "cas"), "jobConfigPath": str(self.root / "absent.json"), "inferencePort": 30123}
        self.node = NodeService(self.config); self.service = ProcessService(self.config, self.node.identity)
        self.service_id = "inference_" + "a" * 32
        self.actual = {"pythonVersion": "3.12.1", "packagesDigest": digest_json("packages"),
                       "packages": [{"name": "sglang", "version": "0.0.0", "commit": None}], "outerImageDigest": None}
        runtime = {"schema_version": "2", "engine": "sglang", "backend": "cpu", "sglang_version": "0.0.0", "sglang_commit": None,
                   "package": {"kind": "python-env", "environment_digest": digest_json(self.actual),
                               "python_version": self.actual["pythonVersion"], "packages_digest": self.actual["packagesDigest"]}}
        runtime["runtime_id"] = digest_json(runtime)
        self.request = {"serviceId": self.service_id, "ownerId": "controller", "model": {"model_id": digest_json("model")},
                        "runtime": runtime, "lock": {"inference_id": digest_json("lock"), "execution": {"platform": {"backend": "cpu"}}}}
        self.handle = {"schema_version": "2", "kind": "process", "node_id": self.node.identity["nodeId"], "generation": self.node.identity["generation"],
                       "service_id": self.service_id, "process": {"pid": 42, "created_at": 1.5}}
        self.supervisor = {"pid": 42, "createdAt": 1.5}; self.engine = {"pid": 43, "createdAt": 1.6}
        self.payload = {"serviceId": self.service_id, "ownerId": "controller", "inferenceId": self.request["lock"]["inference_id"],
                        "inputDigest": digest_json(self.request), "expectedHandle": self.handle}
        self.directory = self.root / "node/inference" / self.service_id
        self.identity = {"node": self.node.identity, "ownerId": "controller", "inputDigest": digest_json(self.request),
                         "inferenceId": self.payload["inferenceId"]}
        atomic_json(self.directory / "identity.json", self.identity); atomic_json(self.directory / "request.json", self.request)
        self.status = {"schemaVersion": 2, "state": "ready", "resourcesReleased": False, "handle": self.handle,
                       "runtime": self.actual, "serverInfo": {"snapshot": "old"}}
        atomic_json(self.directory / "status.json", self.status); atomic_json(self.directory / "engine.json", self.engine)
        self.access = {"port": 30123, "wireModel": "hitch-" + self.request["model"]["model_id"][7:23],
                       "engineToken": "b" * 64, "adminToken": "c" * 64}
        atomic_json(self.directory / "access.json", self.access)
        self.owner = self.service.owner(self.service_id)
        self.service.devices.acquire(self.owner, []); self.service.devices.track(self.owner, [self.supervisor, self.engine])
        self.alive = patch("gear_training.device_lease.owned_alive", return_value=True).start()
        self.runtime = patch("gear_training.inference_attach.observe_runtime", return_value=self.actual).start()
        self.query = patch("gear_training.inference_attach.urllib.request.urlopen").start()
        self.query.return_value.__enter__.return_value.status = 200
        self.query.return_value.__enter__.return_value.read.return_value = json.dumps({"snapshot": "live"}).encode()
        self.gpu = patch("gear_training.device_lease.gpu_processes", return_value=[]).start()
        self.addCleanup(patch.stopall)

    def rpc(self, payload=None):
        data = payload if payload is not None else self.payload
        return self.node.rpc({"schemaVersion": 2, "requestId": "attach-request", "node": self.node.identity,
                              "operation": "inference.attach", "inputDigest": digest_json(data), "payload": data})["result"]

    def snapshot(self):
        return {str(p): p.read_bytes() for p in [*self.directory.glob("*.json"), self.root / "node/device-leases.json"]}

    def test_rpc_replay_uses_live_observation_without_mutating_ownership(self):
        before = self.snapshot()
        with patch("gear_training.inference_process.stop_owned", side_effect=AssertionError("attachment signalled a process")), \
                patch.object(self.service, "start", side_effect=AssertionError("attachment restarted")):
            result = self.rpc(); self.assertEqual(result["serverInfo"], {"snapshot": "live"})
            self.assertEqual(result["handle"], self.handle); self.assertEqual(result["access"], self.access)
            self.assertEqual(result["inputDigest"], self.payload["inputDigest"])
            self.query.return_value.__enter__.return_value.read.return_value = b'{"snapshot":"newer"}'
            self.assertEqual(self.rpc()["serverInfo"], {"snapshot": "newer"})
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.query.call_args.args[0].get_method(), "GET")
        self.assertTrue(self.query.call_args.args[0].full_url.endswith("/server_info"))

    def test_payload_and_start_request_cannot_change(self):
        before = self.snapshot()
        for changes in ({"extra": True}, {"ownerId": "another"}, {"inferenceId": digest_json("other")},
                        {"inputDigest": digest_json("other")}, {"expectedHandle": None},
                        {"expectedHandle": {**self.handle, "generation": "other"}},
                        {"expectedHandle": {**self.handle, "process": {"pid": 42, "created_at": 9}}}):
            with self.subTest(changes=changes), self.assertRaises(ContractError):
                self.service.attach({**self.payload, **changes})
        self.assertEqual(self.snapshot(), before); self.query.assert_not_called()
        atomic_json(self.directory / "request.json", {**self.request, "ownerId": "another"})
        with self.assertRaises(ContractError): self.service.attach(self.payload)

    def test_missing_or_reused_process_identity_never_fences_or_releases(self):
        for pid in (42, 43):
            self.alive.side_effect = lambda p: p["pid"] != pid
            before = self.snapshot()
            with self.subTest(pid=pid), self.assertRaises(ContractError): self.service.attach(self.payload)
            self.assertEqual(self.snapshot(), before)
        self.alive.side_effect = None
        (self.directory / "engine.json").unlink()
        with self.assertRaises(ContractError): self.service.attach(self.payload)
        self.assertFalse((self.directory / "stop.json").exists())

    def test_fenced_service_or_device_ledger_is_never_revived(self):
        for state in ("starting", "stopping", "failed", "stopped"):
            atomic_json(self.directory / "status.json", {**self.status, "state": state})
            with self.subTest(state=state), self.assertRaises(ContractError): self.service.attach(self.payload)
        atomic_json(self.directory / "status.json", self.status)
        atomic_json(self.directory / "stop.json", {"reason": "owner-stop"})
        with self.assertRaises(ContractError): self.service.attach(self.payload)
        (self.directory / "stop.json").unlink()
        original = load(self.service.devices.path)
        for change in ({"closing": True}, {"releasedAt": 1}, {"devices": ["GPU-other"]}, {"processes": [self.supervisor]}):
            data = copy.deepcopy(original); data["owners"][digest_json(self.owner)].update(change)
            atomic_json(self.service.devices.path, data); before = self.snapshot()
            with self.subTest(change=change), self.assertRaises(ContractError): self.service.attach(self.payload)
            self.assertEqual(self.snapshot(), before)
        atomic_json(self.service.devices.path, {"schemaVersion": 2, "owners": {}})
        with self.assertRaises(ContractError): self.service.attach(self.payload)

    def test_changed_runtime_or_lost_engine_during_observation_is_rejected(self):
        self.runtime.return_value = {**self.actual, "pythonVersion": "3.13.1"}
        with self.assertRaises(ContractError): self.service.attach(self.payload)
        self.query.assert_not_called(); self.runtime.return_value = self.actual
        self.query.return_value.__enter__.return_value.read.side_effect = lambda size: self.alive.__setattr__("return_value", False) or b'{}'
        before = self.snapshot()
        with self.assertRaises(ContractError): self.service.attach(self.payload)
        self.assertEqual(self.snapshot(), before)

    def test_device_checks_require_live_owned_pids_and_available_driver(self):
        data = load(self.service.devices.path); data["owners"][digest_json(self.owner)]["devices"] = ["GPU-a"]
        atomic_json(self.service.devices.path, data)
        for used in ([], [{"device": "GPU-a", "pid": 99}]):
            self.gpu.return_value = used
            with self.subTest(used=used), self.assertRaises(ContractError):
                self.service.devices.verify_active(self.owner, ["GPU-a"], [self.supervisor, self.engine])
        self.gpu.return_value = [{"device": "GPU-a", "pid": 43}]
        before = self.snapshot()
        self.service.devices.verify_active(self.owner, ["GPU-a"], [self.supervisor, self.engine])
        self.assertEqual(self.snapshot(), before)
        self.gpu.side_effect = OSError("driver unavailable")
        with self.assertRaises(OSError): self.service.devices.verify_active(self.owner, ["GPU-a"], [self.supervisor, self.engine])


if __name__ == "__main__": unittest.main()
