"""Durable outer-loop behavior with explicit authoring/controller/native doubles.

These tests cover sequencing, reservations and crash recovery. Real task and
native artifact contracts are exercised separately by the evolution/pipeline
integration tests; no fake acceptance here is evidence of model improvement.
"""

import copy
import io
import json
import signal
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

from gear.training.cli import diagevo as cli
from gear.training.recipes import diagevo_run as recipe
from gear.training.recipes.diagevo import DiagEvoPolicy
from gear.training.recipes.diagevo_challenger import DiagEvoChallengerReward
from gear.training.recipes.diagevo_generation import DiagEvoQuestionPrompt
from gear.training.storage.content import ContentStore, ContractError


class EvolutionJournalTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.store = ContentStore(self.root / "cas")
        self.directory = self.root / "evolution"
        self.config = self.root / "controller.json"
        self.config.write_text(json.dumps({"schemaVersion": 2, "storeRoot": str(self.store.root)}))
        ref = self.store.put_json({"fixture": "frozen-source"})
        split = {"snapshotRef": ref, "exactDataAuthorized": True, "tasks": []}
        template = {
            "schemaVersion": 2,
            "kind": "model-training",
            "name": "journal fixture",
            "initialModel": ref,
            "referenceModel": ref,
            "fixedHarness": {"adapter": "model-call"},
            "trainer": {
                "script": ref,
                "recipe": "agent-grpo-v1",
                "optimizerResetPolicy": "initial-cold-start-only",
                "rolloutBatchSize": 1,
                "updatesPerCandidate": 1,
            },
            "datasets": {"train": split, "dev": {"private": "dev"}, "heldOut": {"private": "held"}},
            "rollout": {"groupSize": 2, "zeroVarianceGroup": "keep"},
            "budgets": {
                "gpuSecondsScope": "training",
                "totalGpuSeconds": 60,
                "maxRolloutTokens": 100,
            },
            "evaluation": {"policy": {"maxHeldOutEvaluations": 1, "minDevGain": 0.1}},
        }
        challenger, solver = copy.deepcopy(template), copy.deepcopy(template)
        challenger["initialModel"] = self.store.put_json({"fixture": "initial-challenger"})
        challenger["trainer"]["scriptConfig"] = {
            "objective": DiagEvoChallengerReward(
                group_size=2,
                policy=DiagEvoPolicy(construction_samples=4, optimization_group_size=2),
            )
            .describe()
            .to_dict(),
            "solver": {"model_ref": ref, "max_calls": 16},
        }
        solver["trainer"]["scriptConfig"] = {
            "memoryUpdate": {
                "diagnosis": {"model": "fixture", "max_calls": 8},
                "embedding": {"model_ref": ref, "max_calls": 4},
            }
        }
        self.plan = {
            "schemaVersion": 1,
            "kind": "diagevo-evolution",
            "challenger": challenger,
            "solver": solver,
            "rounds": 2,
            "seed": 17,
            "prompt": DiagEvoQuestionPrompt().describe().to_dict(),
            "freshGenerationMaxSeconds": 30,
            "maxWallClockSeconds": 1000,
            "budgets": {
                "trainingGpuSeconds": 200,
                "rolloutTokens": 400,
                "localGenerations": 36,
                "diagnosticTurns": 16,
                "embeddings": 8,
                "heldOutEvaluations": 4,
            },
            "taskOptions": {
                "sourceLicense": "LicenseRef-Fixture",
                "environmentImage": "node@sha256:" + "a" * 64,
                "verifierImage": "python@sha256:" + "b" * 64,
                "agentTimeoutSeconds": 60,
                "setupTimeoutSeconds": 60,
                "verifierTimeoutSeconds": 30,
                "maxResponseBytes": 4096,
            },
        }
        self.runs, self.preparations, self.commands = {}, [], []
        self.lose_admit = self.lose_advance = self.lose_resume = self.status_offline = False
        self.running = False
        self.outcome, self.pool_status = "accepted", "ready"
        for target, replacement in (
            (
                "gear.training.recipes.diagevo_evolution.prepare_challenger_job",
                self.prepare_challenger,
            ),
            ("gear.training.recipes.diagevo_tasks.prepare_solver_job", self.prepare_solver),
            ("gear.training.recipes.diagevo_tasks._admit_job", self.admit),
            ("gear.training.recipes.diagevo_tasks._command", self.command),
            (
                "gear.training.recipes.diagevo_evolution.accepted_challenger_construction",
                self.challenger_result,
            ),
            ("gear.training.recipes.diagevo_evolution.accepted_solver_memory", self.solver_result),
        ):
            replacement_patch = patch(target, replacement)
            replacement_patch.start()
            self.addCleanup(replacement_patch.stop)

    def step(self, action="advance"):
        return recipe.evolve(
            self.store,
            self.directory,
            plan=self.plan,
            controller_config=self.config,
            gear_command=["fixture-gear"],
            hitch_command=["fixture-hitch"],
            action=action,
        )

    def journal(self):
        return json.loads((self.directory / "state.json").read_text())

    def prepare_challenger(self, store, root, **args):
        self.preparations.append(("challenger", copy.deepcopy(args)))
        return store.put_json({"role": "challenger", "spec": args["challenger_spec"]})

    def prepare_solver(self, store, root, **args):
        self.preparations.append(("solver", copy.deepcopy(args)))
        return store.put_json(
            {
                "role": "solver",
                "spec": args["solver_spec"],
                "constructionRef": args["construction_ref"],
            }
        )

    def admit(self, store, prepared_ref, **kwargs):
        key = prepared_ref["digest"]
        prepared = store.read_json(prepared_ref)
        spec = prepared["spec"]
        # A crash here must leave both the allowance and prepared identity saved.
        self.assertEqual(self.journal()["jobs"][-1]["preparedRef"], prepared_ref)
        if key not in self.runs:
            identity = "job-" + str(len(self.runs))
            self.runs[key] = {
                "id": identity,
                "request": {
                    "experimentId": "exp-" + identity,
                    "trainingRunId": identity,
                    "parentModelRef": spec["initialModel"],
                    "trainer": spec["trainer"],
                    "budgets": spec["budgets"],
                },
                "phase": "admitted",
                "execution": "running",
                "resourcesReleased": True,
                "evaluationTasksCompleted": True,
                "usage": {"gpuSeconds": 0, "rolloutTokens": 0, "groupResamples": 0},
                "heldOutQueries": 0,
                "trainingControl": {"sequence": 0, "action": "start"},
            }
        if self.lose_admit:
            self.lose_admit = False
            raise ConnectionError("admit reply lost")
        run = copy.deepcopy(self.runs[key])
        return {"experimentId": run["request"]["experimentId"], "runId": run["id"], "run": run}

    def command(self, argv, args):
        self.assertEqual(argv, ["fixture-gear"])
        verb, experiment, identity = args[1:4]
        self.commands.append((verb, identity))
        run = next(value for value in self.runs.values() if value["id"] == identity)
        self.assertEqual(experiment, run["request"]["experimentId"])
        if verb == "status" and self.status_offline:
            raise ConnectionError("controller unavailable")
        if verb == "pause":
            if run["execution"] != "completed":
                run["trainingControl"] = {
                    "sequence": run["trainingControl"]["sequence"] + 1,
                    "action": "pause",
                }
                run["execution"] = "paused"
        elif verb == "resume":
            run["trainingControl"] = {
                "sequence": run["trainingControl"]["sequence"] + 1,
                "action": "start",
            }
            run["execution"] = "running"
            if self.lose_resume:
                self.lose_resume = False
                raise ConnectionError("resume reply lost")
        elif verb == "advance" and not self.running:
            run.update(
                phase=self.outcome,
                execution="completed",
                decision={"outcome": self.outcome},
                candidateRef=self.store.put_json({"fixture": "candidate", "job": identity}),
            )
            run["usage"] = {
                "gpuSeconds": min(2, run["request"]["budgets"]["totalGpuSeconds"]),
                "rolloutTokens": min(3, run["request"]["budgets"]["maxRolloutTokens"]),
                "groupResamples": 0,
            }
            run["heldOutQueries"] = 1
            if self.lose_advance:
                self.lose_advance = False
                raise ConnectionError("advance reply lost")
        return copy.deepcopy(run)

    def challenger_result(self, store, run):
        body = {"status": self.pool_status}
        return {
            "modelRef": run["candidateRef"],
            "construction": body,
            "constructionRef": store.put_json({**body, "job": run["id"]}),
        }

    def solver_result(self, store, run):
        return {"modelRef": run["candidateRef"], "memoryRef": store.put_json({"memory": run["id"]})}

    def test_two_rounds_preserve_two_lineages_first_memory_and_fixed_evaluation(self):
        for _ in range(4):
            result = self.step()
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["roundsCompleted"], 2)
        self.assertEqual(
            [row[0] for row in self.preparations], ["challenger", "solver", "challenger", "solver"]
        )
        jobs = result["jobs"]
        first_challenger, first_solver = (self.store.read_json(row["runRef"]) for row in jobs[:2])
        next_challenger = self.preparations[2][1]
        self.assertEqual(
            next_challenger["challenger_spec"]["initialModel"], first_challenger["candidateRef"]
        )
        self.assertEqual(next_challenger["solver_model_ref"], first_solver["candidateRef"])
        self.assertEqual(next_challenger["first_solver"], first_solver)
        self.assertEqual(next_challenger["previous_solver"], first_solver)
        self.assertEqual(
            self.preparations[3][1]["solver_spec"]["initialModel"], first_solver["candidateRef"]
        )
        for role, args in self.preparations:
            spec = args[role + "_spec"]
            self.assertEqual(spec["datasets"], self.plan[role]["datasets"])
            self.assertEqual(spec["referenceModel"], self.plan[role]["referenceModel"])
            self.assertEqual(spec["trainer"], self.plan[role]["trainer"])
        self.assertEqual(result["observedControllerUsage"]["gpuSeconds"], 8)
        self.assertEqual(result["budgetCommitted"]["trainingGpuSeconds"], 8)
        self.assertEqual(result["budgetCommitted"]["localGenerations"], 36)
        commands = self.commands[:]
        self.assertEqual(self.step(), result)
        self.assertEqual(self.commands, commands)

    def test_admission_and_completion_reply_gaps_reconcile_without_new_jobs_or_double_charge(self):
        self.lose_admit = True
        with self.assertRaisesRegex(ConnectionError, "admit reply"):
            self.step()
        self.assertEqual(len(self.runs), 1)
        self.assertNotIn("runId", self.journal()["jobs"][0])
        self.lose_advance = True
        with self.assertRaisesRegex(ConnectionError, "advance reply"):
            self.step()
        result = self.step()
        self.assertEqual(len(self.runs), 2)
        self.assertEqual([row["role"] for row in result["jobs"]], ["challenger", "solver"])
        self.assertEqual(result["observedControllerUsage"]["gpuSeconds"], 4)
        self.assertEqual(
            sum(verb == "advance" for verb, identity in self.commands if identity == "job-0"), 1
        )

    def test_third_round_keeps_first_solver_separate_from_previous_solver(self):
        self.plan["rounds"] = 3
        self.plan["budgets"].update(
            localGenerations=54, diagnosticTurns=24, embeddings=12, heldOutEvaluations=6
        )
        for _ in range(6):
            result = self.step()
        self.assertEqual(result["status"], "completed")
        third = self.preparations[4][1]
        self.assertEqual(third["first_solver"]["id"], "job-1")
        self.assertEqual(third["previous_solver"]["id"], "job-3")
        self.assertNotEqual(
            third["first_solver"]["candidateRef"], third["previous_solver"]["candidateRef"]
        )

    def test_global_gpu_remainder_and_auxiliary_reservations_stop_new_admission(self):
        self.plan["budgets"]["trainingGpuSeconds"] = 5
        for _ in range(4):
            result = self.step()
        self.assertEqual(result["status"], "stopped")
        self.assertEqual(result["reason"], "cross-round-budget-exhausted")
        self.assertEqual(
            [row[1][row[0] + "_spec"]["budgets"]["totalGpuSeconds"] for row in self.preparations],
            [5, 3, 1],
        )
        self.assertEqual(result["budgetCommitted"]["trainingGpuSeconds"], 5)
        self.assertEqual(len(self.runs), 3)

    def test_calls_stay_reserved_and_budget_or_private_pool_drift_is_rejected(self):
        self.plan["budgets"]["diagnosticTurns"] = 8
        for _ in range(4):
            result = self.step()
        self.assertEqual(len(result["jobs"]), 3)
        self.assertEqual(result["budgetCommitted"]["diagnosticTurns"], 8)
        self.plan["budgets"]["diagnosticTurns"] = 16
        with self.assertRaisesRegex(ContractError, "input changed"):
            self.step()
        self.plan["solver"]["datasets"]["heldOut"] = {"private": "different"}
        with self.assertRaisesRegex(ContractError, "same fixed private"):
            self.step()

    def test_pause_survives_controller_outage_and_explicit_resume_reply_gap(self):
        self.running = True
        self.step()
        self.status_offline = True
        with self.assertRaisesRegex(ConnectionError, "unavailable"):
            self.step("pause")
        self.assertEqual(self.journal()["control"], "pause")
        self.status_offline = False
        self.assertEqual(self.step()["status"], "paused")
        advances = sum(verb == "advance" for verb, _ in self.commands)
        self.assertEqual(self.step()["status"], "paused")
        self.assertEqual(sum(verb == "advance" for verb, _ in self.commands), advances)
        self.lose_resume = True
        with self.assertRaisesRegex(ConnectionError, "resume reply"):
            self.step("resume")
        result = self.step()
        self.assertEqual(result["status"], "running")
        self.assertEqual(sum(verb == "resume" for verb, _ in self.commands), 1)
        self.assertEqual(len(self.runs), 1)

    def test_external_pause_does_not_authorize_automatic_resume(self):
        self.running = True
        self.step()
        run = next(iter(self.runs.values()))
        run["execution"] = "paused"
        self.assertEqual(self.step()["status"], "paused")
        self.assertFalse(any(verb == "resume" for verb, _ in self.commands))
        self.assertEqual(self.step("resume")["status"], "running")

    def test_deadline_is_not_reset_and_pauses_the_original_live_job(self):
        self.running = True
        with patch.object(recipe.time, "time", return_value=100):
            original = self.step()
        with patch.object(recipe.time, "time", return_value=1101):
            result = self.step()
            self.assertEqual(self.step("resume"), result)
        self.assertEqual(result["status"], "stopped")
        self.assertEqual(result["reason"], "wall-clock-budget-exhausted")
        self.assertEqual(result["deadlineAt"], original["deadlineAt"])
        self.assertEqual(len(self.runs), 1)
        self.assertEqual(self.commands[-1], ("pause", "job-0"))

    def test_empty_pool_and_rejection_stop_without_solver_or_replacement_sampling(self):
        self.pool_status = "no-retained-questions"
        result = self.step()
        self.assertEqual(result["reason"], self.pool_status)
        self.assertEqual(len(self.runs), 1)
        self.assertEqual(self.step(), result)

    def test_rejected_model_does_not_update_lineage(self):
        self.outcome = "rejected"
        result = self.step()
        self.assertEqual(result["reason"], "challenger-rejected")
        self.assertEqual(result["models"]["challenger"], self.plan["challenger"]["initialModel"])
        self.assertEqual(len(self.runs), 1)

    def test_status_cannot_start_and_independent_directories_have_distinct_jobs(self):
        initial = self.step("status")
        self.assertFalse(self.runs)
        self.step()
        first_id = initial["id"]
        self.directory = self.root / "second-evolution"
        second = self.step()
        self.assertNotEqual(second["id"], first_id)
        self.assertEqual(len(self.runs), 2)

    def cli_arguments(self):
        config = json.loads(self.config.read_text())
        config["hitch"] = {"command": ["fixture-hitch"]}
        self.config.write_text(json.dumps(config))
        plan_file = self.root / "plan.json"
        plan_file.write_text(json.dumps(self.plan))
        return [
            "run",
            str(plan_file),
            "--directory",
            str(self.directory),
            "--config",
            str(self.config),
            "--gear-command",
            '["fixture-gear"]',
            "--poll-seconds",
            "0.1",
        ]

    def test_cli_follows_one_frozen_run_to_completion(self):
        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(io.StringIO()), patch.object(cli.time, "sleep"):
            code = cli.main(self.cli_arguments())
        self.assertEqual(code, 0)
        result = json.loads(out.getvalue())
        self.assertEqual(result["status"], "completed")
        self.assertEqual(len(self.runs), 4)

    def test_cli_termination_persists_pause_without_starting_another_job(self):
        self.running = True
        out = io.StringIO()

        def terminate(argv, args):
            result = self.command(argv, args)
            if args[1] == "advance":
                signal.raise_signal(signal.SIGTERM)
            return result

        with (
            redirect_stdout(out),
            redirect_stderr(io.StringIO()),
            patch.object(cli.time, "sleep"),
            patch.object(recipe.tasks, "_command", terminate),
        ):
            code = cli.main(self.cli_arguments())
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out.getvalue())["status"], "paused")
        self.assertEqual(self.journal()["control"], "pause")
        self.assertEqual(len(self.runs), 1)


if __name__ == "__main__":
    unittest.main()
