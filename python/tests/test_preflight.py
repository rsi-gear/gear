"""CPU diagnostics and contract checks, never real GPU validation evidence."""
import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from gear_training import SLIME_COMMIT
from gear_training.content import ContentStore, ContractError, digest_json
from gear_training.node import NodeService
from gear_training.preflight import bridge_digest, generation_protocol_digest, preflight, missing_probe_checks
from gear_training.runtime_checks import inspect_model_runtime, model_node_preflight, source_observation, validate_process_lock, gpu_inventory, gpu_process_inventory
from test_placement import request_fixture, HYPERPARAMETERS


class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store = ContentStore(str(self.root / "cas"))
        self.config = {"schemaVersion": 2, "storeRoot": str(self.store.root), "jobsRoot": str(self.root / "jobs"), "slimePath": "/model/slime", "megatronPath": "/model/megatron",
                       "node": {"nodeId": "gpu", "generation": "boot-1"}, "gatewayBindHost": "127.0.0.1", "gatewayPort": 30001,
                       "controllerTimeoutSeconds": 30, "episodeTimeoutSeconds": 30}
        self.runtime = {"schemaVersion": 2, "kind": "python-env", "pythonVersion": "3.12.1", "outerImageDigest": None,
                        "packages": [{"name": name, "version": version} for name, version in (("torch", "2.7.0"), ("sglang", "0.4.0"))]}
        self.request = request_fixture()
        self.request.update(schemaVersion=2, deployment={"schemaVersion": 2,
            "modelRuntime": {**self.config["node"], "nodeRef": "gpu", "launcher": "process", "runtimeDigest": digest_json(self.runtime)},
            "gpuScheduling": {"actorRollout": "colocated", "trainEvaluation": "sequential"}}, trainingDevices=[{"nodeId": "gpu", "gpuUuid": "GPU-0"}])
        self.request["trainer"].pop("placement")
        self.request["trainer"]["hyperparametersRef"] = self.store.put_json(HYPERPARAMETERS)
        self.request["trainer"]["runtimeLock"] = {"schemaVersion": 2, "slimeCommit": SLIME_COMMIT, "hitchCommit": "a" * 40,
            "megatronCommit": "b" * 40, "runtime": {"kind": "python-env", "nodeRuntimeDigest": digest_json(self.runtime), "outerImageDigest": None},
            "bridgeDigest": bridge_digest(), "protocolDigest": generation_protocol_digest(self.config), "patchDigests": [], "probeEvidenceRefs": [],
            "validation": "pending-gpu", "pythonVersion": "3.12.1", "cudaVersion": "12.8", "pytorchVersion": "2.7.0", "sglangVersion": "0.4.0"}
        self.calls = []
        def command(args, **_kwargs):
            self.calls.append(args)
            self.assertEqual(args[0], "nvidia-smi", "model diagnostics must not invoke a controller or Docker")
            if "--query-gpu=uuid,name,memory.total,driver_version" in args: return b"GPU-0, Fixture GPU, 81920, 570.1\n"
            if "--query-compute-apps=gpu_uuid,pid" in args: return b""
            raise AssertionError("unexpected model diagnostic command")
        self.addCleanup(patch.stopall)
        patch("gear_training.node_runtime.observe_runtime", side_effect=lambda: copy.deepcopy(self.runtime)).start()
        patch("gear_training.runtime_checks.command", side_effect=command).start()
        patch("gear_training.runtime_checks.source_observation", side_effect=lambda _directory, kind: {
            "commit": SLIME_COMMIT if kind == "slime" else "b" * 40, "patchDigest": None, "untrackedRuntimeCode": False,
            **({"exportExtension": True} if kind == "slime" else {})}).start()
        patch("gear_training.runtime_checks.importlib.metadata.version", return_value="fixture-installed").start()
        patch.dict(sys.modules, {"torch": SimpleNamespace(version=SimpleNamespace(cuda="12.8"), cuda=SimpleNamespace(is_available=lambda: True))}).start()

    def test_process_lock_needs_no_image_or_gpu_side_hitch(self):
        with patch.dict(os.environ, {}, clear=True), patch("gear_training.preflight.HitchClient", side_effect=AssertionError("GPU called Hitch")):
            result = preflight(self.request, self.config)
        self.assertTrue(result["trainingExternalBinding"])
        self.assertIn("gpu-probes-pending", result["blockers"])
        self.assertTrue(any(code.startswith("missing-runtime-probe-evidence:") for code in result["blockers"]))
        self.assertEqual(len(result["blockers"]), 2, result)
        self.assertNotIn("imageDigest", self.request["trainer"]["runtimeLock"])

    def test_optional_outer_image_and_frozen_runtime_are_not_silently_ignored(self):
        self.assertEqual(validate_process_lock(self.request, self.runtime), [])
        altered = {**self.runtime, "outerImageDigest": digest_json("another image")}
        self.assertEqual(set(validate_process_lock(self.request, altered)), {"model-node-runtime-drift", "outer-image-drift"})
        self.request["trainer"]["runtimeLock"]["runtime"]["nodeRuntimeDigest"] = digest_json("another node")
        with self.assertRaisesRegex(ContractError, "frozen process model node"): validate_process_lock(self.request, self.runtime)

    def test_old_image_lock_keeps_its_original_attestation(self):
        self.request["trainer"]["runtimeLock"] = {"schemaVersion": 1, "imageDigest": digest_json("old image")}
        with patch.dict(os.environ, {}, clear=True): self.assertEqual(validate_process_lock(self.request, self.runtime), ["container-image-not-attested"])
        with patch.dict(os.environ, {"GEAR_TRAINING_IMAGE_DIGEST": digest_json("old image")}): self.assertEqual(validate_process_lock(self.request, self.runtime), [])
        self.request["trainer"]["runtimeLock"]["schemaVersion"] = 2
        self.request["schemaVersion"] = 1
        with self.assertRaisesRegex(ContractError, "v1 training"): preflight(self.request, {"schemaVersion": 1})

    def test_independent_failures_are_all_reported_without_private_diagnostics(self):
        secret = "private-root-and-credential-must-not-leak"
        with patch("gear_training.runtime_checks.source_observation", side_effect=OSError(secret)), \
             patch("gear_training.runtime_checks.importlib.metadata.version", side_effect=OSError(secret)), \
             patch("gear_training.runtime_checks.command", side_effect=OSError(secret)), \
             patch.dict(sys.modules, {"torch": None}):
            report = inspect_model_runtime(self.config)
        blocked = {item["code"] for item in report["checks"] if item["status"] == "blocked"}
        self.assertTrue({"package-torch", "package-sglang", "slime-checkout", "megatron-checkout", "gpu-inventory", "gpu-process-observation", "cuda-runtime"}.issubset(blocked))
        self.assertNotIn(secret, json.dumps(report))
        self.assertNotIn("validation", report)

    def test_busy_and_unobservable_gpus_remain_blockers(self):
        with patch("gear_training.runtime_checks.gpu_process_inventory", return_value={"GPU-0": 1}):
            self.assertIn("training-gpu-pool-occupied", preflight(self.request, self.config)["blockers"])
        with patch("gear_training.runtime_checks.gpu_process_inventory", side_effect=OSError("not observable")):
            self.assertIn("model-node:gpu-process-observation", preflight(self.request, self.config)["blockers"])

    def test_malformed_gpu_output_is_not_a_free_device(self):
        for output in (b"Insufficient permission\n", b"GPU-0, not-a-pid\n", b"GPU-0, 0\n"):
            with self.subTest(output=output), patch("gear_training.runtime_checks.command", return_value=output), self.assertRaises(ContractError):
                gpu_process_inventory()
        with patch("gear_training.runtime_checks.command", return_value=b"GPU-0, GPU, 81920, 570.1\nGPU-0, GPU, 81920, 570.1\n"), self.assertRaises(ContractError):
            gpu_inventory()

    def test_preflight_rpc_is_pinned_empty_and_does_not_create_a_training_job(self):
        node_config = {"schemaVersion": 2, "nodeId": "gpu", "nodeRoot": str(self.root / "node"), "storeRoot": str(self.store.root),
                       "jobConfigPath": str(self.root / "job.json"), "inferencePort": 30002}
        Path(node_config["jobConfigPath"]).write_text(json.dumps(self.config))
        node = NodeService(node_config)
        envelope = {"schemaVersion": 2, "requestId": "preflight-1", "node": node.identity, "operation": "preflight", "payload": {}, "inputDigest": digest_json({})}
        result = node.rpc(envelope)
        self.assertEqual(result["node"], node.identity)
        self.assertEqual(result["result"]["node"], node.identity)
        self.assertEqual(result["result"]["ports"], {"rollout": 30001, "inference": 30002})
        self.assertTrue(all(check["status"] == "passed" for check in result["result"]["checks"]))
        self.assertFalse(Path(self.config["jobsRoot"]).exists())
        self.assertFalse((self.root / "node" / "rpc").exists())
        for invalid in ({**envelope, "node": None}, {**envelope, "payload": {"heldOut": "forbidden"}, "inputDigest": digest_json({"heldOut": "forbidden"})}):
            with self.assertRaises(ContractError): node.rpc(invalid)

    def test_invalid_configuration_is_structured_and_cannot_smuggle_controller_dependency(self):
        node_config = {"jobConfigPath": str(self.root / "job.json"), "storeRoot": str(self.store.root), "inferencePort": 30002}
        Path(node_config["jobConfigPath"]).write_text(json.dumps({**self.config, "hitchCommand": ["secret-command"], "gatewayPort": "secret-port"}))
        report = model_node_preflight(node_config, self.config["node"])
        self.assertEqual(report["checks"][0], {"code": "training-node-configuration", "status": "blocked"})
        self.assertIsNone(report["ports"]["rollout"])
        self.assertNotIn("secret", json.dumps(report))

    def test_old_probe_identity_cannot_validate_the_process_lock(self):
        lock = self.request["trainer"]["runtimeLock"]
        old = {**lock, "schemaVersion": 1, "imageDigest": digest_json("old image")}; old.pop("runtime")
        core = {key: value for key, value in old.items() if key not in ("validation", "probeEvidenceRefs")}
        proof = self.store.put_json({"schemaVersion": 1, "kind": "gear-training-compatibility-probe", "runtimeLockIdentityDigest": digest_json(core),
            "checks": {"exactTokenIds": True, "behaviorLogProbs": True, "hitchHarbor": True}})
        lock["probeEvidenceRefs"] = [proof]
        self.assertIn("exactTokenIds", missing_probe_checks(self.request, self.store))

    def test_missing_jobs_directory_configuration_blocks_before_submission(self):
        config = dict(self.config); config.pop("jobsRoot")
        node_config = {"jobConfigPath": str(self.root / "job.json"), "storeRoot": str(self.store.root), "inferencePort": 30002}
        Path(node_config["jobConfigPath"]).write_text(json.dumps(config))
        report = model_node_preflight(node_config, self.config["node"])
        self.assertEqual(report["checks"][0]["status"], "blocked")


class SourceObservationTests(unittest.TestCase):
    def test_checkout_identity_is_observed_and_cannot_come_from_a_parent_repo(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            subprocess.run(["git", "init", str(root)], check=True, capture_output=True)
            (root / "megatron").mkdir(); (root / "megatron" / "__init__.py").write_text("version = 1\n")
            subprocess.run(["git", "add", "."], cwd=root, check=True, capture_output=True)
            subprocess.run(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture"], cwd=root, check=True, capture_output=True)
            first = source_observation(str(root), "megatron")
            self.assertIsNone(first["patchDigest"]); self.assertFalse(first["untrackedRuntimeCode"])
            (root / "megatron" / "__init__.py").write_text("version = 2\n")
            (root / "megatron" / "untracked.py").write_text("extra = True\n")
            changed = source_observation(str(root), "megatron")
            self.assertEqual(changed["commit"], first["commit"]); self.assertIsNotNone(changed["patchDigest"]); self.assertTrue(changed["untrackedRuntimeCode"])
            with self.assertRaisesRegex(ContractError, "enclosing repository"): source_observation(str(root / "megatron"), "megatron")


if __name__ == "__main__": unittest.main()
