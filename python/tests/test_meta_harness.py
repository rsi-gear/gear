import unittest

from gear.algorithms import MetaHarness
from gear.algorithms.contracts import (
    AlgorithmState,
    Budget,
    Candidate,
    Evidence,
    OperationResult,
    ParentInput,
    ParentOption,
    ProposalInput,
    SamplingInput,
    SearchView,
    Task,
)
from gear.algorithms.gepa.proposal import plan_proposals as gepa_plan_proposals
from gear.algorithms.meta_harness.parents import select_frontier_parent
from gear.algorithms.meta_harness.proposal import HISTORY_GUIDANCE, plan_proposals
from gear.algorithms.meta_harness.ranking import rank_candidates
from gear.algorithms.meta_harness.sampling import sample_all_tasks
from gear.algorithms.meta_harness.stopping import stop_reason
from gear.algorithms.random import DeterministicRandom
from gear.algorithms.random_search.parents import select_parent as random_select_parent
from gear.algorithms.testkit import toy_round
from gear.project import Project
from gear.refine.worker import make_algorithm


class MetaHarnessTests(unittest.TestCase):
    def test_custom_policy_survives_sdk_worker_round_trip(self):
        policies = {
            "parent_policy": random_select_parent,
            "sampler": sample_all_tasks,
            "proposal_planner": gepa_plan_proposals,
            "ranker": rank_candidates,
            "stop_rule": stop_reason,
        }
        algorithm = MetaHarness(**policies)

        configuration = Project._describe_algorithm(algorithm)["algorithm"]
        restored = make_algorithm(configuration)

        self.assertEqual(restored.diagnosis_scope, "global")
        for name, policy in policies.items():
            with self.subTest(policy=name):
                self.assertIs(getattr(restored, name), policy)

    def test_runs_a_complete_seed_comparison(self):
        result = toy_round(MetaHarness())

        self.assertEqual(result["status"], "passed")
        self.assertIn("evaluate_seed:global", result["operations"])
        self.assertNotIn("evaluate_seed:local", result["operations"])
        self.assertNotIn("evaluate_seed:bridge", result["operations"])

    def test_emits_one_general_candidate_even_when_the_seed_frontier_is_solved(self):
        tasks = (Task("task-a", "format"), Task("task-b", "files"))
        candidates = (Candidate("anchor", "anchor-digest"),)
        evidence = tuple(Evidence("anchor", task.id, 0, 1.0, "valid", "global") for task in tasks)
        view = SearchView(
            "solved",
            1,
            "fixed",
            tasks,
            candidates,
            evidence,
            (),
            Budget(20, 1, 2),
            "anchor",
        )
        algorithm = MetaHarness()
        diagnosis = algorithm.step(view, AlgorithmState(data={"phase": "parents", "round": 0}))

        self.assertEqual(diagnosis.operations[0].kind, "diagnose_seed")
        self.assertEqual(diagnosis.operations[0].task_ids, ("task-a", "task-b"))
        self.assertEqual(
            diagnosis.operations[0].payload["base_candidates"],
            [{"candidate_id": "anchor", "score": 1.0}],
        )

        completed_view = SearchView(
            view.run_id,
            view.step_id + 1,
            view.seed,
            view.tasks,
            view.candidates,
            view.evidence,
            (
                OperationResult(
                    "diagnose",
                    "diagnose_seed",
                    "complete",
                    "anchor",
                    {"base_candidate_id": "anchor", "hypotheses": [], "clusters": []},
                ),
            ),
            view.budget,
            view.anchor_id,
        )
        proposal = algorithm.step(completed_view, diagnosis.state)

        self.assertEqual(len(proposal.operations), 1)
        self.assertEqual(proposal.operations[0].kind, "generate_candidate")
        self.assertEqual(proposal.operations[0].parent_id, "anchor")
        self.assertEqual(proposal.operations[0].task_ids, ("task-a", "task-b"))

    def test_diagnosis_scope_includes_successful_and_failed_global_seed_evidence(self):
        tasks = (Task("task-a", "format"), Task("task-b", "files"))
        candidates = (Candidate("anchor", "anchor-digest"),)
        evidence = (
            Evidence("anchor", "task-a", 0, 0.0, "valid", "global"),
            Evidence("anchor", "task-b", 0, 1.0, "valid", "global"),
        )
        view = SearchView(
            "mixed-outcomes",
            1,
            "fixed",
            tasks,
            candidates,
            evidence,
            (),
            Budget(20, 1, 2),
            "anchor",
        )

        diagnosis = MetaHarness().step(
            view, AlgorithmState(data={"phase": "parents", "round": 0})
        )

        self.assertEqual(diagnosis.operations[0].kind, "diagnose_seed")
        self.assertEqual(diagnosis.operations[0].task_ids, ("task-a", "task-b"))

    def test_parent_sampling_includes_seed_frontier_members(self):
        options = (
            ParentOption(
                "parser",
                "global",
                ("task-a", "task-b"),
                0.7,
                task_scores=(("task-a", 1.0), ("task-b", 0.4)),
                weights=(("task-a", 0.5), ("task-b", 0.5)),
                content_digest="a",
            ),
            ParentOption(
                "filesystem",
                "global",
                ("task-a", "task-b"),
                0.6,
                task_scores=(("task-a", 0.4), ("task-b", 1.0)),
                weights=(("task-a", 0.5), ("task-b", 0.5)),
                content_digest="b",
            ),
            ParentOption(
                "dominated",
                "global",
                ("task-a", "task-b"),
                0.2,
                task_scores=(("task-a", 0.2), ("task-b", 0.2)),
                weights=(("task-a", 0.5), ("task-b", 0.5)),
                content_digest="c",
            ),
        )

        plan = select_frontier_parent(
            ParentInput(options, candidate_limit=5, champion_id="parser"),
            DeterministicRandom("fixed"),
        )

        self.assertEqual(len(plan.allocations), 1)
        self.assertIn(plan.allocations[0].selection.option.candidate_id, {"parser", "filesystem"})
        self.assertEqual(plan.allocations[0].count, 1)
        self.assertEqual(
            {
                candidate
                for candidate, probability in plan.allocations[0].selection.probabilities
                if probability
            },
            {"global:parser", "global:filesystem"},
        )

    def test_proposer_can_select_a_complete_historical_base_outside_the_parent_frontier(self):
        tasks = (Task("task", "format"),)
        candidates = (
            Candidate("anchor", "anchor-digest"),
            Candidate("historical", "historical-digest", "anchor"),
        )
        evidence = (
            Evidence("anchor", "task", 0, 0.4, "valid", "global"),
            Evidence("historical", "task", 0, 0.8, "valid", "global"),
        )
        view = SearchView(
            "run",
            1,
            "seed",
            tasks,
            candidates,
            evidence,
            (),
            Budget(20, 1, 2),
            "anchor",
        )
        algorithm = MetaHarness()
        diagnosis = algorithm.step(view, AlgorithmState(data={"phase": "parents", "round": 1}))
        diagnose_operation = diagnosis.operations[0]

        self.assertEqual(diagnose_operation.kind, "diagnose_seed")
        self.assertEqual(
            {item["candidate_id"] for item in diagnose_operation.payload["base_candidates"]},
            {"anchor", "historical"},
        )
        self.assertEqual(diagnose_operation.candidate_id, "historical")

        completed_view = SearchView(
            view.run_id,
            view.step_id + 1,
            view.seed,
            view.tasks,
            view.candidates,
            view.evidence,
            (
                OperationResult(
                    "diagnose",
                    "diagnose_seed",
                    "complete",
                    "historical",
                    {"base_candidate_id": "anchor", "hypotheses": ["repair format"]},
                ),
            ),
            view.budget,
            view.anchor_id,
        )
        proposal = algorithm.step(completed_view, diagnosis.state)

        self.assertEqual(proposal.operations[0].kind, "generate_candidate")
        self.assertEqual(proposal.operations[0].parent_id, "anchor")
        self.assertEqual(
            proposal.research[0].data["selected_base_candidate"],
            "anchor",
        )

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

        self.assertEqual(len(plan.hypotheses), 1)
        self.assertIn("First edit", plan.hypotheses[0])
        self.assertIn("Second edit", plan.hypotheses[0])
        self.assertEqual(plan.task_ids, ("task",))
        self.assertEqual(plan.reason, HISTORY_GUIDANCE)
        self.assertIn("execution traces", plan.reason)

    def test_proposal_considers_every_diagnosis_cluster_for_one_candidate(self):
        failures = (
            Evidence("best", "task-a", 0, 0.0, "valid", "global"),
            Evidence("best", "task-b", 0, 0.0, "valid", "global"),
        )
        plan = plan_proposals(
            ProposalInput(
                ParentOption("best", "global", ("task-a", "task-b"), 0.0),
                failures,
                {
                    "clusters": [
                        {"task_ids": ["task-a"], "hypotheses": ["Repair parser recovery"]},
                        {"task_ids": ["task-b"], "hypotheses": ["Preserve generated files"]},
                    ]
                },
                1,
                (Task("task-a", "parser"), Task("task-b", "filesystem")),
            )
        )

        self.assertEqual(len(plan.hypotheses), 1)
        self.assertIn("Repair parser recovery", plan.hypotheses[0])
        self.assertIn("Preserve generated files", plan.hypotheses[0])
        self.assertNotIn("Tasks [", plan.hypotheses[0])
        self.assertEqual(plan.task_ids, ("task-a", "task-b"))
        self.assertIn("do not add task-specific hints", plan.reason)

    def test_proposal_preserves_all_unclustered_hypotheses_for_worker_choice(self):
        plan = plan_proposals(
            ProposalInput(
                ParentOption("parent", "global", ("task",), 0.0),
                (Evidence("parent", "task", 0, 0.0, "valid", "global"),),
                {"hypotheses": ["Repair parser recovery", "Preserve generated files"]},
                1,
                (Task("task", "format"),),
            )
        )

        self.assertIn("Repair parser recovery", plan.hypotheses[0])
        self.assertIn("Preserve generated files", plan.hypotheses[0])
        self.assertEqual(plan.task_ids, ("task",))


if __name__ == "__main__":
    unittest.main()
