import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gear import Project, ProjectError

WARNING = (
    b"(node:123) TimeoutNegativeWarning: -9 is a negative number.\n"
    b"Timeout duration was set to 1.\n"
    b"(Use `node --trace-warnings ...` to show where the warning was created)\n"
)
TERMINAL = b'{"code":"provider-environment-unavailable","message":"Harbor unavailable"}\n'


class ProjectErrorTests(unittest.TestCase):
    def test_terminal_error_survives_warnings_and_retains_exact_private_bytes(self):
        for stderr in (TERMINAL, WARNING + TERMINAL + b"\n", b"\xffwarning\n" + TERMINAL):
            with self.subTest(stderr=stderr):
                error = ProjectError.from_stderr(stderr)
                self.assertEqual(error.code, "provider-environment-unavailable")
                self.assertEqual(str(error), "Harbor unavailable")
                self.assertEqual(error.stderr, stderr)
                self.assertNotIn("TimeoutNegativeWarning", str(error))
        self.assertIsNone(ProjectError("local-error", "local").stderr)

    def test_safe_probe_metadata_in_message_preserves_the_existing_error_contract(self):
        diagnostics = {
            "schema_version": "1",
            "probes": [{
                "probe": "docker_info", "attempt": 1, "stage": "command", "outcome": "timed_out",
                "elapsed_ms": 10000, "exit_code": None, "signal": "SIGTERM",
            }],
        }
        message = "Docker unavailable; diagnostics=" + json.dumps(diagnostics, separators=(",", ":"))
        raw = WARNING + json.dumps({
            "code": "provider-environment-unavailable", "message": message, "retryable": False,
        }).encode() + b"\n"
        error = ProjectError.from_stderr(raw)
        self.assertEqual(error.code, "provider-environment-unavailable")
        self.assertEqual(str(error), message)
        self.assertEqual(json.loads(str(error).split("; diagnostics=", 1)[1]), diagnostics)
        self.assertEqual(error.stderr, raw)

    def test_known_optional_gear_fields_are_accepted(self):
        detail = {
            "code": "operation-needs-recovery",
            "message": "inspect first",
            "retryable": True,
            "location": "run",
            "next_action": "inspect",
            "run_id": "run_original",
            "operation_id": "operation_original",
        }
        self.assertEqual(ProjectError.from_stderr(json.dumps(detail).encode()).code, detail["code"])

    def test_external_worker_error_codes_keep_their_original_spelling(self):
        for code in ("environment_start_timeout", "External.ProviderError"):
            with self.subTest(code=code):
                raw = json.dumps({"code": code, "message": "failed"}).encode()
                self.assertEqual(ProjectError.from_stderr(raw).code, code)

    def test_log_json_nested_errors_trailing_logs_and_invalid_shapes_cannot_grant_recovery(self):
        for stderr in (
            b"",
            b"warning only",
            TERMINAL + b"trailing log\n",
            b"log: " + TERMINAL,
            b'{"error":' + TERMINAL.strip() + b"}",
            b"[" + TERMINAL.strip() + b"]",
            b'{"code":"hitch-call-failed"}',
            b'{"code":1,"message":"failed"}',
            b'{"code":"hitch-call-failed","message":null}',
            b'{"code":"hitch-call-failed","message":"failed","level":"info"}',
            b'{"code":"hitch-call-failed","message":"failed","retryable":"true"}',
            b'{"code":"hitch-call-failed","message":"failed","next_action":{}}',
            b'{"code":"runtime-failed","code":"hitch-call-failed","message":"failed"}',
            b'{"code":"hitch-call-failed","message":"first","message":"second"}',
            b'{"code":"hitch-call-failed","message":"private-\xff"}',
            b"[" * 2000 + b"]" * 2000,
        ):
            with self.subTest(stderr=stderr):
                error = ProjectError.from_stderr(stderr)
                self.assertEqual(error.code, "runtime-failed")
                self.assertEqual(error.stderr, stderr)
                if stderr:
                    self.assertNotIn(stderr.decode(errors="replace"), str(error))

    def test_python_project_uses_the_terminal_error_from_a_real_cli_process(self):
        stderr = WARNING + TERMINAL
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "gear.yaml").write_text("version: 1\n")
            command = [
                sys.executable,
                "-c",
                f"import sys;sys.stderr.buffer.write({stderr!r});sys.exit(1)",
            ]
            with patch.dict("os.environ", {"GEAR_COMMAND": json.dumps(command)}):
                with self.assertRaises(ProjectError) as raised:
                    asyncio.run(Project.open(root).aresume("run_original"))
            self.assertEqual(raised.exception.code, "provider-environment-unavailable")
            self.assertEqual(raised.exception.stderr, stderr)


if __name__ == "__main__":
    unittest.main()
