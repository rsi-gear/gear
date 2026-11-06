"""Installed-style module entrypoints keep CLI parsing out of training services."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class TrainingEntrypoints(unittest.TestCase):
    def command(self, name, *args):
        return subprocess.run(
            [sys.executable, "-m", "gear.training.cli." + name, *args],
            env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1])},
            capture_output=True,
            text=True,
            timeout=15,
        )

    def test_module_help_parses_without_starting_services(self):
        for module in ("job", "node", "script_job", "certify"):
            with self.subTest(module=module):
                result = self.command(module, "--help")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("usage:", result.stdout)
                self.assertEqual(result.stderr, "")

    def test_job_and_node_errors_remain_json_rpc_envelopes(self):
        with tempfile.TemporaryDirectory() as root:
            missing = str(Path(root) / "missing-config.json")
            for module, action, code in [
                ("job", "inspect", "training-job-error"),
                ("node", "rpc", "node-operation-failed"),
            ]:
                with self.subTest(module=module):
                    result = self.command(module, action, "--config", missing)
                    self.assertEqual(result.returncode, 1)
                    response = json.loads(result.stdout)
                    self.assertEqual(response["error"]["code"], code)
                    self.assertEqual(result.stderr, "")
