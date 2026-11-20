"""Caller integration with upstream Tau2 tools; model responses are explicit fixtures."""

import asyncio
import copy
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from dataclasses import asdict
from pathlib import Path
from unittest.mock import patch

from gear.canonical import digest
from gear.curriculum import OutcomeRecord

EXAMPLES = Path(__file__).resolve().parents[2] / "examples/curriculum-harness"
sys.path.insert(0, str(EXAMPLES))
from sentinel_generate import RetailGenerator, controller_cases  # noqa: E402
from sentinel_retail import (  # noqa: E402
    RetailSession,
    load_backend,
    replay_reference,
)


def database():
    """Authored training-only data, independent of Tau2 benchmark users and tasks."""
    address = {
        "address1": "10 Training Way",
        "address2": "",
        "city": "Example City",
        "country": "USA",
        "state": "NY",
        "zip": "10000",
    }
    item = {
        "name": "Training shirt",
        "product_id": "gear-product",
        "item_id": "gear-blue",
        "price": 10.0,
        "options": {"color": "blue", "size": "M"},
    }
    orders = {
        key: {
            "order_id": key,
            "user_id": "gear_alex",
            "address": address,
            "items": [item],
            "status": status,
            "fulfillments": [],
            "payment_history": [
                {
                    "transaction_type": "payment",
                    "amount": 10.0,
                    "payment_method_id": "gear-card",
                }
            ],
        }
        for key, status in (("#G100", "pending"), ("#G101", "delivered"))
    }
    return {
        "users": {
            "gear_alex": {
                "user_id": "gear_alex",
                "name": {"first_name": "Alex", "last_name": "Example"},
                "address": address,
                "email": "alex@gear.example",
                "orders": list(orders),
                "payment_methods": {
                    "gear-card": {
                        "source": "credit_card",
                        "id": "gear-card",
                        "brand": "visa",
                        "last_four": "0000",
                    }
                },
            }
        },
        "orders": orders,
        "products": {
            "gear-product": {
                "name": "Training shirt",
                "product_id": "gear-product",
                "variants": {
                    "gear-blue": {
                        "item_id": "gear-blue",
                        "options": item["options"],
                        "available": True,
                        "price": 10.0,
                    }
                },
            }
        },
    }


def observation(sample, passed=False, *, task="source", environment="env", attempt=0, calls=None):
    return {
        "record": asdict(
            OutcomeRecord(
                task_id=task,
                family="retail-train",
                sample_id=sample,
                attempt=attempt,
                policy_id="fixture-solver",
                environment_id=environment,
                status="completed",
                passed=passed,
                complete=True,
                instruction="Please cancel my pending order.",
                feedback="The order stayed pending; the solver stopped after reading it.",
                evidence_refs=({"fixture": sample, "attempt": attempt},),
            )
        ),
        "tool_calls": calls
        if calls is not None
        else [
            {"name": "get_order_details", "arguments": {"order_id": "#G100"}},
        ],
    }


class SamplingTests(unittest.TestCase):
    def select(self, observations, limit=8):
        return controller_cases(
            observations, environment_id="env", family="retail-train", seed=17, limit=limit
        )

    def test_deduplication_resolves_attempts_and_keeps_both_outcomes(self):
        rows = [
            observation("duplicate-a"),
            observation("duplicate-b"),
            observation("success", True, task="another"),
        ]
        cases, traces = self.select(rows)
        self.assertEqual(len(cases), 2)
        self.assertEqual({case.outcome for case in cases}, {"failure", "success"})
        self.assertEqual(set(traces), {case.case_id for case in cases})
        rows = [observation("retry"), observation("retry", True, attempt=1)]
        cases, _ = self.select(rows)
        self.assertEqual([case.outcome for case in cases], ["success"])

    def test_private_foreign_unreferenced_or_conflicting_observations_are_rejected(self):
        for field, value in (
            ("partition", "test"),
            ("family", "other"),
            ("environment_id", "foreign"),
            ("evidence_refs", []),
        ):
            item = observation("sample")
            item["record"][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.select([item])
        with self.assertRaisesRegex(ValueError, "conflicting outcomes"):
            self.select([observation("a"), observation("b", True)])
        with self.assertRaisesRegex(ValueError, "conflicting tool traces"):
            self.select([observation("a"), observation("a", calls=[])])

    def test_incomplete_latest_attempt_does_not_reuse_an_earlier_failure(self):
        incomplete = observation("retry", attempt=1)
        incomplete["record"].update(status="unknown", complete=False, passed=None)
        cases, _ = self.select([observation("retry"), incomplete])
        self.assertEqual(cases, ())

    def test_sampling_is_bounded_and_seeded_without_changing_references(self):
        rows = [observation(str(i), passed=i % 2 == 0, task=str(i)) for i in range(20)]
        result, traces = self.select(rows, 6)
        self.assertEqual(len(result), 6)
        self.assertEqual(sum(case.outcome == "failure" for case in result), 3)
        self.assertEqual((result, traces), self.select(list(reversed(rows)), 6))


class FixtureCalls:
    identity = "explicit-model-fixture-v1"

    def __init__(self, *, reject=False):
        self.max_calls = 24
        self.receipts = {}
        self.submissions = []
        self.reject = reject

    async def call(self, key, prompt, harness, **settings):
        request = [prompt, harness, settings]
        if key in self.receipts:
            previous, receipt = self.receipts[key]
            if previous != request:
                raise ValueError("fixture model key changed input")
            return receipt
        data = json.loads(prompt)
        if key == "diagnose":
            failures = [row["case_id"] for row in data["cases"] if row["outcome"] == "failure"]
            response = {
                "modes": [
                    {
                        "mode_id": "missing-write",
                        "description": "Stops before performing the requested database change.",
                        "support_case_ids": failures,
                        "counterexample_case_ids": [],
                    }
                ]
            }
        elif key == "goal":
            response = {"goal": "Cancel Alex's pending order #G100 because it is no longer needed."}
        elif key.startswith("user/"):
            response = {
                "message": "Yes, cancel #G100 because it is no longer needed."
                if key != "user/0"
                else "My email is alex@gear.example. Cancel order #G100; I no longer need it."
            }
        elif key.startswith("explore/"):
            actions = [
                ("tool", "find_user_id_by_email", {"email": "alex@gear.example"}, ""),
                ("tool", "get_order_details", {"order_id": "#G100"}, ""),
                (
                    "message",
                    "",
                    {},
                    "Confirm cancellation of pending order #G100 because it is no longer needed, with refund to your original card?",
                ),
                (
                    "tool",
                    "cancel_pending_order",
                    {"order_id": "#G100", "reason": "no longer needed"},
                    "",
                ),
                (
                    "finish",
                    "",
                    {},
                    "Order #G100 is cancelled. Your original card will be refunded in 5 to 7 business days.",
                ),
            ]
            kind, name, arguments, text = actions[int(key.split("/")[1])]
            response = {
                "kind": kind,
                "name": name,
                "arguments_json": json.dumps(arguments),
                "text": text,
            }
        elif key == "rewrite":
            assert data["reference"]["status"] == "completed"
            assert data["reference"]["final"]["orders"]["#G100"]["status"] == "cancelled"
            response = {
                "instruction": "I no longer need my blue training shirt order #G100. Could you cancel it?",
                "user_instructions": "You are Alex (alex@gear.example). Cancel #G100 because it is no longer needed. Confirm after the agent explains cancellation and the card refund.",
            }
        elif key == "audit":
            response = {
                "valid": True,
                "faithful": True,
                "policy_compliant": not self.reject,
                "hides_solution": True,
                "reason": "Explicit semantic model fixture.",
            }
        else:
            raise AssertionError(key)
        receipt = {
            "response": json.dumps(response),
            "usage": {"total": {"total_tokens": 1}},
            "status": "completed",
            "fixture": True,
        }
        self.submissions.append(key)
        self.receipts[key] = request, receipt
        return receipt


TAU_SOURCE = os.environ.get("GEAR_SENTINEL_TAU2_PATH")


@unittest.skipUnless(
    TAU_SOURCE and importlib.util.find_spec("tau2"), "requires pinned Tau2 checkout and package"
)
class NativeRetailTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.backend = load_backend(TAU_SOURCE)

    def config(self, **overrides):
        data = database()
        environment = RetailSession(self.backend, data, "gear_alex").identity
        return {
            "schema_version": 1,
            "partition": "train",
            "family": "retail-train",
            "database": data,
            "user_id": "gear_alex",
            "observations": [observation("failure-1", environment=environment)],
            "model": "explicit-fixture",
            "effort": "low",
            "seed": 23,
            "max_steps": 8,
            "max_calls": 24,
            "max_cases": 8,
            **overrides,
        }

    def generate(self, root, calls=None, config=None):
        caller = RetailGenerator(root, TAU_SOURCE, config or self.config(), calls or FixtureCalls())
        return caller, asyncio.run(caller.generate())

    def test_actual_tools_native_db_verifier_and_negative_controls(self):
        with tempfile.TemporaryDirectory() as root:
            calls = FixtureCalls()
            _, result = self.generate(root, calls)
            self.assertEqual(result["status"], "ready")
            self.assertFalse(result["training_eligible"])
            self.assertEqual(result["selected"], [result["draft"]["draft_id"]])
            trace = json.loads((Path(root) / "reference.json").read_text())
            self.assertEqual(trace["initial"]["orders"]["#G100"]["status"], "pending")
            self.assertEqual(trace["final"]["orders"]["#G100"]["status"], "cancelled")
            self.assertEqual(
                trace["final"]["orders"]["#G100"]["payment_history"][-1]["transaction_type"],
                "refund",
            )
            checks = json.loads((Path(root) / "calibration.json").read_text())
            self.assertEqual(
                {key: value["reward"] for key, value in checks.items()},
                {"reference": 1, "no_actions": 0, "missing_writes": 0},
            )
            self.assertGreater(
                calls.submissions.index("rewrite"), calls.submissions.index("explore/4")
            )
            self.assertEqual(result["task"]["evaluation_criteria"]["reward_basis"], ["DB"])
            self.assertNotIn("trace_digest", result["task"]["user_scenario"]["instructions"])
            evidence = json.loads((Path(root) / "validation-evidence.json").read_text())
            for check in result["report"]["results"][0]["checks"]:
                for reference in check["evidence_refs"]:
                    self.assertEqual(reference["digest"], digest(evidence))
                    self.assertIn(reference["check"], evidence)
            self.assertEqual(result["model_usage"]["completed_calls"], len(calls.submissions))

    def test_memory_resolves_old_support_outside_the_current_sample(self):
        with tempfile.TemporaryDirectory() as root:
            first = Path(root) / "first"
            _, result = self.generate(first)
            history = json.loads((first / "memory.json").read_text())
            old_support = history["memory"][0]["support_case_ids"]
            self.assertEqual(result["memory_ref"]["digest"], digest(history))
            current = observation(
                "failure-2", task="new-task", environment=history["scope"]["environment_id"]
            )
            calls = FixtureCalls()
            second = Path(root) / "second"
            _, result = self.generate(
                second, calls, self.config(history=history, observations=[current])
            )
            merged = json.loads((second / "memory.json").read_text())
            self.assertEqual(len(merged["memory"][0]["support_case_ids"]), 2)
            writer = json.loads(calls.receipts["rewrite"][0][0])
            self.assertEqual(len(writer["cases"]), 2)
            self.assertTrue(set(old_support) <= {case["case_id"] for case in writer["cases"]})
            self.assertEqual(len(json.loads(calls.receipts["diagnose"][0][0])["cases"]), 1)
            self.assertEqual(
                json.loads(calls.receipts["diagnose"][0][0])["memory"], history["memory"]
            )
            third = Path(root) / "third"
            _, repeated = self.generate(
                third, FixtureCalls(), self.config(history=merged, observations=[current])
            )
            self.assertEqual(json.loads((third / "memory.json").read_text()), merged)
            self.assertEqual(repeated["memory_ref"]["digest"], result["memory_ref"]["digest"])
            self.assertEqual(repeated["status"], "no_failures")

    def test_cross_round_duplicate_trace_does_not_inflate_recurrence(self):
        with tempfile.TemporaryDirectory() as root:
            first = Path(root) / "first"
            self.generate(first)
            history = json.loads((first / "memory.json").read_text())
            duplicate = copy.deepcopy(history["observations"][0])
            duplicate["record"]["sample_id"] = "a-second-physical-sample"
            calls = FixtureCalls()
            second = Path(root) / "second"
            _, result = self.generate(
                second, calls, self.config(history=history, observations=[duplicate])
            )
            self.assertEqual(result["status"], "no_failures")
            self.assertEqual(calls.submissions, [])
            self.assertEqual(
                json.loads((second / "memory.json").read_text())["memory"], history["memory"]
            )

    def test_no_new_failure_preserves_active_memory_without_claiming_mastery(self):
        with tempfile.TemporaryDirectory() as root:
            first = Path(root) / "first"
            self.generate(first)
            history = json.loads((first / "memory.json").read_text())
            success = observation(
                "success-only",
                True,
                task="success-task",
                environment=history["scope"]["environment_id"],
            )
            calls = FixtureCalls()
            second = Path(root) / "second"
            _, result = self.generate(
                second, calls, self.config(history=history, observations=[success])
            )
            self.assertEqual(result["status"], "no_failures")
            self.assertEqual(calls.submissions, [])
            self.assertEqual(
                json.loads((second / "memory.json").read_text())["memory"], history["memory"]
            )

    def test_memory_scope_missing_evidence_and_rewritten_samples_are_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            first = Path(root) / "first"
            self.generate(first)
            history = json.loads((first / "memory.json").read_text())
            for change in ("scope", "missing", "mastery", "retry"):
                with self.subTest(change=change):
                    modified = copy.deepcopy(history)
                    config = self.config(history=modified)
                    if change == "scope":
                        modified["scope"]["family"] = "foreign"
                    elif change == "missing":
                        modified["observations"] = []
                    elif change == "mastery":
                        modified["memory"][0]["state"] = "mastered"
                    else:
                        config["observations"][0]["record"]["attempt"] = 1
                    calls = FixtureCalls()
                    with self.assertRaises(ValueError):
                        self.generate(Path(root) / change, calls, config)
                    self.assertEqual(calls.submissions, [])

    def test_recovery_after_tool_state_saved_does_not_charge_or_apply_twice(self):
        with tempfile.TemporaryDirectory() as root:
            calls = FixtureCalls()
            caller = RetailGenerator(root, TAU_SOURCE, self.config(), calls)
            original = caller.checkpoint

            def interrupt(name, value):
                result = original(name, value)
                if name == "steps/3":
                    raise OSError("lost reply after database change was recorded")
                return result

            with patch.object(caller, "checkpoint", side_effect=interrupt):
                with self.assertRaisesRegex(OSError, "lost reply"):
                    asyncio.run(caller.generate())
            _, recovered = self.generate(root, calls)
            count = len(calls.submissions)
            _, replayed = self.generate(root, calls)
            self.assertEqual(recovered, replayed)
            self.assertEqual(len(calls.submissions), count)
            self.assertEqual(calls.submissions.count("explore/3"), 1)
            trace = json.loads((Path(root) / "reference.json").read_text())
            self.assertEqual(len(trace["final"]["orders"]["#G100"]["payment_history"]), 2)

    def test_partial_reference_and_semantic_rejection_cannot_enter_pool(self):
        for steps, reject, status in ((4, False, "invalid_reference"), (8, True, "rejected")):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as root:
                calls = FixtureCalls(reject=reject)
                _, result = self.generate(root, calls, self.config(max_steps=steps))
                self.assertEqual(result["status"], status)
                self.assertEqual(result["selected"], [])
                if steps == 4:
                    self.assertNotIn("rewrite", calls.submissions)

    def test_read_observation_drift_is_rejected_even_when_terminal_state_matches(self):
        with tempfile.TemporaryDirectory() as root:
            _, result = self.generate(root)
            trace = json.loads((Path(root) / "reference.json").read_text())
            changed = copy.deepcopy(trace)
            changed["steps"][1]["execution"]["response"]["content"] = "invented order"
            with self.assertRaisesRegex(ValueError, "observation"):
                replay_reference(self.backend, database(), "gear_alex", changed)
            changed = copy.deepcopy(trace)
            changed["final"]["orders"]["#G100"]["status"] = "pending"
            with self.assertRaisesRegex(ValueError, "terminal database"):
                replay_reference(self.backend, database(), "gear_alex", changed)
            self.assertEqual(result["reference_digest"], digest(trace))

    def test_changed_environment_or_model_cannot_resume(self):
        with tempfile.TemporaryDirectory() as root:
            self.generate(root)
            with self.assertRaisesRegex(ValueError, "frozen SENTINEL"):
                RetailGenerator(
                    root, TAU_SOURCE, self.config(model="another-model"), FixtureCalls()
                )
            config = self.config()
            config["database"]["orders"]["#G100"]["status"] = "delivered"
            with self.assertRaisesRegex(ValueError, "training scope"):
                RetailGenerator(root, TAU_SOURCE, config, FixtureCalls())

    def test_success_only_input_stops_without_model_calls(self):
        with tempfile.TemporaryDirectory() as root:
            config = self.config()
            config["observations"][0]["record"]["passed"] = True
            calls = FixtureCalls()
            _, result = self.generate(root, calls, config)
            self.assertEqual(result["status"], "no_failures")
            self.assertEqual(calls.submissions, [])

    def test_tool_allowlist_arguments_and_unknown_customer_fail_before_execution(self):
        session = RetailSession(self.backend, database(), "gear_alex")
        for action in (
            {"name": "calculate", "arguments": {"expression": "2+2"}},
            {"name": "get_order_details", "arguments": {"order_id": "#G100", "extra": 1}},
            {"name": "get_order_details", "arguments": {"order_id": 1}},
        ):
            with self.assertRaises(ValueError):
                session.execute(action, 0)
        self.assertEqual(session.initial, session.snapshot())
        with self.assertRaises(ValueError):
            RetailSession(self.backend, database(), "not-a-customer")

    def test_quota_mismatch_is_rejected_before_any_model_submission(self):
        with tempfile.TemporaryDirectory() as root:
            calls = FixtureCalls()
            with self.assertRaisesRegex(ValueError, "quota differs"):
                RetailGenerator(root, TAU_SOURCE, self.config(max_calls=25), calls)
            self.assertEqual(calls.submissions, [])

    def test_caller_mutation_does_not_change_the_frozen_observations(self):
        with tempfile.TemporaryDirectory() as root:
            config = self.config()
            caller = RetailGenerator(root, TAU_SOURCE, config, FixtureCalls())
            config["observations"][0]["record"]["evidence_refs"][0]["fixture"] = "changed"
            config["database"]["orders"]["#G100"]["status"] = "delivered"
            result = asyncio.run(caller.generate())
            self.assertEqual(result["status"], "ready")
            self.assertEqual(caller.cases[0].record.evidence_refs[0]["fixture"], "failure-1")

    def test_unknown_model_result_is_propagated_without_starting_later_stages(self):
        with tempfile.TemporaryDirectory() as root:
            calls = FixtureCalls()
            original = calls.call

            async def unknown(key, *args, **kwargs):
                if key == "goal":
                    raise RuntimeError("unknown model result; reconcile existing turn")
                return await original(key, *args, **kwargs)

            with patch.object(calls, "call", side_effect=unknown):
                with self.assertRaisesRegex(RuntimeError, "unknown model"):
                    self.generate(root, calls)
            self.assertEqual(calls.submissions, ["diagnose"])
            self.assertFalse((Path(root) / "reference.json").exists())
            self.assertFalse((Path(root) / "result.json").exists())

    def test_authentication_cannot_be_skipped_by_an_otherwise_valid_native_path(self):
        session = RetailSession(self.backend, database(), "gear_alex")
        action = {
            "name": "cancel_pending_order",
            "arguments": {"order_id": "#G100", "reason": "no longer needed"},
        }
        execution = session.execute(action, 0)
        trace = {
            "schema_version": 1,
            "environment_id": session.identity,
            "initial": session.initial,
            "status": "completed",
            "opening": "Cancel my order",
            "final": session.snapshot(),
            "steps": [
                {"kind": "tool", "action": action, "execution": execution},
                {"kind": "finish", "text": "Cancelled"},
            ],
        }
        self.assertFalse(execution["response"]["error"])
        with self.assertRaisesRegex(ValueError, "authentication"):
            replay_reference(self.backend, database(), "gear_alex", trace)


if __name__ == "__main__":
    unittest.main()
