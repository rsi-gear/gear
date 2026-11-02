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
from gear.algorithms.meta_harness.proposal import (
    HISTORY_GUIDANCE,
    diagnosis_meta,
    parse_diagnosis,
    plan_proposals,
)
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

        self.assertEqual(restored.stages, ("global",))
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
        payload = diagnosis.operations[0].payload
        self.assertEqual(payload["base_candidates"][0]["candidate_id"], "anchor")
        self.assertEqual(
            payload["meta"]["schema"]["properties"]["base_candidate_id"]["enum"],
            ["anchor"],
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
                    {
                        "declined": False,
                        "data": {
                            "summary": "one general change",
                            "base_candidate_id": "anchor",
                            "hypothesis": "improve output recovery",
                        },
                    },
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
        self.assertIn("improve output recovery", proposal.operations[0].payload["hypothesis"])
        self.assertIn("improve output recovery", proposal.operations[0].payload["meta"]["prompt"])

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
        tasks = (Task("format-task", "format"), Task("files-task", "files"))
        candidates = (
            Candidate("anchor", "anchor-digest"),
            Candidate("historical", "historical-digest", "anchor"),
            Candidate("frontier", "frontier-digest", "historical"),
        )
        evidence = (
            Evidence("anchor", "format-task", 0, 0.4, "valid", "global"),
            Evidence("anchor", "files-task", 0, 0.4, "valid", "global"),
            Evidence("historical", "format-task", 0, 0.2, "valid", "global"),
            Evidence("historical", "files-task", 0, 0.2, "valid", "global"),
            Evidence("frontier", "format-task", 0, 0.9, "valid", "global"),
            Evidence("frontier", "files-task", 0, 0.9, "valid", "global"),
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
            {"anchor", "historical", "frontier"},
        )
        self.assertEqual(diagnose_operation.candidate_id, "frontier")

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
                    "frontier",
                    {
                        "declined": False,
                        "data": {
                            "summary": "reuse a prior parser fix",
                            "base_candidate_id": "historical",
                            "hypothesis": "repair format recovery",
                        },
                    },
                ),
            ),
            view.budget,
            view.anchor_id,
        )
        proposal = algorithm.step(completed_view, diagnosis.state)

        self.assertEqual(proposal.operations[0].kind, "generate_candidate")
        self.assertEqual(proposal.operations[0].parent_id, "historical")
        self.assertEqual(
            proposal.research[0].data["selected_base_candidate"],
            "historical",
        )

    def test_sampler_keeps_every_seed_task_with_uniform_weight(self):
        tasks = (Task("b", "two"), Task("a", "one"))

        plan = sample_all_tasks(
            SamplingInput(tasks, (), "global"),
            DeterministicRandom("fixed"),
        )

        self.assertEqual(plan.task_ids, ("a", "b"))
        self.assertEqual(plan.weights, (("a", 0.5), ("b", 0.5)))

    def test_proposal_uses_the_model_selected_hypothesis_without_gepa_clustering(self):
        failure = Evidence("best", "task", 0, 0.0, "valid", "global")
        plan = plan_proposals(
            ProposalInput(
                ParentOption("best", "global", ("task",), 0.0),
                (failure,),
                {
                    "summary": "Reuse a robust parser from history",
                    "base_candidate_id": "older",
                    "hypothesis": "Preserve parser output recovery",
                },
                4,
                (Task("task", "family"),),
            )
        )

        self.assertEqual(len(plan.hypotheses), 1)
        self.assertIn("Preserve parser output recovery", plan.hypotheses[0])
        self.assertEqual(plan.task_ids, ("task",))
        self.assertEqual(plan.reason, HISTORY_GUIDANCE)
        self.assertIn("successful and failed trajectories", plan.reason)

    def test_diagnosis_meta_schema_offers_all_eligible_bases_and_no_fixed_parent(self):
        meta = diagnosis_meta(
            [
                {"candidate_id": "anchor", "score": 0.8},
                {"candidate_id": "older-rejected", "score": 0.2},
            ]
        )
        schema = meta["schema"]

        self.assertEqual(
            schema["properties"]["base_candidate_id"]["enum"],
            ["anchor", "older-rejected"],
        )
        self.assertIn("not restrict the search to a failure family", meta["prompt"])

    def test_meta_result_rejects_unoffered_base_even_if_schema_was_ignored(self):
        with self.assertRaisesRegex(ValueError, "ineligible base"):
            parse_diagnosis(
                {
                    "declined": False,
                    "data": {
                        "summary": "a change",
                        "base_candidate_id": "held-out-candidate",
                        "hypothesis": "reuse an approach",
                    },
                },
                ("anchor", "older-rejected"),
            )


if __name__ == "__main__":
    unittest.main()
