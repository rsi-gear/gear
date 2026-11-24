"""Verified repair context enters real fixed-weight search without becoming a new task."""

import asyncio
import copy
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from gear import Project
from gear.canonical import digest
from gear.core import CandidateRef, Meta, MetaInput

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "examples/curriculum-harness"))
from agentr_harness import CONTEXT_NOTE, prepare_context, usage  # noqa: E402
from fixtures.agentr_calls import AgentRCalls  # noqa: E402
from fixtures.agentr_provider import FixtureCalls, InterruptedCalls  # noqa: E402
from ifeval import read_json, write_json  # noqa: E402
from sentinel_collect import RetailCollector  # noqa: E402
from sentinel_pool import build_pool  # noqa: E402
from sentinel_provider import prepare_jobs, respond  # noqa: E402
from sentinel_search import search  # noqa: E402
from test_agentr_retail import TAU_SOURCE, AgentRFixture  # noqa: E402


class UsageTests(unittest.TestCase):
    def test_missing_token_usage_does_not_become_zero_or_partial_total(self):
        self.assertEqual(
            usage([{"logical_calls": 2, "tokens": 100}, {"logical_calls": 3}]), {"logical_calls": 5}
        )


class AgentRSearchFixture(AgentRFixture):
    def setUp(self):
        super().setUp()
        _, self.repair_result = self.generate()
        task = self.source_config["task"]
        other = {
            **copy.deepcopy(task),
            "id": "second-training-task",
            "ticket": "TRAIN_OTHER Please cancel my unneeded order #G100.",
        }
        pool_config = {
            **{
                key: self.source_config[key]
                for key in ("schema_version", "partition", "family", "database", "user_id")
            },
            "fixed": [
                {
                    "task": value,
                    "reference": self.reference,
                    "evidence_refs": [{"fixture": "authored training source"}],
                }
                for value in (task, other)
            ],
            "generated": [],
            "fixed_count": 2,
            "generated_count": 0,
            "seed": 17,
        }
        self.pool = asyncio.run(build_pool(self.root / "pool", TAU_SOURCE, pool_config))
        self.admitted = {
            "train-source" if row["task"]["id"] == task["id"] else "train-other": row
            for row in self.pool["selected"]
        }
        self.admitted = {
            key: {**value, "gear_task_id": key} for key, value in self.admitted.items()
        }
        self.validation, self.test = [
            {
                **{key: self.source_config[key] for key in ("database", "user_id", "reference")},
                "partition": partition,
                "family": "retail-" + partition,
                "task": {
                    **copy.deepcopy(task),
                    "id": partition + "-task",
                    "ticket": marker + " Cancel my unneeded #G100.",
                },
                "evidence_refs": [{"fixture": "authored private task"}],
            }
            for partition, marker in (("validation", "PRIVATE_DEV"), ("test", "PRIVATE_TEST"))
        ]
        self.search_config = {
            "schema_version": 1,
            "pool_workspace": str(self.root / "pool"),
            "validation": [self.validation],
            "test": [self.test],
            **{key: self.source_config[key] for key in ("model", "effort", "harness", "max_steps")},
            "meta_model": "explicit-fixture",
            "max_calls": 100,
            "max_characters": 1400,
            "target_characters": 800,
            "max_repairs": 2,
            "agentr_workspaces": [str(self.root / "agentr")],
        }
        self.context = asyncio.run(self.admit())

    async def admit(self, *, train=None, config=None, workspaces=None, name="agentr-context.json"):
        return await prepare_context(
            self.root / name,
            TAU_SOURCE,
            workspaces if workspaces is not None else self.search_config["agentr_workspaces"],
            self.admitted if train is None else train,
            self.search_config if config is None else config,
        )

    def meta_message(self, tasks=("train-source",), *, operation="meta"):
        call = Meta(
            "Revise the proposed prompt",
            {
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
                "additionalProperties": False,
            },
        )(
            MetaInput(
                CandidateRef("run", "anchor", digest("candidate")),
                tasks,
                data={"current_prompt": self.source_config["harness"]},
            ),
            key="meta",
        )
        return {
            "action": "submit",
            "configuration": {
                "calls": str(self.root / "calls"),
                "receipts": str(self.root / "operations"),
                "tau2_source": TAU_SOURCE,
                "model": "explicit-fixture",
                "effort": "low",
                "max_calls": 100,
                "max_steps": 8,
                "train_task_ids": list(self.admitted),
                "validation_task_ids": ["private-dev"],
                "test_task_ids": ["private-test"],
                "agentr_context": self.context,
            },
            "context": {
                "tasks": [
                    {"id": key, "instruction": value["task"]["ticket"], "family": value["family"]}
                    for key, value in self.admitted.items()
                ]
                + [
                    {"id": "private-dev", "instruction": "PRIVATE_DEV"},
                    {"id": "private-test", "instruction": "PRIVATE_TEST"},
                ]
            },
            "request": {
                "runId": "run",
                "operationId": digest(operation),
                "operation": {
                    "kind": "diagnose_seed",
                    "candidate_id": "anchor",
                    "task_ids": list(tasks),
                },
                "operatorCall": {"effect": call.effect, "materials": []},
            },
        }


class AgentRContextTests(AgentRSearchFixture):
    def test_replayed_public_projection_has_separate_costs_and_no_new_tasks(self):
        manifest = read_json(Path(self.context["path"]))
        self.assertEqual(self.context["task_ids"], ["train-source"])
        self.assertEqual(self.context["digest"], digest(manifest))
        self.assertEqual(manifest["generation_usage"], self.repair_result["model_usage"])
        self.assertEqual(
            manifest["source_collection_usage"],
            {
                "logical_calls": self.source["model_usage"]["completed_calls"],
                "tokens": self.source["model_usage"]["tokens"],
            },
        )
        self.assertEqual(self.pool["requested"], {"fixed": 2, "generated": 0})
        with patch(
            "model_calls.TextCalls.__aenter__", side_effect=AssertionError("no SDK in admission")
        ):
            self.assertEqual(self.context, asyncio.run(self.admit()))
        row = manifest["tasks"]["train-source"]["repairs"][0]
        self.assertEqual(row["restoration"]["shared_prefix_steps"], 3)
        self.assertEqual(row["restoration"]["failed_through_step"], 4)
        self.assertEqual(row["verdict"]["repaired_native_reward"], 1)
        encoded = json.dumps(row)
        for hidden in (
            "evaluation_criteria",
            "user_scenario",
            "database_digest",
            "execution-proof",
            "reference.json",
        ):
            self.assertNotIn(hidden, encoded)
        self.assertNotIn("initial", row)
        self.assertNotIn("final", row)
        self.assertEqual(asyncio.run(self.admit()), self.context)

    def test_repair_is_bound_to_native_training_task_family_and_baseline(self):
        for name, train, config in (
            ("unadmitted", {"train-other": self.admitted["train-other"]}, self.search_config),
            (
                "family",
                {"train-source": {**self.admitted["train-source"], "family": "foreign"}},
                self.search_config,
            ),
            (
                "private",
                {"train-source": {**self.admitted["train-source"], "partition": "test"}},
                self.search_config,
            ),
            ("baseline", self.admitted, {**self.search_config, "harness": "different"}),
            ("model", self.admitted, {**self.search_config, "model": "different"}),
        ):
            with self.subTest(name=name), self.assertRaises(ValueError):
                asyncio.run(self.admit(train=train, config=config, name=name + ".json"))
            self.assertFalse((self.root / (name + ".json")).exists())
        with self.assertRaisesRegex(ValueError, "counted twice"):
            asyncio.run(self.admit(workspaces=self.search_config["agentr_workspaces"] * 2))
        _, result = self.generate(
            calls=AgentRCalls(self.reference["steps"], mode="repair_failed"), directory="failed"
        )
        self.assertEqual(result["status"], "repair_failed")
        with self.assertRaisesRegex(ValueError, "successful repair"):
            asyncio.run(self.admit(workspaces=[str(self.root / "failed")]))

    def test_meta_sees_only_operation_task_material_and_can_consume_it(self):
        message = self.meta_message()
        jobs = prepare_jobs(message["configuration"], message["context"], message["request"])
        scoped = json.loads(jobs[0]["prompt"].split(CONTEXT_NOTE, 1)[1])["agentr_repairs"]
        self.assertEqual([row["task_id"] for row in scoped], ["train-source"])
        for private in (
            "PRIVATE_DEV",
            "PRIVATE_TEST",
            "TRAIN_OTHER",
            str(self.root),
            "source_collection_usage",
            "evaluation_criteria",
        ):
            self.assertNotIn(private, jobs[0]["prompt"])
        receipt = asyncio.run(respond(message, calls_factory=FixtureCalls))
        self.assertIn("CHECK_TARGET_ORDER", receipt["result"]["data"]["data"]["text"])
        self.assertEqual(receipt["provenance"]["agentr_context"]["task_ids"], ["train-source"])
        other = self.meta_message(("train-other",), operation="other")
        jobs = prepare_jobs(other["configuration"], other["context"], other["request"])
        self.assertNotIn(CONTEXT_NOTE, jobs[0]["prompt"])
        receipt = asyncio.run(respond(other, calls_factory=FixtureCalls))
        self.assertNotIn("CHECK_TARGET_ORDER", receipt["result"]["data"]["data"]["text"])
        self.assertNotIn("agentr_context", receipt["provenance"])

    def test_changed_manifest_scope_and_instruction_fail_before_sdk(self):
        original = read_json(Path(self.context["path"]))
        for change in ("bytes", "scope", "instruction"):
            message = self.meta_message()
            if change == "bytes":
                modified = copy.deepcopy(original)
                modified["tasks"]["train-source"]["repairs"][0]["critic"]["judgment"]["reason"] = (
                    "tampered"
                )
                write_json(Path(self.context["path"]), modified)
            elif change == "scope":
                message["configuration"]["agentr_context"] = {
                    **self.context,
                    "task_ids": ["private-test"],
                }
            else:
                next(row for row in message["context"]["tasks"] if row["id"] == "train-source")[
                    "instruction"
                ] = "different"
            with (
                self.subTest(change=change),
                patch.object(
                    FixtureCalls, "__aenter__", side_effect=AssertionError("must reject before SDK")
                ),
                self.assertRaises(ValueError),
            ):
                asyncio.run(respond(message, calls_factory=FixtureCalls))
            write_json(Path(self.context["path"]), original)
        self.assertFalse((self.root / "calls/submitted.jsonl").exists())

    def test_paid_meta_response_recovery_preserves_context_without_submission(self):
        message = self.meta_message()
        with self.assertRaisesRegex(OSError, "lost completed"):
            asyncio.run(respond(message, calls_factory=InterruptedCalls))
        submitted = (self.root / "calls/submitted.jsonl").read_text()
        result = asyncio.run(
            respond({**message, "action": "inspect"}, calls_factory=InterruptedCalls)
        )
        self.assertEqual(result["state"], "complete")
        self.assertEqual(
            result["receipt"]["provenance"]["agentr_context"]["digest"], self.context["digest"]
        )
        self.assertEqual((self.root / "calls/submitted.jsonl").read_text(), submitted)
        next((self.root / "operations").glob("*/receipt.json")).unlink()
        self.assertEqual(
            result,
            asyncio.run(respond({**message, "action": "inspect"}, calls_factory=InterruptedCalls)),
        )
        self.assertEqual((self.root / "calls/submitted.jsonl").read_text(), submitted)


@unittest.skipUnless(
    os.environ.get("GEAR_TEST_SENTINEL_RUNTIME"), "explicit CLI/worker integration"
)
class AgentRRuntimeTests(AgentRSearchFixture):
    def test_repairs_enter_formal_meta_constraints_gate_and_native_holdout(self):
        async def run():
            workspace = self.root / "search"
            provider = ROOT / "python/tests/fixtures/agentr_provider.py"
            await search(
                workspace, TAU_SOURCE, self.search_config, provider_script=provider, preflight=True
            )
            self.assertFalse((workspace / "calls/submitted.jsonl").exists())
            profiles = [
                read_json(path)["configuration"] for path in (self.root / "profiles").glob("*.json")
            ]
            self.assertEqual(sum("agentr_context" in value for value in profiles), 1)
            result = await search(
                workspace, TAU_SOURCE, self.search_config, provider_script=provider
            )
            self.assertIn("CHECK_TARGET_ORDER", result["harness"])
            self.assertEqual([row["status"] for row in result["constraints"]], ["reject", "allow"])
            self.assertEqual([row["accepted"] for row in result["training_gates"]], [True])
            self.assertEqual(result["physical_attempts"], 6)
            self.assertFalse(result["test_opened"])
            self.assertEqual(len(result["task_ids"]["train"]), 2)
            self.assertEqual(result["agentr_generation_usage"], self.repair_result["model_usage"])
            self.assertEqual(
                result["agentr_source_collection_usage"],
                {
                    "logical_calls": self.source["model_usage"]["completed_calls"],
                    "tokens": self.source["model_usage"]["tokens"],
                },
            )
            manifest = read_json(workspace / "agentr-context.json")
            self.assertEqual(result["agentr_context_digest"], digest(manifest))
            meta_requests = []
            for path in (workspace / "calls").glob("*.json"):
                request = read_json(path)["request"]
                if request["key"].endswith("/meta"):
                    self.assertIn(CONTEXT_NOTE, request["prompt"])
                    meta_requests.append(request)
                    for hidden in (
                        "PRIVATE_DEV",
                        "PRIVATE_TEST",
                        "evaluation_criteria",
                        "database_digest",
                        "user_scenario",
                    ):
                        self.assertNotIn(hidden, request["prompt"])
                elif "/solve/" in request["key"]:
                    self.assertEqual(
                        set(json.loads(request["prompt"])), {"policy", "tools", "conversation"}
                    )
            self.assertEqual(len(meta_requests), 2)
            submissions = (workspace / "calls/submitted.jsonl").read_text()
            (workspace / "result.json").unlink()
            self.assertEqual(
                result,
                await search(workspace, TAU_SOURCE, self.search_config, provider_script=provider),
            )
            self.assertEqual(submissions, (workspace / "calls/submitted.jsonl").read_text())
            # A drift after the final Meta call must not replace validated costs
            # in the outer result. Inspecting the completed run does not resubmit.
            original_report = Project.areport

            async def changed_after_report(project, *args, **kwargs):
                report = await original_report(project, *args, **kwargs)
                changed = copy.deepcopy(manifest)
                changed["generation_usage"]["logical_calls"] = 0
                write_json(workspace / "agentr-context.json", changed)
                return report

            (workspace / "result.json").unlink()
            with (
                patch.object(Project, "areport", changed_after_report),
                self.assertRaisesRegex(ValueError, "context changed"),
            ):
                await search(workspace, TAU_SOURCE, self.search_config, provider_script=provider)
            self.assertFalse((workspace / "result.json").exists())
            self.assertEqual(submissions, (workspace / "calls/submitted.jsonl").read_text())
            write_json(workspace / "agentr-context.json", manifest)
            self.assertEqual(
                result,
                await search(workspace, TAU_SOURCE, self.search_config, provider_script=provider),
            )
            with self.assertRaises(ValueError):
                await search(
                    workspace,
                    TAU_SOURCE,
                    {
                        key: value
                        for key, value in self.search_config.items()
                        if key != "agentr_workspaces"
                    },
                    provider_script=provider,
                )
            control_config = {
                key: value
                for key, value in self.search_config.items()
                if key != "agentr_workspaces"
            }
            control = await search(
                self.root / "control", TAU_SOURCE, control_config, provider_script=provider
            )
            self.assertNotIn("CHECK_TARGET_ORDER", control["harness"])
            self.assertEqual(result["task_ids"], control["task_ids"])
            self.assertFalse(control["test_opened"])
            verdicts = []
            for name, harness in (
                ("baseline", self.search_config["harness"]),
                ("selected", result["harness"]),
            ):
                sample = {
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
                    "model": self.search_config["model"],
                    "effort": self.search_config["effort"],
                    "harness": harness,
                    "max_steps": 8,
                    "max_calls": 24,
                    "sample_id": "final-" + name,
                    "attempt": 0,
                }
                async with FixtureCalls(self.root / ("final-calls-" + name), max_calls=24) as calls:
                    final = await RetailCollector(
                        self.root / ("final-" + name), TAU_SOURCE, sample, calls
                    ).collect()
                self.assertEqual(final["observation"]["record"]["partition"], "test")
                verdicts.append(final["observation"]["record"]["passed"])
            self.assertEqual(verdicts, [False, True])

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
