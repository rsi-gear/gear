"""Semantic novelty, measured difficulty, bounded exploration and mixed pools."""

import unittest
from dataclasses import replace

from gear.canonical import digest
from gear.core import DeterministicRandom
from gear.curriculum import PracticeMeasurement, SelectPractice, SemanticNeighborhood
from test_curriculum import evidence, fixture


def pool(count=3):
    _, _, validator, _, _, original = fixture()
    drafts = tuple(
        replace(
            original, draft_id=f"draft-{index}", instruction=f"Practice {index}", data={"x": index}
        )
        for index in range(count)
    )
    plan = validator.plan(drafts)
    return drafts, validator.assess(plan, evidence(plan))


def measurement(draft, successes):
    return PracticeMeasurement(
        draft.digest,
        "student",
        tuple(draft.draft_id + f"-sample-{i}" for i in range(10)),
        successes,
        ("rollout-evidence",),
    )


class PoolSelectionTests(unittest.TestCase):
    def test_semantic_duplicates_are_checked_against_the_actually_retained_pool(self):
        drafts, report = pool()
        existing = digest("existing")
        comparison = digest(sorted([existing, *(draft.content_digest for draft in drafts)]))
        links = (
            ((existing, 0.95),),
            ((drafts[0].content_digest, 0.96),),
            ((drafts[1].content_digest, 0.98),),
        )
        observations = tuple(
            SemanticNeighborhood(
                draft.digest, comparison, "embed-v1", 0.8, neighbors, ("nearest-neighbor-search",)
            )
            for draft, neighbors in zip(drafts, links)
        )
        operator = SelectPractice(semantic_threshold=0.9, semantic_method_id="embed-v1")
        options = dict(budget=3, base_pool_version="pool-v1", existing_content_digests=(existing,))
        result = operator(drafts, report, neighborhoods=observations, **options)
        self.assertEqual([item.draft_id for item in result.selections], ["draft-1"])
        self.assertEqual(set(reason for _, reason in result.rejected), {"semantic near duplicate"})
        with self.assertRaisesRegex(ValueError, "comparison pool"):
            operator(
                drafts,
                report,
                neighborhoods=(replace(observations[0], comparison_pool_digest=digest("stale")),),
                **options,
            )
        with self.assertRaisesRegex(ValueError, "omit neighbors"):
            operator(
                drafts,
                report,
                neighborhoods=(replace(observations[0], minimum_similarity=0.99),),
                **options,
            )

    def test_missing_semantic_observations_do_not_assert_novelty(self):
        drafts, report = pool(1)
        operator = SelectPractice(semantic_threshold=0.9, semantic_method_id="embed-v1")
        result = operator(drafts, report, budget=1, base_pool_version="pool")
        self.assertFalse(result.selections)
        self.assertIn("missing", result.rejected[0][1])
        observation = SemanticNeighborhood(
            drafts[0].digest,
            digest([drafts[0].content_digest]),
            "embed-v1",
            0.9,
            (),
            ("search",),
            False,
        )
        result = operator(
            drafts, report, budget=1, base_pool_version="pool", neighborhoods=(observation,)
        )
        self.assertFalse(result.selections)

    def test_difficulty_filter_and_exploration_have_separate_bounded_slots(self):
        drafts, report = pool()
        observations = tuple(measurement(draft, count) for draft, count in zip(drafts, (0, 5, 10)))
        options = dict(
            budget=2, base_pool_version="pool", measurements=observations, policy_id="student"
        )
        operator = SelectPractice(min_success_rate=0.2, max_success_rate=0.8, exploration_count=1)
        result = operator(drafts, report, rng=DeterministicRandom("fixed-seed"), **options)
        self.assertEqual(len(result.selections), 2)
        self.assertEqual(result.selections[0].draft_id, "draft-1")
        self.assertEqual(
            result, operator(drafts, report, rng=DeterministicRandom("fixed-seed"), **options)
        )
        with self.assertRaisesRegex(ValueError, "explicit random source"):
            operator(drafts, report, **options)
        # Missing measurements can use only the declared exploration slot.
        unknown = operator(
            drafts,
            report,
            budget=2,
            base_pool_version="pool",
            policy_id="student",
            rng=DeterministicRandom("fixed-seed"),
        )
        self.assertEqual(len(unknown.selections), 1)

    def test_difficulty_cannot_reuse_different_policy_or_sample_bindings(self):
        drafts, report = pool(2)
        observations = (measurement(drafts[0], 5), measurement(drafts[1], 5))
        operator = SelectPractice(min_success_rate=0.1)
        with self.assertRaisesRegex(ValueError, "different policy"):
            operator(
                drafts,
                report,
                budget=2,
                base_pool_version="pool",
                measurements=observations,
                policy_id="new-policy",
            )
        with self.assertRaisesRegex(ValueError, "different draft bytes"):
            operator(
                drafts,
                report,
                budget=2,
                base_pool_version="pool",
                measurements=(
                    observations[0],
                    replace(observations[1], sample_ids=observations[0].sample_ids),
                ),
                policy_id="student",
            )

    def test_mixed_pool_shortfall_is_not_silently_backfilled(self):
        drafts, report = pool(4)
        operator = SelectPractice(mix_counts=(("fixed", 1), ("random", 2)))
        sources = tuple(
            (draft.digest, "fixed" if index < 3 else "random") for index, draft in enumerate(drafts)
        )
        result = operator(drafts, report, budget=3, base_pool_version="pool", sources=sources)
        self.assertEqual([item.draft_id for item in result.selections], ["draft-0", "draft-3"])
        self.assertTrue(
            all(reason == "source mix quota exhausted" for _, reason in result.rejected)
        )
        with self.assertRaisesRegex(ValueError, "sum to the explicit budget"):
            operator(drafts, report, budget=4, base_pool_version="pool", sources=sources)


if __name__ == "__main__":
    unittest.main()
