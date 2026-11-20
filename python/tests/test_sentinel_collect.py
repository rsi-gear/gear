"""Actual retail solver execution and grading; all model outputs are explicit fixtures."""

import asyncio
import copy
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gear.canonical import digest

EXAMPLES = Path(__file__).resolve().parents[2] / "examples/curriculum-harness"
sys.path.insert(0, str(EXAMPLES))
from sentinel_collect import RetailCollector  # noqa: E402
from sentinel_generate import EXPLORER_PROMPT, RetailGenerator, controller_cases  # noqa: E402
from sentinel_retail import RetailSession, load_backend, replay_trace  # noqa: E402
from test_sentinel_retail import FixtureCalls, database, observation  # noqa: E402

TAU_SOURCE = os.environ.get("GEAR_SENTINEL_TAU2_PATH")


class SolverCalls:
    identity = "explicit-solver-fixture-v1"
    max_calls = 24

    def __init__(self, steps, *, policy=True):
        self.steps = steps
        self.policy = policy
        self.receipts = {}
        self.submissions = []

    async def call(self, key, prompt, harness, **settings):
        request = [prompt, harness, settings]
        if key in self.receipts:
            previous, receipt = self.receipts[key]
            if previous != request:
                raise ValueError("solver fixture input changed")
            return receipt
        if key.startswith("solve/"):
            step = self.steps[int(key.split("/")[1])]
            action = step.get("action", {"name": "", "arguments": {}})
            response = {
                "kind": step["kind"],
                "name": action["name"],
                "arguments_json": json.dumps(action["arguments"]),
                "text": step.get("text", ""),
            }
        elif key.startswith("user/"):
            response = {"message": "Yes, cancel #G100 with the refund to my original card."}
        elif key == "policy-audit":
            response = {"policy_compliant": self.policy, "reason": "Explicit semantic fixture."}
        else:
            raise AssertionError(key)
        receipt = {
            "response": json.dumps(response),
            "status": "completed",
            "fixture": True,
            "usage": {"total": {"total_tokens": 1}},
        }
        self.receipts[key] = request, receipt
        self.submissions.append(key)
        return receipt


@unittest.skipUnless(
    TAU_SOURCE and importlib.util.find_spec("tau2"), "requires pinned Tau2 checkout and package"
)
class SolverCollectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.backend = load_backend(TAU_SOURCE)
        cls.reference_root = tempfile.TemporaryDirectory()
        cls.generation_config = {
            "schema_version": 1,
            "partition": "train",
            "family": "retail-train",
            "database": database(),
            "user_id": "gear_alex",
            "model": "explicit-fixture",
            "effort": "low",
            "seed": 23,
            "max_steps": 8,
            "max_calls": 24,
            "max_cases": 8,
            "observations": [
                observation(
                    "source",
                    environment=RetailSession(cls.backend, database(), "gear_alex").identity,
                )
            ],
        }
        generator = RetailGenerator(
            cls.reference_root.name, TAU_SOURCE, cls.generation_config, FixtureCalls()
        )
        cls.generated = asyncio.run(generator.generate())
        cls.reference = json.loads((Path(cls.reference_root.name) / "reference.json").read_text())

    @classmethod
    def tearDownClass(cls):
        cls.reference_root.cleanup()

    def config(self, **overrides):
        return copy.deepcopy(
            {
                "schema_version": 1,
                "partition": "train",
                "family": "retail-train",
                "database": database(),
                "user_id": "gear_alex",
                "model": "explicit-fixture",
                "effort": "low",
                "harness": EXPLORER_PROMPT,
                "max_steps": 8,
                "max_calls": 24,
                "sample_id": "solver-1",
                "attempt": 0,
                "task": self.generated["task"],
                "reference": self.reference,
                **overrides,
            }
        )

    def collect(self, root, calls, **overrides):
        collector = RetailCollector(root, TAU_SOURCE, self.config(**overrides), calls)
        return collector, asyncio.run(collector.collect())

    def test_solver_success_native_grading_and_hidden_material_isolation(self):
        with tempfile.TemporaryDirectory() as root:
            calls = SolverCalls(self.reference["steps"])
            _, result = self.collect(root, calls)
            self.assertTrue(result["observation"]["record"]["passed"])
            grading = json.loads((Path(root) / "grading.json").read_text())
            self.assertEqual(grading["native"]["reward"], 1)
            for key, (request, _) in calls.receipts.items():
                data = json.loads(request[0])
                if key.startswith("solve/"):
                    self.assertEqual(set(data), {"policy", "tools", "conversation"})
                if key.startswith("user/"):
                    self.assertEqual(set(data), {"goal", "customer", "conversation"})
                    self.assertTrue(
                        all(set(row) == {"role", "content"} for row in data["conversation"])
                    )
            for ref in result["observation"]["record"]["evidence_refs"]:
                self.assertEqual(ref["digest"], digest(json.loads(Path(ref["path"]).read_text())))

    def test_complete_failure_enters_generator_but_step_limit_stays_unknown(self):
        with tempfile.TemporaryDirectory() as root:
            _, failed = self.collect(
                Path(root) / "solver",
                SolverCalls([{"kind": "finish", "text": "I have completed your cancellation."}]),
            )
            record = failed["observation"]["record"]
            self.assertTrue(record["complete"])
            self.assertFalse(record["passed"])
            config = {**self.generation_config, "observations": [failed["observation"]]}
            generator = RetailGenerator(
                Path(root) / "generator", TAU_SOURCE, config, FixtureCalls()
            )
            generated = asyncio.run(generator.generate())
            # The fixture writer repeats the source request: diagnosis is usable,
            # but novelty still rejects it instead of silently admitting it.
            self.assertEqual(generated["status"], "rejected")
            self.assertEqual(generated["selected"], [])
            self.assertEqual(generator.cases[0].record.policy_id, record["policy_id"])
            _, partial = self.collect(
                Path(root) / "partial", SolverCalls(self.reference["steps"]), max_steps=4
            )
            self.assertFalse(partial["observation"]["record"]["complete"])
            self.assertIsNone(partial["observation"]["record"]["passed"])
            cases, _ = controller_cases(
                [partial["observation"]],
                environment_id=record["environment_id"],
                family="retail-train",
                seed=1,
                limit=2,
            )
            self.assertEqual(cases, ())
            self.assertFalse((Path(root) / "partial/model/policy-audit.json").exists())

    def test_native_error_can_be_preserved_and_recovered(self):
        steps = copy.deepcopy(self.reference["steps"])
        steps.insert(
            1,
            {
                "kind": "tool",
                "action": {
                    "name": "cancel_pending_order",
                    "arguments": {"order_id": "#G101", "reason": "no longer needed"},
                },
            },
        )
        with tempfile.TemporaryDirectory() as root:
            _, result = self.collect(root, SolverCalls(steps))
            self.assertTrue(result["observation"]["record"]["passed"])
            trace = json.loads((Path(root) / "trajectory.json").read_text())
            self.assertTrue(trace["steps"][1]["execution"]["response"]["error"])
            replay_trace(self.backend, database(), "gear_alex", trace)
            trace["steps"][1]["execution"]["response"]["error"] = False
            with self.assertRaisesRegex(ValueError, "observation"):
                replay_trace(self.backend, database(), "gear_alex", trace)

    def test_native_db_match_does_not_override_authentication_or_policy_failure(self):
        for steps, policy in (
            (self.reference["steps"][1:], True),
            (self.reference["steps"], False),
        ):
            with self.subTest(policy=policy), tempfile.TemporaryDirectory() as root:
                _, result = self.collect(root, SolverCalls(steps, policy=policy))
                self.assertFalse(result["observation"]["record"]["passed"])
                grading = json.loads((Path(root) / "grading.json").read_text())
                self.assertEqual(grading["native"]["reward"], 1)

    def test_resume_saved_write_keeps_receipts_and_native_state_identical(self):
        with tempfile.TemporaryDirectory() as root:
            calls = SolverCalls(self.reference["steps"])
            collector = RetailCollector(root, TAU_SOURCE, self.config(), calls)
            original = collector.checkpoint

            def lose_return(name, value):
                result = original(name, value)
                if name == "steps/3":
                    raise OSError("lost return after saved write")
                return result

            with patch.object(collector, "checkpoint", side_effect=lose_return):
                with self.assertRaisesRegex(OSError, "lost return"):
                    asyncio.run(collector.collect())
            _, recovered = self.collect(root, calls)
            submissions = list(calls.submissions)
            _, replayed = self.collect(root, calls)
            self.assertEqual(recovered, replayed)
            self.assertEqual(calls.submissions, submissions)
            self.assertEqual(
                len(
                    json.loads((Path(root) / "trajectory.json").read_text())["final"]["orders"][
                        "#G100"
                    ]["payment_history"]
                ),
                2,
            )

    def test_private_task_reference_drift_and_unsupported_state_rejected_before_model(self):
        for change in ("partition", "initial_state", "actions", "reference"):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as root:
                config = self.config()
                if change == "partition":
                    config["partition"] = "test"
                elif change == "initial_state":
                    config["task"]["initial_state"] = {}
                elif change == "actions":
                    config["task"]["evaluation_criteria"]["actions"] = []
                else:
                    config["reference"]["final"]["orders"]["#G100"]["status"] = "pending"
                calls = SolverCalls(self.reference["steps"])
                with self.assertRaises(ValueError):
                    collector = RetailCollector(root, TAU_SOURCE, config, calls)
                    asyncio.run(collector.collect())
                self.assertEqual(calls.submissions, [])

    def test_unknown_model_and_invalid_action_are_never_failed_native_observations(self):
        with tempfile.TemporaryDirectory() as root:
            calls = SolverCalls(self.reference["steps"])
            with patch.object(calls, "call", side_effect=RuntimeError("unknown API result")):
                with self.assertRaisesRegex(RuntimeError, "unknown API"):
                    self.collect(root, calls)
            self.assertFalse((Path(root) / "result.json").exists())
        with tempfile.TemporaryDirectory() as root:
            calls = SolverCalls(
                [{"kind": "tool", "action": {"name": "nonexistent_tool", "arguments": {}}}]
            )
            with self.assertRaisesRegex(ValueError, "unavailable"):
                self.collect(root, calls)
            self.assertTrue((Path(root) / "model/solve/0.json").exists())
            self.assertFalse((Path(root) / "steps/0.json").exists())
            self.assertFalse((Path(root) / "result.json").exists())


if __name__ == "__main__":
    unittest.main()
