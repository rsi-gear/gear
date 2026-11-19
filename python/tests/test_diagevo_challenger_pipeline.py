"""Real frozen HF solver + native driver, with an explicitly fake Slime actor.

HTTP challenger generation and optimizer/checkpoint are CPU doubles. Only the
tiny solver's forward passes, capture facts, Math-Verify and native wiring are
real; this is not a two-model training effect experiment.
"""

import importlib.util
import json
import sys
import unittest
from contextlib import contextmanager
from unittest.mock import patch

import test_dev_grpo
import test_diagevo_inference
import test_diagevo_pipeline
from gear.training.backends.slime.driver import run
from gear.training.pipelines.diagevo_challenger import ChallengerDatasetStage
from gear.training.recipes import diagevo_inference
from gear.training.recipes.diagevo import DiagEvoPolicy
from gear.training.recipes.diagevo_challenger import DiagEvoChallengerReward
from gear.training.recipes.diagevo_inference import FrozenHFSolver
from gear.training.storage.content import ContractError


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
class ChallengerPipelineTests(unittest.TestCase):
    def setUp(self):
        self.driver = test_dev_grpo.DevGRPOTests()
        self.driver.setUp()
        self.addCleanup(self.driver.doCleanups)
        self.store, self.root = self.driver.d.store, self.driver.d.root
        self.solver_ref = test_diagevo_inference.tiny_model(self.root / "tiny-solver", self.store)
        self.driver.controller = self.controller
        self.driver.train = self.train
        self.questions = {
            "train-a": "Generate a new mathematical question.",
            "train-b": "Generate a new probability question.",
        }
        self.invalid = False
        request = self.driver.d.request
        request["rollout"]["zeroVarianceGroup"] = "keep"
        objective = DiagEvoChallengerReward(
            group_size=2,
            repetition_weight=0,
            policy=DiagEvoPolicy(construction_samples=4, optimization_group_size=2),
        )
        source = self.store.put_bytes(
            b"from gear.training.pipelines.diagevo_challenger import build_loop\n",
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
            "objective": objective.describe().to_dict(),
            "solver": {
                "model_ref": self.solver_ref,
                "instruction": "Solve and box the answer.",
                "max_new_tokens": 8,
                "max_context_tokens": 128,
                "max_calls": 16,
            },
            "prompts": {
                key: [{"role": "system", "content": "solve"}, {"role": "user", "content": text}]
                for key, text in self.questions.items()
            },
        }

    async def controller(self, stopped):
        # Same actual HTTP/SQLite bridge, using this fixture's challenger tasks.
        await test_diagevo_pipeline.SolverPipelineTests.controller(self, stopped)

    def train(self, rollout_id, data):
        samples = data["preprocessed"].samples[0]
        self.assertEqual([row.reward for row in samples], [0, 0] if self.invalid else [0.5, 0])
        for slot, row in enumerate(samples):
            self.assertEqual(row.tokens, [1, 10 + slot, 3, 4])
            self.assertEqual(row.loss_mask, [1, 1])
            self.assertEqual(row.rollout_log_probs, [-0.1, -0.1])
        self.driver.d.rt.train()

    @contextmanager
    def native(self):
        import transformers

        owner = self
        tokenizer_loader = transformers.AutoTokenizer.from_pretrained

        class Native:
            expected_weight_version = "1"

            async def generate(self, payload):
                owner.driver.native_calls.append(payload)
                valid = not owner.invalid and payload["input_ids"][-1] == 10
                return {
                    "text": "<question>What is one plus one?</question>" if valid else "bad format",
                    "output_ids": [3, 4],
                    "meta_info": {
                        "weight_version": "1",
                        "completion_tokens": 2,
                        "output_token_logprobs": [[-0.1, 3], [-0.1, 4]],
                        "finish_reason": {"type": "stop"},
                    },
                }

        def tokenizer(path, **kwargs):
            return object() if path == "cpu-fixture" else tokenizer_loader(path, **kwargs)

        # Keep the existing Slime/tokenizer fixture for its actor path, while
        # allowing the independently frozen solver to load real HF classes.
        with (
            self.driver.cpu_runtime(),
            patch.dict(sys.modules, {"transformers": transformers}),
            patch.object(transformers.AutoTokenizer, "from_pretrained", side_effect=tokenizer),
            patch("gear.training.backends.slime.rollout.NativeSGLang", return_value=Native()),
        ):
            yield

    def solver_records(self):
        return [
            json.loads(path.read_text())
            for path in sorted((self.root / "diagevo-frozen-solver/calls").glob("*/result.json"))
        ]

    def test_native_updates_consume_actual_frozen_solver_captures_and_rewards(self):
        with self.native():
            run(self.root)
        self.assertEqual(self.driver.native_events.count("train"), 2)
        self.assertEqual(len(self.driver.native_calls), 4)
        self.assertEqual(len(self.solver_records()), 8)
        policies = set()
        for index in range(2):
            dataset, update = (
                self.driver.stage(stage, index) for stage in ("dataset-builder", "model-updater")
            )
            self.assertEqual(
                dataset["batchRef"]["digest"],
                self.store.read_json(update["commitRef"])["consumedBatchDigest"],
            )
            batch = self.store.read_json(dataset["batchRef"])
            group = self.store.read_json(batch["samplesRef"])[0]
            proof = self.store.read_json(group[0]["metadata"]["curriculumRewardRef"])
            policies.add(proof["solverPolicyId"])
            self.assertEqual(len(proof["solverTrajectories"]), 1)
            for rows in proof["solverTrajectories"].values():
                self.assertEqual(len(rows), 4)
                for raw in rows:
                    receipt = self.store.read_json(raw["receipt_refs"][0])
                    source = self.store.read_json(receipt["rawRequestRef"])["native"]
                    self.assertEqual(source["backend"]["modelRef"], self.solver_ref)
        self.assertEqual(len(policies), 1)

    def test_local_receipt_reply_gap_does_not_resample_challenger_or_finished_solver(self):
        self.driver.d.request["trainer"]["updatesPerCandidate"] = 1
        finish = diagevo_inference._finish

        def gap(*args):
            finish(*args)
            raise RuntimeError("local solver receipt gap")

        with (
            self.native(),
            patch.object(diagevo_inference, "_finish", gap),
            self.assertRaisesRegex(RuntimeError, "receipt gap"),
        ):
            run(self.root)
        self.assertEqual(len(self.solver_records()), 1)
        self.assertEqual(len(self.driver.native_calls), 2)
        self.driver.reset_runtime()
        generate = FrozenHFSolver._generate
        calls = []

        def counted(backend, *args):
            calls.append(args)
            return generate(backend, *args)

        with self.native(), patch.object(FrozenHFSolver, "_generate", counted):
            run(self.root)
        self.assertEqual(len(calls), 3)
        self.assertEqual(len(self.driver.native_calls), 2)
        self.assertEqual(self.driver.native_events.count("train"), 1)

    def test_sealed_batch_reply_gap_replays_both_model_captures(self):
        self.driver.d.request["trainer"]["updatesPerCandidate"] = 1
        original = ChallengerDatasetStage.build

        async def gap(stage, ctx, raw):
            await original(stage, ctx, raw)
            raise RuntimeError("challenger batch reply gap")

        with (
            self.native(),
            patch.object(ChallengerDatasetStage, "build", gap),
            self.assertRaisesRegex(RuntimeError, "batch reply gap"),
        ):
            run(self.root)
        self.driver.reset_runtime()
        with (
            self.native(),
            patch.object(
                FrozenHFSolver, "_generate", side_effect=AssertionError("must not regenerate")
            ),
        ):
            run(self.root)
        self.assertEqual(len(self.driver.native_calls), 2)
        self.assertEqual(len(self.solver_records()), 4)
        self.assertEqual(self.driver.native_events.count("train"), 1)

    def test_commit_reply_gap_finishes_without_loading_either_model(self):
        self.driver.d.request["trainer"]["updatesPerCandidate"] = 1
        self.driver.d.fail_commit_reply = True
        with self.native(), self.assertRaisesRegex(OSError, "commit response lost"):
            run(self.root)
        before = self.driver.native_events[:]
        with (
            patch(
                "gear.training.backends.slime.gpu_visibility.verify_visible_devices",
                side_effect=AssertionError("must not restart CUDA"),
            ),
            patch.object(
                FrozenHFSolver, "_load", side_effect=AssertionError("must not load solver")
            ),
        ):
            run(self.root)
        self.assertEqual(self.driver.native_events, before)
        self.assertEqual(self.driver.stage("model-updater")["committedUpdate"], 1)

    def test_prompt_drift_stops_before_frozen_solver_generation(self):
        self.driver.d.request["trainer"]["scriptConfig"]["prompts"]["train-a"][-1]["content"] = (
            "Changed prompt"
        )
        with (
            self.native(),
            patch.object(FrozenHFSolver, "_load", side_effect=AssertionError("must not load")),
            self.assertRaisesRegex(ContractError, "frozen generation prompt"),
        ):
            run(self.root)
        self.assertFalse(self.solver_records())
        self.assertNotIn("train", self.driver.native_events)

    def test_all_malformed_questions_keep_zero_rewards_without_solver_calls(self):
        self.invalid = True
        self.driver.d.request["trainer"]["updatesPerCandidate"] = 1
        with (
            self.native(),
            patch.object(FrozenHFSolver, "_load", side_effect=AssertionError("must not load")),
        ):
            run(self.root)
        self.assertFalse(self.solver_records())
        self.assertEqual(self.driver.native_events.count("train"), 1)


if __name__ == "__main__":
    unittest.main()
