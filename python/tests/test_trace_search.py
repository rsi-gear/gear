"""Generated Python environments enter real mixed-pool harness search on CPU."""

import asyncio
import copy
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from gear.canonical import digest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "examples/curriculum-harness"))
from fixtures.trace_calls import TraceCalls  # noqa: E402
from fixtures.trace_provider import FixtureCalls, InterruptedCalls  # noqa: E402
from ifeval_experiment import read_json  # noqa: E402
from sentinel_collect import RetailCollector  # noqa: E402
from sentinel_pool import build_pool  # noqa: E402
from sentinel_provider import prepare_jobs, respond  # noqa: E402
from sentinel_search import search  # noqa: E402
from test_sentinel_search import TAU_SOURCE  # noqa: E402
from test_trace_generate import TraceGenerationFixture  # noqa: E402


class TraceSearchFixture(TraceGenerationFixture):
    def setUp(self):
        super().setUp()
        result = self.generate()
        self.entry = {
            "recipe": "trace",
            "workspace": str(self.root / "trace"),
            "draft_id": result["selected"][0],
            "seeds": [31],
        }
        self.mixed_config = {**self.pool_config, "generated": [self.entry]}
        self.mixed = asyncio.run(build_pool(self.root / "mixed", TAU_SOURCE, self.mixed_config))
        self.bundle = next(row for row in self.mixed["selected"] if row.get("kind") == "trace")

    def trace_message(self, *, name="trace-evaluation", max_steps=8):
        message = self.message(max_steps=max_steps)
        identifier = self.bundle["pool_task_id"]
        bundle = {**self.bundle, "gear_task_id": identifier}
        message["configuration"]["train_task_ids"].append(identifier)
        message["configuration"]["trace_tasks"] = {identifier: digest(bundle)}
        message["context"]["benchmark"] = {
            "tasks": [
                {"id": identifier, "instruction": bundle["instruction"], "family": bundle["family"]}
            ],
            "verifiers": {identifier: {"expected": json.dumps(bundle)}},
        }
        message["request"]["operationId"] = digest(name)
        message["request"]["operation"]["task_ids"] = [identifier]
        message["request"]["slots"] = [{"taskId": identifier, "repetition": 0}]
        return message


class TracePoolProviderTests(TraceSearchFixture):
    def test_new_seeds_must_not_alias_the_same_executed_task(self):
        suffix = "\noriginal_reset = CapabilityGame.reset\ndef reset(self, seed):\n    original_reset(self, seed if seed < 30 else 31)\nCapabilityGame.reset = reset\n"
        generated = self.generate(calls=TraceCalls(code_suffix=suffix), name="aliased")
        entry = {
            **self.entry,
            "workspace": str(self.root / "aliased"),
            "draft_id": generated["selected"][0],
            "seeds": [31, 32],
        }
        with self.assertRaisesRegex(ValueError, "distinct initial requests"):
            asyncio.run(
                build_pool(
                    self.root / "aliased-pool",
                    TAU_SOURCE,
                    {**self.mixed_config, "generated": [entry]},
                )
            )

    def test_exact_pool_replay_new_seeds_and_partition_binding(self):
        self.assertEqual(self.mixed["status"], "ready")
        self.assertEqual(self.mixed["requested"], {"fixed": 1, "generated": 1})
        self.assertEqual(self.bundle["seed"], 31)
        self.assertEqual(self.bundle["provenance"]["recipe"], "trace")
        self.assertNotIn("reference_actions", self.bundle["instruction"])
        self.assertNotIn('"summary"', self.bundle["instruction"])
        with patch(
            "model_calls.TextCalls.__aenter__",
            side_effect=AssertionError("pool replay must not open SDK"),
        ):
            self.assertEqual(
                self.mixed,
                asyncio.run(build_pool(self.root / "mixed", TAU_SOURCE, self.mixed_config)),
            )
        for index, change in enumerate(({"seeds": [17]}, {"seeds": [31, 31]})):
            config = {**self.mixed_config, "generated": [{**self.entry, **change}]}
            with self.assertRaises(ValueError):
                asyncio.run(build_pool(self.root / f"bad-{index}", TAU_SOURCE, config))
        for change in ("code", "instruction", "seed", "scope", "unadmitted"):
            message = self.trace_message()
            identifier = self.bundle["pool_task_id"]
            value = json.loads(message["context"]["benchmark"]["verifiers"][identifier]["expected"])
            if change == "scope":
                message["configuration"]["train_task_ids"].remove(identifier)
                message["configuration"]["validation_task_ids"].append(identifier)
            elif change == "unadmitted":
                message["configuration"]["trace_tasks"] = {}
            elif change == "code":
                value["environment"]["code"] += "\n# changed"
            elif change == "seed":
                value["seed"] += 1
            else:
                value["instruction"] = "different"
            message["context"]["benchmark"]["verifiers"][identifier]["expected"] = json.dumps(value)
            with self.subTest(change=change), self.assertRaises(ValueError):
                prepare_jobs(message["configuration"], message["context"], message["request"])
        self.assertFalse((self.root / "calls/submitted.jsonl").exists())

    def test_actual_generated_execution_unknown_and_incomplete_results(self):
        message = self.trace_message()
        result = asyncio.run(respond(message, calls_factory=FixtureCalls))
        self.assertEqual(result["evidence"][0]["score"], 1)
        sample = result["provenance"]["samples"][0]
        self.assertEqual(sample["kind"], "trace")
        self.assertEqual(sample["partition"], "train")
        self.assertEqual(read_json(Path(sample["path"]) / "result.json")["reward"], 1)
        submitted = (self.root / "calls/submitted.jsonl").read_text()
        next((self.root / "operations").glob("*/receipt.json")).unlink()
        self.assertEqual(
            asyncio.run(respond({**message, "action": "inspect"}, calls_factory=FixtureCalls)),
            {"state": "complete", "receipt": result},
        )
        self.assertEqual(submitted, (self.root / "calls/submitted.jsonl").read_text())
        partial = asyncio.run(
            respond(self.trace_message(name="partial", max_steps=1), calls_factory=FixtureCalls)
        )
        self.assertEqual(partial["evidence"][0]["status"], "scoring_failed")
        self.assertIsNone(partial["evidence"][0]["score"])
        unknown = self.trace_message(name="unknown")
        with (
            patch.object(
                FixtureCalls, "call", side_effect=RuntimeError("unknown model turn")
            ) as call,
            patch.object(FixtureCalls, "inspect", return_value=("unknown", None)),
        ):
            with self.assertRaisesRegex(RuntimeError, "unknown model turn"):
                asyncio.run(respond(unknown, calls_factory=FixtureCalls))
            self.assertEqual(
                asyncio.run(respond({**unknown, "action": "inspect"}, calls_factory=FixtureCalls)),
                {"state": "unknown"},
            )
            self.assertEqual(call.await_count, 1)
        for path in (self.root / "calls").glob("*.json"):
            request = read_json(path)["request"]
            self.assertEqual(
                set(json.loads(request["prompt"])), {"system_prompt", "tools", "messages"}
            )

    def test_interrupted_generated_rollout_reuses_paid_receipt_and_clean_seed(self):
        message = self.trace_message()
        with self.assertRaisesRegex(OSError, "lost completed TRACE"):
            asyncio.run(respond(message, calls_factory=InterruptedCalls))
        submitted = (self.root / "calls/submitted.jsonl").read_text()
        self.assertEqual(
            asyncio.run(respond({**message, "action": "inspect"}, calls_factory=InterruptedCalls)),
            {"state": "resumable"},
        )
        self.assertEqual(submitted, (self.root / "calls/submitted.jsonl").read_text())
        result = asyncio.run(respond(message, calls_factory=InterruptedCalls))
        self.assertEqual(result["evidence"][0]["score"], 1)
        keys = (self.root / "calls/submitted.jsonl").read_text().splitlines()
        self.assertEqual(len(keys), 4)
        self.assertEqual(len(keys), len(set(keys)))


@unittest.skipUnless(
    os.environ.get("GEAR_TEST_SENTINEL_RUNTIME"), "explicit CLI/worker integration"
)
class TraceRuntimeTests(TraceSearchFixture):
    def test_generated_environment_improves_candidate_then_native_holdout_is_evaluated(self):
        async def run():
            provider = ROOT / "python/tests/fixtures/trace_provider.py"
            workspace = self.root / "trace-search"
            config = {**self.config, "pool_workspace": str(self.root / "mixed")}
            await search(workspace, TAU_SOURCE, config, provider_script=provider, preflight=True)
            self.assertFalse((workspace / "calls/submitted.jsonl").exists())
            result = await search(workspace, TAU_SOURCE, config, provider_script=provider)
            self.assertIn("SOLVE_WITH_TOOLS", result["harness"])
            self.assertEqual([row["status"] for row in result["constraints"]], ["reject", "allow"])
            self.assertEqual([row["accepted"] for row in result["training_gates"]], [True])
            self.assertEqual(result["physical_attempts"], 6)
            self.assertFalse(result["test_opened"])
            self.assertEqual(
                sum(key.startswith("trace-") for key in result["task_ids"]["train"]), 1
            )
            self.assertTrue(
                all(
                    key.startswith("retail-")
                    for key in result["task_ids"]["validation"] + result["task_ids"]["test"]
                )
            )
            submissions = (workspace / "calls/submitted.jsonl").read_text()
            (workspace / "result.json").unlink()
            self.assertEqual(
                result, await search(workspace, TAU_SOURCE, config, provider_script=provider)
            )
            self.assertEqual(submissions, (workspace / "calls/submitted.jsonl").read_text())
            private = copy.deepcopy(config)
            private["validation"] = [
                {
                    **self.bundle,
                    "partition": "validation",
                    "family": "private",
                    "evidence_refs": [{"fixture": True}],
                }
            ]
            with self.assertRaisesRegex(ValueError, "training-only"):
                await search(
                    self.root / "bad-holdout", TAU_SOURCE, private, provider_script=provider
                )
            # Only after selection do both fixed harnesses see the same native
            # test task. These model responses are fixtures, not effect evidence.
            verdicts = []
            for name, harness in (("baseline", config["harness"]), ("selected", result["harness"])):
                sample_config = {
                    **{
                        key: self.test[key]
                        for key in (
                            "partition",
                            "family",
                            "database",
                            "user_id",
                            "task",
                            "reference",
                        )
                    },
                    "schema_version": 1,
                    "model": config["model"],
                    "effort": config["effort"],
                    "harness": harness,
                    "max_steps": 8,
                    "max_calls": 24,
                    "sample_id": "final-" + name,
                    "attempt": 0,
                }
                async with FixtureCalls(self.root / ("final-calls-" + name), max_calls=24) as calls:
                    final = await RetailCollector(
                        self.root / ("final-" + name), TAU_SOURCE, sample_config, calls
                    ).collect()
                verdicts.append(final["observation"]["record"]["passed"])
                self.assertEqual(final["observation"]["record"]["partition"], "test")
            self.assertEqual(verdicts, [False, True])
            for path in (workspace / "calls").glob("*.json"):
                request = read_json(path)["request"]
                if request["key"].endswith("/meta"):
                    self.assertNotIn("PRIVATE_DEV", request["prompt"])
                    self.assertNotIn("PRIVATE_TEST", request["prompt"])
                    self.assertNotIn("reference_actions", request["prompt"])
                    self.assertNotIn("verification_digest", request["prompt"])

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
