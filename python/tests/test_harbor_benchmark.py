import csv
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from gear.benchmark import compile_benchmark
from gear.benchmark.harbor import compile_harbor


class HarborCompilerTests(unittest.TestCase):
    def test_native_verifiers_keep_expected_out_of_environment(self):
        for template, expected, outputs in [
            ("text", "PRIVATE_EXPECTED", {"answer.txt": "PRIVATE_EXPECTED"}),
            ("json", '{"/value":1}', {"answer.txt": '{"value":1.0}'}),
            ("files", '{"result.txt":"PRIVATE_EXPECTED"}', {"result.txt": "PRIVATE_EXPECTED"}),
        ]:
            with self.subTest(template=template), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                with (root / "tasks.csv").open("w") as stream:
                    writer = csv.writer(stream)
                    writer.writerow(["id", "instruction", "expected", "family", "split"])
                    writer.writerow(["one", "Complete the task", expected, "sample", "seed"])
                benchmark = compile_benchmark(root, {"version": 1, "source": "tasks.csv", "template": template})
                result = compile_harbor(benchmark, str(root / "harbor"), ["one"], "python@sha256:" + "1" * 64)
                task = Path(result["directory"]) / "one"
                self.assertTrue((task / "task.toml").is_file())
                self.assertIn('environment_mode = "separate"', (task / "task.toml").read_text())
                self.assertIn('network_mode = "no-network"', (task / "task.toml").read_text())
                self.assertIn('artifacts = ["/app"]', (task / "task.toml").read_text())
                self.assertIn('COPY . /tests', (task / "tests/Dockerfile").read_text())
                self.assertNotIn("PRIVATE_EXPECTED", (task / "instruction.md").read_text())
                self.assertFalse(any(b"PRIVATE_EXPECTED" in file.read_bytes() for file in (task / "environment").rglob("*") if file.is_file()))
                workspace, logs = root / "workspace", root / "logs"
                workspace.mkdir()
                for name, value in outputs.items():
                    (workspace / name).write_text(value)
                subprocess.run([sys.executable, str(task / "tests/verify.py"), str(workspace), str(logs)], check=True)
                self.assertEqual(float((logs / "reward.txt").read_text()), 1)
                for name in outputs:
                    (workspace / name).write_text("WRONG")
                subprocess.run([sys.executable, str(task / "tests/verify.py"), str(workspace), str(logs)], check=True)
                self.assertEqual(json.loads((logs / "gear-result.json").read_text())["status"], "valid")
                self.assertEqual(float((logs / "reward.txt").read_text()), 0)

    def test_json_numeric_equivalence_preserves_nested_boolean_distinction(self):
        from gear.benchmark.scorers import score_output
        self.assertEqual(score_output('{"n": 1.0}', {"/n": 1}, {"kind": "json"}).value, 1)
        self.assertEqual(score_output('{"n": [true]}', {"/n": [1]}, {"kind": "json"}).value, 0)
        self.assertEqual(score_output('[1]', {"/-1": 1}, {"kind": "json"}).value, 0)
