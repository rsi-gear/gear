import json
import tempfile
import unittest
from pathlib import Path

try:
    import tomllib
except ImportError:
    import tomli as tomllib

from gear.benchmark import BenchmarkError, compile_benchmark
from gear.benchmark.harbor import compile_harbor
from gear.benchmark.runtime_limits import native_timeouts


class RuntimeLimitsTests(unittest.TestCase):
    def test_declared_template_limits_match_the_executed_harbor_config(self):
        from test_llm_scorer import config as llm_config

        for kind in ("text", "llm"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "tasks.jsonl").write_text(
                    json.dumps(
                        {
                            "id": "a",
                            "instruction": "answer",
                            "expected": "yes",
                            "split": "seed",
                        }
                    )
                    + "\n"
                )
                config = {"version": 1, "source": "tasks.jsonl", "template": kind}
                if kind == "llm":
                    config.update(
                        scorer=llm_config(),
                        fixtures={
                            "a": [
                                {"actual": "yes", "score": 1},
                                {"actual": "no", "score": 0},
                            ]
                        },
                    )
                benchmark = compile_benchmark(root, config)
                destination = root / "harbor"
                compile_harbor(benchmark, str(destination), ["a"], "python@sha256:" + "1" * 64)
                task = tomllib.loads((destination / "a/task.toml").read_text())
                declared = benchmark["execution_timeouts"]["a"]
                self.assertEqual(native_timeouts(task, "a"), declared)
                self.assertEqual(declared["verifier_seconds"], 30 if kind == "llm" else 60)
                self.assertEqual(declared["agent_seconds"], 600)

    def test_native_omissions_are_unknown_and_explicit_limits_remain_exact(self):
        self.assertTrue(all(value is None for value in native_timeouts({}, "task").values()))
        config = {
            "agent": {"timeout_sec": 1.25},
            "verifier": {
                "timeout_sec": 60,
                "environment": {"build_timeout_sec": 42},
            },
        }
        self.assertEqual(
            native_timeouts(config, "task"),
            {
                "agent_seconds": 1.25,
                "verifier_seconds": 60,
                "environment_build_seconds": None,
                "verifier_build_seconds": 42,
            },
        )
        for invalid in (True, 0, -1, float("inf"), "300"):
            with self.subTest(invalid=invalid), self.assertRaises(BenchmarkError):
                native_timeouts({"agent": {"timeout_sec": invalid}}, "task")
