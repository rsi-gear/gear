"""Statistical units, promotion boundaries, and deterministic SFT recovery."""

import hashlib
import unittest
from pathlib import Path
from unittest.mock import patch

from gear.algorithms.model_training import (
    offline_window,
    training_decide,
    training_dev_gate,
    training_pair,
)
from gear.training.data.offline import window
from gear.training.pipelines.offline_sft import (
    AssistantDatasetBuilder,
    DatasetTaskSource,
    OfflineRolloutExecutor,
)
from gear.training.runtime.implementation import stage_identity
from gear.training.runtime.preflight import bridge_digest


class TrainingPolicies(unittest.TestCase):
    def report(self, pairs):
        return training_pair(
            {
                "partition": "dev",
                "pairs": [
                    {"taskId": task, "baselineReward": before, "candidateReward": after}
                    for task, before, after in pairs
                ],
                "slot_count": len(pairs),
                "inference_errors": 0,
            }
        )

    def test_each_task_has_equal_weight_regardless_of_attempt_count(self):
        report = self.report([("b", 0, 1), ("a", 1, 0), ("a", 1, 0)])
        self.assertEqual(report["meanDelta"], 0)
        self.assertEqual(report["standardError"], 1)
        self.assertEqual(
            report["taskDeltas"],
            [
                {"taskId": "a", "baseline": 1, "candidate": 0, "delta": -1},
                {"taskId": "b", "baseline": 0, "candidate": 1, "delta": 1},
            ],
        )
        self.assertIsNone(self.report([("a", 0, 1), ("a", 1, 0)])["standardError"])

    def test_locales_do_not_change_task_order(self):
        self.assertEqual(
            [
                task["taskId"]
                for task in self.report(
                    [
                        ("é", 0, 1),
                        ("z", 0, 1),
                        ("A", 0, 1),
                        ("a", 0, 1),
                    ]
                )["taskDeltas"]
            ],
            ["A", "a", "z", "é"],
        )

    def test_incomplete_and_nonfinite_statistics_fail(self):
        with self.assertRaises(ValueError):
            self.report([])
        with self.assertRaises(ValueError):
            self.report([("a", -1e308, 1e308)])

    def test_threshold_equality_and_all_rejection_reasons(self):
        policy = {
            "minDevGain": 0,
            "maxHeldOutRegression": 0.25,
            "maxInferenceErrorRate": 0.5,
            "requiredTaskIds": ["required"],
        }
        dev = self.report([("other", 0, 0)])
        held = {
            **self.report([("other", 0.25, 0)]),
            "partition": "held-out",
            "inferenceErrorRate": 0.5,
        }
        self.assertEqual(
            training_decide({"policy": policy, "dev": dev, "heldOut": held})["outcome"], "accepted"
        )
        dev = {**self.report([("required", 1, 0)]), "inferenceErrorRate": 1}
        held = {**dev, "partition": "held-out"}
        reasons = [
            "dev-gain-below-threshold",
            "dev-inference-error-rate",
            "required-task-regression:required",
        ]
        self.assertEqual(training_dev_gate({"policy": policy, "dev": dev}), reasons)
        decision = training_decide({"policy": policy, "dev": dev, "heldOut": held})
        self.assertEqual(decision["outcome"], "rejected")
        self.assertEqual(
            decision["reasons"],
            reasons
            + [
                "held-out-regression",
                "held-out-inference-error-rate",
                "held-out-required-task-regression",
            ],
        )
        self.assertEqual(decision["heldOut"]["taskCount"], 1)

    def test_offline_window_matches_frozen_order_and_resume_across_epochs(self):
        records = [{"id": index} for index in range(4)]
        # Frozen SHA-256 ordering from the previous training implementation.
        result = window(records, 42, 0, 12)
        self.assertEqual([item["id"] for item in result], [3, 0, 1, 2, 2, 0, 3, 1, 1, 2, 0, 3])
        self.assertEqual(window(records, 42, 3, 7), result[3:10])
        self.assertEqual(offline_window({"records": [], "seed": 0, "position": 0, "size": 0}), [])
        for seed, position, size in [(True, 0, 1), (0, -1, 1), (0, 0, -1), (0, 0, 1.5)]:
            with self.assertRaises(ValueError):
                window(records, seed, position, size)
        with self.assertRaises(ValueError):
            window([], 0, 0, 1)

    def test_shared_algorithm_bytes_are_in_bridge_and_stage_identities(self):
        algorithm = Path(__file__).resolve().parents[1] / "gear/algorithms/model_training.py"
        original_read = Path.read_bytes
        stages = [
            cls(None)
            for cls in (DatasetTaskSource, OfflineRolloutExecutor, AssistantDatasetBuilder)
        ]
        original_bridge = bridge_digest()
        identities = [stage_identity(stage) for stage in stages]
        digest = "sha256:" + hashlib.sha256(algorithm.read_bytes()).hexdigest()
        for identity in identities:
            self.assertIn({"name": algorithm.name, "digest": digest}, identity["sources"])

        def changed_read(path):
            data = original_read(path)
            return data + b"\n# changed algorithm\n" if path.resolve() == algorithm else data

        with patch.object(Path, "read_bytes", changed_read):
            self.assertNotEqual(bridge_digest(), original_bridge)
            for stage, identity in zip(stages, identities):
                self.assertNotEqual(stage_identity(stage), identity)
