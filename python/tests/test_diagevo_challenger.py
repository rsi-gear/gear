"""Reward semantics with real BLEU and clustering, without claiming model training."""

import unittest
from dataclasses import replace

from gear.core import clone
from gear.training.recipes.diagevo import DiagEvoPolicy, SolverSample
from gear.training.recipes.diagevo_challenger import ChallengerSample, DiagEvoChallengerReward


def batch(questions):
    return tuple(
        ChallengerSample(
            f"q{index}",
            f"group{index // 2}",
            "free-exploration",
            "challenger-v1",
            f"<question>{question}</question>",
            f"capture/challenger/{index}",
        )
        for index, question in enumerate(questions)
    )


def votes(rows, answers="a" * 6 + "b" * 6):
    return tuple(
        DiagEvoPolicy().construction(
            tuple(
                SolverSample(
                    f"solver/{row.sample_id}/{index}",
                    row.sample_id,
                    "solver-v1",
                    "construction",
                    answer,
                    f"capture/solver/{row.sample_id}/{index}",
                )
                for index, answer in enumerate(answers)
            )
        )
        for row in rows
    )


class ChallengerTests(unittest.TestCase):
    def test_uncertainty_uses_all_votes_without_curriculum_retention_filter(self):
        reward = DiagEvoChallengerReward(group_size=2, repetition_weight=0)
        rows = batch(("alpha beta gamma delta", "one two three four"))
        tied, easy = votes(rows[:1])[0], votes(rows[1:], "a" * 12)[0]
        self.assertFalse(tied.retained)
        self.assertFalse(easy.retained)
        scored = reward.score(rows, (tied, easy))
        self.assertEqual(tuple(row.reward for row in scored), (1, 0))
        other = reward.score(rows, votes(rows, "a" * 9 + "b" * 3))
        self.assertEqual(tuple(row.reward for row in other), (0.5, 0.5))
        minority = reward.score(rows, votes(rows, "aaa" + "bcdefghij"))
        self.assertEqual(tuple(row.uncertainty for row in minority), (0.5, 0.5))

    def test_duplicate_cluster_penalty_is_batch_wide_and_preserves_groups(self):
        reward = DiagEvoChallengerReward(group_size=2)
        rows = batch(("alpha beta gamma delta",) * 3 + ("one two three four",))
        scored = reward.score(rows, votes(rows))
        self.assertEqual(tuple(row.reward for row in scored), (0.25, 0.25, 0.25, 0.75))
        self.assertEqual(scored[0].cluster_sample_ids, ("q0", "q1", "q2"))
        self.assertEqual(scored[3].cluster_sample_ids, ("q3",))
        self.assertEqual(tuple(row.sample for row in scored), rows)
        self.assertEqual(clone(reward).score(rows, votes(rows)), scored)
        self.assertEqual(reward.describe().package_dependencies, ("nltk", "scikit-learn"))
        clipped = reward.score(rows, votes(rows, "a" * 9 + "b" * 3))
        self.assertEqual(tuple(row.reward for row in clipped), (0, 0, 0, 0.25))

    def test_completed_format_errors_remain_zero_and_count_in_batch_denominator(self):
        reward = DiagEvoChallengerReward(group_size=2)
        original = batch(("alpha beta gamma delta", "one two three four"))
        invalid = (
            "",
            "<question> </question>",
            "question without tags",
            "<question>x</question><question>y</question>",
            "<question><question>x</question></question>",
            "<question>x</question>answer=3",
            "prefix<question>x</question>",
        )
        for response in invalid:
            with self.subTest(response=response):
                rows = (original[0], replace(original[1], response=response))
                self.assertEqual(reward.questions(rows), (("q0", "alpha beta gamma delta"),))
                scored = reward.score(rows, votes(rows[:1]))
                self.assertEqual(tuple(row.reward for row in scored), (0.5, 0))
                self.assertIsNone(scored[1].vote)
                self.assertIsNone(scored[1].uncertainty)
                self.assertEqual(scored[1].cluster_sample_ids, ())
        rows = tuple(replace(row, response="") for row in original)
        self.assertEqual(tuple(row.reward for row in reward.score(rows, ())), (0, 0))
        spaced = tuple(replace(row, response=" \n" + row.response + "\n ") for row in original)
        self.assertEqual(reward.questions(spaced), reward.questions(original))

    def test_partial_mixed_or_reused_challenger_groups_fail_before_solver_sampling(self):
        reward = DiagEvoChallengerReward(group_size=2)
        rows = batch(("alpha beta gamma delta",) * 4)
        variants = (
            (),
            rows[:-1],
            (rows[0],) * 4,
            (replace(rows[0], completed=False),) + rows[1:],
            (replace(rows[0], prompt_id="different"),) + rows[1:],
            (replace(rows[0], policy_id="stale-challenger"),) + rows[1:],
            (replace(rows[0], trajectory_ref=rows[1].trajectory_ref),) + rows[1:],
            (replace(rows[0], group_id="group1"),) + rows[1:],
        )
        for values in variants:
            with self.subTest(values=values), self.assertRaises(ValueError):
                reward.questions(values)
        self.assertEqual(len(reward.questions(rows)), 4)

    def test_missing_extra_or_cross_solver_evidence_is_rejected(self):
        reward = DiagEvoChallengerReward(group_size=2)
        rows = batch(("alpha beta gamma delta", "one two three four"))
        first, second = votes(rows)
        mixed = DiagEvoPolicy().construction(
            tuple(replace(row, policy_id="stale-solver") for row in second.samples)
        )
        for evidence in ((first,), (first, first), (first, second, second), (first, mixed)):
            with self.subTest(evidence=evidence), self.assertRaises(ValueError):
                reward.score(rows, evidence)
        with self.assertRaisesRegex(ValueError, "construction evidence"):
            reward.score(rows, (replace(first, p1=0.99), second))
        invalid = (rows[0], replace(rows[1], response=""))
        with self.assertRaisesRegex(ValueError, "every valid question"):
            reward.score(invalid, (first, second))

    def test_aliases_cannot_reuse_captures_or_sample_ids_across_model_requests(self):
        reward = DiagEvoChallengerReward(group_size=2)
        rows = batch(("alpha beta gamma delta", "one two three four"))
        first, second = votes(rows)
        for field, value in (
            ("trajectory_ref", first.samples[0].trajectory_ref),
            ("trajectory_ref", rows[0].trajectory_ref),
            ("sample_id", first.samples[0].sample_id),
            ("sample_id", rows[0].sample_id),
        ):
            evidence = DiagEvoPolicy().construction(
                (replace(second.samples[0], **{field: value}),) + second.samples[1:]
            )
            with (
                self.subTest(field=field, value=value),
                self.assertRaisesRegex(ValueError, "distinct"),
            ):
                reward.score(rows, (first, evidence))

    def test_ordered_bleu_convention_is_not_replaced_by_bidirectional_average(self):
        # Short -> long has brevity penalty exp(-1) < 0.5. Long -> short
        # has BLEU (0.5 * 3/7 * 2/6 * 1/5)**0.25 < 0.5 too, so use
        # threshold 0.64: the former merges and the latter stays separate.
        reward = DiagEvoChallengerReward(group_size=2, distance_threshold=0.64)
        short = "alpha beta gamma delta"
        rows = batch((short, short + " epsilon zeta eta theta"))
        forward = reward.score(rows, votes(rows))
        reverse = reward.score(tuple(reversed(rows)), votes(rows))
        self.assertEqual(tuple(row.reward for row in forward), (0, 0))
        self.assertEqual(tuple(row.reward for row in reverse), (0.5, 0.5))

    def test_parameter_bounds_do_not_silently_change_the_objective(self):
        rows = batch(("alpha beta gamma delta",) * 2)
        for values in (
            {"group_size": True},
            {"group_size": 1},
            {"repetition_weight": -1},
            {"repetition_weight": float("nan")},
            {"distance_threshold": float("inf")},
            {"distance_threshold": -0.1},
            {"distance_threshold": 1.1},
        ):
            with (
                self.subTest(values=values),
                self.assertRaisesRegex(ValueError, "invalid challenger"),
            ):
                DiagEvoChallengerReward(**values).questions(rows)


if __name__ == "__main__":
    unittest.main()
