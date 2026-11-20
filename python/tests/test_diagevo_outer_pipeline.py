"""Two actual controller/native jobs per round; explicit CPU actor/eval/SDK doubles."""

import copy
import importlib.util
import json
import os
import subprocess
import sys
import unittest
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import test_diagevo_construction_pipeline as construction_tests
import test_diagevo_fresh_pipeline as fresh_tests
import test_diagevo_memory_pipeline as memory_tests
import test_diagevo_tasks as task_tests
from gear.training.backends.slime.driver import run as run_native
from gear.training.recipes import diagevo_run, diagevo_tasks
from gear.training.recipes.diagevo_solver import native_component
from gear.training.storage.content import digest_json
from gear.training.storage.ledger import Ledger
from gear.training.storage.models import seal_hf


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
class OuterPipelineTests(unittest.TestCase):
    def setUp(self):
        python = patch.dict(os.environ, {"GEAR_PYTHON": sys.executable})
        python.start()
        self.addCleanup(python.stop)
        construction = construction_tests.ConstructionPipelineTests()
        construction.setUp()
        self.addCleanup(construction.doCleanups)
        construction.ready_solver()
        self.store, self.root = construction.store, construction.root
        self.updated_challenger = construction.fresh.updated
        self.hitch = [
            "node",
            str(Path(os.environ["GEAR_DIAGEVO_HITCH_PATH"]) / "dist/bin/hitch.js"),
        ]
        source = construction.fresh.request["trainDataset"]
        source["exactDataAuthorized"] = True
        source["snapshotRef"] = self.store.put_json({"fixture": "authorized-source"})
        for task in source["tasks"]:
            task["family"] = "authorized-math"
        helper = task_tests.SolverTaskHandoffTests()
        helper.root, helper.store, helper.pipeline = self.root, self.store, construction
        helper.hitch = self.hitch
        solver, config = helper.template()
        memory = memory_tests.SolverMemoryPipelineTests()
        memory.setUp()
        self.addCleanup(memory.doCleanups)
        self.copy_store(memory.store)
        solver["trainer"]["scriptConfig"] = {"memoryUpdate": memory.options}
        challenger = copy.deepcopy(solver)
        challenger_model = seal_hf(self.store, self.root / "question-model")
        challenger["initialModel"] = challenger["referenceModel"] = challenger_model["modelRef"]
        challenger["trainer"]["script"] = construction.fresh.request["trainer"]["script"]
        challenger["trainer"]["scriptConfig"] = {
            key: construction.fresh.request["trainer"]["scriptConfig"][key]
            for key in ("objective", "solver")
        }
        proof = self.store.put_json(
            {"fixture": "CPU capability declaration; not GPU certification"}
        )
        for spec in (challenger, solver):
            spec["trainer"]["runtimeLock"].update(validation="validated", probeEvidenceRefs=[proof])
            spec["evaluation"]["common"].update(
                runtimeDigest=digest_json({"engine": "diagevo-evaluation-double"}),
                protocolDigest=digest_json({"api": "chat-completions"}),
                samplingDigest=digest_json({"max_output_tokens": 16, "temperature": 0}),
            )
        self.plan = {
            "schemaVersion": 1,
            "kind": "diagevo-evolution",
            "challenger": challenger,
            "solver": solver,
            "rounds": 2,
            "seed": 17,
            "prompt": construction.fresh.prompt.describe().to_dict(),
            "freshGenerationMaxSeconds": 30,
            "maxWallClockSeconds": 600,
            "budgets": {
                "trainingGpuSeconds": 240,
                "rolloutTokens": 8000,
                "localGenerations": 36,
                "diagnosticTurns": 16,
                "embeddings": 8,
                "heldOutEvaluations": 4,
            },
            "taskOptions": {
                "sourceLicense": "LicenseRef-ContractFixture",
                "environmentImage": "node@sha256:" + "a" * 64,
                "verifierImage": "python@sha256:" + "b" * 64,
                "agentTimeoutSeconds": 60,
                "setupTimeoutSeconds": 120,
                "verifierTimeoutSeconds": 30,
                "maxResponseBytes": 4096,
            },
        }
        self.config_file = self.root / "controller.json"
        self.config_file.write_text(json.dumps(config))
        self.gear = ["node", str(Path(__file__).resolve().parents[2] / "lib/cli.js")]
        self.original_command = diagevo_tasks._command
        self.native_jobs = []
        self.lose_advance_reply = False
        self.sdk = memory_tests.DiagnosticSDKFixture(lambda: None)

    def copy_store(self, source):
        for path in (source.root / "objects").glob("*/*"):
            self.store.put_bytes(path.read_bytes(), "application/octet-stream")

    def execute_native(self, request):
        role = "challenger" if "objective" in request["trainer"]["scriptConfig"] else "solver"
        if role == "challenger":
            fixture = fresh_tests.FreshPipelineTests()
            fixture.setUp()
            self.addCleanup(fixture.doCleanups)
            driver = fixture.driver
            self.copy_store(fixture.store)
            fixture.store = fixture.native.store = self.store
            fixture.request = request
            fixture.updated = self.updated_challenger
            fixture.native.questions = {
                key: messages[-1]["content"]
                for key, messages in request["trainer"]["scriptConfig"]["prompts"].items()
            }
            driver.train = lambda *_: driver.d.rt.train()
            runtime = fixture.native.native
            output_hf = self.updated_challenger
        else:
            fixture = memory_tests.SolverMemoryPipelineTests()
            fixture.setUp()
            self.addCleanup(fixture.doCleanups)
            driver = fixture.driver
            self.copy_store(fixture.store)
            fixture.store = fixture.fixture.store = self.store
            fixture.request = request
            fixture.client = self.sdk
            construction = self.store.read_json(
                request["trainer"]["scriptConfig"]["constructionRef"]
            )
            pool = self.store.read_json(construction["curriculumRef"])
            fixture.fixture.questions = pool["input"]["questions"]
            runtime = fixture.native
            output_hf = request["parentModel"]["hfSnapshotRef"]
        directory = self.root / "native-jobs" / request["trainingRunId"]
        directory.mkdir(parents=True)
        (directory / "worker.json").write_text(
            json.dumps({"incarnation": "fixture-" + request["trainingRunId"]})
        )
        driver.d.root, driver.d.store, driver.d.request = directory, self.store, request
        driver.f.store = self.store
        driver.f.private = request["verifier"]
        driver.config["storeRoot"] = str(self.store.root)
        driver.d.hf = output_hf
        committed = SimpleNamespace(driver=driver, request=request, updated=output_hf)
        driver.d.commit = lambda store, ledger, **kwargs: fresh_tests.FreshPipelineTests.commit(
            committed, store, ledger, **kwargs
        )

        @contextmanager
        def exporter(*_args):
            yield driver.d.rt.actor

        driver.d.exporter = exporter
        with runtime():
            run_native(directory)
        self.assertEqual(driver.native_events.count("train"), 1)
        self.native_jobs.append((role, request["trainingRunId"]))
        body = json.loads((directory / "artifacts.body.json").read_text())
        ledger = Ledger(directory / "ledger.sqlite")
        try:
            usage = ledger.usage()
        finally:
            ledger.close()
        body.update(
            schemaVersion=1,
            resourcesReleased=True,
            usage=usage,
            handle={
                "schemaVersion": 1,
                "provider": "slime",
                "jobId": request["trainingRunId"],
                "requestDigest": digest_json(request),
            },
        )
        target = directory / "controller-artifacts.json"
        target.write_text(json.dumps(body))
        return target

    def command(self, argv, args):
        if args[:2] != ["training", "advance"]:
            return self.original_command(argv, args)
        current = self.original_command(argv, ["training", "status", *args[2:]])
        artifacts_file = self.execute_native(current["request"])
        bridge = Path(__file__).parent / "fixtures/diagevo_controller_step.mjs"
        try:
            result = self.original_command(
                ["node", str(bridge)], [str(self.store.root), args[2], args[3], str(artifacts_file)]
            )
        except subprocess.CalledProcessError as error:
            self.fail(error.stderr)
        if self.lose_advance_reply:
            self.lose_advance_reply = False
            raise ConnectionError("actual controller decision reply lost")
        return result

    def step(self):
        return diagevo_run.evolve(
            self.store,
            self.root / "evolution",
            plan=self.plan,
            controller_config=self.config_file,
            gear_command=self.gear,
            hitch_command=self.hitch,
        )

    def test_two_rounds_compile_admit_train_evaluate_and_reuse_accepted_memory(self):
        self.lose_advance_reply = True
        with patch.object(diagevo_tasks, "_command", self.command):
            with self.assertRaisesRegex(ConnectionError, "actual controller decision reply lost"):
                self.step()
            for _ in range(3):
                result = self.step()
            self.assertEqual(self.step(), result)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["roundsCompleted"], 2)
        self.assertEqual(
            [role for role, _ in self.native_jobs], ["challenger", "solver", "challenger", "solver"]
        )
        first_solver = self.store.read_json(result["jobs"][1]["runRef"])
        for index in (2, 3):
            run = self.store.read_json(result["jobs"][index]["runRef"])
            self.assertFalse(run["request"]["coldStart"])
            self.assertIn("resumeCheckpointRef", run["request"])
            checkpoint = self.store.read_json(
                self.store.read_json(run["candidateRef"])["trainerCheckpointRef"]
            )
            self.assertEqual(checkpoint["committedUpdate"], 2)
        prepared = self.store.read_json(result["jobs"][2]["preparedRef"])
        schedule = self.store.read_json(prepared["scheduleRef"])
        self.assertEqual(schedule["memoryRef"], result["jobs"][1]["outputRef"])
        self.assertEqual(schedule["solverModelRef"], first_solver["candidateRef"])
        self.assertEqual(result["observedControllerUsage"]["heldOutQueries"], 4)
        self.assertTrue(self.sdk.turns)

    def test_no_retained_questions_stops_before_solver_admission(self):
        parameters = self.plan["challenger"]["trainer"]["scriptConfig"]
        objective = native_component(parameters["objective"])
        objective.policy = replace(objective.policy, p_high=0.75)
        parameters["objective"] = objective.describe().to_dict()
        with patch.object(diagevo_tasks, "_command", self.command):
            result = self.step()
            self.assertEqual(self.step(), result)
        self.assertEqual(result["status"], "stopped")
        self.assertEqual(result["reason"], "no-retained-questions")
        self.assertEqual(len(self.native_jobs), 1)
        self.assertEqual(result["roundsCompleted"], 0)

    def test_no_valid_fresh_questions_does_not_resample_or_admit_solver(self):
        directory = self.root / "invalid-question-model"
        _, self.updated_challenger = fresh_tests.question_models(
            directory, self.store, response="invalid question format"
        )
        model = seal_hf(self.store, directory)
        self.plan["challenger"]["initialModel"] = model["modelRef"]
        self.plan["challenger"]["referenceModel"] = model["modelRef"]
        with patch.object(diagevo_tasks, "_command", self.command):
            result = self.step()
            self.assertEqual(self.step(), result)
        self.assertEqual(result["reason"], "no-valid-questions")
        self.assertEqual(len(self.native_jobs), 1)
        self.assertFalse(self.sdk.turns)


if __name__ == "__main__":
    unittest.main()
