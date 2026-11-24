"""Complete repeated rollout groups, unknown outcomes, and actual CPU execution."""

import asyncio
import copy
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

EXAMPLES = Path(__file__).resolve().parents[2] / "examples/curriculum-harness"
sys.path.insert(0, str(EXAMPLES))
from fixtures.trace_calls import TraceCalls  # noqa: E402
from fixtures.trace_game import TOOLS, source  # noqa: E402
from ifeval import read_json  # noqa: E402
from trace_calibrate import TraceCollector, calibrate, calibration_parameters, verify_environment  # noqa: E402
from trace_environment import TraceEnvironment  # noqa: E402

IMAGE = os.environ.get("GEAR_TRACE_PYTHON_IMAGE")
THRESHOLDS = {
    "mean_min": 0.2,
    "mean_max": 0.6,
    "success_min": 0.2,
    "success_max": 0.6,
    "std_min": 0.05,
    "max_all_success_groups": 0.2,
    "max_all_zero_groups": 0.2,
    "max_constant_groups": 0.5,
    "min_informative_groups": 0.5,
    "success_threshold": 1,
    "zero_threshold": 0,
    "pass_at_k": [1, 2],
}


class CalibrationTests(unittest.TestCase):
    def rows(self):
        return [
            {
                "environment_id": "environment",
                "policy_id": "policy",
                "seed": seed,
                "sample_idx": index,
                "sample_id": f"{seed}/{index}",
                "evidence_refs": [{"fixture": f"{seed}/{index}"}],
                "complete": True,
                "reward": int(index == seed - 10),
            }
            for seed in (10, 11)
            for index in (0, 1)
        ]

    def calibrate(self, rows):
        return calibrate(
            rows,
            seeds=[10, 11],
            group_size=2,
            environment_id="environment",
            policy_id="policy",
            thresholds=THRESHOLDS,
        )

    def test_complete_matrix_uses_sample_order_for_empirical_first_k(self):
        result = self.calibrate(list(reversed(self.rows())))
        self.assertEqual(result["status"], "ready")
        metrics = result["metrics"]
        self.assertEqual(metrics["mean_reward"], 0.5)
        self.assertEqual(metrics["std_reward"], 0.5)
        self.assertEqual(metrics["success_rate"], 0.5)
        self.assertEqual(metrics["pass_at_k"], {"1": 0.5, "2": 1})
        self.assertEqual(metrics["informative_group_rate"], 1)
        self.assertEqual(metrics["num_rollouts"], 4)

    def test_too_easy_too_hard_and_constant_groups_do_not_pass(self):
        for reward in (0, 1, 0.5):
            with self.subTest(reward=reward):
                result = self.calibrate([{**row, "reward": reward} for row in self.rows()])
                self.assertEqual(result["status"], "rejected")
                self.assertEqual(result["metrics"]["informative_group_rate"], 0)
                self.assertTrue(result["errors"])

    def test_incomplete_episode_keeps_the_whole_distribution_unknown(self):
        rows = self.rows()
        rows[0].update(complete=False, reward=None)
        result = self.calibrate(rows)
        self.assertEqual(result["status"], "incomplete")
        self.assertIsNone(result["metrics"])
        self.assertEqual(result["unknown_samples"], 1)
        rows[0]["reward"] = 0
        with self.assertRaisesRegex(ValueError, "unknown episodes"):
            self.calibrate(rows)

    def test_missing_duplicate_or_unrelated_samples_cannot_establish_a_group(self):
        for change in (
            {"sample_idx": 2},
            {"sample_id": "10/1"},
            {"environment_id": "different"},
            {"policy_id": "different"},
            {"seed": True},
            {"evidence_refs": []},
            {"complete": "true"},
            {"reward": float("nan")},
            {"reward": True},
        ):
            with self.subTest(change=change):
                rows = self.rows()
                rows[0].update(change)
                with self.assertRaises(ValueError):
                    self.calibrate(rows)
        with self.assertRaisesRegex(ValueError, "complete, unique"):
            self.calibrate(self.rows()[:-1])
        with self.assertRaisesRegex(ValueError, "duplicate"):
            self.calibrate(self.rows() + [self.rows()[0]])

    def test_measurement_plan_is_validated_before_collection(self):
        for change in (
            {"pass_at_k": [3]},
            {"zero_threshold": 1},
            {"mean_min": 0.8},
            {"std_min": float("inf")},
        ):
            with self.subTest(change=change), self.assertRaises(ValueError):
                calibration_parameters([1, 2], 2, {**THRESHOLDS, **change})
        for seeds, size in (([1, 1], 2), ([1], 2), ([True, 2], 2), ([1, 2], 1)):
            with self.assertRaises(ValueError):
                calibration_parameters(seeds, size, THRESHOLDS)


@unittest.skipUnless(IMAGE, "requires an explicit local CPU Python Docker image ID")
class CollectorTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.environment = TraceEnvironment(self.root / "environment", source(), TOOLS, image=IMAGE)
        self.config = {
            "schema_version": 1,
            "model": "explicit-fixture",
            "effort": "low",
            "harness": "Read the records before answering.",
            "seed": 17,
            "sample_idx": 0,
            "sample_id": "test-17-0",
            "max_steps": 8,
            "max_calls": 64,
        }

    def collect(self, calls, *, name="sample", config=None):
        return asyncio.run(
            TraceCollector(
                self.root / name, self.environment, config or self.config, calls
            ).collect()
        )

    def test_actual_execution_negative_controls_and_paid_receipt_recovery(self):
        verified = verify_environment(self.environment, [17, 18])
        self.assertEqual(verified["distinct_initial_contexts"], 2)
        for row in verified["records"]:
            self.assertEqual(row["traces"]["reference"]["snapshots"][-1]["summary"]["reward"], 1)
            self.assertLess(row["traces"]["wrong_result"]["snapshots"][-1]["summary"]["reward"], 1)
        calls = TraceCalls(passed=True)
        calls.interrupt_key = "solve/2"
        with self.assertRaisesRegex(OSError, "lost completed"):
            self.collect(calls)
        self.assertFalse((self.root / "sample/result.json").exists())
        result = self.collect(calls)
        self.assertEqual(result["reward"], 1)
        self.assertTrue(result["complete"])
        self.assertEqual(result["model_usage"]["completed_calls"], 4)
        self.assertEqual(len(calls.submissions), 4)
        self.assertEqual(result, self.collect(calls))
        self.assertEqual(len(calls.submissions), 4)
        for request, _ in calls.receipts.values():
            json_data = json.loads(request[0])
            self.assertEqual(set(json_data), {"system_prompt", "tools", "messages"})
            self.assertNotIn("reference_actions", str(json_data))
        trace = read_json(self.root / "sample/trajectory.json")
        self.assertEqual(trace["snapshots"][0]["summary"], {"reward": 0, "steps": 0})

    def test_step_limit_and_unknown_model_results_are_never_zero_scores(self):
        calls = TraceCalls(passed=True)
        config = {**copy.deepcopy(self.config), "max_steps": 1}
        result = self.collect(calls, config=config)
        self.assertFalse(result["complete"])
        self.assertIsNone(result["reward"])
        unknown = TraceCalls(passed=True)
        unknown.unknown_key = "solve/0"
        with self.assertRaisesRegex(RuntimeError, "incomplete or unknown"):
            self.collect(unknown, name="unknown")
        self.assertFalse((self.root / "unknown/result.json").exists())
        self.assertFalse((self.root / "unknown/model/solve/0.json").exists())


if __name__ == "__main__":
    unittest.main()
