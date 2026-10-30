"""Tests for the pure validation module that checks recipe contracts."""

import unittest

from gear.algorithms.contracts import (
    ParentInput,
    ParentOption,
    ParentPlan,
    SamplingInput,
    SamplingPlan,
    Task,
)
from gear.algorithms.validation import validate_parent_plan, validate_sampling_plan


def option(cid, score=0.5, scope="global", tasks=("a",), weights=(("a", 1.0),)):
    return ParentOption(cid, scope, tasks, score, task_scores=tuple(zip(tasks, (score,) * len(tasks))), weights=weights)


class ValidationTests(unittest.TestCase):
    def test_parent_plan_requires_reason(self):
        view = ParentInput((option("a"),), 1, "anchor")
        with self.assertRaises(ValueError):
            validate_parent_plan(view, ParentPlan((), ""))

    def test_parent_plan_rejects_over_quota(self):
        view = ParentInput((option("a"),), 1, "anchor")
        from gear.algorithms.contracts import ParentAllocation, Selection
        sel = Selection(option("a"), (("global:a", 1.0),), 0, "sha256:" + "0" * 64)
        with self.assertRaises(ValueError):
            validate_parent_plan(view, ParentPlan((ParentAllocation(sel, 2),), "ok"))

    def test_parent_plan_rejects_ineligible_selection(self):
        view = ParentInput((option("a"),), 1, "anchor")
        from gear.algorithms.contracts import ParentAllocation, Selection
        sel = Selection(option("b"), (("global:a", 1.0),), 0, "sha256:" + "0" * 64)
        with self.assertRaises(ValueError):
            validate_parent_plan(view, ParentPlan((ParentAllocation(sel, 1),), "ok"))

    def test_parent_plan_rejects_invalid_distribution(self):
        view = ParentInput((option("a"), option("b")), 1, "anchor")
        from gear.algorithms.contracts import ParentAllocation, Selection
        sel = Selection(option("a"), (("global:a", 0.5), ("global:b", 0.4)), 0, "sha256:" + "0" * 64)
        with self.assertRaises(ValueError):
            validate_parent_plan(view, ParentPlan((ParentAllocation(sel, 1),), "ok"))

    def test_parent_plan_rejects_invalid_random_provenance(self):
        view = ParentInput((option("a"),), 1, "anchor")
        from gear.algorithms.contracts import ParentAllocation, Selection
        sel = Selection(option("a"), (("global:a", 1.0),), -1, "bad")
        with self.assertRaises(ValueError):
            validate_parent_plan(view, ParentPlan((ParentAllocation(sel, 1),), "ok"))

    def test_valid_parent_plan_passes(self):
        view = ParentInput((option("a"),), 1, "anchor")
        from gear.algorithms.contracts import ParentAllocation, Selection
        sel = Selection(option("a"), (("global:a", 1.0),), 0, "sha256:" + "0" * 64)
        validate_parent_plan(view, ParentPlan((ParentAllocation(sel, 1),), "ok"))

    def test_sampling_plan_requires_reason(self):
        view = SamplingInput((Task("a", "f"),), (), "local")
        with self.assertRaises(ValueError):
            validate_sampling_plan(view, SamplingPlan(("a",), (("a", 1.0),), ""))

    def test_sampling_plan_rejects_duplicate_tasks(self):
        view = SamplingInput((Task("a", "f"),), (), "local")
        with self.assertRaises(ValueError):
            validate_sampling_plan(view, SamplingPlan(("a", "a"), (("a", 0.5), ("a", 0.5)), "ok"))

    def test_sampling_plan_rejects_out_of_scope_tasks(self):
        view = SamplingInput((Task("a", "f"),), (), "local")
        with self.assertRaises(ValueError):
            validate_sampling_plan(view, SamplingPlan(("b",), (("b", 1.0),), "ok"))

    def test_sampling_plan_rejects_weights_not_summing_to_one(self):
        view = SamplingInput((Task("a", "f"), Task("b", "f")), (), "local")
        with self.assertRaises(ValueError):
            validate_sampling_plan(view, SamplingPlan(("a", "b"), (("a", 0.5), ("b", 0.4)), "ok"))

    def test_sampling_plan_rejects_dropping_required_tasks(self):
        view = SamplingInput((Task("a", "f"), Task("b", "f")), (), "local", required=("a",))
        with self.assertRaises(ValueError):
            validate_sampling_plan(view, SamplingPlan(("b",), (("b", 1.0),), "ok"))

    def test_valid_sampling_plan_passes(self):
        view = SamplingInput((Task("a", "f"), Task("b", "f")), (), "local")
        validate_sampling_plan(view, SamplingPlan(("a", "b"), (("a", 0.5), ("b", 0.5)), "ok"))


if __name__ == "__main__":
    unittest.main()