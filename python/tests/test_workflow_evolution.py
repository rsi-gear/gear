"""Tests for reusable workflow synthesis, anti-bloat validation, and Pareto ranking."""

import unittest
from gear.algorithms import (
    GEPA,
    Evidence,
    ParentOption,
    ProposalInput,
    RankingInput,
    Task,
    WorkflowCatalog,
    WorkflowEntry,
    plan_workflow_proposals,
    rank_candidates_pareto,
    validate_anti_bloat_candidate,
)
from gear.algorithms.testkit import toy_round


class WorkflowEvolutionTests(unittest.TestCase):
    def test_workflow_catalog_parsing_and_formatting(self):
        catalog_json = """[
            {
                "id": "safe-cli",
                "trigger": "Sending nested JSON via terminal CLI",
                "path": "workflows/safe-cli.md",
                "helper": "workflows/safe-cli/request.py",
                "summary": "Serializes JSON safely to prevent bash quoting corruption."
            },
            {
                "id": "db-ops",
                "trigger": "Executing SQL or CRM database updates",
                "path": "workflows/db-ops.md",
                "summary": "Resolves destination contracts prior to mutation."
            }
        ]"""
        catalog = WorkflowCatalog.parse_json(catalog_json)
        self.assertEqual(len(catalog.entries), 2)
        self.assertEqual(catalog.entries[0].id, "safe-cli")
        self.assertEqual(catalog.entries[0].helper, "workflows/safe-cli/request.py")

        formatted = catalog.format_prompt_section()
        self.assertIn("Available on-demand procedures", formatted)
        self.assertIn("[safe-cli] Trigger: \"Sending nested JSON via terminal CLI\"", formatted)
        self.assertIn("[db-ops]", formatted)
        # Verify compact token footprint (less than 100 words)
        self.assertLess(len(formatted.split()), 100)

    def test_workflow_catalog_rejects_malformed_entries(self):
        with self.assertRaises(ValueError):
            WorkflowCatalog.parse_json('{"not": "a list"}')

        with self.assertRaises(ValueError):
            WorkflowEntry.from_dict({"id": "", "trigger": "test", "path": "p", "summary": "s"})

        with self.assertRaises(ValueError):
            WorkflowEntry.from_dict({"id": "valid", "trigger": "", "path": "p", "summary": "s"})

    def test_anti_bloat_candidate_validation(self):
        # 1. Reject candidate that bloats policy.js with 1200 bytes of raw inlined text
        bloated_patch = "\n".join([f"+ This is an excessively long inlined procedure line number {i}" for i in range(25)])
        diff_bloated = {"harness/plugins/policy.js": bloated_patch}
        valid, reason = validate_anti_bloat_candidate(diff_bloated, max_prompt_delta_bytes=400)
        self.assertFalse(valid)
        self.assertIn("Prompt bloat rejected", reason or "")

        # 2. Accept candidate that modularizes into workflows/ and keeps policy.js lean
        lean_policy_patch = "+ ctx.systemPrompt.section({ name: 'catalog', text: 'Load via workflow_read' })"
        workflow_patch = "\n".join([f"+ Detailed multi-step standard operating procedure line {i}" for i in range(50)])
        diff_clean = {
            "harness/plugins/policy.js": lean_policy_patch,
            "harness/workflows/new-sop.md": workflow_patch,
        }
        valid, reason = validate_anti_bloat_candidate(diff_clean, max_prompt_delta_bytes=400)
        self.assertTrue(valid)
        self.assertIsNone(reason)

    def test_multi_task_failure_clustering_proposals(self):
        tasks = (
            Task("task_1", "marketing_cli"),
            Task("task_2", "marketing_cli"),
            Task("task_3", "marketing_cli"),
            Task("task_4", "isolated_task"),
        )
        failures = (
            Evidence("candidate_0", "task_1", 0, 0.0, "valid", "local"),
            Evidence("candidate_0", "task_2", 0, 0.0, "valid", "local"),
            Evidence("candidate_0", "task_4", 0, 0.0, "valid", "local"),
        )
        parent = ParentOption("candidate_0", "local", ("task_1", "task_2", "task_4"), 0.0)
        view = ProposalInput(
            parent=parent,
            tasks=tasks,
            failures=failures,
            candidate_limit=2,
            diagnosis={"hypotheses": []},
        )

        plan = plan_workflow_proposals(view, min_cluster_size=2)
        self.assertEqual(plan.reason, "reusable-workflow-synthesis")
        self.assertGreaterEqual(len(plan.hypotheses), 1)
        # Should identify the cluster of failures in 'marketing_cli'
        self.assertIn("marketing_cli", plan.hypotheses[0])
        self.assertIn("workflows/<id>.md", plan.hypotheses[0])
        self.assertIn("task_1", plan.task_ids)
        self.assertIn("task_2", plan.task_ids)

    def test_pareto_ranking_penalizes_prompt_bloat_on_equal_accuracy(self):
        cells = (
            Evidence("cand_bloated", "task_1", 0, 1.0, "valid", "all"),
            Evidence("cand_bloated", "task_2", 0, 0.5, "valid", "all"),
            Evidence("cand_clean", "task_1", 0, 1.0, "valid", "all"),
            Evidence("cand_clean", "task_2", 0, 0.5, "valid", "all"),
        )
        # Both candidates have identical task accuracy (mean 0.75)
        view = RankingInput(
            candidate_ids=("cand_bloated", "cand_clean"),
            task_ids=("task_1", "task_2"),
            evidence=cells,
            repetitions=1,
        )

        # cand_bloated added 2000 bytes to prompt; cand_clean added 0 bytes
        penalties = {"cand_bloated": 5.0, "cand_clean": 0.0}
        plan = rank_candidates_pareto(view, complexity_penalties=penalties, complexity_weight=0.05)

        # cand_clean must be ranked FIRST due to zero complexity penalty
        self.assertEqual(plan.candidate_ids, ("cand_clean", "cand_bloated"))

    def test_gepa_runs_with_workflow_proposals_and_pareto_ranking(self):
        custom_gepa = GEPA(
            proposal_planner=plan_workflow_proposals,
            ranker=rank_candidates_pareto,
        )
        result = toy_round(custom_gepa)
        self.assertEqual(result["status"], "passed")
        self.assertIsNotNone(result["nominee"])
        self.assertIn("evaluate_seed:local", result["operations"])


if __name__ == "__main__":
    unittest.main()
