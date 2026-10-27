"""Tests for the pure projection module that maps trial evidence onto objectives."""

import unittest

from gear.algorithms.projection import (
    compare_candidates,
    project_candidate,
    protected_tasks,
    raw_scope,
    scope,
)


def cell(candidate, task, score, status="valid", raw=None):
    return {
        "candidate_id": candidate,
        "task_id": task,
        "repetition": 0,
        "score": score,
        "status": status,
        "scope": "global",
        "feedback": "",
        "raw_metrics": raw or {},
    }


def configuration(terms=None, metrics=None, protection=None, assertions=None):
    return {
        "definition": {
            "terms": terms or [{"metric": "pass_rate", "weight": 1, "scale": 1, "metricContractDigest": "pass"}],
            "constraints": [],
            "comparisonPrecision": 1e-9,
            "scorerVersion": "linear-raw-v1",
            "digest": "objective",
            "direction": "maximize",
        },
        "metrics": metrics or [
            {"id": "pass_rate", "digest": "pass", "unit": "ratio", "granularity": "trial",
             "repetitionReducer": "mean", "taskReducer": "weighted-mean",
             "direction": "maximize", "comparisonPrecision": 1e-9,
             "source": {"path": "score", "extractor": "equals-v1", "equals": 1}},
        ],
        "protection": protection or [],
        "assertions": assertions or [],
    }


class ProjectionTests(unittest.TestCase):
    def test_scope_rejects_duplicate_tasks_and_invalid_repetitions(self):
        with self.assertRaises(ValueError):
            scope({"task_ids": ["a", "a"], "repetitions": 1, "evidence": [], "candidate_id": "a"})
        with self.assertRaises(ValueError):
            scope({"task_ids": ["a"], "repetitions": 0, "evidence": [], "candidate_id": "a"})
        with self.assertRaises(ValueError):
            scope({"task_ids": ["a"], "repetitions": 1, "evidence": [], "candidate_id": "a", "weights": {"b": 1}})

    def test_scope_requires_nonnegative_weights_covering_tasks(self):
        with self.assertRaises(ValueError):
            scope({"task_ids": ["a"], "repetitions": 1, "evidence": [], "candidate_id": "a", "weights": {"a": -1}})
        with self.assertRaises(ValueError):
            scope({"task_ids": ["a", "b"], "repetitions": 1, "evidence": [], "candidate_id": "a", "weights": {"a": 0, "b": 0}})

    def test_raw_scope_derives_pass_rate_from_score(self):
        result = raw_scope({
            "task_ids": ["a"],
            "repetitions": 1,
            "evidence": [cell("c", "a", 1)],
            "candidate_id": "c",
            "objective": configuration(),
        })
        self.assertEqual(result["pass_rate"]["status"], "available")
        self.assertEqual(result["pass_rate"]["value"], 1)

    def test_raw_scope_marks_failed_environment_as_invalid(self):
        result = raw_scope({
            "task_ids": ["a"],
            "repetitions": 1,
            "evidence": [cell("c", "a", None, "environment_failed")],
            "candidate_id": "c",
            "objective": configuration(),
        })
        self.assertEqual(result["pass_rate"]["status"], "invalid")

    def test_project_candidate_without_objective_uses_mean_score(self):
        result = project_candidate({
            "task_ids": ["a", "b"],
            "repetitions": 1,
            "evidence": [cell("c", "a", 1), cell("c", "b", 0)],
            "candidate_id": "c",
            "anchor_id": "c",
        })
        self.assertTrue(result["complete"])
        self.assertEqual(result["score"], 0.5)

    def test_project_candidate_without_objective_is_incomplete_when_missing(self):
        result = project_candidate({
            "task_ids": ["a", "b"],
            "repetitions": 1,
            "evidence": [cell("c", "a", 1)],
            "candidate_id": "c",
            "anchor_id": "c",
        })
        self.assertFalse(result["complete"])
        self.assertIsNone(result["score"])

    def test_compare_candidates_reports_gain_only_when_both_complete(self):
        base = {
            "task_ids": ["a"],
            "repetitions": 1,
            "evidence": [cell("anchor", "a", 0), cell("c", "a", 1)],
            "candidate_id": "c",
            "anchor_id": "anchor",
            "objective": configuration(),
        }
        result = compare_candidates(base)
        self.assertTrue(result["complete"])
        self.assertEqual(result["gain"], 1)
        incomplete = compare_candidates({**base, "evidence": [cell("anchor", "a", 0)]})
        self.assertFalse(incomplete["complete"])
        self.assertIsNone(incomplete["gain"])

    def test_protected_tasks_require_baseline_for_no_regression(self):
        config = configuration(
            protection=[{"task_id": "a", "partition": "seed", "metric": "pass_rate", "rule": "no_regression"}]
        )
        result = protected_tasks({
            "task_ids": ["a"],
            "repetitions": 1,
            "evidence": [cell("c", "a", 1), cell("anchor", "a", 0)],
            "candidate_id": "c",
            "anchor_id": "anchor",
            "partition": "seed",
            "objective": config,
        })
        self.assertEqual(result[0]["status"], "passed")

    def test_protected_tasks_skip_held_out_rules(self):
        config = configuration(
            protection=[{"task_id": "a", "partition": "held_out", "metric": "pass_rate", "rule": "minimum", "value": 0}]
        )
        result = protected_tasks({
            "task_ids": ["a"],
            "repetitions": 1,
            "evidence": [cell("c", "a", 1), cell("anchor", "a", 0)],
            "candidate_id": "c",
            "anchor_id": "anchor",
            "partition": "seed",
            "objective": config,
        })
        self.assertEqual(result, [])


if __name__ == "__main__":
    unittest.main()