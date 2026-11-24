"""Boolean behavioral signals keep the paper's thresholds and evidence scope."""

import unittest
from dataclasses import replace

from gear.curriculum import (
    BehavioralObservation,
    ExtractLearningSignals,
    ExtractOutcomeCases,
    OutcomeRecord,
)


def observation(
    name,
    score,
    *,
    policy="current",
    group="group",
    condition="same-plan",
    patterns=("common",),
    complete=True,
):
    record = OutcomeRecord(
        "task",
        "family",
        name,
        0,
        policy,
        "environment",
        "completed",
        score > 0.5 if score is not None else None,
        complete,
        evidence_refs=({"execution": name},),
    )
    case = ExtractOutcomeCases()((record,))[0]
    return BehavioralObservation(case, condition, group, score, patterns)


class LearningSignalTests(unittest.TestCase):
    def test_forgetting_uses_a_bounded_comparable_recent_history(self):
        prior = observation("prior", 0.5, policy="old")
        now = observation("now", 0.4)
        result = ExtractLearningSignals()((prior, now), policy_id="current")
        self.assertEqual(result[0].signals, ("forgetting",))
        self.assertFalse(
            ExtractLearningSignals(history_window=1)((prior, now), policy_id="current")
        )
        self.assertFalse(
            ExtractLearningSignals()(
                (replace(prior, comparison_id="different-plan"), now), policy_id="current"
            )
        )

    def test_boundary_marks_every_member_only_with_strict_success_and_failure(self):
        values = (
            observation("success", 0.9),
            observation("equal", 0.5),
            observation("failed", 0.1),
        )
        result = ExtractLearningSignals()(values, policy_id="current")
        self.assertTrue(all("boundary" in row.signals for row in result))
        self.assertEqual(len(result), 3)
        self.assertFalse(ExtractLearningSignals()(values[:2], policy_id="current"))
        split = (
            values[0],
            replace(values[2], group_id="different-group", comparison_id="different-plan"),
        )
        self.assertFalse(ExtractLearningSignals()(split, policy_id="current"))

    def test_rare_pattern_requires_positive_observed_frequency_and_minimum_support(self):
        old = tuple(observation(f"old-{i}", 1, policy="old") for i in range(20))
        rare = observation("rare", 1, patterns=("rare-action",))
        result = ExtractLearningSignals()(old + (rare,), policy_id="current")
        self.assertEqual(result[0].signals, ("rare",))
        self.assertEqual(result[0].rare_patterns, ("rare-action",))
        self.assertFalse(
            ExtractLearningSignals(minimum_patterns=22)(old + (rare,), policy_id="current")
        )
        # A declared but unobserved action is never manufactured as a rare signal.
        self.assertFalse(
            ExtractLearningSignals()(
                old + (observation("empty", 1, patterns=()),), policy_id="current"
            )
        )

    def test_unknown_or_incomplete_outcomes_do_not_supply_failure_signals(self):
        prior = observation("prior", 1, policy="old")
        self.assertFalse(
            ExtractLearningSignals()(
                (prior, observation("partial", 0, complete=False), observation("unknown", None)),
                policy_id="current",
            )
        )
        with self.assertRaisesRegex(ValueError, "duplicate case"):
            ExtractLearningSignals()((prior, prior), policy_id="current")


if __name__ == "__main__":
    unittest.main()
