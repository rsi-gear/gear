"""Measured retail memory using real tools and native scoring; model outputs are fixtures."""

import asyncio
import copy
import json
import os
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fixtures.sentinel_provider import FixtureCalls as ProbeCalls
from fixtures.sentinel_study import FixtureCalls as SourceCalls
from ifeval_experiment import read_json
from sentinel_collect import RetailCollector
from sentinel_generate import EXPLORER_PROMPT, RetailGenerator
from sentinel_mastery import RetailMastery
from sentinel_search import search
from test_sentinel_retail import FixtureCalls as GenerationCalls
from test_sentinel_search import ROOT, TAU_SOURCE, RetailSearchFixture


class MasteryFixture(RetailSearchFixture):
    def setUp(self):
        super().setUp()
        second = copy.deepcopy(self.fixed_task)
        second.update(
            id="second-support",
            ticket="TRAIN_SECOND Please cancel pending order #G100, which is no longer needed.",
        )
        self.tasks = [
            {
                "task": task,
                "reference": self.reference,
                "evidence_refs": [{"fixture": "authored source task"}],
            }
            for task in (self.fixed_task, second)
        ]
        observations = [
            self.collect_source(row, f"source-{index}")["observation"]
            for index, row in enumerate(self.tasks)
        ]
        self.assertTrue(all(row["record"]["passed"] is False for row in observations))
        generator = RetailGenerator(
            self.root / "diagnosed",
            TAU_SOURCE,
            {**self.generation_config, "observations": observations},
            GenerationCalls(),
        )
        asyncio.run(generator.generate())
        self.history = read_json(self.root / "diagnosed/memory.json")
        self.probe_config = {
            **{
                key: self.generation_config[key]
                for key in (
                    "schema_version",
                    "partition",
                    "family",
                    "database",
                    "user_id",
                    "model",
                    "effort",
                )
            },
            "history": self.history,
            "tasks": self.tasks,
            "probe_id": "after-search-1",
            "repetitions": 2,
            "harness": EXPLORER_PROMPT + " SOLVE_WITH_TOOLS",
            "max_steps": 8,
            "max_calls": 100,
        }

    def collect_source(self, bundle, sample, harness=None):
        config = {
            **{
                key: self.generation_config[key]
                for key in (
                    "schema_version",
                    "partition",
                    "family",
                    "database",
                    "user_id",
                    "model",
                    "effort",
                )
            },
            "task": bundle["task"],
            "reference": bundle["reference"],
            "max_steps": 8,
            "max_calls": 17,
            "harness": harness or self.config["harness"],
            "sample_id": sample,
            "attempt": 0,
        }
        calls = SourceCalls(self.root / sample / "calls", max_calls=17)
        return asyncio.run(RetailCollector(self.root / sample, TAU_SOURCE, config, calls).collect())

    def probe(self, name="mastery", config=None, calls=None):
        config = config or self.probe_config
        root = self.root / name
        calls = calls or ProbeCalls(root / "calls", max_calls=config["max_calls"])
        return RetailMastery(root, TAU_SOURCE, config, calls)

    def generate_from_memory(self, history, name, **overrides):
        calls = GenerationCalls()
        caller = RetailGenerator(
            self.root / name,
            TAU_SOURCE,
            {
                **self.generation_config,
                "history": history,
                "observations": [],
                "use_failure_memory": True,
                **overrides,
            },
            calls,
        )
        return asyncio.run(caller.generate()), calls


class MasteryTests(MasteryFixture):
    def test_replaying_old_observations_does_not_revoke_newer_measured_mastery(self):
        probe = self.probe()
        asyncio.run(probe.measure())
        history = read_json(probe.root / "memory.json")
        result, calls = self.generate_from_memory(
            history,
            "historical-material",
            observations=self.history["observations"],
        )
        self.assertEqual(result["status"], "no_targets")
        self.assertFalse(calls.submissions)
        self.assertEqual(read_json(self.root / "historical-material/memory.json"), history)

    def test_duplicate_failure_trace_can_reopen_mastery_without_inflating_recurrence(self):
        async def failed_response(key, prompt, harness, **settings):
            value = (
                {
                    "action": {
                        "kind": "finish",
                        "name": "",
                        "arguments_json": "{}",
                        "text": "I would next verify your account.",
                    }
                }
                if key == "solve/0"
                else {"policy_compliant": True, "reason": "Explicit model fixture."}
            )
            return {
                "status": "completed",
                "response": json.dumps(value),
                "usage": None,
                "fixture": True,
            }

        def fail(bundle, sample_id):
            config = {
                **{
                    key: self.probe_config[key]
                    for key in (
                        "schema_version",
                        "partition",
                        "family",
                        "database",
                        "user_id",
                        "model",
                        "effort",
                        "harness",
                        "max_steps",
                    )
                },
                "task": bundle["task"],
                "reference": bundle["reference"],
                "max_calls": 17,
                "sample_id": sample_id,
                "attempt": 0,
            }
            calls = SimpleNamespace(
                call=failed_response,
                max_calls=17,
                identity=ProbeCalls.identity,
                timeout_seconds=ProbeCalls.timeout_seconds,
                root=self.root / sample_id / "calls",
            )
            return asyncio.run(
                RetailCollector(self.root / sample_id, TAU_SOURCE, config, calls).collect()
            )

        originals = [
            fail(bundle, "old-flaky-" + str(i))["observation"]
            for i, bundle in enumerate(self.tasks)
        ]
        generator = RetailGenerator(
            self.root / "flaky-diagnosis",
            TAU_SOURCE,
            {**self.generation_config, "observations": originals},
            GenerationCalls(),
        )
        asyncio.run(generator.generate())
        probe = self.probe(
            config={
                **self.probe_config,
                "history": read_json(self.root / "flaky-diagnosis/memory.json"),
            }
        )
        self.assertEqual(probe.policy_id, originals[0]["record"]["policy_id"])
        asyncio.run(probe.measure())
        current = fail(self.tasks[0], "new-flaky-result")["observation"]
        self.assertFalse(current["record"]["passed"])
        calls = GenerationCalls()
        repeated = RetailGenerator(
            self.root / "flaky-carry",
            TAU_SOURCE,
            {
                **self.generation_config,
                "history": read_json(probe.root / "memory.json"),
                "observations": [current],
            },
            calls,
        )
        self.assertEqual(repeated.cases, ())  # Same task/policy/trace is still deduplicated.
        asyncio.run(repeated.generate())
        self.assertFalse(calls.submissions)
        mode = read_json(repeated.root / "memory.json")["memory"][0]
        self.assertEqual(mode["state"], "active")
        self.assertIsNone(mode["mastery"])
        self.assertEqual(len(mode["support_case_ids"]), 2)

    def test_all_supporting_tasks_repeated_and_cached_then_reopened_and_reused(self):
        probe = self.probe()
        self.assertFalse((probe.calls.root / "submitted.jsonl").exists())
        self.assertEqual(len(probe.schedule), 4)
        result = asyncio.run(probe.measure())
        self.assertEqual(result["status"], "measured")
        self.assertEqual(result["model_usage"]["completed_calls"], 28)
        self.assertEqual([row["mastered"] for row in result["measurements"]], [True])
        history = read_json(probe.root / "memory.json")
        self.assertEqual(history["memory"][0]["state"], "mastered")
        self.assertEqual(len(history["memory"][0]["support_case_ids"]), 2)
        calls = (probe.calls.root / "submitted.jsonl").read_bytes()
        (probe.root / "result.json").unlink()
        self.assertEqual(asyncio.run(self.probe().measure()), result)
        self.assertEqual((probe.calls.root / "submitted.jsonl").read_bytes(), calls)
        for path in probe.root.glob("probes/*/trajectory.json"):
            self.assertEqual(len(read_json(path)["final"]["orders"]["#G100"]["payment_history"]), 2)
        generated, models = self.generate_from_memory(history, "mastered-generation")
        self.assertEqual(generated["status"], "no_targets")
        self.assertFalse(models.submissions)

        following = self.probe(
            "regression",
            {
                **self.probe_config,
                "history": history,
                "harness": self.config["harness"],
                "probe_id": "regressed-policy-2",
            },
        )
        reopened = asyncio.run(following.measure())
        self.assertEqual([row["mastered"] for row in reopened["measurements"]], [False])
        self.assertEqual(
            reopened["invalidated_prior_policy_measurements"], [history["memory"][0]["mode_id"]]
        )
        history = read_json(following.root / "memory.json")
        self.assertEqual(history["memory"][0]["state"], "active")
        self.assertEqual(
            len(history["memory"][0]["support_case_ids"]), 2
        )  # Probes are not new diagnoses.
        generated, models = self.generate_from_memory(history, "reactivated-generation")
        self.assertEqual(generated["status"], "ready")
        self.assertNotIn("diagnose", models.submissions)
        self.assertIn("goal", models.submissions)

    def test_incomplete_new_policy_probes_do_not_inherit_mastery_or_become_failures(self):
        previous = self.probe()
        asyncio.run(previous.measure())
        probe = self.probe(
            "limited",
            {
                **self.probe_config,
                "history": read_json(previous.root / "memory.json"),
                "probe_id": "bounded-new-policy",
                "max_steps": 3,
            },
        )
        result = asyncio.run(probe.measure())
        self.assertEqual(result["status"], "inconclusive")
        self.assertEqual(result["measurements"], [])
        self.assertTrue(
            all(row["passed"] is None and not row["complete"] for row in result["probes"])
        )
        memory = read_json(probe.root / "memory.json")["memory"]
        self.assertEqual(memory[0]["state"], "active")
        self.assertIsNone(memory[0]["mastery"])

    def test_generator_invalidates_old_policy_mastery_from_new_actual_observations(self):
        previous = self.probe()
        asyncio.run(previous.measure())
        history = read_json(previous.root / "memory.json")
        current = self.collect_source(
            self.tasks[0], "fresh-current-policy", "Different prompt. SOLVE_WITH_TOOLS"
        )
        self.assertTrue(current["observation"]["record"]["passed"])
        result, calls = self.generate_from_memory(
            history,
            "changed-policy",
            observations=[current["observation"]],
            use_failure_memory=False,
        )
        self.assertEqual(result["status"], "no_failures")
        self.assertFalse(calls.submissions)
        mode = read_json(self.root / "changed-policy/memory.json")["memory"][0]
        self.assertEqual(mode["state"], "active")
        self.assertIsNone(mode["mastery"])

    def test_forged_mastery_missing_probes_and_wrong_policy_are_rejected(self):
        probe = self.probe()
        asyncio.run(probe.measure())
        history = read_json(probe.root / "memory.json")
        for mutation in ("verdict", "policy", "cases", "missing", "repetitions"):
            changed = copy.deepcopy(history)
            mode = changed["memory"][0]
            if mutation == "verdict":
                mode["mastery"]["mastered"] = False
                mode["state"] = "active"
            elif mutation == "policy":
                mode["mastery"]["policy_id"] = "unmeasured-policy"
            elif mutation == "cases":
                mode["mastery"]["evidence_refs"][0]["case_ids"].pop()
            elif mutation == "repetitions":
                mode["mastery"]["evidence_refs"][0]["repetitions"] = 1
            else:
                changed["observations"] = [
                    row
                    for row in changed["observations"]
                    if row["record"]["sample_id"] != result_sample(probe)
                ]
            calls = GenerationCalls()
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                RetailGenerator(
                    self.root / mutation,
                    TAU_SOURCE,
                    {**self.generation_config, "history": changed, "observations": []},
                    calls,
                )
            self.assertFalse(calls.submissions)

    def test_incomplete_private_extra_and_changed_task_plans_fail_before_submission(self):
        for mutation in ("missing", "private", "changed", "duplicate"):
            config = copy.deepcopy(self.probe_config)
            if mutation == "missing":
                config["tasks"].pop()
            elif mutation == "private":
                config["partition"] = "test"
            elif mutation == "changed":
                config["tasks"][0]["task"]["ticket"] = "A different task."
            else:
                config["tasks"].append(copy.deepcopy(config["tasks"][0]))
            calls = ProbeCalls(self.root / mutation / "calls", max_calls=config["max_calls"])
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                self.probe(mutation, config, calls)
            self.assertFalse((calls.root / "submitted.jsonl").exists())

    def test_reusing_a_probe_id_with_measured_history_is_rejected_before_models(self):
        previous = self.probe()
        asyncio.run(previous.measure())
        config = {**self.probe_config, "history": read_json(previous.root / "memory.json")}
        calls = ProbeCalls(self.root / "duplicate/calls", max_calls=config["max_calls"])
        with self.assertRaisesRegex(ValueError, "probe_id was already measured"):
            self.probe("duplicate", config, calls)
        self.assertFalse((calls.root / "submitted.jsonl").exists())

    def test_unknown_model_and_exhausted_budget_do_not_emit_memory_measurements(self):
        probe = self.probe()
        with patch.object(probe.calls, "call", side_effect=RuntimeError("unknown model result")):
            with self.assertRaisesRegex(RuntimeError, "unknown model"):
                asyncio.run(probe.measure())
        self.assertFalse((probe.root / "memory.json").exists())
        small = self.probe("quota", {**self.probe_config, "max_calls": 2})
        with self.assertRaisesRegex(RuntimeError, "quota exhausted"):
            asyncio.run(small.measure())
        self.assertFalse((small.root / "memory.json").exists())
        self.assertEqual(len((small.calls.root / "submitted.jsonl").read_text().splitlines()), 2)


def result_sample(probe):
    return probe.schedule[0][2].config["sample_id"]


@unittest.skipUnless(
    os.environ.get("GEAR_TEST_SENTINEL_RUNTIME"), "explicit CLI/worker integration"
)
class MasteryRuntimeTests(MasteryFixture):
    def test_sealed_formal_search_harness_is_measured_by_actual_training_probes(self):
        async def run():
            selected = await search(
                self.root / "formal",
                TAU_SOURCE,
                self.config,
                provider_script=ROOT / "python/tests/fixtures/sentinel_provider.py",
            )
            self.assertFalse(selected["test_opened"])
            probe = self.probe(
                config={
                    **self.probe_config,
                    "harness": selected["harness"],
                    "probe_id": selected["run_id"],
                }
            )
            result = await probe.measure()
            self.assertEqual([row["mastered"] for row in result["measurements"]], [True])
            self.assertEqual(len(result["probes"]), 4)
            self.assertTrue(all(row["passed"] for row in result["probes"]))

        with patch.dict(
            os.environ,
            {
                "GEAR_PROFILE_ROOT": str(self.root / "profiles"),
                "GEAR_PYTHON": sys.executable,
                "GEAR_COMMAND": json.dumps(["node", str(ROOT / "lib/cli.js")]),
                "PYTHONPATH": str(ROOT / "python"),
            },
        ):
            asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
