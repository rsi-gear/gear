"""Real tiny HF construction and two native jobs with explicit CPU actor doubles."""

import copy
import importlib.util
import unittest
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import patch

import test_dev_grpo
import test_diagevo_fresh_pipeline as fresh_tests
import test_diagevo_pipeline as solver_tests
from gear.training.backends.slime.driver import run
from gear.training.pipelines.diagevo_challenger import ChallengerModelUpdater
from gear.training.pipelines.diagevo_solver import _component, build_loop
from gear.training.recipes.diagevo_inference import FrozenHFSolver
from gear.training.recipes.diagevo_solver import DiagEvoSolverDatasetBuilder
from gear.training.storage.content import ContractError
from gear.training.storage.models import seal_hf


@unittest.skipUnless(
    all(
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
    "install CPU training-math and training-metrics dependencies",
)
class ConstructionPipelineTests(unittest.TestCase):
    def setUp(self):
        self.fresh = fresh_tests.FreshPipelineTests()
        self.fresh.setUp()
        self.addCleanup(self.fresh.doCleanups)
        self.store, self.root = self.fresh.store, self.fresh.root

    def ready_solver(self):
        # This controlled decoder always emits boxed 2. p_high=1 explicitly
        # tests admission plumbing; it is not the paper's difficulty window.
        _, self.solver_ref = fresh_tests.question_models(
            self.root / "boxed-solver",
            self.store,
            response=r"\boxed{2}",
        )
        self.solver_model = seal_hf(self.store, self.root / "boxed-solver")
        self.fresh.native.solver_ref = self.solver_ref
        parameters = self.fresh.request["trainer"]["scriptConfig"]
        parameters["solver"].update(
            model_ref=self.solver_ref, instruction="solve", max_new_tokens=16
        )
        objective = _component(parameters["objective"])
        objective.policy = replace(objective.policy, p_high=1)
        parameters["objective"] = objective.describe().to_dict()

        def train(rollout_id, data):
            self.assertEqual([row.reward for row in data["preprocessed"].samples[0]], [0, 0])
            self.fresh.driver.d.rt.train()

        self.fresh.driver.train = train

    def first_job(self):
        with self.fresh.native.native():
            run(self.root)
        return self.result()

    def result(self):
        final, origin, generation = self.fresh.result()
        ref = final["checkpoint"]["constructionRef"]
        body = self.store.read_json(ref)
        self.assertEqual(body["generationRef"], final["checkpoint"]["generationRef"])
        self.assertEqual(self.store.read_json(body["challengerRequestRef"]), self.fresh.request)
        if body["curriculumRef"] is not None:
            builder = DiagEvoSolverDatasetBuilder(
                self.store,
                policy=generation.challenger.objective.policy,
                generation_builder=generation,
            )
            self.assertEqual(
                builder._pool(body["curriculumRef"])[0], self.store.read_json(body["curriculumRef"])
            )
        return ref, body, origin, generation

    def solver_request(self, base, result):
        request = copy.deepcopy(base)
        request["trainingRunId"] = "solver-job"
        request["parentModel"] = self.solver_model["model"]
        request["parentModelRef"] = self.solver_model["modelRef"]
        request["referenceModelRef"] = self.solver_model["modelRef"]
        request["trainer"]["updatesPerCandidate"] = 1
        request["rollout"]["zeroVarianceGroup"] = "keep"
        request["rollout"]["sampling"]["maxNewTokens"] = 16
        body = self.store.read_json(result)
        task = request["trainDataset"]["tasks"][0]
        request["trainDataset"]["tasks"] = [
            {**task, "id": key} for key in body["retainedQuestionIds"]
        ]
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
        request["trainer"]["scriptConfig"] = {"constructionRef": result}
        return request

    def test_construction_has_fresh_solver_captures_actual_classes_and_all_votes(self):
        self.ready_solver()
        _, body, origin, _ = self.first_job()
        self.assertEqual(body["status"], "ready")
        pool = self.store.read_json(body["curriculumRef"])
        self.assertEqual(set(body["retainedQuestionIds"]), set(origin["questions"]))
        self.assertEqual([vote["p1"] for vote in pool["votes"]], [1, 1])
        self.assertEqual(body["usage"]["logicalGenerations"], 8)
        self.assertEqual(body["usage"]["outputTokens"], 16)
        self.assertEqual(len(self.fresh.native.solver_records()), 12)
        batch = self.store.read_json(self.fresh.driver.stage("dataset-builder")["batchRef"])
        samples = self.store.read_json(batch["samplesRef"])
        old = self.store.read_json(samples[0][0]["metadata"]["curriculumRewardRef"])[
            "solverTrajectories"
        ]
        old_ids = {raw["context_ref"]["digest"] for rows in old.values() for raw in rows}
        new_ids = {
            raw["context_ref"]["digest"]
            for rows in pool["input"]["construction"].values()
            for raw in rows
        }
        self.assertFalse(old_ids & new_ids)

    def test_filtering_keeps_rejected_questions_and_does_not_relax_the_policy(self):
        ref, body, origin, _ = self.first_job()
        self.assertEqual(body["status"], "no-retained-questions")
        pool = self.store.read_json(body["curriculumRef"])
        self.assertEqual(set(pool["input"]["questions"]), set(origin["questions"]))
        self.assertEqual(len(pool["votes"]), 2)
        self.assertFalse(body["retainedQuestionIds"])
        self.assertTrue(all(not vote["retained"] for vote in pool["votes"]))
        with self.assertRaisesRegex(ContractError, "ready construction"):
            build_loop(
                {"parameters": {"constructionRef": ref}},
                SimpleNamespace(store=self.store, request=self.fresh.request, config={}),
            )

    def test_no_valid_questions_is_explicit_and_never_triggers_solver_resampling(self):
        initial, final = fresh_tests.question_models(
            self.root / "bad-questions", self.store, response="missing question tags"
        )
        self.fresh.initial, self.fresh.updated = initial, final
        self.fresh.driver.d.hf = final
        manifest = self.store.read_json(initial)
        self.fresh.request["parentModel"].update(
            {
                key: manifest[key]
                for key in (
                    "tokenizerDigest",
                    "chatTemplateDigest",
                    "weightsDigest",
                    "architecture",
                    "dtype",
                )
            }
        )
        self.fresh.request["parentModel"]["hfSnapshotRef"] = initial
        _, body, origin, _ = self.first_job()
        self.assertFalse(origin["questions"])
        self.assertEqual(body["status"], "no-valid-questions")
        self.assertIsNone(body["curriculumRef"])
        self.assertEqual(body["usage"]["logicalGenerations"], 0)
        self.assertEqual(len(self.fresh.native.solver_records()), 4)

    def test_constructed_result_reply_gap_replays_both_models_without_loading(self):
        self.ready_solver()
        original, refs = ChallengerModelUpdater.construct, []

        async def gap(updater, *args):
            refs.append(await original(updater, *args))
            raise RuntimeError("construction result gap")

        with (
            self.fresh.native.native(),
            patch.object(ChallengerModelUpdater, "construct", gap),
            self.assertRaisesRegex(RuntimeError, "construction result gap"),
        ):
            run(self.root)
        before = self.fresh.driver.native_events[:]
        with (
            patch.object(FrozenHFSolver, "_load", side_effect=AssertionError("must not load")),
            patch(
                "gear.training.backends.slime.gpu_visibility.verify_visible_devices",
                side_effect=AssertionError("must not start CUDA"),
            ),
        ):
            run(self.root)
        self.assertEqual(self.fresh.driver.native_events, before)
        self.assertEqual(self.result()[0], refs[0])

    def test_solver_quota_exhaustion_retains_partial_evidence_without_a_partial_vote(self):
        self.fresh.request["trainer"]["scriptConfig"]["solver"]["max_calls"] = 6
        with self.fresh.native.native(), self.assertRaisesRegex(ContractError, "quota exhausted"):
            run(self.root)
        self.assertEqual(len(self.fresh.native.solver_records()), 6)
        self.assertEqual(self.fresh.driver.native_events.count("train"), 1)
        self.assertFalse((self.root / "artifacts.body.json").exists())
        with (
            patch.object(
                FrozenHFSolver, "_generate", side_effect=AssertionError("must not regenerate")
            ),
            self.assertRaisesRegex(ContractError, "quota exhausted"),
        ):
            run(self.root)
        self.assertEqual(len(self.fresh.native.solver_records()), 6)

    def test_constructed_curriculum_feeds_a_second_native_solver_job(self):
        self.ready_solver()
        ref, body, origin, generation = self.first_job()
        second = test_dev_grpo.DevGRPOTests()
        second.setUp()
        self.addCleanup(second.doCleanups)
        # Two job workspaces on one model node use the same durable CAS. Do not
        # upload controller-only task/verifier bytes through a generic graph walk.
        for item in (
            second.d.hf,
            second.d.state_ref,
            second.d.request["trainer"]["hyperparametersRef"],
        ):
            self.store.put_bytes(second.d.store.read_bytes(item), item["mediaType"])
        second.d.store = second.f.store = self.store
        second.config["storeRoot"] = str(self.store.root)
        request = self.solver_request(second.d.request, ref)
        request["fixedHarness"]["adapter"] = "model-call"
        second.d.request = request
        proxy = solver_tests.SolverPipelineTests()
        proxy.driver, proxy.store, proxy.questions = second, self.store, origin["questions"]
        second.controller, second.train = proxy.controller, proxy.train
        committed = SimpleNamespace(driver=second, request=request, updated=self.solver_ref)
        second.d.commit = lambda store, ledger, **kwargs: fresh_tests.FreshPipelineTests.commit(
            committed, store, ledger, **kwargs
        )
        with second.cpu_runtime(), proxy.native():
            run(second.d.root)
        self.assertNotEqual(second.d.root, self.root)
        self.assertEqual(second.native_events.count("train"), 1)
        self.assertEqual(len(second.native_calls), 2)
        commit = second.stage("model-updater")["commitRef"]
        builder = DiagEvoSolverDatasetBuilder(
            self.store,
            request,
            policy=generation.challenger.objective.policy,
            generation_builder=generation,
        )
        evidence = builder.round_evidence([commit], curriculum_ref=body["curriculumRef"])
        self.assertEqual([group.rewards for group in evidence.groups], [(1, -1)])
        self.assertFalse(self.store.path(second.f.private["digest"]).exists())

    def test_handoff_rejects_wrong_starting_model_sampling_and_retained_scope(self):
        self.ready_solver()
        ref, body, _, _ = self.first_job()
        request = self.solver_request(self.fresh.request, ref)
        for kind in (
            "weights",
            "sampling",
            "backend",
            "retained",
            "admission",
            "template",
            "missing-backend",
            "invalid-backend",
            "missing-generation",
        ):
            candidate, params, config = copy.deepcopy(request), {"constructionRef": ref}, {}
            if kind == "weights":
                candidate["parentModel"]["hfSnapshotRef"] = self.fresh.initial
            elif kind == "sampling":
                candidate["rollout"]["sampling"]["maxNewTokens"] += 1
            elif kind in (
                "backend",
                "retained",
                "missing-backend",
                "invalid-backend",
                "missing-generation",
            ):
                changed = copy.deepcopy(body)
                if kind == "backend":
                    changed["solverBackend"]["seed"] += 1
                elif kind == "retained":
                    changed["retainedQuestionIds"] = []
                elif kind == "missing-backend":
                    changed.pop("solverBackend")
                elif kind == "invalid-backend":
                    changed["solverBackend"] = None
                else:
                    changed.pop("generationRef")
                params["constructionRef"] = self.store.put_json(changed)
            elif kind == "admission":
                candidate["trainDataset"]["tasks"].pop()
            else:
                config["chatTemplateKwargs"] = {"enable_thinking": True}
            with self.subTest(kind=kind), self.assertRaises(ContractError):
                build_loop(
                    {"parameters": params},
                    SimpleNamespace(store=self.store, request=candidate, config=config),
                )


class UnadmittedCurriculumTests(unittest.TestCase):
    def test_unadmitted_curriculum_builder_cannot_create_gradients_or_committed_failures(self):
        builder = DiagEvoSolverDatasetBuilder(None)
        with self.assertRaisesRegex(ContractError, "admitted solver"):
            builder.build([], lease={}, curriculum_ref={}, answer_classes_ref={})
        with self.assertRaisesRegex(ContractError, "admitted solver"):
            builder.round_evidence([], curriculum_ref={})


if __name__ == "__main__":
    unittest.main()
