"""Public component and declaration contracts, exercised without a runtime service."""

import importlib
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from gear.algorithms import AlgorithmState
from gear.algorithms.random import DeterministicRandom
from gear.canonical import digest
from gear.core import (
    Call,
    CallResult,
    CandidateRef,
    Meta,
    MetaInput,
    Results,
    Sequential,
    StateTree,
    clone,
    describe_module,
    freeze_module,
)
from gear.core.base import construct_module
from gear.core.schema import validate_output, validate_schema
from gear.core.testing import check_operator
from gear.project import Project
from gear.refine.worker import load_entrypoint, make_algorithm
from gear.search import Decision, Terminal

FIXTURES = Path(__file__).resolve().parents[2] / "tests" / "fixtures"
sys.path.insert(0, str(FIXTURES))
components = importlib.import_module("operator_tree")


class ComponentTests(unittest.TestCase):
    def test_sequential_child_random_namespaces_are_distinct_and_repeatable(self):
        def draw(value, *, rng):
            return value + (rng.value("same-key"),)

        operator = Sequential((draw, draw))
        first = operator((), rng=DeterministicRandom("seed"))
        self.assertNotEqual(first[0], first[1])
        self.assertEqual(first, operator((), rng=DeterministicRandom("seed")))

    def test_sequential_preserves_namespaced_choice_for_existing_search_components(self):
        from gear.search.contracts_v1 import ParentOption

        options = (
            ParentOption("one", "scope", (), 1, probability=0.25),
            ParentOption("two", "scope", (), 2, probability=0.75),
        )

        def select(value, *, rng):
            return value + (rng.choice(options, key="parent", index=3),)

        rng = DeterministicRandom("seed")
        actual = Sequential((select, select))((), rng=rng)
        expected = tuple(
            rng.choice(options, key=digest([f"steps/{index}", "parent"]), index=3)
            for index in range(2)
        )
        self.assertEqual(actual, expected)
        self.assertEqual(actual, Sequential((select, select))((), rng=rng))

    def test_results_decode_with_frozen_pure_code_without_mutating_wire_values(self):
        from gear.core import CallRef

        reference = CallRef("result", digest("request"))
        raw = CallResult(reference, "succeeded", {"value": 3})
        result = Results((raw,)).require(
            reference, decode=lambda value: components.Scale(value["value"])
        )
        self.assertIsInstance(result.value, components.Scale)
        self.assertEqual(result.value(2), 6)
        self.assertEqual(raw.value, {"value": 3})
        self.assertEqual(result.to_dict(), raw.to_dict())
        failed = CallResult(reference, "failed", error={"code": "failed"}).decode(
            lambda value: 1 / 0
        )
        self.assertIsNone(failed.value)

    def tree(self):
        return components.TreeAlgorithm(
            components.Pipeline(
                (components.Scale(4), components.increment),
                {"schema__name": {"__gear_child__": "user data"}, "": 2},
            )
        )

    def test_sdk_worker_roundtrip_retains_arbitrary_children_and_json_keys(self):
        original = self.tree()
        description = json.loads(json.dumps(Project._describe_algorithm(original)))
        restored = make_algorithm(description["algorithm"])
        self.assertIsInstance(restored.evaluator.steps[0], components.Scale)
        self.assertIs(restored.evaluator.steps[1], components.increment)
        self.assertEqual(restored.evaluator.metadata, original.evaluator.metadata)
        self.assertEqual(restored.step(None, AlgorithmState()).state.data["value"], 13)
        self.assertEqual([item["path"] for item in description["sources"]], ["operator_tree.py"])
        with self.assertRaisesRegex(ValueError, "frozen"):
            restored.evaluator.set_params(metadata={})

    def test_nested_replacement_is_atomic_and_clone_drops_runtime_state(self):
        original = self.tree()
        original.evaluator.runtime_cache.append("not configuration")
        copied = clone(original)
        self.assertEqual(copied.evaluator.runtime_cache, [])
        copied.set_params(evaluator__steps__0__factor=5)
        self.assertEqual(copied.evaluator(3), 16)
        self.assertEqual(original.evaluator(3), 13)
        snapshot = copied.describe().to_dict()
        with self.assertRaises(ValueError):
            copied.set_params(initial=10, evaluator__unknown=1)
        self.assertEqual(copied.describe().to_dict(), snapshot)
        copied.set_params(**{"evaluator__metadata__schema~1name": {"value": 1}})
        self.assertEqual(copied.evaluator.metadata["schema__name"], {"value": 1})

    def test_freeze_is_detached_and_shared_child_instances_get_separate_configs(self):
        child = components.Scale(2)
        original = components.Pipeline([child, child], {"values": [1]})
        frozen = freeze_module(original)
        self.assertIsNot(frozen.steps[0], frozen.steps[1])
        original.metadata["values"].append(2)
        self.assertEqual(frozen.metadata, {"values": [1]})
        self.assertEqual(components.Empty().get_params(), {})
        self.assertEqual(clone(components.Empty())("value"), "value")

    def test_reconstruction_rejects_tampered_state_version_or_child_bindings(self):
        description = self.tree().describe().to_dict()
        description["state_schema_version"] = 2
        with self.assertRaisesRegex(ValueError, "version changed"):
            construct_module(description, load_entrypoint)
        description = self.tree().describe().to_dict()
        description["children"]["unused"] = description["children"]["evaluator"]
        with self.assertRaisesRegex(ValueError, "unreferenced"):
            construct_module(description, load_entrypoint)

    def test_cycles_and_anonymous_functions_are_rejected(self):
        value = components.Pipeline([])
        value.steps.append(value)
        with self.assertRaisesRegex(ValueError, "cycle"):
            describe_module(value)
        with self.assertRaisesRegex(ValueError, "importable"):
            describe_module(components.Pipeline([lambda value: value]))

    def test_contract_checker_detects_hidden_state_and_external_io(self):
        self.assertEqual(check_operator(components.Scale(3), 2)["result"], 6)
        with self.assertRaisesRegex(ValueError, "hidden state"):
            check_operator(components.HiddenCounter(), 1)
        with self.assertRaisesRegex(ValueError, "external I/O"):
            check_operator(components.opens_file, "/does-not-need-to-exist")


class SchemaTests(unittest.TestCase):
    def test_local_definitions_and_result_constraints_are_enforced(self):
        schema = {
            "type": "object",
            "$defs": {"verdict": {"enum": ["allow", "reject"]}},
            "properties": {
                "status": {"$ref": "#/$defs/verdict"},
                "count": {"type": "integer", "minimum": 1},
            },
            "required": ["status", "count"],
            "additionalProperties": False,
        }
        validate_output(schema, {"status": "allow", "count": 2})
        for result in (
            {"status": "allow"},
            {"status": "unknown", "count": 2},
            {"status": "allow", "count": True},
            {"status": "allow", "count": 0},
            {"status": "allow", "count": 2, "extra": 1},
        ):
            with self.subTest(result=result), self.assertRaises(ValueError):
                validate_output(schema, result)

    def test_unsupported_keywords_and_external_or_hidden_schema_references_are_rejected(self):
        for schema in (
            {"pattern": "unknown subset"},
            {"$ref": "https://external/schema"},
            {"const": {"not-a-schema-keyword": True}, "$ref": "#/const"},
        ):
            with self.subTest(schema=schema), self.assertRaises(ValueError):
                validate_schema(schema)


class CallTests(unittest.TestCase):
    def call(self):
        return Meta("inspect", {"type": "object"})(
            MetaInput(CandidateRef("run", "anchor", digest("anchor")), ("task",)),
            key="round/0/critic",
        )

    def test_calls_do_not_execute_and_request_identity_has_no_mutable_aliases(self):
        with patch("builtins.open", side_effect=AssertionError("unexpected I/O")):
            call = self.call()
        request = call.to_dict()
        copied = Call.from_dict(request)
        request["effect"]["input"]["prompt"] = "changed"
        self.assertEqual(call.ref, copied.ref)
        self.assertNotEqual(call.effect["input"]["prompt"], "changed")
        wire = call.to_dict()
        wire["output_schema_ref"]["schema"]["title"] = "changed"
        with self.assertRaisesRegex(ValueError, "digest"):
            Call.from_dict(wire)

    def test_results_only_resolve_matching_terminal_references(self):
        call = self.call()
        data = {"allow": True}
        result = CallResult(call.ref, "succeeded", data)
        data["allow"] = False
        results = Results((result,))
        self.assertTrue(results.require(call.ref).value["allow"])
        with self.assertRaisesRegex(ValueError, "unavailable"):
            results.require({"key": call.key, "request_digest": digest("another request")})
        with self.assertRaisesRegex(ValueError, "conflicting"):
            Results((result, CallResult(call.ref, "failed", error={"code": "failed"})))

    def test_state_and_decision_boundaries_are_explicit(self):
        raw = {"nested": [1]}
        state = StateTree(raw)
        raw["nested"].append(2)
        saved = state.state_dict()
        saved["data"]["nested"].append(3)
        self.assertEqual(state.data, {"nested": [1]})
        updated = state.updated(pending=self.call().ref)
        self.assertEqual(updated.data["pending"]["key"], self.call().key)
        with self.assertRaisesRegex(ValueError, "version mismatch"):
            StateTree.from_state_dict({"version": 2, "data": {}})
        with self.assertRaises(ValueError):
            Decision(state, (), "no work")
        with self.assertRaises(ValueError):
            Decision(state, (self.call(),), "mixed", Terminal("stop"))
        self.assertEqual(
            Decision(state, reason="done", terminal=Terminal("stop")).to_dict()["calls"], []
        )


if __name__ == "__main__":
    unittest.main()
