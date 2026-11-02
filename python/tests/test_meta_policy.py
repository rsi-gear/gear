import json
import sys
import unittest
from dataclasses import asdict, replace
from pathlib import Path
from unittest.mock import patch

from gear import Project
from gear.algorithms import (
    GEPA,
    AlgorithmState,
    Budget,
    Candidate,
    Evidence,
    MetaTask,
    Operation,
    OperationResult,
    RandomSearch,
    SearchView,
    Task,
    default_meta,
)
from gear.algorithms.meta import parse_meta_result, prepare_meta
from gear.algorithms.meta_schema import result_schema, validate_result
from gear.canonical import digest
from gear.refine.worker import make_algorithm


def meta_input(operation):
    return {
        "operation": asdict(operation),
        "tasks": [{"id": "seed", "instruction": "Answer correctly", "family": "format"}],
        "evidence": [],
        "harness": {},
        "mutationPolicy": {},
        "experience": None,
    }


class MetaPolicyTests(unittest.TestCase):
    def test_large_task_scope_is_not_limited_by_result_array_capacity(self):
        operation = Operation("diagnose_seed", task_ids=tuple(f"task-{i}" for i in range(1000)))
        bound = default_meta(operation).bind(operation)
        result = {
            "summary": "failure",
            "declined": False,
            "hypotheses": [],
            "clusters": [{"task_ids": ["task-999"], "hypotheses": []}],
        }
        self.assertEqual(parse_meta_result({"operation": asdict(bound), "result": result}), result)

    def test_long_unicode_instructions_keep_the_guard_prompt_bounded(self):
        schema = {"type": "object", "properties": {}, "required": [], "additionalProperties": False}
        operation = MetaTask("诊断原因。" * 2000, schema).bind(Operation("diagnose_seed"))
        prepared = prepare_meta(meta_input(operation))
        self.assertGreater(len(prepared["instructions"].encode()), 4096)
        self.assertLess(len(prepared["prompt"].encode()), 4096)
        self.assertIn("meta-instructions.md", prepared["prompt"])
        with self.assertRaises(ValueError):
            MetaTask("诊" * 22000, schema).bind(Operation("diagnose_seed"))

    def test_default_request_and_response_preserve_existing_behavior(self):
        for kind in ("diagnose_seed", "generate_candidate"):
            with self.subTest(kind=kind):
                operation = Operation(kind, task_ids=("seed",), payload={"hypothesis": "fix"})
                prepared = prepare_meta(meta_input(operation))
                bound = default_meta(operation).bind(operation)
                self.assertEqual(prepared["schema"], prepare_meta(meta_input(bound))["schema"])
                self.assertEqual(bound.payload["hypothesis"], "fix")
                self.assertEqual(
                    set(prepared["schema"]["required"]),
                    {"summary", "declined", "hypotheses", "clusters"},
                )
                result = {
                    "summary": "evidence",
                    "declined": False,
                    "hypotheses": ["fix"],
                    "clusters": [{"task_ids": ["seed"], "hypotheses": ["fix"]}],
                }
                self.assertEqual(
                    parse_meta_result({"operation": asdict(bound), "result": result}), result
                )
                result["clusters"][0]["task_ids"] = ["held-out"]
                with self.assertRaises(ValueError):
                    parse_meta_result({"operation": asdict(bound), "result": result})

    def test_task_binding_is_a_detached_json_snapshot(self):
        schema = {"type": "object", "properties": {}, "required": [], "additionalProperties": False}
        operation = Operation("diagnose_seed", task_ids=("seed",), payload={"hint": "keep"})
        bound = MetaTask("Inspect evidence", schema).bind(operation)
        schema["properties"]["changed"] = {"type": "boolean"}
        self.assertEqual(bound.payload["meta"]["result_schema"]["properties"], {})
        self.assertEqual(operation.payload, {"hint": "keep"})
        with self.assertRaises(ValueError):
            MetaTask("Inspect evidence", schema).bind(bound)
        with self.assertRaises(ValueError):
            MetaTask("Inspect evidence", schema).bind(Operation("evaluate_seed"))

    def test_custom_policy_survives_sdk_worker_and_drives_proposals(self):
        examples = str(Path(__file__).resolve().parents[2] / "examples/algorithms")
        with patch.object(sys, "path", [examples, *sys.path]):
            from custom_meta import FailureAnalysis, plan_findings

            for recipe in (GEPA, RandomSearch):
                original = recipe(
                    meta_policy=FailureAnalysis("format errors"), proposal_planner=plan_findings
                )
                described = Project._describe_algorithm(original)
                self.assertTrue(
                    any(source["path"] == "custom_meta.py" for source in described["sources"])
                )
                restored = make_algorithm(json.loads(json.dumps(described))["algorithm"])
                self.assertEqual(restored.meta_policy.focus, "format errors")
                view = SearchView(
                    "run",
                    0,
                    "fixed",
                    (Task("seed", "format"),),
                    (Candidate("anchor", digest("anchor")),),
                    (Evidence("anchor", "seed", 0, 0, "valid", "global"),),
                    (),
                    Budget(10, 1, 1),
                    "anchor",
                )
                state = AlgorithmState(
                    data={
                        "phase": "diagnose",
                        "round": 0,
                        "batch_index": 0,
                        "batches": [{"parent": "anchor", "tasks": ["seed"], "count": 1}],
                        "parent_reason": "test",
                    }
                )
                # Enter through the public step with the production parent-selection phase.
                state = replace(state, data={**state.data, "phase": "parents"})
                decision = restored.step(view, state)
                diagnosis = decision.operations[0]
                self.assertEqual(diagnosis.kind, "diagnose_seed")
                prepared = prepare_meta(meta_input(diagnosis))
                self.assertIn("format errors", prepared["instructions"])
                self.assertNotIn("clusters", prepared["schema"]["properties"])
                result = parse_meta_result(
                    {
                        "operation": asdict(diagnosis),
                        "result": {"findings": ["Fix formatting"], "declined": False},
                    }
                )
                view = replace(
                    view,
                    step_id=1,
                    completed=(
                        OperationResult("op", "diagnose_seed", "complete", "anchor", result),
                    ),
                )
                proposal = restored.step(view, decision.state).operations[0]
                self.assertEqual(proposal.kind, "generate_candidate")
                self.assertEqual(proposal.payload["hypothesis"], "Fix formatting")
                self.assertIn(
                    "Implement the requested hypothesis", proposal.payload["meta"]["instructions"]
                )

    def test_custom_result_cannot_override_execution_status_or_schema_validation(self):
        for schema in (
            {
                "type": "object",
                "properties": {"declined": {"type": "string"}},
                "required": ["declined"],
                "additionalProperties": False,
            },
            {"type": "object", "properties": {}, "required": [], "additionalProperties": True},
            {
                "type": "object",
                "properties": {"x": {"$ref": "file:///private"}},
                "required": ["x"],
                "additionalProperties": False,
            },
            {
                "type": "object",
                "properties": {"x": {"type": "string", "pattern": ".*"}},
                "required": ["x"],
                "additionalProperties": False,
            },
        ):
            with self.subTest(schema=schema), self.assertRaises(ValueError):
                result_schema(schema)
        schema = result_schema(
            {"type": "object", "properties": {}, "required": [], "additionalProperties": False}
        )
        validate_result(schema, {"declined": True})
        for result in ({}, {"declined": 0}, {"declined": False, "extra": True}):
            with self.subTest(result=result), self.assertRaises(ValueError):
                validate_result(schema, result)

    def test_bounded_nested_results_and_scalar_types(self):
        schema = result_schema(
            {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "items": {
                        "type": "array",
                        "maxItems": 1,
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "properties": {
                                "score": {"type": "integer", "minimum": 0, "maximum": 2},
                                "reason": {"type": "string", "maxLength": 4},
                                "label": {"type": "string", "enum": ["ok"]},
                            },
                            "required": ["score", "reason", "label"],
                        },
                    }
                },
                "required": ["items"],
            }
        )
        valid = {"declined": False, "items": [{"score": 1, "reason": "good", "label": "ok"}]}
        validate_result(schema, valid)
        for key, value in (
            ("score", True),
            ("score", 3),
            ("score", 1.5),
            ("reason", "too long"),
            ("label", "bad"),
        ):
            broken = json.loads(json.dumps(valid))
            broken["items"][0][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                validate_result(schema, broken)
        with self.assertRaises(ValueError):
            validate_result(schema, {**valid, "items": valid["items"] * 2})


if __name__ == "__main__":
    unittest.main()
