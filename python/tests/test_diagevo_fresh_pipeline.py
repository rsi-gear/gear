"""Real local post-update HF sampling; native training remains a CPU double."""

import copy
import importlib.util
import json
import unittest
from unittest.mock import patch

import test_diagevo_challenger_pipeline as challenger_tests
from gear.training.backends.slime.driver import run
from gear.training.recipes import diagevo_inference
from gear.training.recipes.diagevo_data import DiagEvoChallengerDatasetBuilder
from gear.training.recipes.diagevo_generation import DiagEvoGenerationBuilder, DiagEvoQuestionPrompt
from gear.training.recipes.diagevo_inference import FrozenHFSolver
from gear.training.runtime.preflight import compatibility_digest
from gear.training.storage.content import ContractError
from gear.training.storage.models import seal_hf


def question_models(directory, store, *, response="<question>What is one plus one?</question>"):
    """Fixed decoder transitions input -> question -> EOS, without a text stub."""
    import torch
    from tokenizers import Tokenizer
    from tokenizers.models import WordLevel
    from transformers import GPT2Config, GPT2LMHeadModel, PreTrainedTokenizerFast

    raw = Tokenizer(
        WordLevel(
            {
                "<input>": 0,
                response: 1,
                "<eos>": 2,
                "<unk>": 3,
            },
            unk_token="<unk>",
        )
    )
    tokenizer = PreTrainedTokenizerFast(tokenizer_object=raw, eos_token="<eos>", unk_token="<unk>")
    tokenizer.chat_template = "<input>"
    tokenizer.save_pretrained(directory)
    config = GPT2Config(
        vocab_size=4,
        n_positions=128,
        n_ctx=128,
        n_embd=8,
        n_layer=1,
        n_head=1,
        eos_token_id=2,
        bos_token_id=0,
        resid_pdrop=0,
        embd_pdrop=0,
        attn_pdrop=0,
    )
    with torch.random.fork_rng(devices=[]):
        model = GPT2LMHeadModel(config)
    with torch.no_grad():
        for parameter in model.parameters():
            parameter.zero_()
        for name, parameter in model.named_parameters():
            if "ln_" in name and name.endswith("weight"):
                parameter.fill_(1)
        a = torch.tensor([1.0, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0])
        b = torch.tensor([0.0, 0.0, 1.0, -1.0, 0.0, 0.0, 0.0, 0.0])
        model.transformer.wte.weight[0].copy_(a)
        model.transformer.wte.weight[1].copy_(100 * (a + b))
        model.transformer.wte.weight[2].copy_(300 * b)
    model.save_pretrained(directory, safe_serialization=True)
    initial = seal_hf(store, directory)["model"]["hfSnapshotRef"]
    with torch.no_grad():
        model.transformer.wte.weight[2].mul_(1.1)
    model.save_pretrained(directory, safe_serialization=True)
    final = seal_hf(store, directory)["model"]["hfSnapshotRef"]
    assert initial != final
    return initial, final


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
class FreshPipelineTests(unittest.TestCase):
    def setUp(self):
        self.native = challenger_tests.ChallengerPipelineTests()
        self.native.setUp()
        self.addCleanup(self.native.doCleanups)
        self.driver = self.native.driver
        self.store, self.root = self.native.store, self.native.root
        self.request = self.driver.d.request
        self.request["trainer"]["updatesPerCandidate"] = 1
        self.initial, self.updated = question_models(self.root / "question-model", self.store)
        manifest = self.store.read_json(self.initial)
        self.request["parentModel"].update(
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
        self.request["parentModel"]["hfSnapshotRef"] = self.initial
        self.driver.d.hf = self.updated
        self.driver.d.commit = self.commit
        self.prompt = DiagEvoQuestionPrompt(
            system="solve", free="Generate a new mathematical question."
        )
        self.native.questions = {key: self.prompt.free for key in self.native.questions}
        parameters = self.request["trainer"]["scriptConfig"]
        parameters["prompts"] = {
            key: [
                {"role": "system", "content": "solve"},
                {"role": "user", "content": self.prompt.free},
            ]
            for key in self.native.questions
        }
        parameters["freshGeneration"] = {
            "prompt": self.prompt.describe().to_dict(),
            "memory": [],
            "nodes": [],
            "directives": {key: {"mode": "free", "cause_ids": []} for key in self.native.questions},
            "seed": 42,
            "maxSeconds": 10,
        }

    def commit(self, store, ledger, **kwargs):
        """Explicit fixture checkpoint/optimizer; export bytes are a real HF model."""
        driver = self.driver.d
        cursor = store.put_json(kwargs["data_cursor"])
        checkpoint = store.put_json(
            {
                "schemaVersion": 1,
                "committedUpdate": kwargs["committed_update"],
                "actorStateRef": driver.state_ref,
                "optimizerStateRef": driver.state_ref,
                "schedulerAndRngRef": driver.state_ref,
                "dataCursorRef": cursor,
                "hfExportRef": self.updated,
                "actorWeightsDigest": store.read_json(self.updated)["weightsDigest"],
                "compatibilityDigest": compatibility_digest(self.request),
            }
        )
        commit = store.put_json(
            {
                "schemaVersion": 1,
                "checkpointRef": checkpoint,
                "committedUpdate": kwargs["committed_update"],
                "trainingRunId": self.request["trainingRunId"],
                "consumedBatchDigest": kwargs["batch_ref"]["digest"],
                "rngRef": driver.state_ref,
                "dataCursorRef": cursor,
                **(
                    {"previousCommitRef": kwargs["previous_commit"]}
                    if kwargs.get("previous_commit")
                    else {}
                ),
            }
        )
        ledger.commit_update(kwargs["committed_update"], kwargs["batch_ref"]["digest"], commit)
        if driver.fail_commit_reply:
            raise OSError("commit response lost")
        return checkpoint, commit

    def records(self):
        return list(
            (
                self.root
                / "four-stage-loop/rounds/000000/model-updater/workspace/fresh-challenger/calls"
            ).glob("*/result.json")
        )

    def result(self):
        artifacts = json.loads((self.root / "artifacts.body.json").read_text())
        provenance = self.store.read_json(artifacts["model"]["provenanceRef"])
        result = self.store.read_json(provenance["trainingLoopRef"])
        self.assertEqual(result["checkpoint"]["checkpointRef"], artifacts["checkpointRef"])
        self.assertEqual(result["checkpoint"], self.driver.stage("model-updater"))
        self.assertEqual(result["roundsCompleted"], 1)
        ref = result["checkpoint"]["generationRef"]
        value = self.store.read_json(ref)
        from gear.training.pipelines.diagevo_solver import _component

        builder = DiagEvoGenerationBuilder(
            DiagEvoChallengerDatasetBuilder(
                self.store, self.request, objective=_component(value["objective"])
            ),
            prompt=self.prompt,
        )
        self.assertEqual(builder.read(ref)[0], value)
        return result, value, builder

    def test_final_export_is_sampled_and_result_is_reachable_from_model_provenance(self):
        with self.native.native():
            run(self.root)
        result, value, _ = self.result()
        self.assertEqual(len(self.records()), 2)
        self.assertEqual(len(value["questions"]), 2)
        self.assertEqual(set(value["questions"].values()), {"What is one plus one?"})
        self.assertEqual(value["input"]["localBackend"]["modelRef"], self.updated)
        self.assertNotIn("lease", value["input"])
        old = self.driver.stage("rollout-executor")["groups"][0]
        self.assertFalse(
            {row["context_ref"]["digest"] for row in old}
            & {row["context_ref"]["digest"] for group in value["input"]["groups"] for row in group}
        )
        for raw in value["input"]["groups"][0]:
            context = self.store.read_json(raw["context_ref"])
            self.assertNotIn("trainingRunId", context)
            self.assertEqual(context["taskId"], "train-b")
        self.assertEqual(result["checkpoint"]["generationUsage"]["outputTokens"], 4)
        self.assertEqual(self.driver.native_events.count("train"), 1)

    def test_native_commit_reply_gap_completes_fresh_inference_without_cuda(self):
        self.driver.d.fail_commit_reply = True
        with self.native.native(), self.assertRaisesRegex(OSError, "commit response lost"):
            run(self.root)
        self.assertFalse(self.records())
        before = self.driver.native_events[:]
        with patch(
            "gear.training.backends.slime.gpu_visibility.verify_visible_devices",
            side_effect=AssertionError("must not start CUDA"),
        ):
            run(self.root)
        self.assertEqual(self.driver.native_events, before)
        self.assertEqual(len(self.records()), 2)
        self.result()

    def test_fresh_receipt_reply_gap_only_generates_the_unfinished_slot(self):
        finish = diagevo_inference._finish

        def gap(directory, *args):
            saved = finish(directory, *args)
            if "fresh-challenger" in str(directory):
                raise RuntimeError("fresh receipt gap")
            return saved

        with (
            self.native.native(),
            patch.object(diagevo_inference, "_finish", gap),
            self.assertRaisesRegex(RuntimeError, "fresh receipt gap"),
        ):
            run(self.root)
        self.assertEqual(len(self.records()), 1)
        before = self.driver.native_events[:]
        generate, calls = FrozenHFSolver._generate, []

        def counted(backend, *args):
            calls.append(backend.model_ref)
            return generate(backend, *args)

        with (
            patch.object(FrozenHFSolver, "_generate", counted),
            patch(
                "gear.training.backends.slime.gpu_visibility.verify_visible_devices",
                side_effect=AssertionError("must not start CUDA"),
            ),
        ):
            run(self.root)
        self.assertEqual(calls, [self.updated] + [self.native.solver_ref] * 8)
        self.assertEqual(self.driver.native_events, before)
        self.result()

    def test_sealed_questions_reply_gap_only_runs_the_unfinished_solver_construction(self):
        original, refs = DiagEvoGenerationBuilder.seal_local, []

        def gap(builder, *args, **kwargs):
            refs.append(original(builder, *args, **kwargs))
            raise RuntimeError("fresh publication gap")

        with (
            self.native.native(),
            patch.object(DiagEvoGenerationBuilder, "seal_local", gap),
            self.assertRaisesRegex(RuntimeError, "fresh publication gap"),
        ):
            run(self.root)
        before = self.driver.native_events[:]
        original_generate, models = FrozenHFSolver._generate, []

        def generate(backend, *args):
            self.assertNotEqual(backend.model_ref, self.updated)
            models.append(backend.model_ref)
            return original_generate(backend, *args)

        with (
            patch.object(FrozenHFSolver, "_generate", generate),
            patch(
                "gear.training.backends.slime.gpu_visibility.verify_visible_devices",
                side_effect=AssertionError("must not start CUDA"),
            ),
        ):
            run(self.root)
        self.assertEqual(self.driver.native_events, before)
        result, _, _ = self.result()
        self.assertEqual(result["checkpoint"]["generationRef"], refs[0])
        self.assertEqual(models, [self.native.solver_ref] * 8)

    def test_old_weights_incomplete_groups_and_reused_training_captures_are_rejected(self):
        with self.native.native():
            run(self.root)
        _, value, builder = self.result()
        for name in ("old-weights", "incomplete-group", "training-captures", "native-lease"):
            inputs = copy.deepcopy(value["input"])
            if name == "old-weights":
                inputs["localBackend"]["modelRef"] = self.initial
            elif name == "incomplete-group":
                inputs["groups"][0].pop()
            elif name == "training-captures":
                inputs["groups"] = self.driver.stage("rollout-executor")["groups"]
            else:
                inputs["lease"] = self.driver.stage("rollout-executor")["lease"]
            with self.subTest(name=name), self.assertRaises(ContractError):
                builder._value(inputs)

    def test_memory_prompt_drift_stops_before_any_model_call(self):
        changed = DiagEvoQuestionPrompt(system="solve", free="Use a different prompt.")
        self.request["trainer"]["scriptConfig"]["freshGeneration"]["prompt"] = (
            changed.describe().to_dict()
        )
        with (
            self.native.native(),
            patch.object(FrozenHFSolver, "_load", side_effect=AssertionError("must not load")),
            self.assertRaisesRegex(ContractError, "frozen memory plan"),
        ):
            run(self.root)
        self.assertFalse(self.driver.native_calls)
        self.assertNotIn("train", self.driver.native_events)

    def test_repeated_task_groups_still_have_independent_captures(self):
        self.request["trainDataset"]["tasks"] = self.request["trainDataset"]["tasks"][:1]
        self.request["trainer"]["rolloutBatchSize"] = 2
        self.driver.d.args.rollout_batch_size = 2
        parameters = self.request["trainer"]["scriptConfig"]
        parameters["solver"]["max_calls"] = 24
        parameters["prompts"] = {"train-a": parameters["prompts"]["train-a"]}
        parameters["freshGeneration"]["directives"] = {"train-a": {"mode": "free", "cause_ids": []}}
        with self.native.native():
            run(self.root)
        result, value, _ = self.result()
        self.assertEqual(len(value["questions"]), 4)
        self.assertEqual(len(self.records()), 4)
        self.assertEqual(result["checkpoint"]["generationUsage"]["outputTokens"], 8)
        groups = value["input"]["groups"]
        self.assertEqual(
            len({self.store.read_json(group[0]["context_ref"])["groupId"] for group in groups}), 2
        )

    def test_post_commit_cancellation_resumes_without_retraining(self):
        self.driver.d.fail_commit_reply = True
        with self.native.native(), self.assertRaisesRegex(OSError, "commit response lost"):
            run(self.root)
        before = self.driver.native_events[:]
        (self.root / "cancel.json").write_text("{}")
        with patch(
            "gear.training.backends.slime.gpu_visibility.verify_visible_devices",
            side_effect=AssertionError("must not start CUDA"),
        ):
            run(self.root)
            self.assertEqual(
                json.loads((self.root / "outcome.json").read_text())["outcome"], "paused"
            )
            self.assertFalse(self.records())
            (self.root / "cancel.json").unlink()
            run(self.root)
        self.assertEqual(self.driver.native_events, before)
        self.result()


if __name__ == "__main__":
    unittest.main()
