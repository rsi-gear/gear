"""Actual retail execution through Gear's formal search; model responses are fixtures."""

import asyncio
import base64
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
from gear.core import CandidateRef, Meta, MetaInput

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "examples/curriculum-harness"))
import test_sentinel_retail as source_fixture  # noqa: E402
from fixtures.sentinel_provider import FixtureCalls  # noqa: E402
from ifeval import read_json  # noqa: E402
from sentinel_collect import RetailCollector  # noqa: E402
from sentinel_generate import EXPLORER_PROMPT, RetailGenerator, freeze  # noqa: E402
from sentinel_pool import build_pool  # noqa: E402
from sentinel_provider import prepare_jobs, respond  # noqa: E402
from sentinel_retail import load_backend  # noqa: E402
from sentinel_search import search  # noqa: E402
from test_sentinel_collect import SolverCalls  # noqa: E402

TAU_SOURCE = os.environ.get("GEAR_SENTINEL_TAU2_PATH")


class InterruptedCalls(FixtureCalls):
    async def call(self, key, *args, **kwargs):
        receipt = await super().call(key, *args, **kwargs)
        marker = self.root / "interrupted"
        if key.endswith("/solve/3") and not marker.exists():
            marker.write_text(key)
            raise OSError("lost completed model reply before write execution")
        return receipt


@unittest.skipUnless(TAU_SOURCE and importlib.util.find_spec("tau2"), "requires pinned Tau2")
class RetailSearchFixture(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        source = source_fixture.NativeRetailTests()
        source.backend = load_backend(TAU_SOURCE)
        self.generation_config = source.config()
        generator = RetailGenerator(
            self.root / "generation",
            TAU_SOURCE,
            self.generation_config,
            source_fixture.FixtureCalls(),
        )
        result = asyncio.run(generator.generate())
        self.reference = read_json(self.root / "generation/reference.json")
        self.generated_task = result["task"]
        self.fixed_task = {
            **copy.deepcopy(self.generated_task),
            "id": "fixed-training",
            "ticket": "TRAIN_FIXED Cancel the pending order #G100 because it is no longer needed.",
        }
        self.pool_config = {
            **{
                key: self.generation_config[key]
                for key in ("schema_version", "partition", "family", "database", "user_id")
            },
            "fixed": [
                {
                    "task": self.fixed_task,
                    "reference": self.reference,
                    "evidence_refs": [{"fixture": "authored fixed task"}],
                }
            ],
            "generated": [str(self.root / "generation")],
            "fixed_count": 1,
            "generated_count": 1,
            "seed": 23,
        }
        self.pool = asyncio.run(build_pool(self.root / "pool", TAU_SOURCE, self.pool_config))
        self.validation = self.private_bundle("validation", "PRIVATE_DEV")
        self.test = self.private_bundle("test", "PRIVATE_TEST")
        self.config = {
            "schema_version": 1,
            "pool_workspace": str(self.root / "pool"),
            "validation": [self.validation],
            "test": [self.test],
            "harness": "Give the customer a concise explanation of the next step.",
            "model": "explicit-fixture",
            "meta_model": "explicit-fixture",
            "effort": "low",
            "max_steps": 8,
            "max_calls": 100,
            "max_characters": 1400,
            "target_characters": 800,
            "max_repairs": 2,
        }

    def collect(self, name, passed, **overrides):
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
            "task": self.fixed_task,
            "reference": self.reference,
            "harness": EXPLORER_PROMPT,
            "max_steps": 8,
            "max_calls": 24,
            "sample_id": name,
            "attempt": 0,
            **overrides,
        }
        steps = (
            self.reference["steps"]
            if passed
            else [{"kind": "finish", "text": "I would verify your account."}]
        )
        return asyncio.run(
            RetailCollector(self.root / name, TAU_SOURCE, config, SolverCalls(steps)).collect()
        )

    def private_bundle(self, partition, marker):
        return {
            "partition": partition,
            "family": "retail-" + partition,
            "database": copy.deepcopy(self.generation_config["database"]),
            "user_id": "gear_alex",
            "task": {
                **copy.deepcopy(self.generated_task),
                "id": partition + "-task",
                "ticket": marker + " Cancel order #G100; I no longer need it.",
            },
            "reference": self.reference,
            "evidence_refs": [{"fixture": "authored private task"}],
        }

    def message(self, *, partition="train", max_steps=8):
        bundle = self.pool["selected"][0] if partition == "train" else self.validation
        identifier = bundle["task"]["id"]
        bundle = {**bundle, "gear_task_id": identifier}
        target = self.root / "targets/anchor"
        for folder in ("extensions", "skills", "prompts"):
            (target / ".pi" / folder).mkdir(parents=True, exist_ok=True)
        freeze(target / ".pi/settings.json", {})
        (target / "AGENTS.md").write_text(EXPLORER_PROMPT + " SOLVE_WITH_TOOLS")
        configuration = {
            "calls": str(self.root / "calls"),
            "receipts": str(self.root / "operations"),
            "tau2_source": TAU_SOURCE,
            "model": "explicit-fixture",
            "effort": "low",
            "max_calls": 100,
            "max_steps": max_steps,
            "train_task_ids": [row["task"]["id"] for row in self.pool["selected"]],
            "validation_task_ids": [self.validation["task"]["id"]],
            "test_task_ids": [self.test["task"]["id"]],
        }
        return {
            "action": "submit",
            "configuration": configuration,
            "context": {
                "targets": str(self.root / "targets"),
                "benchmark": {
                    "tasks": [
                        {
                            "id": identifier,
                            "instruction": bundle["task"]["ticket"],
                            "family": bundle["family"],
                        }
                    ],
                    "verifiers": {identifier: {"expected": json.dumps(bundle)}},
                },
            },
            "request": {
                "runId": "run",
                "operationId": digest("retail-operation"),
                "partition": "seed",
                "operation": {
                    "kind": "evaluate_seed",
                    "candidate_id": "anchor",
                    "scope": "seed",
                    "task_ids": [identifier],
                },
                "slots": [{"taskId": identifier, "repetition": 0}],
            },
        }


class RetailProviderTests(RetailSearchFixture):
    def test_submission_delay_is_rejected_before_search_or_provider_io(self):
        for value in (None, True, -1, 61, 10.0, "10"):
            with self.subTest(value=value):
                message = self.message()
                message["configuration"]["call_delay_seconds"] = value
                with self.assertRaisesRegex(ValueError, "call_delay_seconds"):
                    asyncio.run(respond(message, calls_factory=FixtureCalls))
                with self.assertRaisesRegex(ValueError, "call_delay_seconds"):
                    asyncio.run(
                        search(
                            self.root / "invalid-delay",
                            TAU_SOURCE,
                            {**self.config, "call_delay_seconds": value},
                            preflight=True,
                        )
                    )
                self.assertFalse((self.root / "calls/submitted.jsonl").exists())
                self.assertFalse((self.root / "invalid-delay/input.json").exists())

    def test_invalid_call_wait_budget_is_rejected_before_search_or_provider_io(self):
        for value in (None, True, 0, -1, 1801, 240.0, "240"):
            with self.subTest(value=value):
                message = self.message()
                message["configuration"]["call_timeout_seconds"] = value
                with self.assertRaisesRegex(ValueError, "call_timeout_seconds"):
                    asyncio.run(respond(message, calls_factory=FixtureCalls))
                with self.assertRaisesRegex(ValueError, "call_timeout_seconds"):
                    asyncio.run(
                        search(
                            self.root / "invalid-wait",
                            TAU_SOURCE,
                            {**self.config, "call_timeout_seconds": value},
                            preflight=True,
                        )
                    )
                self.assertFalse((self.root / "calls/submitted.jsonl").exists())
                self.assertFalse((self.root / "invalid-wait/input.json").exists())

    def test_unknown_turn_remains_unknown_during_inspection(self):
        message = self.message()
        with (
            patch.object(
                FixtureCalls, "call", side_effect=RuntimeError("unknown model turn")
            ) as call,
            patch.object(FixtureCalls, "inspect", return_value=("unknown", None)),
        ):
            with self.assertRaisesRegex(RuntimeError, "unknown model turn"):
                asyncio.run(respond(message, calls_factory=FixtureCalls))
            self.assertEqual(
                asyncio.run(respond({**message, "action": "inspect"}, calls_factory=FixtureCalls)),
                {"state": "unknown"},
            )
            self.assertEqual(call.await_count, 1)
        self.assertFalse(list((self.root / "operations").glob("*/receipt.json")))

    def test_capabilities_do_not_claim_hard_budgets_or_cancellation(self):
        message = self.message()
        description = asyncio.run(
            respond({**message, "action": "describe"}, calls_factory=FixtureCalls)
        )
        self.assertTrue(description["capabilities"]["inspect"])
        for key in ("cancel", "generationBudget", "hardDollarBudget", "evidenceProjection"):
            self.assertFalse(description["capabilities"][key])
        message["request"]["generationLimits"] = {"tokens": 5}
        with self.assertRaisesRegex(ValueError, "hard generation"):
            asyncio.run(respond(message, calls_factory=FixtureCalls))
        self.assertFalse((self.root / "calls/submitted.jsonl").exists())

    def test_native_grading_preserves_private_partition_and_cached_operation(self):
        message = self.message(partition="validation")
        before = asyncio.run(respond({**message, "action": "inspect"}, calls_factory=FixtureCalls))
        self.assertEqual(before, {"state": "not_submitted"})
        result = asyncio.run(respond(message, calls_factory=FixtureCalls))
        self.assertEqual(result["evidence"][0]["score"], 1)
        self.assertEqual(result["physicalAttempts"], 1)
        self.assertEqual(result["usage"], {})
        sample = result["provenance"]["samples"][0]
        self.assertEqual(sample["partition"], "validation")
        self.assertEqual(
            read_json(Path(sample["path"]) / "result.json")["observation"]["record"]["partition"],
            "validation",
        )
        submitted = (self.root / "calls/submitted.jsonl").read_text()
        self.assertEqual(
            asyncio.run(respond({**message, "action": "inspect"}, calls_factory=FixtureCalls)),
            {"state": "complete", "receipt": result},
        )
        # Losing the operation receipt still reconstructs it from the same model observations.
        next((self.root / "operations").glob("*/receipt.json")).unlink()
        self.assertEqual(
            asyncio.run(respond({**message, "action": "inspect"}, calls_factory=FixtureCalls)),
            {"state": "complete", "receipt": result},
        )
        self.assertEqual((self.root / "calls/submitted.jsonl").read_text(), submitted)

    def test_partial_solver_is_not_a_zero_score(self):
        result = asyncio.run(respond(self.message(max_steps=4), calls_factory=FixtureCalls))
        self.assertEqual(result["evidence"][0]["status"], "scoring_failed")
        self.assertIsNone(result["evidence"][0]["score"])
        self.assertEqual(result["physicalAttempts"], 1)

    def test_interrupted_adaptive_loop_inspection_does_not_submit_missing_calls(self):
        message = self.message()
        with self.assertRaisesRegex(OSError, "lost completed"):
            asyncio.run(respond(message, calls_factory=InterruptedCalls))
        submitted = (self.root / "calls/submitted.jsonl").read_text()
        inspection = asyncio.run(
            respond({**message, "action": "inspect"}, calls_factory=InterruptedCalls)
        )
        self.assertEqual(inspection, {"state": "resumable"})
        self.assertEqual((self.root / "calls/submitted.jsonl").read_text(), submitted)
        result = asyncio.run(respond(message, calls_factory=InterruptedCalls))
        self.assertEqual(result["evidence"][0]["score"], 1)
        keys = (self.root / "calls/submitted.jsonl").read_text().splitlines()
        self.assertEqual(len(keys), len(set(keys)))
        trace = read_json(Path(result["provenance"]["samples"][0]["path"]) / "trajectory.json")
        self.assertEqual(len(trace["final"]["orders"]["#G100"]["payment_history"]), 2)

    def test_meta_never_receives_private_tasks_or_gold_payloads(self):
        message = self.message()
        train = message["configuration"]["train_task_ids"][0]
        candidate = CandidateRef("run", "anchor", digest("candidate"))
        call = Meta("Improve", {"type": "object"})(
            MetaInput(candidate, (train,), data={"current_prompt": "initial"}), key="meta"
        )
        request = {
            "runId": "run",
            "operationId": digest("meta"),
            "operation": {"kind": "diagnose_seed", "task_ids": [train]},
            "operatorCall": {
                "effect": call.effect,
                "materials": [
                    {
                        "ref": {"kind": "assessment"},
                        "value": {"feedback": "TRAIN_FEEDBACK"},
                        "files": {
                            "prompt": {"content": base64.b64encode(b"training prompt").decode()}
                        },
                    }
                ],
            },
        }
        context = {
            "tasks": [
                {"id": train, "instruction": "TRAIN"},
                {"id": "validation-task", "instruction": "PRIVATE_DEV"},
            ]
        }
        jobs = prepare_jobs(message["configuration"], context, request)
        self.assertIn("TRAIN_FEEDBACK", jobs[0]["prompt"])
        self.assertNotIn("PRIVATE_DEV", jobs[0]["prompt"])
        request["operation"]["task_ids"] = ["validation-task"]
        with self.assertRaisesRegex(ValueError, "training scope"):
            prepare_jobs(message["configuration"], context, request)

    def test_slot_partition_task_payload_and_extra_candidate_resources_are_rejected(self):
        for change in ("partition", "instruction", "slots", "extensions"):
            message = self.message()
            key = message["request"]["slots"][0]["taskId"]
            if change == "partition":
                bundle = json.loads(message["context"]["benchmark"]["verifiers"][key]["expected"])
                bundle["partition"] = "test"
                message["context"]["benchmark"]["verifiers"][key]["expected"] = json.dumps(bundle)
            elif change == "instruction":
                message["context"]["benchmark"]["tasks"][0]["instruction"] = "changed task"
            elif change == "slots":
                message["request"]["slots"].append(message["request"]["slots"][0])
            else:
                (self.root / "targets/anchor/.pi/extensions/unsupported.js").write_text("fixture")
            with self.subTest(change=change), self.assertRaises(ValueError):
                prepare_jobs(message["configuration"], message["context"], message["request"])


@unittest.skipUnless(
    os.environ.get("GEAR_TEST_SENTINEL_RUNTIME"), "explicit CLI/worker integration"
)
class RetailRuntimeTests(RetailSearchFixture):
    def test_incomplete_training_retains_anchor_without_selecting_or_resubmitting(self):
        async def run():
            provider = ROOT / "python/tests/fixtures/sentinel_provider.py"
            for phase in ("training", "candidate_training"):
                with self.subTest(phase=phase):
                    config = {**self.config, "max_steps": 1}
                    if phase == "training":
                        config["harness"] += " SOLVE_WITH_TOOLS"
                    workspace = self.root / phase
                    result = await search(workspace, TAU_SOURCE, config, provider_script=provider)
                    self.assertEqual(result["status"], "incomplete_training_evidence")
                    self.assertIsNone(result["selected"])
                    self.assertEqual(result["retained"]["candidate_id"], "anchor")
                    self.assertEqual(result["harness"], config["harness"])
                    self.assertFalse(result["test_opened"])
                    journal = read_json(
                        workspace / "project/.gear/runs" / result["run_id"] / "journal.json"
                    )
                    self.assertFalse(journal["heldOutEvidence"])
                    self.assertTrue(
                        any(
                            row["score"] is None
                            for operation in journal["operations"]
                            for row in operation["receipt"]["evidence"]
                        )
                    )
                    submitted = (workspace / "calls/submitted.jsonl").read_text()
                    if phase == "training":
                        self.assertNotIn("/meta", submitted)
                    else:
                        self.assertEqual(result["physical_attempts"], 5)
                    (workspace / "result.json").unlink()
                    self.assertEqual(
                        result,
                        await search(workspace, TAU_SOURCE, config, provider_script=provider),
                    )
                    self.assertEqual(submitted, (workspace / "calls/submitted.jsonl").read_text())

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

    def test_formal_run_repair_training_gate_frozen_admission_and_recovery(self):
        async def run():
            provider = ROOT / "python/tests/fixtures/sentinel_provider.py"
            workspace = self.root / "search"
            await search(
                workspace, TAU_SOURCE, self.config, provider_script=provider, preflight=True
            )
            self.assertFalse((workspace / "calls/submitted.jsonl").exists())
            result = await search(workspace, TAU_SOURCE, self.config, provider_script=provider)
            self.assertFalse(result["test_opened"])
            self.assertIn("SOLVE_WITH_TOOLS", result["harness"])
            self.assertEqual([row["status"] for row in result["constraints"]], ["reject", "allow"])
            self.assertEqual([row["accepted"] for row in result["training_gates"]], [True])
            self.assertEqual(result["physical_attempts"], 6)
            submitted = (workspace / "calls/submitted.jsonl").read_text()
            (workspace / "result.json").unlink()  # Outer acknowledgement lost after Gear completed.
            self.assertEqual(
                result, await search(workspace, TAU_SOURCE, self.config, provider_script=provider)
            )
            self.assertEqual(submitted, (workspace / "calls/submitted.jsonl").read_text())
            self.assertEqual(
                len(list((workspace / "project/.gear/runs").glob("*/journal.json"))), 1
            )
            with self.assertRaises(ValueError):
                await search(
                    workspace,
                    TAU_SOURCE,
                    {**self.config, "harness": "changed"},
                    provider_script=provider,
                )
            expanded = copy.deepcopy(self.pool_config)
            fixed = copy.deepcopy(expanded["fixed"][0])
            fixed["task"].update(
                id="new-training", ticket="TRAIN_NEW Please cancel my unneeded order #G100."
            )
            expanded["fixed"].append(fixed)
            expanded["fixed_count"] = 2
            await build_pool(self.root / "expanded-pool", TAU_SOURCE, expanded)
            following = {
                **self.config,
                "harness": result["harness"],
                "pool_workspace": str(self.root / "expanded-pool"),
            }
            second = await search(
                self.root / "following", TAU_SOURCE, following, provider_script=provider
            )
            self.assertNotEqual(result["run_id"], second["run_id"])
            self.assertFalse(second["test_opened"])
            self.assertEqual(
                result, await search(workspace, TAU_SOURCE, self.config, provider_script=provider)
            )

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

    def test_incomplete_pool_is_not_admitted(self):
        async def run():
            await build_pool(
                self.root / "short-pool", TAU_SOURCE, {**self.pool_config, "generated_count": 2}
            )
            with self.assertRaisesRegex(ValueError, "no fallback"):
                await search(
                    self.root / "search",
                    TAU_SOURCE,
                    {**self.config, "pool_workspace": str(self.root / "short-pool")},
                )
            self.assertFalse((self.root / "search/project").exists())

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
