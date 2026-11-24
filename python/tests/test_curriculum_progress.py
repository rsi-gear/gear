"""Measured scheduling, policy comparability and independent signal ablations."""

import unittest
from dataclasses import replace

from gear.core import clone
from gear.curriculum import (
    FailureMode,
    MasteryObservation,
    ProgressObservation,
    SelectLearningTargets,
)


def memory():
    return tuple(
        FailureMode(name, name, ("case-" + name,), (), ("family",), "diagnoser")
        for name in ("a", "b", "c")
    )


def observed(name, successes, policy="current", actions=()):
    return ProgressObservation(
        name,
        policy,
        "same-evaluation-plan",
        tuple(f"{policy}-{name}-{i}" for i in range(10)),
        successes,
        ("measurement",),
        tuple(name for name, _ in actions),
        actions,
    )


class ProgressSelectionTests(unittest.TestCase):
    def test_frontier_prioritizes_measured_middle_and_preserves_exact_budget(self):
        operator = SelectLearningTargets("frontier")
        values = tuple(
            observed(name, successes) for name, successes in (("a", 5), ("b", 9), ("c", 1))
        )
        result = operator(memory(), budget=7, progress=values, policy_id="current")
        self.assertEqual(sum(target.count for target in result), 7)
        self.assertEqual(result[0].target_id, "a")
        self.assertGreater(result[0].count, result[1].count)
        self.assertEqual(
            result, clone(operator)(memory(), budget=7, progress=values, policy_id="current")
        )

    def test_forgetting_can_revisit_previously_mastered_modes(self):
        modes = list(memory())
        modes[0] = replace(
            modes[0],
            state="mastered",
            mastery=MasteryObservation("a", True, "previous", ("old-proof",)),
        )
        values = tuple(
            observed(name, successes) for name, successes in (("a", 5), ("b", 9), ("c", 1))
        )
        values += tuple(
            observed(name, successes, "previous")
            for name, successes in (("a", 9), ("b", 9), ("c", 1))
        )
        options = dict(
            budget=6, progress=values, policy_id="current", previous_policy_id="previous"
        )
        result = SelectLearningTargets("forgetting")(modes, **options)
        self.assertEqual([(target.target_id, target.count) for target in result], [("a", 6)])
        # Turning off the other two scheduling signals removes their input
        # requirements and matches the standalone forgetting strategy.
        ablated = SelectLearningTargets("signal_mix", frontier_weight=0, rare_action_weight=0)
        self.assertEqual(result, ablated(modes, **options))

    def test_conditions_and_policy_identity_are_required_for_forgetting(self):
        modes = memory()[:1]
        current, previous = observed("a", 3), observed("a", 9, "previous")
        operator = SelectLearningTargets("forgetting")
        with self.assertRaisesRegex(ValueError, "matching evaluation conditions"):
            operator(
                modes,
                budget=2,
                progress=(current, replace(previous, comparison_id="different-pool")),
                policy_id="current",
                previous_policy_id="previous",
            )
        with self.assertRaisesRegex(ValueError, "different policies"):
            operator(
                modes,
                budget=2,
                progress=(current, replace(previous, sample_ids=current.sample_ids)),
                policy_id="current",
                previous_policy_id="previous",
            )
        with self.assertRaisesRegex(ValueError, "distinct explicit previous"):
            operator(modes, budget=2, progress=(current,), policy_id="current")

    def test_rare_actions_require_observed_zero_counts_not_missing_data(self):
        operator = SelectLearningTargets("rare_action")
        values = (
            observed("a", 5, actions=(("tool", 100),)),
            observed("b", 5, actions=(("tool", 0),)),
        )
        result = operator(memory()[:2], budget=4, progress=values, policy_id="current")
        self.assertEqual([(target.target_id, target.count) for target in result], [("b", 4)])
        with self.assertRaisesRegex(ValueError, "explicit counts"):
            operator(
                memory()[:1],
                budget=1,
                progress=(replace(values[0], action_counts=()),),
                policy_id="current",
            )
        with self.assertRaisesRegex(ValueError, "unknown, not a zero"):
            operator(memory()[:2], budget=2, progress=values[:1], policy_id="current")

    def test_all_zero_signal_does_not_invent_learning_budget(self):
        value = observed("a", 10)
        result = SelectLearningTargets("frontier")(
            memory()[:1], budget=100, progress=(value,), policy_id="current"
        )
        self.assertEqual(result, ())
        with self.assertRaisesRegex(ValueError, "at least one"):
            SelectLearningTargets(
                "signal_mix", frontier_weight=0, forgetting_weight=0, rare_action_weight=0
            )(memory()[:1], budget=1, progress=(value,), policy_id="current")


if __name__ == "__main__":
    unittest.main()
