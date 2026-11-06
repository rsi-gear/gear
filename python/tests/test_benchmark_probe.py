import json
import tempfile
import unittest
from pathlib import Path

from gear.benchmark import BenchmarkError, compile_benchmark
from gear.benchmark.probe import prepare_probe, read_probe_case


class BenchmarkProbeTests(unittest.TestCase):
    def test_malformed_author_fixtures_are_rejected_before_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "tasks.jsonl"
            source.write_text('{"id":"a","instruction":"seed","expected":"x","split":"seed"}')
            for malformed in ({"actual": "x", "score": []}, {"actual": "x", "score": True},
                              {"actual": 3, "score": 1}, {"actual": "x", "score": 1, "artifacts": []}):
                with self.assertRaises(BenchmarkError) as error:
                    compile_benchmark(root, {
                        "version": 1, "source": source.name,
                        "fixtures": {"a": [malformed, {"actual": "wrong", "score": 0}]},
                    })
                self.assertEqual(error.exception.location, "tasks.jsonl:1:fixtures")

    def test_probe_uses_seed_and_private_frozen_fixtures(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "tasks.jsonl"
            source.write_text("\n".join(json.dumps(row) for row in [
                {"id": "a", "instruction": "seed", "expected": "PRIVATE", "split": "seed"},
                {"id": "b", "instruction": "held", "expected": "HELD", "split": "held_out"},
            ]))
            benchmark = compile_benchmark(root, {"version": 1, "source": source.name})
            image = "python@sha256:" + "1" * 64
            with self.assertRaisesRegex(BenchmarkError, "seed task"):
                prepare_probe(benchmark, str(root / "rejected"), "b", image, True)
            self.assertFalse((root / "rejected").exists())
            plan = prepare_probe(benchmark, str(root / "probe"), "a", image, True)
            self.assertEqual(len(plan["cases"]), 2)
            self.assertEqual((Path(plan["cases"][0]["workspace"]) / "answer.txt").read_text(), "PRIVATE")
            self.assertNotIn("PRIVATE", json.dumps(plan))
            self.assertFalse((root / "probe/tasks/b").exists())
            environment = prepare_probe(benchmark, str(root / "environment-only"), "a", image)
            self.assertEqual(environment["cases"], [])

    def test_probe_results_distinguish_zero_mismatch_and_invalid_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result, reward = root / "gear-result.json", root / "reward.txt"
            self.assertEqual(read_probe_case(directory, 0)["status"], "scoring_failed")
            result.write_text('{"status":"valid","value":0}')
            reward.write_text("0")
            self.assertEqual(read_probe_case(directory, 0)["status"], "passed")
            self.assertEqual(read_probe_case(directory, 1)["status"], "failed")
            reward.write_text("1")
            self.assertEqual(read_probe_case(directory, 0)["status"], "scoring_failed")
            for value in ("NaN", "true", '"0"', "2"):
                result.write_text('{"status":"valid","value":' + value + "}")
                reward.write_text(value)
                self.assertEqual(read_probe_case(directory, 0)["status"], "scoring_failed")
            result.unlink()
            result.symlink_to(reward)
            self.assertEqual(read_probe_case(directory, 0)["status"], "scoring_failed")
