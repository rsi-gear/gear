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

    def test_generated_verifiers_preserve_exact_newlines(self):
        for template in ("text", "files"):
            for expected_newline in ("\n", "\r\n", "\r"):
                for actual_newline in ("\n", "\r\n", "\r"):
                    with (
                        self.subTest(template=template, expected=repr(expected_newline), actual=repr(actual_newline)),
                        tempfile.TemporaryDirectory() as directory,
                    ):
                        expected = "first" + expected_newline + "second"
                        actual = "first" + actual_newline + "second"
                        self.assert_generated_score(
                            Path(directory), {"template": template},
                            expected if template == "text" else {"result.txt": expected},
                            {"answer.txt" if template == "text" else "result.txt": actual.encode("utf-8")},
                            float(expected == actual),
                        )

    def test_generated_text_verifier_only_applies_explicit_normalization(self):
        for newline in ("\r\n", "\r"):
            for normalization, score in (({"trim": True}, 0), ({"collapse_whitespace": True}, 1)):
                with (
                    self.subTest(newline=repr(newline), normalization=normalization),
                    tempfile.TemporaryDirectory() as directory,
                ):
                    self.assert_generated_score(
                        Path(directory), {"template": "text", "normalization": normalization},
                        "first\nsecond", {"answer.txt": ("first" + newline + "second").encode("utf-8")}, score,
                    )

    def test_generated_python_verifier_preserves_answer_and_artifact_newlines(self):
        for newline in ("\r\n", "\r"):
            for name in ("answer.txt", "proof.txt"):
                with self.subTest(newline=repr(newline), name=name), tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    outputs = {"answer.txt": "first\nsecond", "proof.txt": "first\nsecond"}
                    outputs[name] = "first" + newline + "second"
                    (root / "scorer.py").write_bytes(
                        b'def score(actual, expected, artifacts, *, seed):\n'
                        b'    return actual == expected["answer"] and artifacts.get("proof.txt") == expected["proof"]\n'
                    )
                    config = {
                        "template": "python",
                        "scorer": {
                            "entrypoint": "scorer.py:score", "version": "v1",
                            "randomness": {"seed": 0}, "cost": {"model_requests": 0},
                            "artifacts": ["proof.txt"],
                        },
                        "fixtures": {"one": [
                            {"actual": outputs["answer.txt"], "artifacts": {"proof.txt": outputs["proof.txt"]}, "score": 1},
                            {"actual": "wrong", "artifacts": {"proof.txt": "wrong"}, "score": 0},
                        ]},
                    }
                    self.assert_generated_score(
                        root, config, {"answer": outputs["answer.txt"], "proof": outputs["proof.txt"]},
                        {name: value.encode("utf-8") for name, value in outputs.items()}, 1,
                    )

    def test_generated_verifiers_reject_invalid_utf8(self):
        for template in ("text", "files"):
            with self.subTest(template=template), tempfile.TemporaryDirectory() as directory:
                self.assert_generated_score(
                    Path(directory), {"template": template},
                    "answer" if template == "text" else {"result.txt": "answer"},
                    {"answer.txt" if template == "text" else "result.txt": b"\xff"}, None,
                )

    def assert_generated_score(self, root, config, expected, outputs, score):
        row = {"id": "one", "instruction": "Write the requested content", "expected": expected, "split": "seed"}
        (root / "tasks.jsonl").write_bytes(json.dumps(row).encode("utf-8"))
        benchmark = compile_benchmark(root, {"version": 1, "source": "tasks.jsonl", **config})
        compiled = compile_harbor(benchmark, str(root / "harbor"), ["one"], "python@sha256:" + "1" * 64)
        verifier = Path(compiled["directory"]) / "one/tests/verify.py"
        workspace, logs = root / "workspace", root / "logs"
        workspace.mkdir()
        logs.mkdir()
        reward = logs / "reward.txt"
        reward.write_bytes(b"1")
        for name, content in outputs.items():
            # Preserve the test bytes even on hosts that translate newlines when writing text.
            (workspace / name).write_bytes(content)
        result = subprocess.run(
            [sys.executable, "-B", str(verifier), str(workspace), str(logs)],
            capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(result.returncode, 2 if score is None else 0, result.stderr)
        recorded = json.loads((logs / "gear-result.json").read_bytes())
        self.assertEqual(recorded["status"], "scoring_failed" if score is None else "valid")
        self.assertEqual(recorded["value"], score)
        if score is None:
            self.assertEqual(recorded["reason"], "UnicodeDecodeError")
            self.assertFalse(reward.exists())
        else:
            self.assertEqual(float(reward.read_bytes()), score)
