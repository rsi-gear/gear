"""Real task compiler/controller admission; CPU native actor and deployment fixtures."""

import asyncio
import copy
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import test_diagevo_construction_pipeline as construction_tests
from gear.training import SLIME_COMMIT
from gear.training.pipelines.diagevo_solver import build_loop
from gear.training.recipes import diagevo_tasks
from gear.training.recipes.diagevo_completion import completion
from gear.training.storage.content import ContractError
from gear.training.storage.snapshots import materialize, seal_directory


class CompletionVerifierTests(unittest.TestCase):
    def test_actual_verifier_distinguishes_completion_from_math_and_infrastructure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "response.json"
            valid = {
                "schema_version": "1",
                "run_id": "actual-contract-fixture",
                "response": "wrong arithmetic",
                "termination": "succeeded",
                "source": "hitch-run-result",
            }
            for text in ("wrong arithmetic", r"\boxed{2}", ""):
                path.write_text(json.dumps({**valid, "response": text}))
                self.assertEqual(completion(path, 1024), {"completion": 1})
            for value in (
                {**valid, "termination": "failed"},
                {**valid, "source": "candidate"},
                {**valid, "response": []},
                {**valid, "run_id": ""},
                [],
            ):
                path.write_text(json.dumps(value))
                with self.subTest(value=value), self.assertRaises(ValueError):
                    completion(path, 1024)
            path.write_text('{"source":"a","source":"b"}')
            with self.assertRaisesRegex(ValueError, "duplicate"):
                completion(path, 1024)
            path.write_text(json.dumps(valid))
            with self.assertRaisesRegex(ValueError, "oversized"):
                completion(path, 2)
            symlink = path.with_name("link.json")
            symlink.symlink_to(path)
            with self.assertRaisesRegex(ValueError, "unsafe"):
                completion(symlink, 1024)


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
        )
    ),
    "set GEAR_DIAGEVO_HITCH_PATH and install CPU training-math/training-metrics dependencies",
)
class SolverTaskHandoffTests(unittest.TestCase):
    def setUp(self):
        self.pipeline = construction_tests.ConstructionPipelineTests()
        self.pipeline.setUp()
        self.addCleanup(self.pipeline.doCleanups)
        self.pipeline.ready_solver()
        self.store, self.root = self.pipeline.store, self.pipeline.root
        source = self.pipeline.fresh.request["trainDataset"]
        source["exactDataAuthorized"] = True
        source["snapshotRef"] = self.store.put_json({"fixture": "challenger-source"})
        for task in source["tasks"]:
            task["family"] = "authorized-math"
        self.construction_ref, self.construction, _, _ = self.pipeline.first_job()
        self.hitch = [
            "node",
            str(Path(os.environ["GEAR_DIAGEVO_HITCH_PATH"]) / "dist/bin/hitch.js"),
        ]
        self.gear = ["node", str(Path(__file__).resolve().parents[2] / "lib/cli.js")]
        self.options = {
            # Syntactic fixture pins: these tests compile files, never pull/build images.
            "environmentImage": "node@sha256:" + "a" * 64,
            "verifierImage": "python@sha256:" + "b" * 64,
            "sourceLicense": "LicenseRef-ContractFixture",
            "agentTimeoutSeconds": 60,
            "setupTimeoutSeconds": 120,
            "verifierTimeoutSeconds": 30,
            "maxResponseBytes": 4096,
        }
        self.spec, self.config = self.template()
        self.config_file = self.root / "controller.json"
        self.config_file.write_text(json.dumps(self.config))

    def split(self, name, text=None):
        task = self.root / "private-tasks" / name
        task.mkdir(parents=True, exist_ok=True)
        (task / "instruction.md").write_text(
            text if text is not None else name + " private question"
        )
        (task / "task.toml").write_text('schema_version = "1.4"\n')
        ref = seal_directory(self.store, task, dataset=True)
        return {
            "snapshotRef": ref,
            "exactDataAuthorized": False,
            "tasks": [
                {
                    "id": name,
                    "family": name,
                    "taskRef": ref,
                    "environmentRef": self.store.put_json({"fixture": name}),
                }
            ],
        }

    def template(self):
        ref = self.store.put_json({"fixture": "controller-deployment-not-GPU-evidence"})
        digest = ref["digest"]
        node = {"nodeId": "fixture-node", "generation": "fixture-boot"}
        deployment = {
            "schemaVersion": 2,
            "taskExecution": {"placement": "local", "provider": "local-docker"},
            "modelRuntime": {"nodeRef": "gpu", "launcher": "process"},
            "gpuScheduling": {"actorRollout": "colocated", "trainEvaluation": "isolated"},
            "nodes": {
                "gpu": {
                    "transport": {"type": "local"},
                    "workspace": str(self.root),
                    "python": [sys.executable],
                    "configPath": str(self.root / "node.json"),
                    "gateway": {"localPort": 31001, "nodePort": 31001},
                }
            },
        }
        trainer = copy.deepcopy(self.pipeline.fresh.request["trainer"])
        trainer.pop("placement", None)
        source = self.store.put_bytes(
            b"from gear.training.pipelines.diagevo_solver import build_loop\n",
            "application/octet-stream",
        )
        trainer.update(
            {
                "provider": "slime",
                "recipe": "agent-grpo-v1",
                "backend": "megatron",
                "checkpointEveryUpdate": True,
                "optimizerResetPolicy": "initial-cold-start-only",
                "script": {
                    "entrypoint": "recipe:build_loop",
                    "sourceRef": self.store.put_json(
                        {
                            "schemaVersion": 1,
                            "kind": "training-script-source",
                            "files": [{"path": "recipe.py", "contentRef": source}],
                        }
                    ),
                },
                "scriptConfig": {},
                "runtimeLock": {
                    "schemaVersion": 1,
                    "slimeCommit": SLIME_COMMIT,
                    "hitchCommit": "2" * 40,
                    "imageDigest": digest,
                    "pythonVersion": "3.12",
                    "cudaVersion": "fixture",
                    "pytorchVersion": "fixture",
                    "megatronCommit": "3" * 40,
                    "sglangVersion": "fixture",
                    "bridgeDigest": digest,
                    "protocolDigest": digest,
                    "patchDigests": [],
                    "validation": "pending-gpu",
                    "probeEvidenceRefs": [],
                },
            }
        )
        rollout = copy.deepcopy(self.pipeline.fresh.request["rollout"])
        rollout.update(
            {
                "provider": "hitch",
                "mode": "synchronous",
                "maxPolicyLag": 0,
                "episodeFormat": "linear-token-trajectory-v1",
                "capture": "exact-policy-tokens-v1",
                "truncation": "reject",
                "compaction": False,
                "subagents": False,
                "auxiliaryModelCalls": False,
            }
        )
        rollout["sampling"]["maxNewTokens"] = 16
        spec = {
            "schemaVersion": 2,
            "kind": "model-training",
            "name": "DiagEvo admission CPU fixture",
            "fixedHarness": {"commit": "2" * 40, "manifestRef": ref, "adapter": "model-call"},
            "initialModel": self.pipeline.solver_model["modelRef"],
            "referenceModel": self.pipeline.solver_model["modelRef"],
            "datasets": {
                "train": copy.deepcopy(self.pipeline.fresh.request["trainDataset"]),
                "dev": self.split("dev"),
                "heldOut": self.split("held-out"),
            },
            "verifier": ref,
            "trainer": trainer,
            "rollout": rollout,
            "resources": {
                "trainingDevices": [{"nodeId": node["nodeId"], "gpuUuid": "GPU-fixture"}]
            },
            "deployment": {
                "schemaVersion": 2,
                "taskExecution": {
                    **deployment["taskExecution"],
                    "providerIdentityDigest": digest,
                    "capabilitiesDigest": digest,
                },
                "modelRuntime": {**deployment["modelRuntime"], **node, "runtimeDigest": digest},
                "gpuScheduling": deployment["gpuScheduling"],
            },
            "budgets": {
                "gpuSecondsScope": "training",
                "totalGpuSeconds": 60,
                "maxRolloutTokens": 2000,
                "maxEpisodeSteps": 1,
                "maxGroupResamples": 0,
            },
            "evaluation": {
                "provider": "hitch-endpoint",
                "topology": "harbor-dataset",
                "common": {
                    "runtimeDigest": digest,
                    "protocolDigest": digest,
                    "samplingDigest": digest,
                    "budgetsDigest": digest,
                    "attempts": 1,
                },
                "policy": {
                    "minDevGain": 0.1,
                    "maxHeldOutRegression": 0,
                    "maxInferenceErrorRate": 0,
                    "requiredTaskIds": ["held-out"],
                    "maxHeldOutEvaluations": 1,
                },
            },
            "publication": {"mode": "explicit"},
        }
        config = {
            "schemaVersion": 2,
            "storeRoot": str(self.store.root),
            "deployment": deployment,
            "activationPath": str(self.root / "active.json"),
            "episodeTimeoutSeconds": 60,
            "evaluationBindings": {
                "bindingsFile": str(self.root / "bindings.json"),
                "trustedReceiptSources": ["fixture"],
            },
            "hitch": {
                "command": self.hitch,
                "root": str(self.root / "hitch"),
                "workspace": str(self.root / "controller"),
                "python": [sys.executable],
                "harnessSourceDirectory": os.environ["GEAR_DIAGEVO_HITCH_PATH"],
                "budgets": {
                    "timeoutSeconds": 60,
                    "setupTimeoutSeconds": 120,
                    "maxConcurrent": 1,
                    "maxEpisodeSteps": 16,
                    "infrastructureRetries": 0,
                    "maxRepairRounds": 0,
                },
            },
        }
        return spec, config

    def prepare(self, **overrides):
        arguments = {
            "construction_ref": self.construction_ref,
            "challenger_request": self.pipeline.fresh.request,
            "solver_spec": self.spec,
            "hitch_command": self.hitch,
            "task_options": self.options,
        }
        return diagevo_tasks.prepare_solver_job(
            self.store, self.root / "handoff", **{**arguments, **overrides}
        )

    def admit(self, prepared):
        return diagevo_tasks.admit_solver_job(
            self.store, prepared, controller_config=self.config_file, gear_command=self.gear
        )

    def test_real_compiler_seals_exact_prompts_then_real_controller_admits_and_replays(self):
        freeze, refs = diagevo_tasks._freeze, []

        def lost(path, value):
            freeze(path, value)
            if path.name == "result.json":
                refs.append(value["resultRef"])
                raise RuntimeError("preparation reply lost")

        with (
            patch.object(diagevo_tasks, "_freeze", side_effect=lost),
            self.assertRaisesRegex(RuntimeError, "preparation reply lost"),
        ):
            self.prepare()
        prepared_ref = self.prepare()
        self.assertEqual(refs, [prepared_ref])
        prepared = self.store.read_json(prepared_ref)
        spec = self.store.read_json(prepared["specRef"])
        expected = copy.deepcopy(self.spec)
        expected["datasets"]["train"] = spec["datasets"]["train"]
        expected["trainer"]["scriptConfig"] = {"constructionRef": self.construction_ref}
        self.assertEqual(spec, expected)
        for task in spec["datasets"]["train"]["tasks"]:
            manifest = self.store.read_json(task["taskRef"])
            files = {row["path"]: row["contentRef"] for row in manifest["files"]}
            descriptor = json.loads(self.store.read_bytes(files[".hitch-benchmark.json"]))
            self.assertEqual(
                descriptor["candidate_input"]["messages"],
                [
                    {"role": "system", "content": [{"type": "input_text", "text": "solve"}]},
                    {
                        "role": "user",
                        "content": [{"type": "input_text", "text": "What is one plus one?"}],
                    },
                ],
            )
            self.assertEqual(task["family"], "authorized-math")
            self.assertEqual(manifest["name"], task["id"])
            self.assertEqual(
                self.store.read_json(task["environmentRef"])["taskSnapshotDigest"],
                task["taskRef"]["digest"],
            )
        # The public compiler also verifies the standard dataset manifest.
        destination = self.root / "materialized"
        materialize(self.store, spec["datasets"]["train"]["snapshotRef"], destination)
        self.check_hitch_export(destination / spec["datasets"]["train"]["tasks"][0]["id"])
        with patch.object(
            diagevo_tasks, "_command", side_effect=AssertionError("must reuse preparation")
        ):
            self.assertEqual(self.prepare(), prepared_ref)
        admitted = self.admit(prepared_ref)
        self.assertEqual(admitted["run"]["phase"], "admitted")
        self.assertEqual(admitted["run"]["request"]["budgets"], self.spec["budgets"])
        self.assertEqual(
            self.admit(prepared_ref),
            admitted,
        )
        runtime = SimpleNamespace(store=self.store, request=admitted["run"]["request"], config={})
        loop = build_loop({"parameters": spec["trainer"]["scriptConfig"]}, runtime)
        self.assertIsNotNone(loop)
        self.assertEqual(self.spec["trainer"]["scriptConfig"], {})

    def check_hitch_export(self, task):
        # Actual trusted worker functions, with an explicit local filesystem
        # environment double. No Harbor/Docker or deployment is claimed here.
        source = (
            Path(os.environ["GEAR_DIAGEVO_HITCH_PATH"]) / "integrations/harbor/hitch_benchmark.py"
        )
        spec = importlib.util.spec_from_file_location("diagevo_hitch_export", source)
        hooks = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(hooks)
        uploaded = {}

        async def upload(source, target):
            uploaded[target] = Path(source).read_bytes()

        trial = self.root / "trial"
        trial.mkdir()
        environment = SimpleNamespace(
            environment_dir=task / "environment",
            trial_paths=SimpleNamespace(trial_dir=trial),
            exec=AsyncMock(return_value=SimpleNamespace(return_code=0)),
            upload_file=upload,
        )
        actual, timeout = hooks.candidate_instruction("must not alter the prompt", environment)
        self.assertEqual(
            json.loads(actual),
            json.loads((task / ".hitch-benchmark.json").read_text())["candidate_input"],
        )
        self.assertEqual(timeout, 60000)
        asyncio.run(
            hooks.export_final_response(
                environment,
                {
                    "run_id": "fixture-canonical",
                    "status": "succeeded",
                    "output": "not a math proof",
                },
            )
        )
        uploaded["/hitch-evidence/final-response.json"] = b"untrusted replacement"
        verifier = SimpleNamespace(
            environment=environment,
            trial_paths=environment.trial_paths,
            task=SimpleNamespace(paths=SimpleNamespace(environment_dir=task / "environment")),
        )
        asyncio.run(hooks.restore_final_response(verifier))
        final = trial / "restored.json"
        final.write_bytes(uploaded["/hitch-evidence/final-response.json"])
        reward = trial / "reward.json"
        subprocess.run(
            [sys.executable, str(task / "tests/verify.py"), str(final), "4096", str(reward)],
            check=True,
        )
        self.assertEqual(json.loads(reward.read_text()), {"completion": 1})

    def test_creation_and_admission_reply_gaps_do_not_add_jobs(self):
        prepared = self.prepare()
        original = diagevo_tasks._command
        ids = []
        for action in ("init", "admit"):

            def lost(command, args):
                result = original(command, args)
                if args[1] == action:
                    ids.append((action, result["id"]))
                    raise RuntimeError("committed reply lost")
                return result

            with (
                patch.object(diagevo_tasks, "_command", side_effect=lost),
                self.assertRaisesRegex(RuntimeError, "reply lost"),
            ):
                self.admit(prepared)
        actual = self.admit(prepared)
        self.assertEqual(ids, [("init", actual["experimentId"]), ("admit", actual["runId"])])
        state = diagevo_tasks._command(
            self.gear,
            ["training", "status", actual["experimentId"], "--config", str(self.config_file)],
        )
        self.assertEqual(list(state["runs"]), [actual["runId"]])
        self.assertEqual(state["usage"], {"gpuSeconds": 0, "rolloutTokens": 0, "groupResamples": 0})

    def test_rejects_private_content_model_source_and_input_drift(self):
        mutated = copy.deepcopy(self.spec)
        mutated["datasets"]["dev"] = self.split("private-copy", "What is one plus one?")
        with self.assertRaisesRegex(ContractError, "private evaluation task"):
            self.prepare(solver_spec=mutated)
        # A failed preparation still binds its original intent; use another root
        # for independent negative cases rather than rewriting the saved input.
        for change in ("model", "family", "authorization", "status", "pseudolabel"):
            spec, request = copy.deepcopy(self.spec), copy.deepcopy(self.pipeline.fresh.request)
            ref = self.construction_ref
            if change == "model":
                spec["initialModel"] = self.store.put_json(
                    {"hfSnapshotRef": self.store.put_json({"other": True})}
                )
            elif change == "family":
                spec["datasets"]["dev"]["tasks"][0]["family"] = "authorized-math"
            elif change == "authorization":
                request["trainDataset"]["exactDataAuthorized"] = False
            elif change == "status":
                ref = self.store.put_json({**self.construction, "status": "no-retained-questions"})
            else:
                pool = self.store.read_json(self.construction["curriculumRef"])
                pool["votes"][0]["p1"] = 0.5
                ref = self.store.put_json(
                    {**self.construction, "curriculumRef": self.store.put_json(pool)}
                )
            with self.subTest(change=change), self.assertRaises(ContractError):
                diagevo_tasks.prepare_solver_job(
                    self.store,
                    self.root / change,
                    construction_ref=ref,
                    challenger_request=request,
                    solver_spec=spec,
                    hitch_command=self.hitch,
                    task_options=self.options,
                )
        with self.assertRaisesRegex(ContractError, "handoff input changed"):
            self.prepare()


if __name__ == "__main__":
    unittest.main()
