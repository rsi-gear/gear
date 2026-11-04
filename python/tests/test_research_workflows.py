"""Public workflow mechanisms with deterministic operation/observation fixtures."""

import sys
import unittest
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "examples/algorithms"))
from research_workflows import ACEExample, DarwinXExample, RRSIMechanismExample

from gear.algorithms import (
    AlgorithmState,
    Budget,
    Candidate,
    Evidence,
    OperationResult,
    ResearchTrial,
    SearchView,
    Task,
)
from gear.canonical import digest


def exercise(
    algorithm, *, known_usage=True, regression_at=None, guard_failure=False, wrong_quote=False
):
    view = SearchView(
        "run",
        0,
        "seed",
        (Task("a", "train"), Task("b", "dev")),
        (Candidate("anchor", digest("anchor")),),
        (),
        (),
        Budget(100, 8, 2),
        "anchor",
        research_data={
            "train": ["a", "b"] if regression_at else ["a"],
            "dev": [] if regression_at else ["b"],
            "allowDerivedInputs": True,
            "tasks": [
                {"id": "a", "instruction": "Original question"},
                {"id": "b", "instruction": "Selection question"},
            ],
        },
    )
    state, calls, revisions = AlgorithmState(), [], {}
    critics = 0
    for _ in range(100):
        decision = algorithm.step(view, state)
        state = decision.state
        for operation in decision.operations:
            calls.append(operation)
            if operation.kind in ("stop", "nominate"):
                return operation, calls
            data, candidate = None, None
            if operation.kind == "generate_candidate":
                data = {"declined": False, "data": "design"}
                candidate = Candidate(
                    operation.candidate_id, digest(operation.candidate_id), operation.parent_id
                )
            elif operation.kind == "diagnose_seed":
                if operation.rationale == "digester":
                    value = {"quote": "fabricated" if wrong_quote else "reported observation"}
                elif operation.rationale == "critic":
                    critics += 1
                    value = {"accept": critics > 1}
                else:
                    value = "Use the reflection"
                data = {"declined": False, "data": value}
            elif operation.kind == "workspace_open":
                command = operation.payload["gear_workspace_v1"]
                ref = {
                    "id": command["output_id"],
                    "digest": digest(command["output_id"]),
                    "root_id": command["output_id"],
                    "parent_id": None,
                    "base_candidate_id": operation.parent_id,
                    "base_digest": view.candidates[0].digest,
                }
                revisions[ref["id"]] = ref
                data = {"workspace": ref}
            elif operation.kind == "workspace_edit":
                command = operation.payload["gear_workspace_v1"]
                ref = {
                    **command["source"],
                    "id": command["output_id"],
                    "parent_id": command["source"]["id"],
                    "digest": digest(command["output_id"]),
                }
                revisions[ref["id"]] = ref
                data = {"workspace": ref, "declined": False, "data": "repaired"}
            elif operation.kind == "artifact_trial_read":
                data = {"events": [{"seq": 0, "data": {"text": "reported observation"}}]}
            elif operation.kind == "artifact_diff":
                data = {
                    "changed_paths": ["AGENTS.md"],
                    "changes": [{"path": "AGENTS.md", "before": "old", "after": "new"}],
                }
            elif operation.kind == "workspace_seal":
                candidate = Candidate(
                    operation.candidate_id, digest(operation.candidate_id), operation.parent_id
                )
            elif operation.kind == "evaluate_seed":
                plan = operation.payload["gear_trials_v1"]
                trials = list(view.research_trials)
                for item in plan["instances"]:
                    for repetition in range(plan["repetitions"]):
                        trial_id = digest(
                            [operation.candidate_id, plan["group"], item["id"], repetition]
                        )
                        if any(trial.id == trial_id for trial in trials):
                            continue
                        if isinstance(algorithm, ACEExample):
                            value = 1 if item.get("question") else 0
                        elif isinstance(algorithm, DarwinXExample):
                            value = 0.5 if operation.candidate_id != view.candidates[-1].id else 1
                            if regression_at:
                                value = 0.6 if item["task_id"] == "b" else 0.0
                                if operation.candidate_id == view.candidates[-1].id:
                                    value = (
                                        0.5
                                        if item["task_id"] == "b"
                                        and plan["group"].startswith(regression_at)
                                        else 1
                                    )
                        else:
                            value = 0.5
                        evidence = Evidence(
                            operation.candidate_id,
                            item["task_id"],
                            repetition,
                            value,
                            "valid",
                            "global",
                            raw_metrics={
                                "quality": {
                                    "status": "available",
                                    "value": 0.1
                                    if guard_failure and operation.candidate_id != "anchor"
                                    else 0.9,
                                }
                            },
                        )
                        usage = (
                            {
                                "complete": True,
                                "total_tokens": 20 if operation.candidate_id == "anchor" else 10,
                            }
                            if known_usage
                            else None
                        )
                        trials.append(
                            ResearchTrial(
                                trial_id,
                                f"operation-{view.step_id}",
                                plan["group"],
                                item["id"],
                                item["task_id"],
                                repetition,
                                operation.candidate_id,
                                digest([item["task_id"], item.get("question")]),
                                evidence,
                                "output",
                                usage,
                                "finished",
                            )
                        )
                view = replace(view, research_trials=tuple(trials))
            else:
                raise AssertionError(operation.kind)
            result = OperationResult(
                f"operation-{view.step_id}",
                operation.kind,
                "complete",
                operation.candidate_id,
                data,
            )
            view = replace(
                view,
                completed=view.completed + (result,),
                candidates=view.candidates + ((candidate,) if candidate else ()),
            )
        view = replace(view, step_id=view.step_id + 1)
    raise AssertionError("workflow did not finish")


class ResearchWorkflowExamplesTests(unittest.TestCase):
    def test_ace_retries_changed_input_but_scores_only_first_attempt(self):
        final, calls = exercise(ACEExample(max_steps=1))
        result = final.payload["gear_result_v1"]["data"]
        self.assertEqual(result["online_score"], 0)
        plans = [op.payload["gear_trials_v1"] for op in calls if op.kind == "evaluate_seed"]
        self.assertNotIn("question", plans[0]["instances"][0])
        self.assertIn("Use the reflection", plans[1]["instances"][0]["question"])
        self.assertEqual(plans[0]["instances"][0]["task_id"], plans[1]["instances"][0]["task_id"])

    def test_darwinx_reads_donor_ancestor_and_remeasures_every_comparison(self):
        final, calls = exercise(DarwinXExample())
        merge = next(op for op in calls if op.rationale == "recombiner")
        references = merge.payload["gear_candidate_references_v1"]
        self.assertEqual(set(references), {"donor", "ancestor"})
        self.assertEqual(references["ancestor"]["candidate_id"], "anchor")
        measurements = [op.payload["gear_trials_v1"] for op in calls if op.kind == "evaluate_seed"]
        self.assertEqual(len(measurements), 6)
        self.assertEqual(len({row["group"] for row in measurements}), 6)
        self.assertEqual([row["repetitions"] for row in measurements], [1, 1, 1, 2, 2, 2])
        self.assertIn("confirmation", final.payload["gear_result_v1"]["data"]["comparisons"])

    def test_darwinx_rejects_complementary_parent_regression_despite_higher_average(self):
        for phase in ("screen", "confirmation"):
            final, calls = exercise(DarwinXExample(), regression_at=phase)
            merged = next(op.candidate_id for op in calls if op.rationale == "recombiner")
            self.assertNotEqual(final.payload["gear_result_v1"]["selected"], merged)

    def test_rrsi_repairs_same_draft_then_uses_target_cost_for_selection(self):
        final, calls = exercise(RRSIMechanismExample())
        edits = [op.payload["gear_workspace_v1"] for op in calls if op.kind == "workspace_edit"]
        self.assertEqual(len(edits), 2)
        self.assertEqual(edits[1]["source"]["id"], edits[0]["output_id"])
        self.assertEqual(edits[0]["source"]["root_id"], edits[1]["source"]["root_id"])
        self.assertEqual(sum(op.kind == "workspace_seal" for op in calls), 1)
        data = final.payload["gear_result_v1"]["data"]
        self.assertTrue(data["accepted"])
        self.assertEqual(data["trace_quote"], "reported observation")
        groups = [
            op.payload["gear_trials_v1"]["group"] for op in calls if op.kind == "evaluate_seed"
        ]
        self.assertEqual(groups[:2], ["calibration/0", "calibration/1"])
        self.assertEqual(len(groups), len(set(groups)))
        rejected, _ = exercise(RRSIMechanismExample(), guard_failure=True)
        self.assertEqual(rejected.payload["gear_result_v1"]["selected"], "anchor")
        forged, _ = exercise(RRSIMechanismExample(), wrong_quote=True)
        self.assertEqual(forged.payload["gear_result_v1"]["data"]["measurement"], "invalid")
        missing, _ = exercise(RRSIMechanismExample(), known_usage=False)
        self.assertEqual(missing.payload["gear_result_v1"]["data"]["measurement"], "invalid")
        self.assertEqual(missing.payload["gear_result_v1"]["selected"], "anchor")
