import unittest

from gear.algorithms import MetaHarness
from gear.algorithms.contracts import (
    Evidence,
    ParentInput,
    ParentOption,
    ProposalInput,
    SamplingInput,
    Task,
)
from gear.algorithms.meta_harness.parents import select_best_parent
from gear.algorithms.meta_harness.proposal import HISTORY_GUIDANCE, plan_proposals
from gear.algorithms.meta_harness.sampling import sample_all_tasks
from gear.algorithms.random import DeterministicRandom
from gear.algorithms.testkit import toy_round


class MetaHarnessTests(unittest.TestCase):
    def test_runs_a_complete_seed_comparison(self):
        result = toy_round(MetaHarness())

        self.assertEqual(result["status"], "passed")
        self.assertIn("evaluate_seed:global", result["operations"])
        self.assertNotIn("evaluate_seed:local", result["operations"])
        self.assertNotIn("evaluate_seed:bridge", result["operations"])

    def test_parent_is_highest_scoring_complete_candidate(self):
        options = (
            ParentOption("older", "global", ("task",), 0.4, content_digest="a"),
            ParentOption("best", "global", ("task",), 0.8, content_digest="b"),
        )

        plan = select_best_parent(
            ParentInput(options, candidate_limit=5, champion_id="older"),
            DeterministicRandom("fixed"),
        )

        self.assertEqual(len(plan.allocations), 1)
        self.assertEqual(plan.allocations[0].selection.option.candidate_id, "best")
        self.assertEqual(plan.allocations[0].count, 1)

    def test_sampler_keeps_every_seed_task_with_uniform_weight(self):
        tasks = (Task("b", "two"), Task("a", "one"))

        plan = sample_all_tasks(
            SamplingInput(tasks, (), "global"),
            DeterministicRandom("fixed"),
        )

        self.assertEqual(plan.task_ids, ("a", "b"))
        self.assertEqual(plan.weights, (("a", 0.5), ("b", 0.5)))

    def test_proposal_is_single_and_requests_archive_grounding(self):
        failure = Evidence("best", "task", 0, 0.0, "valid", "global")
        plan = plan_proposals(
            ProposalInput(
                ParentOption("best", "global", ("task",), 0.0),
                (failure,),
                {"hypotheses": ["First edit", "Second edit"]},
                4,
                (Task("task", "family"),),
            )
        )

        self.assertEqual(plan.hypotheses, ("First edit",))
        self.assertEqual(plan.task_ids, ("task",))
        self.assertEqual(plan.reason, HISTORY_GUIDANCE)
        self.assertIn("execution traces", plan.reason)


if __name__ == "__main__":
    unittest.main()
