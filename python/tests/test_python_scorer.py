import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from gear.benchmark import BenchmarkError, compile_benchmark
from gear.benchmark.harbor import compile_harbor
from gear.benchmark.probe import prepare_probe, read_probe_case
from gear.canonical import digest

IMAGE = "python@sha256:" + "1" * 64
SOURCE = '''def score(actual, expected, artifacts, *, seed):
    return actual.strip() == expected and artifacts.get("proof.txt") == "proof" and seed == 7
'''


class PythonScorerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "tasks.jsonl").write_text(json.dumps({
            "id": "a", "instruction": "Complete the task", "expected": "PRIVATE",
            "split": "seed",
        }))
        (self.root / "scorers.py").write_text(SOURCE)
        self.config = {
            "version": 1, "source": "tasks.jsonl", "template": "python",
            "scorer": {
                "entrypoint": "scorers.py:score", "version": "v1",
                "randomness": {"seed": 7}, "cost": {"model_requests": 0},
                "artifacts": ["proof.txt"],
            },
            "fixtures": {"a": [
                {"actual": "PRIVATE", "artifacts": {"proof.txt": "proof"}, "score": 1},
                {"actual": "WRONG", "artifacts": {"proof.txt": "proof"}, "score": 0},
            ]},
        }

    def compile(self):
        return compile_benchmark(self.root, self.config)

    def verify(self, tests, workspace, logs):
        return subprocess.run(
            [sys.executable, str(Path(tests) / "verify.py"), str(workspace), str(logs)],
            capture_output=True, text=True, timeout=10,
        )

    def test_check_and_compilation_never_execute_source(self):
        marker = self.root / "IMPORTED"
        (self.root / "scorers.py").write_text(
            f"from pathlib import Path\nPath({str(marker)!r}).touch()\n" + SOURCE
        )
        benchmark = self.compile()
        self.assertFalse(marker.exists())
        self.assertEqual(benchmark["checks"], {
            "static": "passed", "verifier_fixtures": "not_run", "environment": "not_run",
        })
        self.assertNotIn("PRIVATE", json.dumps(benchmark["tasks"]))
        compiled = compile_harbor(benchmark, str(self.root / "harbor"), ["a"], IMAGE)
        self.assertFalse(marker.exists())
        environment = Path(compiled["directory"]) / "a/environment"
        self.assertFalse(any(b"PRIVATE" in path.read_bytes() for path in environment.rglob("*") if path.is_file()))

    def test_probe_executes_frozen_source_and_declared_artifacts(self):
        benchmark = self.compile()
        (self.root / "scorers.py").write_text("raise RuntimeError('mutable source was loaded')")
        plan = prepare_probe(benchmark, str(self.root / "probe"), "a", IMAGE, True)
        self.assertNotIn("source", plan["scorer_metadata"])
        self.assertEqual(plan["scorer_metadata"]["randomness"], {"seed": 7})
        self.assertEqual(plan["scorer_metadata"]["cost"], {"model_requests": 0})
        for case in plan["cases"]:
            with self.subTest(case=case["index"]):
                run = self.verify(plan["tests"], case["workspace"], case["logs"])
                self.assertEqual(run.returncode, 0, run.stderr)
                self.assertEqual(read_probe_case(case["logs"], case["expected_score"])["status"], "passed")
        environment_only = prepare_probe(benchmark, str(self.root / "environment"), "a", IMAGE)
        self.assertEqual(environment_only["cases"], [])

    def test_nonboolean_returns_and_exceptions_are_scoring_failures_and_clear_stale_reward(self):
        for expression in ("0", "1.0", "0.5", "None", "float('nan')", "1 / 0"):
            with self.subTest(expression=expression):
                (self.root / "scorers.py").write_text(
                    f"def score(actual, expected, artifacts, *, seed):\n    return {expression}\n"
                )
                benchmark = self.compile()
                path = self.root / digest(expression).split(":")[1]
                plan = prepare_probe(benchmark, str(path), "a", IMAGE, True)
                case = plan["cases"][0]
                reward = Path(case["logs"]) / "reward.txt"
                reward.write_text("1")
                result = self.verify(plan["tests"], case["workspace"], case["logs"])
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse(reward.exists())
                status = json.loads((Path(case["logs"]) / "gear-result.json").read_text())
                self.assertEqual(status["status"], "scoring_failed")
                self.assertIsNone(status["value"])

    def test_source_and_configuration_changes_invalidate_benchmark_identity(self):
        original = self.compile()["digest"]
        (self.root / "scorers.py").write_text(SOURCE + "\n# versioned implementation\n")
        self.assertNotEqual(original, self.compile()["digest"])
        (self.root / "scorers.py").write_text(SOURCE)
        for field, value in (("version", "v2"), ("randomness", {"seed": 8}), ("artifacts", [])):
            with self.subTest(field=field):
                config = copy.deepcopy(self.config)
                config["scorer"][field] = value
                if field == "artifacts":
                    for fixture in config["fixtures"]["a"]:
                        fixture.pop("artifacts")
                self.assertNotEqual(original, compile_benchmark(self.root, config)["digest"])

    def test_invalid_contracts_are_rejected_statically(self):
        for field, values in {
            "entrypoint": ["../scorers.py:score", "scorers.py:missing", "scorers.py"],
            "version": [1, ""], "randomness": [{"seed": True}, {"seed": -1}, {}],
            "cost": [{"model_requests": 1}, {"model_requests": False}, {}],
            "artifacts": [["../private"], ["answer.txt"], ["."], ["a", "a"], [{}]],
        }.items():
            for value in values:
                with self.subTest(field=field, value=value), self.assertRaises(BenchmarkError):
                    config = copy.deepcopy(self.config)
                    config["scorer"][field] = value
                    compile_benchmark(self.root, config)
        for source in (
            "syntax error", "score = lambda: True",
            "async def score(actual, expected, artifacts, *, seed):\n    return True",
            "def score(actual):\n    return True",
        ):
            with self.subTest(source=source), self.assertRaises(BenchmarkError):
                (self.root / "scorers.py").write_text(source)
                self.compile()

    def test_explicit_fixtures_and_known_artifacts_are_required(self):
        for mutate in (
            lambda config: config.pop("fixtures"),
            lambda config: config["fixtures"]["a"].pop(),
            lambda config: config["fixtures"].update(unknown=config["fixtures"]["a"]),
            lambda config: config["fixtures"]["a"][0]["artifacts"].update(undeclared="x"),
            lambda config: config.update(normalization={"trim": True}),
            lambda config: config.update(template="text"),
        ):
            with self.subTest(mutate=mutate), self.assertRaises(BenchmarkError):
                config = copy.deepcopy(self.config)
                mutate(config)
                compile_benchmark(self.root, config)

    def test_changed_runtime_and_frozen_source_digest_are_rejected(self):
        benchmark = self.compile()
        benchmark["python_scorer_source_digest"] = "sha256:" + "0" * 64
        benchmark["digest"] = digest({k: v for k, v in benchmark.items() if k != "digest"})
        with self.assertRaisesRegex(BenchmarkError, "runtime changed"):
            compile_harbor(benchmark, str(self.root / "changed"), ["a"], IMAGE)
        benchmark = self.compile()
        benchmark["verifiers"]["a"]["rule"]["scorer"]["source_digest"] = "sha256:" + "0" * 64
        benchmark["digest"] = digest({k: v for k, v in benchmark.items() if k != "digest"})
        plan = prepare_probe(benchmark, str(self.root / "tampered"), "a", IMAGE, True)
        case = plan["cases"][0]
        self.assertEqual(self.verify(plan["tests"], case["workspace"], case["logs"]).returncode, 2)
