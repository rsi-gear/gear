import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

PROBES = Path(__file__).resolve().parents[1] / "probes"


def module(name):
    spec = importlib.util.spec_from_file_location(name, PROBES / f"{name}.py")
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


guard = module("vast_instance_guard")
vm = module("vast_harbor_worker")


class ContainerStopped(BaseException):
    pass


class GuardTest(unittest.TestCase):
    def test_created_instance_credential_is_exact_and_not_account_key(self):
        response = {"success": True, "new_contract": 42, "instance_api_key": "instance-only-test-key"}
        environ = {}
        guard.install_created_credential(42, response, environ)
        self.assertEqual(guard.credentials(42, environ), "instance-only-test-key")
        self.assertEqual(environ["GEAR_VAST_GUARD_CREDENTIAL_SOURCE"], "creation-response")
        for changed in [{**response, "new_contract": 43}, {**response, "success": False},
                        {"success": True, "new_contract": 42, "api_key": "account-key"}]:
            with self.assertRaises(AssertionError):
                guard.install_created_credential(42, changed, {})
        with self.assertRaises(AssertionError):
            guard.install_created_credential(42, response, {"CONTAINER_ID": "43"})

    def test_reads_only_vast_fields_from_container_init(self):
        env, source = guard.container_environment({}, b"UNRELATED_SECRET=never-copy\0CONTAINER_ID=42\0VAST_CONTAINERLABEL=C.42\0CONTAINER_API_KEY=instance-only-test-key\0")
        self.assertEqual(source, "container-init-environment")
        self.assertEqual(set(env), {"CONTAINER_ID", "VAST_CONTAINERLABEL", "CONTAINER_API_KEY"})
        self.assertEqual(guard.credentials(42, env), "instance-only-test-key")
        self.assertEqual(guard.container_environment(env, b"UNRELATED=not-read"), (env, "ssh-environment"))

    def test_rejects_conflicting_or_oversized_init_environment(self):
        with self.assertRaises(AssertionError):
            guard.container_environment({"CONTAINER_ID": "43"}, b"CONTAINER_ID=42\0CONTAINER_API_KEY=instance-only-test-key\0")
        with self.assertRaises(AssertionError):
            guard.container_environment({}, b"a" * (1024 ** 2 + 1))

    def test_only_own_injected_credential(self):
        env = {"CONTAINER_ID": "42", "VAST_CONTAINERLABEL": "C.42", "CONTAINER_API_KEY": "instance-only-test-key"}
        self.assertEqual(guard.credentials(42, env), "instance-only-test-key")
        for changed in [{**env, "CONTAINER_ID": "43"}, {**env, "VAST_CONTAINERLABEL": "C.43"},
                        {"CONTAINER_ID": "42", "VAST_API_KEY": "account-key-not-accepted"}]:
            with self.assertRaises(AssertionError):
                guard.credentials(42, changed)

    def test_exact_stop_endpoint_and_body(self):
        class Response:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, size): return b'{"success":true}'
        with patch.object(guard.urllib.request, "urlopen", return_value=Response()) as call:
            guard.request_state(42, "instance-only-test-key", "stopped")
        request = call.call_args.args[0]
        self.assertEqual(request.full_url, "https://console.vast.ai/api/v0/instances/42/")
        self.assertEqual(request.method, "PUT")
        self.assertEqual(json.loads(request.data), {"state": "stopped"})
        self.assertEqual(call.call_args.kwargs["timeout"], 12)
        with self.assertRaises(AssertionError):
            guard.request_state(42, "instance-only-test-key", "destroyed")

    def test_retries_after_three_failures_and_after_ack(self):
        now = [100.0]
        calls = []
        def request():
            calls.append(now[0])
            if len(calls) <= 3:
                raise TimeoutError("must-not-persist-secret-test-value")
            if len(calls) == 5:
                raise ContainerStopped()
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            with self.assertRaises(ContainerStopped):
                guard.guard_loop({"deadline": 110, "instanceId": 42, "nonce": "test"}, directory, request,
                                 clock=lambda: now[0], monotonic=lambda: now[0],
                                 sleep=lambda seconds: now.__setitem__(0, now[0] + seconds))
            data = json.loads((directory / "stop-attempt.json").read_text())
            self.assertEqual(calls, [110, 125, 140, 155, 170])
            self.assertTrue(data["requestAccepted"])
            self.assertFalse(data["stopConfirmed"])
            self.assertNotIn("must-not-persist-secret", (directory / "stop-attempt.json").read_text())

    def test_clock_rollback_does_not_extend_budget(self):
        wall, elapsed = [100.0], [0.0]
        def sleep(seconds):
            elapsed[0] += seconds
            wall[0] -= 50
        def request():
            self.assertEqual(elapsed[0], 10)
            raise ContainerStopped()
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(ContainerStopped):
                guard.guard_loop({"deadline": 110, "instanceId": 42, "nonce": "test"}, Path(root), request,
                                 clock=lambda: wall[0], monotonic=lambda: elapsed[0], sleep=sleep)

    def test_vm_watchdog_does_not_abandon_unknown_state(self):
        with tempfile.TemporaryDirectory() as root:
            private = Path(root) / "private"
            private.mkdir()
            file = private / "watchdog.json"
            file.write_text(json.dumps({"stopAt": 0, "vast": "/fixture/vastai", "label": "owned", "modelInstance": 99}))
            stopped = {"id": 42, "actual_status": "exited", "cur_state": "stopped", "intended_status": "stopped"}
            outcomes = [TimeoutError(), None, TimeoutError(), TimeoutError(), stopped]
            with patch.object(vm, "stop_owned", side_effect=outcomes) as call, patch.object(vm.time, "sleep"):
                self.assertEqual(vm.watchdog(file), 0)
            self.assertEqual(call.call_count, 5)
            result = json.loads((Path(root) / "watchdog-result.json").read_text())
            self.assertTrue(result["stopped"])
            self.assertEqual(result["attempts"], 5)


if __name__ == "__main__":
    unittest.main()
