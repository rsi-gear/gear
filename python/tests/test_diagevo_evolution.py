"""Accepted native memory -> next challenger; controller decisions remain fixtures."""

import copy
import importlib.util
import json
import os
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import test_diagevo_memory_pipeline as memory_tests
import test_diagevo_tasks as task_tests
from gear.training.pipelines.diagevo_challenger import build_loop
from gear.training.recipes import diagevo_evolution as evolution
from gear.training.recipes.diagevo_generation import DiagEvoQuestionPrompt
from gear.training.storage.content import ContractError, digest_json


@unittest.skipUnless(
    os.environ.get("GEAR_DIAGEVO_HITCH_PATH")
    and all(
        importlib.util.find_spec(name)
        for name in (
            "torch",
            "transformers",
            "tokenizers",
            "safetensors",
            "math_verify",
            "nltk",
            "sklearn",
            "openai_codex",
        )
    ),
    "set GEAR_DIAGEVO_HITCH_PATH and install CPU training/agents dependencies",
)
class NextChallengerTests(unittest.TestCase):
    def setUp(self):
        native = memory_tests.SolverMemoryPipelineTests()
        native.setUp()
        self.addCleanup(native.doCleanups)
        native.test_fresh_challenger_construction_continues_to_solver_memory()
        self.native, self.store, self.root = native, native.store, native.root
        artifacts = json.loads((self.root / "artifacts.body.json").read_text())
        handle = {
            "schemaVersion": 1,
            "provider": "slime",
            "jobId": "fixture-node-job",
            "requestDigest": digest_json(native.request),
        }
        artifacts.update(
            handle=handle,
            schemaVersion=1,
            resourcesReleased=True,
            usage={"gpuSeconds": 0, "rolloutTokens": 4, "groupResamples": 0},
        )
        # Acceptance is an explicit controller-decision double. The model,
        # committed batches, memory, receipts and HF files are actual artifacts.
        self.accepted = {
            "id": native.request["trainingRunId"],
            "request": native.request,
            "handle": handle,
            "candidateRef": self.store.put_json(artifacts["model"]),
            "artifactsRef": self.store.put_json(artifacts),
            "phase": "accepted",
            "execution": "completed",
            "decision": {"outcome": "accepted", "reasons": []},
            "resourcesReleased": True,
            "evaluationTasksCompleted": True,
        }
        construction = self.store.read_json(
            native.request["trainer"]["scriptConfig"]["constructionRef"]
        )
        source_request = self.store.read_json(construction["challengerRequestRef"])
        source_request = copy.deepcopy(source_request)
        source_request["trainDataset"]["exactDataAuthorized"] = True
        source_request["trainDataset"]["snapshotRef"] = self.store.put_json(
            {"fixture": "authorized-source"}
        )
        for task in source_request["trainDataset"]["tasks"]:
            task["family"] = "authorized-math"
        # Reuse the real controller fixture configuration; start this new
        # challenger from the genuine frozen HF seed, not a GPU-certified model.
        helper = task_tests.SolverTaskHandoffTests()
        helper.store, helper.root = self.store, self.root
        helper.pipeline = SimpleNamespace(
            fresh=SimpleNamespace(request=source_request),
            solver_model={"modelRef": native.request["parentModelRef"]},
        )
        helper.hitch = [
            "node",
            str(Path(os.environ["GEAR_DIAGEVO_HITCH_PATH"]) / "dist/bin/hitch.js"),
        ]
        self.spec, self.config = helper.template()
        self.spec["trainer"]["script"] = source_request["trainer"]["script"]
        self.spec["trainer"]["scriptConfig"] = {
            key: source_request["trainer"]["scriptConfig"][key] for key in ("objective", "solver")
        }
        self.config_file = self.root / "controller.json"
        self.config_file.write_text(json.dumps(self.config))
        self.hitch, self.gear = (
            helper.hitch,
            ["node", str(Path(__file__).resolve().parents[2] / "lib/cli.js")],
        )
        self.task_options = {
            "environmentImage": "node@sha256:" + "a" * 64,
            "verifierImage": "python@sha256:" + "b" * 64,
            "sourceLicense": "LicenseRef-ContractFixture",
            "agentTimeoutSeconds": 60,
            "setupTimeoutSeconds": 120,
            "verifierTimeoutSeconds": 30,
            "maxResponseBytes": 4096,
        }

    def prepare(self, *, round_index=1, root=None, **overrides):
        arguments = {
            "challenger_spec": self.spec,
            "solver_model_ref": self.accepted["candidateRef"],
            "prompt": DiagEvoQuestionPrompt().describe().to_dict(),
            "round_index": round_index,
            "seed": 17,
            "max_seconds": 30,
            "hitch_command": self.hitch,
            "task_options": self.task_options,
            "previous_solver": self.accepted if round_index else None,
            "first_solver": self.accepted if round_index else None,
        }
        return evolution.prepare_challenger_job(
            self.store, root or self.root / f"round-{round_index}", **{**arguments, **overrides}
        )

    def test_real_committed_memory_is_scheduled_sealed_admitted_and_consumed_by_factory(self):
        memory = evolution.accepted_solver_memory(self.store, self.accepted)
        self.assertEqual(memory["frequency"], 1)
        self.assertEqual(memory["memoryRef"], self.native.result()[0])
        ref = self.prepare()
        prepared = self.store.read_json(ref)
        schedule = self.store.read_json(prepared["scheduleRef"])
        spec = self.store.read_json(prepared["specRef"])
        self.assertEqual(schedule["firstRoundFrequency"], 1)
        self.assertEqual(schedule["memoryRef"], schedule["firstMemoryRef"])
        self.assertEqual(
            schedule["freshGeneration"]["memory"], self.native.result()[1]["memory"]["memory"]
        )
        self.assertEqual(len(schedule["prompts"]), 2)
        for key, directive in schedule["freshGeneration"]["directives"].items():
            if directive["mode"] != "free":
                self.assertIn(
                    memory_tests.DiagnosticSDKFixture.phrase,
                    schedule["prompts"][key][-1]["content"],
                )
        expected = copy.deepcopy(self.spec)
        expected["datasets"]["train"] = spec["datasets"]["train"]
        expected["trainer"]["scriptConfig"] = spec["trainer"]["scriptConfig"]
        self.assertEqual(spec, expected)
        calls = len(self.native.client.turns)
        with patch.object(
            evolution.diagevo_tasks,
            "_command",
            side_effect=AssertionError("must not compile twice"),
        ):
            self.assertEqual(self.prepare(), ref)
        admitted = evolution.admit_challenger_job(
            self.store, ref, controller_config=self.config_file, gear_command=self.gear
        )
        self.assertEqual(admitted["run"]["request"]["trainer"], spec["trainer"])
        self.assertEqual(
            evolution.admit_challenger_job(
                self.store, ref, controller_config=self.config_file, gear_command=self.gear
            ),
            admitted,
        )
        runtime = SimpleNamespace(
            store=self.store,
            request=admitted["run"]["request"],
            config={},
            job_dir=self.root / "next-challenger",
        )
        loop = build_loop({"parameters": spec["trainer"]["scriptConfig"]}, runtime)
        self.assertIsNotNone(loop)
        self.assertEqual(len(self.native.client.turns), calls)

    def test_round_zero_has_no_memory_and_drift_does_not_silently_reset_the_schedule(self):
        ref = self.prepare(round_index=0)
        schedule = self.store.read_json(self.store.read_json(ref)["scheduleRef"])
        self.assertEqual(schedule["freshGeneration"]["memory"], [])
        self.assertEqual(
            {row["mode"] for row in schedule["freshGeneration"]["directives"].values()}, {"free"}
        )
        with self.assertRaisesRegex(ContractError, "empty memory"):
            self.prepare(round_index=0, previous_solver=self.accepted)
        with self.assertRaisesRegex(ContractError, "handoff input changed"):
            self.prepare(round_index=0, seed=18)
        with self.assertRaisesRegex(ContractError, "previous and first"):
            self.prepare(first_solver=None)
        with self.assertRaisesRegex(ContractError, "selected solver"):
            self.prepare(solver_model_ref=self.spec["initialModel"])

    def test_rejects_unaccepted_model_wrong_job_missing_receipt_and_changed_frequency(self):
        for field, value in (
            ("phase", "rejected"),
            ("execution", "paused"),
            ("resourcesReleased", False),
        ):
            with (
                self.subTest(field=field),
                self.assertRaisesRegex(ContractError, "accepted controller"),
            ):
                evolution.accepted_solver_memory(self.store, {**self.accepted, field: value})
        wrong = copy.deepcopy(self.accepted)
        wrong["request"]["trainingRunId"] = "another-job"
        with self.assertRaisesRegex(ContractError, "controller job"):
            evolution.accepted_solver_memory(self.store, wrong)
        ref, memory = self.native.result()
        changed = copy.deepcopy(memory)
        cause = changed["memory"]["memory"][0]
        cause["episode_failure_ids"].append("made-up-failure")
        cause["failure_ids"].append("made-up-failure")
        read = self.store.read_json

        def corrupt(target):
            return changed if target == ref else read(target)

        with (
            patch.object(self.store, "read_json", side_effect=corrupt),
            self.assertRaisesRegex(ContractError, "consumed failures"),
        ):
            evolution.accepted_solver_memory(self.store, self.accepted)
        self.store.path(memory["callReceipts"][0]["receiptRef"]["digest"]).unlink()
        with self.assertRaises(FileNotFoundError):
            evolution.accepted_solver_memory(self.store, self.accepted)


if __name__ == "__main__":
    unittest.main()
