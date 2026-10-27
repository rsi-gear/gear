"""Tests for the shared evidence helpers used by recipe ranking."""

import unittest

from gear.algorithms.contracts import Evidence, RankingInput
from gear.algorithms.evidence import complete_scope_mean, task_scores


def cell(candidate, task, score, status="valid"):
    return Evidence(candidate, task, 0, score, status, "global")


class EvidenceTests(unittest.TestCase):
    def test_task_scores_requires_positive_repetitions(self):
        with self.assertRaises(ValueError):
            task_scores(RankingInput(("a",), (), (), 0))

    def test_task_scores_requires_unique_tasks(self):
        with self.assertRaises(ValueError):
            task_scores(RankingInput(("a",), ("a", "a"), (), 1))

    def test_task_scores_skips_incomplete_slots(self):
        cells = (cell("a", "t", 1), cell("a", "t", None, "environment_failed"))
        profiles = task_scores(RankingInput(("a",), ("t",), cells, 1))
        self.assertEqual(profiles, {})

    def test_task_scores_averages_repetitions(self):
        cells = (
            Evidence("a", "t", 0, 1, "valid", "global"),
            Evidence("a", "t", 1, 0, "valid", "global"),
        )
        profiles = task_scores(RankingInput(("a",), ("t",), cells, 2))
        self.assertEqual(profiles, {"a": (("t", 0.5),)})

    def test_complete_scope_mean_ranks_by_weighted_sum(self):
        cells = (
            Evidence("a", "important", 0, 1, "valid", "global"),
            Evidence("a", "small", 0, 0, "valid", "global"),
            Evidence("b", "important", 0, 0, "valid", "global"),
            Evidence("b", "small", 0, 1, "valid", "global"),
        )
        ranking = complete_scope_mean(
            RankingInput(("a", "b"), ("important", "small"), cells, 1,
                         (("important", 0.8), ("small", 0.2)))
        )
        self.assertEqual(ranking.scores, (("a", 0.8), ("b", 0.2)))

    def test_complete_scope_mean_marks_incomplete_candidates(self):
        cells = (cell("a", "t", 1), cell("b", "t", None, "environment_failed"))
        ranking = complete_scope_mean(RankingInput(("a", "b"), ("t",), cells, 1))
        self.assertEqual(ranking.candidate_ids, ("a",))
        self.assertEqual(ranking.incomplete, ("b",))


if __name__ == "__main__":
    unittest.main()