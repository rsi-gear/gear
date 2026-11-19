"""Actual tiny causal-LM inference; no pretrained mathematics skill is claimed."""

import asyncio
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gear.training.data.samples import build_episode
from gear.training.recipes.diagevo_inference import FrozenHFSolver
from gear.training.storage.content import ContentStore, ContractError
from gear.training.storage.models import seal_hf

DEPENDENCIES = ("torch", "transformers", "tokenizers", "safetensors")


def tiny_model(directory, store, *, eos=0):
    """A real one-layer decoder with fixed weights favoring EOS, for capture tests."""
    import torch
    from tokenizers import Tokenizer
    from tokenizers.models import WordLevel
    from transformers import GPT2Config, GPT2LMHeadModel, PreTrainedTokenizerFast

    raw = Tokenizer(WordLevel({"<eos>": 0, "<unk>": 1}, unk_token="<unk>"))
    tokenizer = PreTrainedTokenizerFast(tokenizer_object=raw, eos_token="<eos>", unk_token="<unk>")
    # This deliberately trivial template is fixture material, not a math harness.
    tokenizer.chat_template = "{{ eos_token }}"
    tokenizer.save_pretrained(directory)
    config = GPT2Config(
        vocab_size=2,
        n_positions=128,
        n_ctx=128,
        n_embd=8,
        n_layer=1,
        n_head=1,
        eos_token_id=eos,
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
        model.transformer.wte.weight[0].copy_(torch.tensor([2.0, -2.0] * 4))
    model.save_pretrained(directory, safe_serialization=True)
    return seal_hf(store, directory)["model"]["hfSnapshotRef"]


@unittest.skipUnless(
    all(importlib.util.find_spec(name) for name in DEPENDENCIES),
    "install CPU torch/transformers/tokenizers/safetensors",
)
class FrozenSolverTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.store = ContentStore(self.root / "content")
        self.ref = tiny_model(self.root / "model", self.store)
        self.backend = self.make()

    def make(self, **options):
        return FrozenHFSolver(
            self.store,
            self.root / options.pop("root", "solver"),
            model_ref=options.pop("model_ref", self.ref),
            instruction="Solve the question and put the final answer in a boxed expression.",
            max_new_tokens=8,
            max_context_tokens=128,
            **options,
        )

    def sample(self, backend=None, *, key="group", questions=None, count=2):
        return asyncio.run(
            (backend or self.backend).sample(key, questions or {"q": "What is 1+1?"}, count=count)
        )

    def test_real_tokens_likelihoods_frozen_weights_and_rng(self):
        import torch

        rng = torch.random.get_rng_state().clone()
        rows = self.sample()["q"]
        self.assertTrue(torch.equal(rng, torch.random.get_rng_state()))
        self.assertEqual(len(rows), 2)
        self.assertNotEqual(rows[0], rows[1])
        weights = [parameter.clone() for parameter in self.backend.model.parameters()]
        for raw in rows:
            episode, feedback, context = (
                self.store.read_json(ref)
                for ref in (raw.episode_ref, raw.feedback_ref, raw.context_ref)
            )
            receipt = self.store.read_json(raw.receipt_refs[0])
            sample = build_episode(self.store, episode, [receipt], feedback, context)
            inputs = self.store.read_json(receipt["inputTokenIdsRef"])
            outputs = self.store.read_json(receipt["outputTokenIdsRef"])
            self.assertEqual(inputs, [0])
            self.assertEqual(outputs, [0])
            with torch.inference_mode():
                logits = self.backend.model(torch.tensor([inputs])).logits[0, -1].float()
            self.assertAlmostEqual(
                sample.rollout_log_probs[0], float(logits.log_softmax(-1)[0]), places=6
            )
            self.assertEqual(sample.reward, 0)
            proof = self.store.read_json(feedback["verifierEvidenceRef"])
            self.assertFalse(proof["correctnessAssessed"])
        self.sample(key="another")
        for before, after in zip(weights, self.backend.model.parameters(), strict=True):
            self.assertTrue(torch.equal(before, after))
            self.assertFalse(after.requires_grad)

    def test_completed_replay_needs_neither_model_load_nor_new_generation(self):
        expected = self.sample()
        backend = self.make()
        with (
            patch.object(backend, "_load", side_effect=AssertionError("must not load")),
            patch.object(backend, "_generate", side_effect=AssertionError("must not generate")),
        ):
            self.assertEqual(self.sample(backend), expected)
        self.assertIsNone(backend.model)

    def test_declared_template_options_change_actual_tokens_and_enter_identity(self):
        from transformers import AutoTokenizer

        directory = self.root / "model"
        tokenizer = AutoTokenizer.from_pretrained(directory, local_files_only=True)
        tokenizer.chat_template = (
            "{% if enable_thinking %}{{ unk_token }}{% else %}{{ eos_token }}{% endif %}"
        )
        tokenizer.save_pretrained(directory)
        ref = seal_hf(self.store, directory)["model"]["hfSnapshotRef"]
        for flag, expected in ((False, [0]), (True, [1])):
            backend = self.make(
                root=str(flag), model_ref=ref, chat_template_kwargs={"enable_thinking": flag}
            )
            row = self.sample(backend, count=1)["q"][0]
            receipt = self.store.read_json(row.receipt_refs[0])
            self.assertEqual(self.store.read_json(receipt["inputTokenIdsRef"]), expected)
            self.assertEqual(backend.identity["chatTemplateKwargs"], {"enable_thinking": flag})
        for options in ({"enable_thinking": "false"}, {"unsealed_option": True}):
            with self.subTest(options=options), self.assertRaises(ContractError):
                self.make(root="invalid", chat_template_kwargs=options)

    def test_native_output_budget_can_fill_the_remaining_context(self):
        backend = FrozenHFSolver(
            self.store,
            self.root / "full-context",
            model_ref=self.ref,
            instruction="Solve the question.",
            max_new_tokens=128,
            max_context_tokens=128,
        )
        row = self.sample(backend, count=1)["q"][0]
        receipt = self.store.read_json(row.receipt_refs[0])
        effective = self.store.read_json(receipt["effectiveSamplingRef"])
        self.assertEqual(effective["max_new_tokens"], 127)
        self.assertEqual(self.store.read_json(receipt["inputTokenIdsRef"]), [0])

    def test_local_interruption_reuses_seed_and_quota_reservation(self):
        import gear.training.recipes.diagevo_inference as module

        backend = self.make(root="gap", max_calls=1)
        original, generated = module._finish, []

        def gap(directory, request, receipt):
            generated.append(receipt["generation"])
            raise RuntimeError("local publication gap")

        with patch.object(module, "_finish", gap):
            with self.assertRaisesRegex(RuntimeError, "publication gap"):
                self.sample(backend, count=1)
        resumed = self.make(root="gap", max_calls=1)
        with patch.object(module, "_finish", wraps=original) as finish:
            row = self.sample(resumed, count=1)["q"][0]
        result = finish.call_args.args[2]["generation"]
        for field in ("inputTokenIds", "outputTokenIds", "behaviorLogProbs", "text"):
            self.assertEqual(result[field], generated[0][field])
        self.assertTrue(row.receipt_refs)
        with self.assertRaisesRegex(ContractError, "quota exhausted"):
            self.sample(resumed, key="new", count=1)

    def test_changed_question_group_size_and_backend_identity_are_rejected(self):
        self.sample()
        for kwargs in ({"questions": {"q": "Different question?"}}, {"count": 3}):
            with (
                self.subTest(kwargs=kwargs),
                self.assertRaisesRegex(ContractError, "input changed"),
            ):
                self.sample(**kwargs)
        with self.assertRaisesRegex(ContractError, "input changed"):
            self.make(seed=99)

    def test_truncated_response_is_saved_and_never_regenerated_as_success(self):
        ref = tiny_model(self.root / "never-eos", self.store, eos=1)
        backend = self.make(root="length", model_ref=ref)
        with self.assertRaisesRegex(ContractError, "did not reach EOS"):
            self.sample(backend, count=1)
        with patch.object(backend, "_generate", side_effect=AssertionError("must not regenerate")):
            with self.assertRaisesRegex(ContractError, "did not reach EOS"):
                self.sample(backend, count=1)
        self.assertEqual(len(list((self.root / "length/calls").glob("*/result.json"))), 1)

    def test_corrupted_model_bytes_are_rejected_before_forward(self):
        row = next(
            row
            for row in self.store.read_json(self.ref)["files"]
            if row["path"].endswith(".safetensors")
        )
        self.store.path(row["contentRef"]["digest"]).write_bytes(b"corrupt")
        with self.assertRaises(ContractError):
            self.sample(count=1)


if __name__ == "__main__":
    unittest.main()
