"""Native solver driver/HTTP capture with Math-Verify and CPU actor doubles.

Challenger history and construction are explicit native-contract fixtures.
No real LLM, GPU, or challenger optimization is represented by this test.
"""

import asyncio
import copy
import importlib.util
import unittest
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import patch

import test_dev_grpo
import test_diagevo_data
import test_diagevo_generation
import test_diagevo_solver
from episode_fixture import EpisodeFixture
from gear.training.backends.slime.driver import run
from gear.training.data.episodes import EpisodeJournal
from gear.training.pipelines import diagevo_solver
from gear.training.recipes.agent_grpo import sampling_params
from gear.training.recipes.diagevo import DiagEvoPolicy, GenerationDirective
from gear.training.recipes.diagevo_answers import DiagEvoMathClassifier
from gear.training.recipes.diagevo_challenger import DiagEvoChallengerReward
from gear.training.recipes.diagevo_data import DiagEvoChallengerDatasetBuilder
from gear.training.recipes.diagevo_generation import DiagEvoGenerationBuilder, DiagEvoQuestionPrompt
from gear.training.recipes.diagevo_solver import DiagEvoSolverDatasetBuilder
from gear.training.storage.content import ContractError, digest_json


@unittest.skipUnless(
    all(importlib.util.find_spec(name) is not None for name in ("math_verify", "nltk", "sklearn")),
    "install training-math and training-metrics for the native solver pipeline",
)
class SolverPipelineTests(unittest.TestCase):
    def setUp(self):
        self.driver = test_dev_grpo.DevGRPOTests()
        self.driver.setUp()
        self.addCleanup(self.driver.doCleanups)
        self.store = self.driver.d.store
        self.driver.controller = self.controller
        self.driver.train = self.train
        self.origin = self.make_origin()
        self.classifier = DiagEvoMathClassifier(self.store)
        questions = self.store.read_json(self.origin.ref)["questions"]
        request = self.driver.d.request
        task = request["trainDataset"]["tasks"][0]
        request["trainDataset"]["tasks"] = [{**task, "id": key} for key in questions]
        self.origin.native.request = request
        self.origin.native.questions = questions
        self.builder = DiagEvoSolverDatasetBuilder(
            self.store,
            request,
            policy=self.origin.native.policy,
            generation_builder=self.origin.builder,
        )
        captures = {
            key: tuple(
                self.origin.native.capture(f"construction/{key}/{i}", key, text, slot=i)
                for i, text in enumerate([r"\boxed{2}"] * 9 + [r"\boxed{3}"] * 3)
            )
            for key in questions
        }
        self.pool = self.builder.seal_curriculum(
            questions,
            captures,
            generation={key: self.origin.directives["generate"] for key in questions},
            memory=self.origin.memory,
            construction_policy_id="solver-v1",
            answer_classes_ref=self.classifier.construction(questions, captures),
            generation_ref=self.origin.ref,
        )
        source = self.store.put_bytes(
            b"from gear.training.pipelines.diagevo_solver import build_loop\n",
            "application/octet-stream",
        )
        request["trainer"]["script"] = {
            "entrypoint": "recipe:build_loop",
            "sourceRef": self.store.put_json(
                {
                    "schemaVersion": 1,
                    "kind": "training-script-source",
                    "files": [{"path": "recipe.py", "contentRef": source}],
                }
            ),
        }
        request["trainer"]["scriptConfig"] = {
            "curriculumRef": self.pool,
            "challengerRequestRef": self.store.put_json(self.origin.request),
        }
        self.questions = questions

    def make_origin(self):
        """Reuse contract fixtures, matching the native solver sampling identity."""
        origin = test_diagevo_generation.FreshGenerationTests()
        fixture = test_diagevo_data.NativeRewardTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.store.put_bytes(fixture.store.read_bytes(fixture.fixed), fixture.fixed["mediaType"])
        fixture.store = self.store
        capture = fixture.capture
        solver_request = self.driver.d.request

        def solver_capture(*args, **kwargs):
            raw = capture(*args, **kwargs)
            if not kwargs.get("solver"):
                return raw
            context = self.store.read_json(raw.context_ref)
            receipt = self.store.read_json(raw.receipt_refs[0])
            sampling = sampling_params(solver_request["rollout"])
            context.update(sampling=sampling, maxContextTokens=128, maxEpisodeSteps=4)
            for key in ("tokenizerDigest", "chatTemplateDigest"):
                context[key] = receipt[key] = solver_request["parentModel"][key]
            receipt["effectiveSamplingRef"] = self.store.put_json(sampling)
            return replace(
                raw,
                context_ref=self.store.put_json(context),
                receipt_refs=[self.store.put_json(receipt)],
            )

        fixture.capture = solver_capture
        native = test_diagevo_solver.SolverBatchTests()
        native.store, native.fixed, native.fixture = self.store, fixture.fixed, fixture
        native.policy = DiagEvoPolicy(optimization_group_size=2)
        # Complete manifests are fixtures; native solver execution below is real
        # driver code with an explicitly substituted CPU actor.
        request = copy.deepcopy(solver_request)
        request.update(trainingRunId="train-challenger")
        request["parentModel"].update(
            hfSnapshotRef=fixture.fixed,
            tokenizerDigest=fixture.fixed["digest"],
            chatTemplateDigest=fixture.fixed["digest"],
        )
        for key in ("rollout", "trainDataset", "fixedHarness", "verifier", "budgets"):
            request[key] = copy.deepcopy(fixture.request[key])
        native.request = request
        origin.native, origin.fixture = native, fixture
        origin.store, origin.fixed, origin.request = self.store, fixture.fixed, request
        origin.memory = ()
        origin.nodes = ()
        origin.directives = {"generate": GenerationDirective("free")}
        origin.prompt = DiagEvoQuestionPrompt()
        origin.challenger = DiagEvoChallengerDatasetBuilder(
            self.store,
            request,
            objective=DiagEvoChallengerReward(group_size=2, policy=native.policy),
        )
        origin.builder = DiagEvoGenerationBuilder(origin.challenger, prompt=origin.prompt)
        origin.commits = []
        before = fixture.fixed
        for step in range(2):
            batch, _ = origin.training_batch(step, before)
            commit, before = native.commit(
                batch, step + 1, origin.commits[-1] if origin.commits else None
            )
            origin.commits.append(commit)
        origin.fresh = origin.group(2)
        origin.lease = origin.policy_lease(2, before)
        origin.ref = origin.seal()
        return origin

    async def controller(self, stopped):
        import aiohttp

        journal = EpisodeJournal(self.driver.d.root)
        proxy = SimpleNamespace(
            journal=journal,
            ledger=journal.ledger,
            private=self.driver.f.private,
            store=self.store,
            ref=self.driver.f.ref,
            address=EpisodeFixture.address,
        )
        try:
            async with aiohttp.ClientSession() as session:
                while not stopped.is_set():
                    for entry in journal.list(renew=True)["entries"]:
                        if entry["result"] or entry["cancelRequested"]:
                            continue
                        intent = entry["intent"]
                        auth = {"Authorization": "Bearer " + intent["credential"]}
                        endpoint = f"http://127.0.0.1:{intent['gateway']['nodePort']}"
                        run_id = "run_" + digest_json(intent["id"])[7:39]
                        async with session.post(
                            endpoint + "/v1/hitch/run",
                            headers=auth,
                            json={"runId": run_id, "bindingId": intent["binding"]["bindingId"]},
                        ) as response:
                            self.assertEqual(response.status, 200, await response.text())
                        slot = intent["context"]["slot"]
                        question = self.questions[intent["context"]["taskId"]]
                        async with session.post(
                            endpoint + "/v1/chat/completions",
                            headers=auth,
                            json={
                                "model": intent["lease"]["policyVersion"],
                                "fixture_tokens": [1, 10 + slot],
                                "messages": [
                                    {"role": "system", "content": "solve"},
                                    {"role": "user", "content": question},
                                ],
                            },
                        ) as response:
                            self.assertEqual(response.status, 200, await response.text())
                        journal.resolve(
                            EpisodeFixture.address(intent),
                            EpisodeFixture.feedback(proxy, intent, reward=7),
                        )
                    await asyncio.sleep(0.01)
        finally:
            journal.close()

    def train(self, rollout_id, data):
        self.assertTrue(data["slime_backend_object"])
        samples = data["preprocessed"].samples[0]
        self.assertEqual([row.reward for row in samples], [1, -1])
        for slot, row in enumerate(samples):
            self.assertEqual(row.tokens, [1, 10 + slot, 3, 4])
            self.assertEqual(row.loss_mask, [1, 1])
            self.assertEqual(row.rollout_log_probs, [-0.1, -0.1])
        self.driver.d.rt.train()

    def native(self):
        owner = self

        class Native:
            expected_weight_version = "1"

            async def generate(self, payload):
                owner.driver.native_calls.append(payload)
                answer = "2" if payload["input_ids"][-1] == 10 else "3"
                return {
                    "text": r"\boxed{" + answer + "}",
                    "output_ids": [3, 4],
                    "meta_info": {
                        "weight_version": "1",
                        "completion_tokens": 2,
                        "output_token_logprobs": [[-0.1, 3], [-0.1, 4]],
                        "finish_reason": {"type": "stop"},
                    },
                }

        return patch("gear.training.backends.slime.rollout.NativeSGLang", return_value=Native())

    def test_frozen_factory_runs_two_native_rounds_with_actual_math_rewards(self):
        with self.driver.cpu_runtime(), self.native():
            run(self.driver.d.root)
        self.assertEqual(self.driver.native_events.count("train"), 2)
        self.assertEqual(len(self.driver.native_calls), 4)
        commits = []
        for index in range(2):
            dataset = self.driver.stage("dataset-builder", index)
            update = self.driver.stage("model-updater", index)
            commits.append(update["commitRef"])
            self.assertEqual(
                dataset["batchRef"]["digest"],
                self.store.read_json(update["commitRef"])["consumedBatchDigest"],
            )
        # Reconstruct failures from the actually consumed batches/commits.
        evidence = self.builder.round_evidence(commits, curriculum_ref=self.pool)
        self.assertEqual([row.rewards for row in evidence.groups], [(1, -1), (1, -1)])

    def test_sealed_dataset_reply_gap_reuses_captures_and_does_not_repeat_update(self):
        self.driver.d.request["trainer"]["updatesPerCandidate"] = 1
        normal = diagevo_solver.SolverDatasetStage.build

        async def interrupted(stage, ctx, raw):
            await normal(stage, ctx, raw)
            raise RuntimeError("dataset result gap")

        with (
            self.driver.cpu_runtime(),
            self.native(),
            patch.object(diagevo_solver.SolverDatasetStage, "build", interrupted),
            self.assertRaisesRegex(RuntimeError, "dataset result gap"),
        ):
            run(self.driver.d.root)
        self.assertEqual(len(self.driver.native_calls), 2)
        self.assertNotIn("train", self.driver.native_events)
        self.driver.reset_runtime()
        with self.driver.cpu_runtime(), self.native():
            run(self.driver.d.root)
        self.assertEqual(len(self.driver.native_calls), 2)
        self.assertEqual(self.driver.native_events.count("train"), 1)

    def test_commit_reply_gap_recovers_without_model_restart_or_new_comparisons(self):
        self.driver.d.request["trainer"]["updatesPerCandidate"] = 1
        self.driver.d.fail_commit_reply = True
        with (
            self.driver.cpu_runtime(),
            self.native(),
            self.assertRaisesRegex(OSError, "commit response lost"),
        ):
            run(self.driver.d.root)
        before = self.driver.native_events[:]
        with (
            patch(
                "gear.training.backends.slime.gpu_visibility.verify_visible_devices",
                side_effect=AssertionError("must not restart CUDA"),
            ),
            patch.object(
                DiagEvoMathClassifier,
                "optimization",
                side_effect=AssertionError("must not reclassify"),
            ),
        ):
            run(self.driver.d.root)
        self.assertEqual(self.driver.native_events, before)
        self.assertEqual(len(self.driver.native_calls), 2)
        self.assertEqual(self.driver.stage("model-updater")["committedUpdate"], 1)

    def test_factory_rejects_wrong_admission_request_and_arbitrary_component(self):
        runtime = SimpleNamespace(store=self.store, request=copy.deepcopy(self.driver.d.request))
        config = {"parameters": copy.deepcopy(runtime.request["trainer"]["scriptConfig"])}
        runtime.request["trainDataset"]["tasks"].pop()
        with self.assertRaisesRegex(ContractError, "exactly the retained"):
            diagevo_solver.build_loop(config, runtime)
        config["parameters"]["challengerRequestRef"] = self.store.put_json({"wrong": "request"})
        with self.assertRaisesRegex(ContractError, "sealed challenger request"):
            diagevo_solver.build_loop(config, runtime)
        spec = DiagEvoPolicy().describe().to_dict()
        spec["entrypoint"] = "os:system"
        with self.assertRaisesRegex(ContractError, "unsupported native"):
            diagevo_solver._component(spec)


if __name__ == "__main__":
    unittest.main()
