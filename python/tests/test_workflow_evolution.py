"""Tests for reusable workflow synthesis, anti-bloat validation, and Pareto ranking."""

import json
import os
import subprocess
import unittest

from gear.algorithms import (
    GEPA,
    AlgorithmState,
    Budget,
    Candidate,
    Evidence,
    OperationResult,
    ParentOption,
    ProposalInput,
    RankingInput,
    SearchView,
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
        self.assertIn('[safe-cli] Trigger: "Sending nested JSON via terminal CLI"', formatted)
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
        bloated_patch = "\n".join(
            [f"+ This is an excessively long inlined procedure line number {i}" for i in range(25)]
        )
        diff_bloated = {"harness/plugins/policy.js": bloated_patch}
        valid, reason = validate_anti_bloat_candidate(diff_bloated, max_prompt_delta_bytes=400)
        self.assertFalse(valid)
        self.assertIn("Prompt bloat rejected", reason or "")

        # 2. Accept candidate that modularizes into workflows/ and keeps policy.js lean
        lean_policy_patch = (
            "+ ctx.systemPrompt.section({ name: 'catalog', text: 'Load via workflow_read' })"
        )
        workflow_patch = "\n".join(
            [f"+ Detailed multi-step standard operating procedure line {i}" for i in range(50)]
        )
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

    def test_anti_bloat_candidate_rejected_in_execution_before_evaluation(self):
        tasks = (Task("t1", "repo"),)
        bloated_patch = "\n".join([f"+ Bloated procedure line {i}" for i in range(50)])
        bloated_result = OperationResult(
            operation_id="op_1",
            kind="generate_candidate",
            status="complete",
            candidate_id="cand_bloated",
            candidate_change={"harness/plugins/policy.js": bloated_patch},
        )
        view = SearchView(
            run_id="run_1",
            step_id=1,
            seed="seed",
            tasks=tasks,
            candidates=(Candidate("anchor", "digest_0"), Candidate("cand_bloated", "digest_1")),
            evidence=(),
            completed=(bloated_result,),
            budget=Budget(10, 10, 1),
            anchor_id="anchor",
        )
        state = AlgorithmState(
            data={
                "phase": "generated",
                "planned": ["cand_bloated"],
                "batches": [
                    {
                        "parent": "anchor",
                        "scope": "local",
                        "tasks": ["t1"],
                        "count": 1,
                        "selection": {
                            "option": {
                                "candidate_id": "anchor",
                                "scope": "local",
                                "task_ids": ["t1"],
                                "score": 0.0,
                                "probability": 1.0,
                                "task_scores": [["t1", 0.0]],
                                "weights": [["t1", 1.0]],
                                "content_digest": "digest_0",
                            },
                            "seed": 0,
                        },
                    }
                ],
                "batch_index": 0,
                "round": 0,
                "parent": "anchor",
                "failures": ["t1"],
                "limit": 1,
            }
        )
        gepa = GEPA(candidate_validator=validate_anti_bloat_candidate)
        decision = gepa.step(view, state)
        # Oversized candidate must NOT proceed to evaluate_seed
        self.assertNotIn("evaluate_seed", [op.kind for op in decision.operations])
        # It must advance to next batch with rejection reason
        self.assertIn("Prompt bloat rejected", decision.state.data.get("last_batch_reason", ""))

    def test_workflow_catalog_dynamic_discovery_in_policy_js(self):
        catalog_path = os.path.abspath("examples/evolution-search/harness/workflows/catalog.json")
        temp_workflow = os.path.abspath(
            "examples/evolution-search/harness/workflows/temp-test-flow.md"
        )
        with open(catalog_path, "r", encoding="utf-8") as f:
            orig_catalog = f.read()

        try:
            with open(temp_workflow, "w", encoding="utf-8") as f:
                f.write("Dummy procedure text for dynamic discovery test")
            cat = json.loads(orig_catalog)
            cat.append(
                {
                    "id": "temp-test-flow",
                    "trigger": "Dynamic test trigger condition",
                    "path": "workflows/temp-test-flow.md",
                    "summary": "Dynamically discovered test summary",
                }
            )
            with open(catalog_path, "w", encoding="utf-8") as f:
                json.dump(cat, f, indent=2)

            script = """
import { apply } from './examples/evolution-search/harness/plugins/policy.js';
const sections = [];
await apply({ systemPrompt: { section: s => sections.push(s) } });
const catSection = sections.find(s => s.name === 'harness:workflow-catalog');
if (!catSection || !catSection.text.includes('[temp-test-flow]')) {
  throw new Error('Catalog did not discover temp-test-flow');
}
"""
            proc = subprocess.run(
                ["node", "--input-type=module", "-e", script],
                capture_output=True,
                text=True,
                cwd=os.path.abspath("."),
            )
            self.assertEqual(proc.returncode, 0, f"Node output: {proc.stdout} {proc.stderr}")
        finally:
            with open(catalog_path, "w", encoding="utf-8") as f:
                f.write(orig_catalog)
            if os.path.exists(temp_workflow):
                os.remove(temp_workflow)

    def test_pareto_ranking_propagation_through_gepa_loop(self):
        tasks = (Task("t1", "repo"), Task("t2", "repo"))
        bloated_patch = "\n".join([f"+ Bloated procedure line {i}" for i in range(30)])
        bloated_result = OperationResult(
            operation_id="op_1",
            kind="generate_candidate",
            status="complete",
            candidate_id="cand_bloated",
            candidate_change={"harness/plugins/policy.js": bloated_patch},
        )
        clean_result = OperationResult(
            operation_id="op_2",
            kind="generate_candidate",
            status="complete",
            candidate_id="cand_clean",
            candidate_change={"harness/workflows/clean.md": bloated_patch},
        )
        evidence = (
            Evidence("cand_bloated", "t1", 0, 1.0, "valid", "local"),
            Evidence("cand_bloated", "t2", 0, 1.0, "valid", "local"),
            Evidence("cand_clean", "t1", 0, 1.0, "valid", "local"),
            Evidence("cand_clean", "t2", 0, 1.0, "valid", "local"),
            Evidence("anchor", "t1", 0, 0.0, "valid", "local"),
            Evidence("anchor", "t2", 0, 0.0, "valid", "local"),
        )
        view = SearchView(
            run_id="run_1",
            step_id=2,
            seed="seed",
            tasks=tasks,
            candidates=(
                Candidate("anchor", "d0"),
                Candidate("cand_bloated", "d1"),
                Candidate("cand_clean", "d2"),
            ),
            evidence=evidence,
            completed=(bloated_result, clean_result),
            budget=Budget(10, 10, 1),
            anchor_id="anchor",
        )
        state = AlgorithmState(
            data={
                "phase": "rank",
                "participants": ["cand_bloated", "cand_clean"],
                "scope_tasks": ["t1", "t2"],
                "scope_weights": {"t1": 0.5, "t2": 0.5},
                "scope_id": "local",
                "stage_index": 0,
                "round": 0,
                "batch_index": 0,
                "parent": "anchor",
                "failures": ["t1", "t2"],
                "batches": [
                    {
                        "parent": "anchor",
                        "scope": "local",
                        "tasks": ["t1", "t2"],
                        "count": 1,
                        "selection": {
                            "option": {
                                "candidate_id": "anchor",
                                "scope": "local",
                                "task_ids": ["t1", "t2"],
                                "score": 0.0,
                                "probability": 1.0,
                                "task_scores": [["t1", 0.0], ["t2", 0.0]],
                                "weights": [["t1", 0.5], ["t2", 0.5]],
                                "content_digest": "d0",
                            },
                            "seed": 0,
                        },
                    }
                ],
            }
        )
        gepa = GEPA(ranker=rank_candidates_pareto)
        decision = gepa.step(view, state)
        ranking_record = next(r for r in decision.research if r.kind == "ranking")
        ranked_ids = ranking_record.data["ranking"]["candidate_ids"]
        self.assertEqual(ranked_ids[0], "cand_clean")
        self.assertEqual(ranked_ids[1], "cand_bloated")

    def test_single_task_fallback_prevents_unsupported_workflow_proposals(self):
        tasks = (Task("single_task", "isolated_family"),)
        failures = (Evidence("candidate_0", "single_task", 0, 0.0, "valid", "local"),)
        parent = ParentOption("candidate_0", "local", ("single_task",), 0.0)
        view = ProposalInput(
            parent=parent,
            tasks=tasks,
            failures=failures,
            candidate_limit=2,
            diagnosis={
                "hypotheses": [
                    "Synthesize workflow for single_task in workflows/isolated.md with trigger"
                ]
            },
        )
        plan = plan_workflow_proposals(view, min_cluster_size=2)
        self.assertEqual(plan.reason, "failure-family proposals (non-workflow fallback)")
        self.assertEqual(len(plan.hypotheses), 1)
        self.assertNotIn("workflow", plan.hypotheses[0].lower())
        self.assertEqual(
            plan.hypotheses[0],
            "Correct the observed seed failures while preserving successful behavior.",
        )


if __name__ == "__main__":
    unittest.main()
