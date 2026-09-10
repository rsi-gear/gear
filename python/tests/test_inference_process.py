"""Real process/RPC tests with a CPU HTTP fixture, not SGLang/GPU validation."""
import concurrent.futures
import copy
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from pathlib import Path

from gear_training.content import ContentStore, atomic_json, digest_bytes, digest_json
from gear_training.node import NodeService
from gear_training.node_runtime import observe_runtime
from gear_training.recovery import owned_alive
from gear_training.inference_process import ProcessService, run_engine


SERVER = '''
import argparse, json, os
from http.server import BaseHTTPRequestHandler, HTTPServer
p = argparse.ArgumentParser()
for field in ("port", "api-key", "admin-api-key", "served-model-name"): p.add_argument("--" + field)
# Reject the real SGLang ambiguity and unsupported switches instead of hiding
# launcher errors behind parse_known_args. No model execution occurs here.
for field in ("model-path", "host", "random-seed", "tp-size", "dp-size", "pp-size",
              "pp-max-micro-batch-size", "pp-async-batch-depth", "load-format", "dtype",
              "context-length", "max-running-requests", "max-total-tokens",
              "chunked-prefill-size", "max-prefill-tokens", "kv-cache-dtype",
              "attention-backend", "sampling-backend", "mem-fraction-static", "device",
              "tool-call-parser", "reasoning-parser"): p.add_argument("--" + field)
for field in ("disable-radix-cache", "disable-overlap-schedule", "disable-cuda-graph",
              "enable-deterministic-inference", "log-requests"):
    p.add_argument("--" + field, action="store_true")
args = p.parse_args()
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path == "/server_info" and os.environ.get("GEAR_TEST_INFO_STATUS"):
            self.send_response(int(os.environ["GEAR_TEST_INFO_STATUS"])); self.end_headers(); return
        if self.path != "/health" and self.headers.get("Authorization") != "Bearer " + args.api_key:
            self.send_response(401); self.end_headers(); return
        result = {"version": "0.0.0", "device": "cpu", "fixturePid": os.getpid()} if self.path == "/server_info" else {"data": [{"id": args.served_model_name}]}
        self.send_response(200); self.end_headers(); self.wfile.write(json.dumps(result).encode())
HTTPServer(("127.0.0.1", int(args.port)), Handler).serve_forever()
'''


class InferenceProcessTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name); fixture = root / "fixture"; fixture.mkdir()
        (fixture / "sglang").mkdir(); (fixture / "sglang" / "__init__.py").write_text("")
        (fixture / "sglang" / "launch_server.py").write_text(SERVER)
        (fixture / "sglang-0.0.0.dist-info").mkdir()
        (fixture / "sglang-0.0.0.dist-info" / "METADATA").write_text("Name: sglang\nVersion: 0.0.0\n")
        (fixture / "sglang-0.0.0.dist-info" / "RECORD").write_text("sglang/launch_server.py,fixture,0\n")
        sys.path.insert(0, str(fixture)); self.addCleanup(lambda: sys.path.remove(str(fixture)))
        self.env = {**os.environ, "PYTHONPATH": os.pathsep.join([str(fixture), str(Path(__file__).resolve().parents[1]), os.environ.get("PYTHONPATH", "")])}
        startup_environment = patch.dict(os.environ, {"PYTHONPATH": self.env["PYTHONPATH"]})
        startup_environment.start(); self.addCleanup(startup_environment.stop)
        with socket.socket() as sock: sock.bind(("127.0.0.1", 0)); port = sock.getsockname()[1]
        self.config = {"schemaVersion": 2, "nodeId": "cpu-fixture-node", "nodeRoot": str(root / "node"), "storeRoot": str(root / "content"), "jobConfigPath": str(root / "absent.json"), "inferencePort": port}
        self.config_path = root / "node.json"; atomic_json(self.config_path, self.config)
        self.node = NodeService(self.config); self.sequence = 0
        store = ContentStore(self.config["storeRoot"])
        header = json.dumps({"weight": {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]}}).encode()
        bodies = {"config.json": json.dumps({"architectures": ["Fixture"], "torch_dtype": "float32", "model_type": "fixture"}).encode(),
                  "tokenizer_config.json": b'{"chat_template":"fixture template"}', "tokenizer.json": b'{}',
                  "model.safetensors": struct.pack("<Q", len(header)) + header + struct.pack("<f", 1)}
        files = [{"path": name, "size": len(data), "sha256": store.put_bytes(data, "application/octet-stream")["digest"]} for name, data in sorted(bodies.items())]
        model = {"format": "hf-safetensors", "files": files, "architecture": "Fixture", "model_type": "fixture", "dtype": "float32", "quantization": None,
                 "context_tokens": 128, "tokenizer_digest": digest_bytes(b"fixture"), "template_digest": digest_bytes(b"fixture template")}
        model = {**model, "model_id": digest_json(model), "schema_version": "1", "source": {"kind": "local-directory", "label": "fixture", "license": None}, "created_at": "2026-09-08T00:00:00Z"}
        actual = observe_runtime()
        self.actual = actual
        runtime = {"schema_version": "2", "engine": "sglang", "sglang_version": "0.0.0", "sglang_commit": None, "backend": "cpu", "compatibility_profile": "cpu-fixture-only",
                   "package": {"kind": "python-env", "environment_digest": digest_json(actual), "python_version": actual["pythonVersion"], "packages_digest": actual["packagesDigest"]}}
        runtime["runtime_id"] = digest_json(runtime)
        frozen = {"schema_version": "1", "engine": "sglang", "model_id": model["model_id"], "runtime_id": runtime["runtime_id"],
            "execution": {"platform": {"backend": "cpu", "cpu_threads": 1, "overlap_schedule": False},
                "tensor_parallel_size": 1, "data_parallel_size": 1, "pipeline_parallel_size": 1, "load_format": "safetensors", "quantization": None, "hicache": False, "speculative_decoding": False, "cpu_offload_gb": 0,
                "dtype": "float32", "context_tokens_per_request": 128, "max_running_requests": 1, "max_total_tokens": 128,
                "chunked_prefill_size": 64, "max_prefill_tokens": 64, "kv_cache_dtype": "auto", "attention_backend": "torch_native", "sampling_backend": "pytorch",
                "prefix_cache": {"mode": "disabled"}, "deterministic_inference": False, "startup_timeout_ms": 10000},
            "generation": {"seed": 0}, "protocol": {"tool_call_parser": None, "reasoning_parser": None}}
        frozen["inference_id"] = digest_json(frozen)
        self.payload = {"serviceId": "inference_" + "a" * 32, "ownerId": "controller-1", "model": model, "runtime": runtime, "lock": frozen}
        self.owner = {k: self.payload[k] for k in ("serviceId", "ownerId")}
        self.addCleanup(self.cleanup_service)

    def cleanup_service(self):
        if (Path(self.config["nodeRoot"]) / "inference" / self.payload["serviceId"] / "identity.json").exists(): self.call("stop", self.owner)

    def call(self, action, payload, *, discard=False):
        self.sequence += 1
        envelope = {"schemaVersion": 2, "requestId": "request-" + str(self.sequence), "node": self.node.identity,
                    "operation": "inference." + action, "inputDigest": digest_json(payload), "payload": payload}
        completed = subprocess.run([sys.executable, "-m", "gear_training.node", "rpc", "--config", str(self.config_path)],
            input=json.dumps(envelope), text=True, capture_output=True, timeout=20, env=self.env)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        return None if discard else json.loads(completed.stdout)["result"]

    def ready(self):
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            status = self.call("inspect", self.owner)
            if status["state"] == "ready": return status
            self.assertNotEqual(status["state"], "failed", status)
            time.sleep(0.1)
        self.fail("fixture service did not become ready")

    def test_lost_start_reply_reconnect_and_idempotent_stop(self):
        self.call("start", self.payload, discard=True)
        ready = self.ready(); self.assertFalse(ready["resourcesReleased"])
        duplicate = self.call("start", self.payload)
        self.assertEqual(duplicate["handle"], ready["handle"])
        self.assertEqual(duplicate["access"], ready["access"])
        process = ready["handle"]["process"]
        self.assertTrue(owned_alive({"pid": process["pid"], "createdAt": process["created_at"]}))
        stopped = self.call("stop", self.owner)
        self.assertTrue(stopped["resourcesReleased"])
        self.assertEqual(self.call("stop", self.owner)["state"], "stopped")
        self.assertEqual(self.call("start", self.payload)["state"], "stopped")
        self.assertFalse(owned_alive({"pid": process["pid"], "createdAt": process["created_at"]}))

    def test_authentication_rejection_fails_before_startup_deadline_and_releases(self):
        self.payload["lock"]["execution"]["startup_timeout_ms"] = 60000
        self.payload["lock"]["inference_id"] = digest_json({k: v for k, v in self.payload["lock"].items() if k != "inference_id"})
        for code in (401, 403):
            with self.subTest(code=code):
                self.env["GEAR_TEST_INFO_STATUS"] = str(code)
                self.payload["serviceId"] = "inference_" + format(code, "032x")
                self.owner["serviceId"] = self.payload["serviceId"]
                self.call("start", self.payload)
                deadline = time.monotonic() + 6
                while time.monotonic() < deadline:
                    status = self.call("inspect", self.owner)
                    if status["state"] == "failed" and status["resourcesReleased"]: break
                    time.sleep(0.1)
                self.assertEqual(status["state"], "failed", status)
                self.assertEqual(status["error"], "inference-authentication-failed")
                self.assertTrue(status["resourcesReleased"])

    def test_v2_node_binding_is_checked_against_actual_generation_and_runtime(self):
        # Exercise the node protocol on CPU; public Hitch v2 plans require CUDA.
        payload = copy.deepcopy(self.payload)
        frozen = payload["lock"]
        frozen.update(schema_version="2", model_node={"schema_version": "2", "node_id": self.node.identity["nodeId"],
                      "generation": self.node.identity["generation"], "runtime_digest": digest_json(observe_runtime()), "launcher": "process"})
        def seal(): frozen["inference_id"] = digest_json({key: value for key, value in frozen.items() if key != "inference_id"})
        service = ProcessService(self.config, self.node.identity)
        seal(); self.assertEqual(service.prepare(payload)["inferenceId"], frozen["inference_id"])
        for field, changed in (("node_id", "other-node"), ("generation", "other-boot"), ("runtime_digest", digest_json("other-runtime")), ("launcher", "docker")):
            previous = frozen["model_node"][field]; frozen["model_node"][field] = changed; seal()
            with self.assertRaisesRegex(Exception, "another model node or runtime"): service.prepare(payload)
            frozen["model_node"][field] = previous
        frozen["schema_version"] = "1"; seal()
        with self.assertRaisesRegex(Exception, "legacy lock cannot"): service.prepare(payload)

    def test_stop_fences_delayed_supervisor_and_engine_registration(self):
        self.call("start", self.payload)
        stopped = self.call("stop", self.owner)
        self.assertTrue(stopped["resourcesReleased"])
        directory = Path(self.config["nodeRoot"]) / "inference" / self.payload["serviceId"]
        late = subprocess.run([sys.executable, "-m", "gear_training.inference_process", "_supervisor", "--directory", str(directory)], env=self.env, capture_output=True, timeout=10)
        self.assertEqual(late.returncode, 0, late.stderr)
        self.assertEqual(self.call("inspect", self.owner)["state"], "stopped")

    def test_supervisor_loss_retains_engine_ownership_until_recovery(self):
        self.call("start", self.payload); ready = self.ready()
        os.kill(ready["handle"]["process"]["pid"], 9)
        time.sleep(0.15)
        status = self.call("inspect", self.owner)
        self.assertEqual(status["state"], "failed"); self.assertFalse(status["resourcesReleased"])
        self.assertEqual(self.call("start", self.payload)["state"], "failed")
        recovered = self.call("recover", self.owner)
        self.assertTrue(recovered["resourcesReleased"])

    def test_stop_before_start_leaves_a_durable_tombstone(self):
        stopped = self.call("stop", self.owner)
        self.assertTrue(stopped["resourcesReleased"])
        late = self.call("start", self.payload)
        self.assertEqual(late["state"], "stopped"); self.assertNotIn("handle", late)

    def test_inspection_before_model_upload_is_pending_and_stop_still_fences_start(self):
        owner = {**self.owner, "inferenceId": self.payload["lock"]["inference_id"]}
        pending = self.call("inspect", owner)
        self.assertEqual(pending, {"schemaVersion": 2, "state": "admitting", "inferenceId": owner["inferenceId"],
                                  "resourcesReleased": False, "gpuSeconds": 0})
        directory = Path(self.config["nodeRoot"]) / "inference" / owner["serviceId"]
        self.assertFalse(directory.exists())
        self.assertTrue(self.call("stop", owner)["resourcesReleased"])
        self.assertEqual(self.call("start", self.payload)["state"], "stopped")
        with self.assertRaisesRegex(Exception, "another owner or node generation"):
            ProcessService(self.config, self.node.identity).inspect({**owner, "ownerId": "another-owner"})

    def test_missing_service_identity_with_existing_state_or_device_lease_is_not_pending(self):
        service = ProcessService(self.config, self.node.identity)
        owner = {**self.owner, "inferenceId": self.payload["lock"]["inference_id"]}
        directory = service.directory(owner)
        service.devices.acquire(service.owner(directory.name), [])
        with self.assertRaisesRegex(Exception, "another owner or node generation"): service.inspect(owner)
        # Even a released lease is durable evidence of a previous admission.
        service.devices.fence(service.owner(directory.name)); self.assertTrue(service.devices.release(service.owner(directory.name)))
        with self.assertRaisesRegex(Exception, "another owner or node generation"): service.inspect(owner)
        other = {**owner, "serviceId": "inference_" + "f" * 32}
        atomic_json(service.directory(other) / "status.json", {"state": "starting"})
        with self.assertRaisesRegex(Exception, "another owner or node generation"): service.inspect(other)

    def test_stop_during_runtime_observation_prevents_late_engine_spawn(self):
        service = ProcessService(self.config, self.node.identity)
        with patch("gear_training.inference_process.observe_runtime", return_value=self.actual), \
                patch("gear_training.inference_process.subprocess.Popen"): service.start(self.payload)
        directory = service.directory(self.owner)
        actual = observe_runtime()
        def observed():
            self.assertTrue(service.stop(self.owner)["resourcesReleased"])
            return actual
        with patch("gear_training.inference_process.observe_runtime", side_effect=observed), \
                patch("gear_training.inference_process.subprocess.Popen") as launch:
            run_engine(service, directory, self.payload)
        launch.assert_not_called()

    def test_stop_during_spawn_includes_child_in_owned_process_snapshot(self):
        service = ProcessService(self.config, self.node.identity)
        with patch("gear_training.inference_process.observe_runtime", return_value=self.actual), \
                patch("gear_training.inference_process.subprocess.Popen"): service.start(self.payload)
        directory = service.directory(self.owner)
        fence_entered = threading.Event(); stopped = []; threads = []; children = []
        original_fence, original_popen = service._fence, subprocess.Popen
        def fence(path):
            fence_entered.set(); return original_fence(path)
        def spawn(*args, **kwargs):
            child = original_popen([sys.executable, "-c", "import time; time.sleep(30)"], start_new_session=True)
            children.append(child)
            thread = threading.Thread(target=lambda: stopped.append(service.stop(self.owner)))
            threads.append(thread); thread.start()
            self.assertTrue(fence_entered.wait(5))
            return child
        try:
            with patch.object(service, "_fence", side_effect=fence), \
                    patch("gear_training.inference_process.observe_runtime", return_value=self.actual), \
                    patch("gear_training.inference_process.subprocess.Popen", side_effect=spawn):
                run_engine(service, directory, self.payload)
            for thread in threads: thread.join(12); self.assertFalse(thread.is_alive())
            self.assertEqual(len(stopped), 1); self.assertTrue(stopped[0]["resourcesReleased"])
            self.assertEqual(len(children), 1); self.assertIsNotNone(children[0].poll())
            entry = service.devices.inspect(service.owner(directory.name))
            self.assertIn(children[0].pid, [identity["pid"] for identity in entry["processes"]])
        finally:
            for child in children:
                if child.poll() is None: child.kill()
                child.wait(timeout=5)
            for thread in threads: thread.join(12)


if __name__ == "__main__": unittest.main()
