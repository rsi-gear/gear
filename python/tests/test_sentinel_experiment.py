"""Paired retail comparison: native tools, source isolation and real formal search."""

import asyncio
import copy
import json
import os
import sys
import unittest
from unittest.mock import patch

from fixtures.sentinel_study import FixtureCalls, RejectingCalls
from ifeval import read_json
from sentinel_experiment import RetailStudy, aggregate
from sentinel_generate import RetailGenerator
from sentinel_pool import replay_generated
from test_sentinel_retail import FixtureCalls as GenerationCalls
from test_sentinel_search import ROOT, TAU_SOURCE, RetailSearchFixture


class MetricTests(unittest.TestCase):
    def test_partial_observations_do_not_create_a_failure_rate(self):
        rows = [{"complete": True, "passed": True}, {"complete": False, "passed": None}]
        self.assertEqual(
            aggregate(rows),
            {
                "tasks": 2,
                "complete": 1,
                "passed": 1,
                "unknown": 1,
                "pass_rate": None,
            },
        )


class RandomGenerationTests(RetailSearchFixture):
    def test_random_has_no_failure_material_and_uses_the_same_native_validation(self):
        config = {
            **self.generation_config,
            "observations": [],
            "conditioning": "random",
            "random_targets": ["Cancel a pending order", "Return delivered items"],
        }
        calls = GenerationCalls()
        root = self.root / "random"
        result = asyncio.run(RetailGenerator(root, TAU_SOURCE, config, calls).generate())
        self.assertEqual(result["status"], "ready")
        self.assertNotIn("diagnose", calls.submissions)
        plan = read_json(root / "plan.json")
        self.assertEqual(plan["conditioning"], "random")
        self.assertEqual(plan["target"]["source_case_ids"], [])
        self.assertEqual(read_json(root / "model/rewrite.json")["input"]["data"]["cases"], [])
        self.assertEqual(read_json(root / "memory.json")["observations"], [])
        self.assertEqual(asyncio.run(replay_generated(root, TAU_SOURCE))["task"], result["task"])
        config["random_targets"].reverse()
        second_root = self.root / "reordered"
        asyncio.run(RetailGenerator(second_root, TAU_SOURCE, config, GenerationCalls()).generate())
        self.assertEqual(read_json(second_root / "plan.json"), plan)

    def test_random_rejects_outcomes_and_memory_before_any_model_call(self):
        for changes in (
            {},
            {"observations": [], "history": {}},
            {"observations": [], "random_targets": []},
        ):
            calls = GenerationCalls()
            config = {
                **self.generation_config,
                "conditioning": "random",
                "random_targets": ["Cancel a pending order"],
                **changes,
            }
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                RetailGenerator(self.root / "invalid", TAU_SOURCE, config, calls)
            self.assertFalse(calls.submissions)


@unittest.skipUnless(
    os.environ.get("GEAR_TEST_SENTINEL_RUNTIME"), "explicit CLI/worker integration"
)
class StudyRuntimeTests(RetailSearchFixture):
    def study(self, name="study", factory=FixtureCalls, **overrides):
        second = copy.deepcopy(self.pool_config["fixed"][0])
        second["task"].update(
            id="fixed-second", ticket="TRAIN_SECOND Please cancel my unneeded order #G100."
        )
        config = {
            "schema_version": 1,
            "training": {
                **{key: self.pool_config[key] for key in ("family", "database", "user_id")},
                "fixed": [*self.pool_config["fixed"], second],
            },
            **{
                key: self.config[key]
                for key in (
                    "validation",
                    "test",
                    "harness",
                    "model",
                    "meta_model",
                    "effort",
                    "max_steps",
                    "max_characters",
                    "target_characters",
                    "max_repairs",
                )
            },
            "seeds": [23],
            "rounds": 1,
            "calls_per_task": 24,
            "calls_per_generation": 24,
            "calls_per_search": 100,
            "fixed_count": 1,
            "generated_count": 1,
            "generation_attempts": 1,
            "random_targets": ["Cancel a pending order"],
            **overrides,
        }
        return RetailStudy(
            self.root / name,
            TAU_SOURCE,
            config,
            calls_factory=factory,
            provider_script=ROOT / "python/tests/fixtures/sentinel_provider.py",
        )

    def environment(self):
        return patch.dict(
            os.environ,
            {
                "GEAR_PROFILE_ROOT": str(self.root / "profiles"),
                "GEAR_PYTHON": sys.executable,
                "GEAR_COMMAND": json.dumps(["node", str(ROOT / "lib/cli.js")]),
                "PYTHONPATH": str(ROOT / "python"),
            },
        )

    def test_three_arms_seal_tests_recover_and_do_not_send_private_material_to_generators(self):
        async def run():
            study = self.study()
            preflight = await study.run(preflight=True)
            self.assertEqual(preflight["model_calls"], 0)
            self.assertFalse(list(study.root.rglob("submitted.jsonl")))
            original = study.collect

            async def checked_collect(seed, index, bundle, harness):
                if bundle["partition"] == "test":
                    seal = read_json(study.root / "test-admission.json")
                    self.assertEqual(len(seal["selections"]), 4)
                    self.assertEqual(
                        len(list(study.root.glob("trials/*/*/*/search/result.json"))), 3
                    )
                return await original(seed, index, bundle, harness)

            study.collect = checked_collect
            result = await study.run()
            self.assertTrue(result["comparable"])
            self.assertTrue(result["model_fixture"])
            self.assertEqual(
                result["mean_pass_rate"],
                {
                    "fixed": 1.0,
                    "random": 1.0,
                    "failure": 1.0,
                    "baseline": 0.0,
                },
            )
            self.assertEqual(
                result["paired_failure_minus_control"], {"fixed": [0.0], "random": [0.0]}
            )
            source = list(study.root.glob("observations/*/result.json"))
            self.assertEqual(
                sum(read_json(p)["observation"]["record"]["partition"] == "train" for p in source),
                2,
            )
            for path in study.root.glob("trials/*/*/*/generation/*/model/**/*.json"):
                contents = path.read_text()
                self.assertNotIn("PRIVATE_DEV", contents)
                self.assertNotIn("PRIVATE_TEST", contents)
                if "/random/" in str(path):
                    self.assertNotIn("missing-write", contents)
            submissions = {path: path.read_bytes() for path in study.root.rglob("submitted.jsonl")}
            (study.root / "result.json").unlink()
            self.assertEqual(await study.run(), result)
            self.assertEqual(
                submissions, {p: p.read_bytes() for p in study.root.rglob("submitted.jsonl")}
            )
            with self.assertRaises(ValueError):
                self.study(harness="changed after viewing final tests")

        with self.environment():
            asyncio.run(run())

    def test_rejected_generations_keep_attempts_and_do_not_become_a_comparable_study(self):
        with self.environment():
            study = self.study(factory=RejectingCalls)
            result = asyncio.run(study.run())
        self.assertFalse(result["comparable"])
        self.assertIsNone(result["paired_failure_minus_control"])
        for row in result["decisions"]:
            if row["arm"] != "fixed":
                self.assertEqual([a["status"] for a in row["attempts"]], ["rejected"])
                self.assertEqual(row["pool_status"], "insufficient")
                self.assertIsNone(row["search"])
                self.assertEqual(row["harness"], self.config["harness"])
        self.assertEqual(len(list(study.root.glob("trials/*/*/*/search/result.json"))), 1)

    def test_explicit_generator_model_and_budget_final_replies_reach_formal_comparison(self):
        with self.environment():
            study = self.study(
                max_steps=4,
                final_reply_on_limit=True,
                generator_model="explicit-generator",
                call_timeout_seconds=600,
                call_delay_seconds=10,
            )
            result = asyncio.run(study.run())
            with self.assertRaisesRegex(ValueError, "changed"):
                self.study(
                    max_steps=4,
                    final_reply_on_limit=True,
                    generator_model="explicit-generator",
                    call_timeout_seconds=601,
                    call_delay_seconds=10,
                )
            with self.assertRaisesRegex(ValueError, "changed"):
                self.study(
                    max_steps=4,
                    final_reply_on_limit=True,
                    generator_model="explicit-generator",
                    call_timeout_seconds=600,
                    call_delay_seconds=11,
                )
        self.assertTrue(result["comparable"])
        self.assertEqual(result["mean_pass_rate"]["baseline"], 0)
        self.assertTrue(
            all(result["mean_pass_rate"][arm] == 1 for arm in ("fixed", "random", "failure"))
        )
        generation_inputs = list(study.root.glob("trials/*/*/*/generation/*/input.json"))
        self.assertEqual(len(generation_inputs), 2)
        for path in generation_inputs:
            self.assertEqual(read_json(path)["config"]["model"], "explicit-generator")
            for call in path.parent.glob("calls/*.json"):
                self.assertEqual(
                    read_json(call)["request"]["settings"]["model"], "explicit-generator"
                )
        final_samples = list(
            study.root.glob("trials/*/*/*/search/operations/*/samples/*/model/solve/4.json")
        )
        self.assertTrue(final_samples)
        for path in final_samples:
            self.assertTrue(read_json(path)["input"]["data"]["action_budget_exhausted"])
            config = read_json(path.parents[2] / "input.json")["config"]
            self.assertEqual(config["model"], "explicit-fixture")
            self.assertEqual(config["max_calls"], 10)
        stage_inputs = [
            read_json(path)
            for path in study.root.glob("**/input.json")
            if "model_calls_identity" in read_json(path)
        ]
        self.assertTrue(stage_inputs)
        self.assertTrue(all(row["call_timeout_seconds"] == 600 for row in stage_inputs))
        self.assertTrue(all(row["call_delay_seconds"] == 10 for row in stage_inputs))
        actual_calls = list(study.root.glob("**/calls/*.json"))
        self.assertTrue(actual_calls)
        self.assertTrue(
            all(read_json(path)["request"]["timeout_seconds"] == 600 for path in actual_calls)
        )
        self.assertTrue(
            all(read_json(path)["request"]["delay_seconds"] == 10 for path in actual_calls)
        )
        meta_calls = [
            path for path in actual_calls if read_json(path)["request"]["key"].endswith("/meta")
        ]
        self.assertTrue(meta_calls)
        profiles = list((self.root / "profiles").glob("*.json"))
        self.assertTrue(profiles)
        for path in profiles:
            self.assertEqual(read_json(path)["configuration"]["call_timeout_seconds"], 600)
            self.assertEqual(read_json(path)["configuration"]["call_delay_seconds"], 10)

    def test_submission_delay_rejects_invalid_values_before_sealing_input(self):
        for value in (None, True, -1, 61, 10.0, "10"):
            with (
                self.subTest(value=value),
                self.assertRaisesRegex(ValueError, "call_delay_seconds"),
            ):
                self.study(call_delay_seconds=value)
            self.assertFalse((self.root / "study/input.json").exists())

    def test_wait_budget_rejects_invalid_values_before_study_input_is_sealed(self):
        for value in (None, True, 0, -1, 1801, 240.0, "240"):
            with (
                self.subTest(value=value),
                self.assertRaisesRegex(ValueError, "call_timeout_seconds"),
            ):
                self.study(call_timeout_seconds=value)
            self.assertFalse((self.root / "study/input.json").exists())

    def test_incomplete_search_is_retained_and_excluded_from_comparison(self):
        with self.environment():
            study = self.study(max_steps=1)
            result = asyncio.run(study.run())
        self.assertFalse(result["comparable"])
        self.assertIsNone(result["paired_failure_minus_control"])
        fixed = next(row for row in result["decisions"] if row["arm"] == "fixed")
        self.assertEqual(fixed["pool_status"], "ready")
        self.assertEqual(fixed["search"]["status"], "incomplete_training_evidence")
        self.assertIsNone(fixed["search"]["selected"])
        self.assertEqual(fixed["harness"], study.config["harness"])
        selected = next(row for row in result["evaluations"] if row["arm"] == "fixed")
        self.assertFalse(selected["eligible"])


if __name__ == "__main__":
    unittest.main()
