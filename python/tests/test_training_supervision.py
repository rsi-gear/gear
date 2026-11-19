"""Native-capture admission and caller conversion of semantic supervision."""

import copy
import importlib.util
import unittest
from dataclasses import asdict, replace
from pathlib import Path

import test_training
from gear.curriculum import (
    BuildSupervision,
    ExtractOutcomeCases,
    OutcomeRecord,
    RepairSupervision,
    RepairVerification,
    SupervisionTrace,
    TrajectoryVerification,
)
from gear.training.data.supervision import (
    PreferenceDatasetBuilder,
    ProceduralDatasetBuilder,
    RepairSFTDatasetBuilder,
)
from gear.training.data.trajectories import persist_trajectory
from gear.training.storage.content import ContractError, atomic_json, digest_json


class TrainingSupervisionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.fixture = test_training.TrainingTest()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.store = self.fixture.store
        self.root = Path(self.fixture.tmp.name)
        self.initial = self.store.put_json({"state": "initial"})
        self.middle = self.store.put_json({"state": "middle"})
        self.final = self.store.put_json({"state": "failed-terminal"})

    def capture(self, name, *, output=6, initial=None, observations=None):
        context = copy.deepcopy(self.fixture.context)
        context.update(
            id=name,
            initialStateRef=initial or self.initial,
            finalStateRef=self.final,
            checkpointStateRefs=[self.initial, self.middle],
            decisionStateRefs=[initial or self.initial, self.middle],
        )
        old = self.fixture.context
        self.fixture.context = context
        try:
            episode, receipts, feedback = self.fixture.bundle()
        finally:
            self.fixture.context = old
        for receipt in receipts:
            receipt["id"] = name + "-" + receipt["id"]
            receipt["requestId"] = name + "-" + receipt["requestId"]
        receipts[-1]["outputTokenIdsRef"] = self.store.put_json([output, output + 1, output + 2])
        if observations is not None:
            receipts[-1]["inputTokenIdsRef"] = self.store.put_json([1, 2, 3, 4, 5, *observations])
        feedback["receiptIds"] = episode["receiptIds"] = [row["id"] for row in receipts]
        return persist_trajectory(
            self.store,
            self.root,
            episode,
            feedback,
            [self.store.put_json(row) for row in receipts],
            context,
        )[0]

    def success(self, raw):
        episode = self.store.read_json(raw.episode_ref)
        return self.store.put_json(
            {
                "kind": "verified-success",
                "verified": True,
                "episodeId": episode["id"],
                "runId": episode["runId"],
                "receiptDigests": [r["digest"] for r in raw.receipt_refs],
                "evidenceRef": self.fixture.ref,
            }
        )

    def repair_proof(self, failed, revised, **changes):
        context = self.store.read_json(revised.context_ref)
        return self.store.put_json(
            {
                "schemaVersion": 1,
                "kind": "verified-repair",
                "verified": True,
                "failureVerified": True,
                "failedTrajectoryDigest": digest_json(asdict(failed)),
                "revisedTrajectoryDigest": digest_json(asdict(revised)),
                "mode": "verified_replay",
                "startStateDigest": context["initialStateRef"]["digest"],
                "lossStartReceipt": 1,
                "evidenceRef": self.fixture.ref,
                "materialProtocols": ["feedback_only"],
                **changes,
            }
        )

    def preference_proof(self, chosen, rejected, **changes):
        return self.store.put_json(
            {
                "schemaVersion": 1,
                "kind": "verified-preference",
                "verified": True,
                "chosenTrajectoryDigest": digest_json(asdict(chosen)),
                "rejectedTrajectoryDigest": digest_json(asdict(rejected)),
                "initialStateDigest": self.initial["digest"],
                "scope": "trajectory",
                "labelSource": "majority_vote",
                "confidence": 0.8,
                "evidenceRef": self.fixture.ref,
                "materialProtocols": ["feedback_only"],
                **changes,
            }
        )

    async def test_caller_maps_semantic_repair_to_new_receipts_and_exact_loss_mask(self):
        failed, revised = self.capture("failed"), self.capture("revised", output=10)
        traces = []
        for raw, passed in ((failed, False), (revised, True)):
            episode = self.store.read_json(raw.episode_ref)
            case = ExtractOutcomeCases()(
                (
                    OutcomeRecord(
                        "task-a",
                        "family",
                        episode["id"],
                        0,
                        episode["policyVersion"],
                        "env",
                        "completed",
                        passed,
                        True,
                        evidence_refs=(raw.feedback_ref,),
                    ),
                )
            )[0]
            traces.append(
                SupervisionTrace(
                    case,
                    self.store.put_json(asdict(raw)),
                    self.initial,
                    len(raw.receipt_refs),
                    final_state_ref=self.final,
                )
            )
        original, repaired = traces
        proposal = BuildSupervision()(
            RepairSupervision(
                original,
                repaired,
                1,
                RepairVerification(
                    original.digest,
                    repaired.digest,
                    "verified_replay",
                    self.initial,
                    (self.fixture.ref,),
                    "test-environment-verifier",
                ),
                TrajectoryVerification(
                    repaired.digest, "success", 2, (self.fixture.ref,), "test-verifier"
                ),
            )
        )
        # This caller's semantic steps are capture calls. No adapter layer or
        # token positions are supplied by the curriculum proposal.
        cut = next(span.start_step for span in proposal.spans if span.loss)
        proof = self.repair_proof(failed, revised, lossStartReceipt=cut)
        result = self.store.read_json(
            await RepairSFTDatasetBuilder(self.store).build(
                [
                    (failed, revised, proof, self.success(revised)),
                ]
            )
        )
        sample = result["samples"][0]
        self.assertEqual(sample["tokens"], [1, 2, 3, 4, 5, 90, 91, 92, 10, 11, 12])
        self.assertEqual(sample["lossMask"], [0, 0, 0, 0, 0, 1, 1, 1])
        self.assertEqual(sample["sourceTrajectory"], asdict(revised))
        self.assertNotIn("rolloutLogProbs", sample)
        self.assertEqual(self.store.read_json(failed.feedback_ref)["reward"], 0)

    async def test_repair_rejects_copied_receipts_missing_state_and_material_expansion(self):
        failed, revised = self.capture("failed"), self.capture("revised", output=10)
        rows = []
        for changes in (
            {"startStateDigest": "wrong"},
            {"lossStartReceipt": 2},
            {"materialProtocols": ["gold_answer_allowed"]},
        ):
            rows.append(
                (
                    failed,
                    revised,
                    self.repair_proof(failed, revised, **changes),
                    self.success(revised),
                )
            )
        context = self.store.read_json(revised.context_ref)
        del context["initialStateRef"]
        missing = replace(revised, context_ref=self.store.put_json(context))
        proof = self.store.read_json(self.repair_proof(failed, revised))
        proof["revisedTrajectoryDigest"] = digest_json(asdict(missing))
        rows.append((failed, missing, self.store.put_json(proof), self.success(missing)))
        receipts = [self.store.read_json(ref) for ref in revised.receipt_refs]
        originals = [self.store.read_json(ref) for ref in failed.receipt_refs]
        for row, original in zip(receipts, originals):
            row["requestId"] = original["requestId"]
        copied = replace(revised, receipt_refs=[self.store.put_json(row) for row in receipts])
        rows.append((failed, copied, self.repair_proof(failed, copied), self.success(copied)))
        for row in rows:
            with self.subTest(row=row[2]["digest"]), self.assertRaises(ContractError):
                await RepairSFTDatasetBuilder(self.store).build([row])

    async def test_continue_and_reset_require_captured_source_state(self):
        failed = self.capture("failed")
        for mode, state in (("terminal_continue", self.final), ("checkpoint_reset", self.middle)):
            revised = self.capture(mode, output=10, initial=state)
            proof = self.repair_proof(failed, revised, mode=mode, lossStartReceipt=0)
            result = self.store.read_json(
                await RepairSFTDatasetBuilder(self.store).build(
                    [
                        (failed, revised, proof, self.success(revised)),
                    ]
                )
            )
            self.assertEqual(result["samples"][0]["lossMask"], [1, 1, 0, 0, 0, 1, 1, 1])
        wrong = self.capture("wrong-state", initial=self.store.put_json({"state": "not-captured"}))
        with self.assertRaisesRegex(ContractError, "checkpoint"):
            await RepairSFTDatasetBuilder(self.store).build(
                [
                    (
                        failed,
                        wrong,
                        self.repair_proof(failed, wrong, mode="checkpoint_reset"),
                        self.success(wrong),
                    ),
                ]
            )

    async def test_trajectory_preference_allows_divergence_but_retains_pseudo_label_source(self):
        chosen = self.capture("chosen", output=10)
        rejected = self.capture("rejected", observations=[93, 94])
        proof = self.preference_proof(chosen, rejected)
        result = self.store.read_json(
            await PreferenceDatasetBuilder(self.store).build(
                [
                    (chosen, rejected, proof),
                ]
            )
        )
        pair = result["pairs"][0]
        self.assertEqual(pair["labelSource"], "majority_vote")
        self.assertEqual(pair["confidence"], 0.8)
        self.assertNotEqual(pair["chosen"]["tokens"], pair["rejected"]["tokens"])
        reverse = self.preference_proof(rejected, chosen)
        with self.assertRaisesRegex(ContractError, "repeated or reversed"):
            await PreferenceDatasetBuilder(self.store).build(
                [
                    (chosen, rejected, proof),
                    (rejected, chosen, reverse),
                ]
            )
        wrong = self.capture("other-start", initial=self.final)
        with self.assertRaisesRegex(ContractError, "initial state"):
            await PreferenceDatasetBuilder(self.store).build(
                [
                    (chosen, wrong, self.preference_proof(chosen, wrong)),
                ]
            )

    async def test_step_preference_requires_equal_actual_prefix_and_decision_state(self):
        chosen, rejected = self.capture("chosen", output=10), self.capture("rejected")
        fields = dict(
            scope="step",
            chosenReceiptIndex=1,
            rejectedReceiptIndex=1,
            decisionStateDigest=self.middle["digest"],
        )
        proof = self.preference_proof(chosen, rejected, **fields)
        pair = self.store.read_json(
            await PreferenceDatasetBuilder(self.store).build(
                [
                    (chosen, rejected, proof),
                ]
            )
        )["pairs"][0]
        self.assertEqual(pair["chosen"]["responseLength"], 3)
        self.assertEqual(pair["chosen"]["lossMask"], [1, 1, 1])
        diverged = self.capture("different-prefix", observations=[999])
        with self.assertRaisesRegex(ContractError, "conditioning"):
            await PreferenceDatasetBuilder(self.store).build(
                [
                    (chosen, diverged, self.preference_proof(chosen, diverged, **fields)),
                ]
            )
        context = self.store.read_json(rejected.context_ref)
        context["decisionStateRefs"][1] = self.final
        changed = replace(rejected, context_ref=self.store.put_json(context))
        with self.assertRaisesRegex(ContractError, "states differ"):
            await PreferenceDatasetBuilder(self.store).build(
                [
                    (chosen, changed, self.preference_proof(chosen, changed, **fields)),
                ]
            )

    async def test_native_token_or_proof_mutations_cannot_enter_a_dataset(self):
        chosen, rejected = self.capture("chosen", output=10), self.capture("rejected")
        proof = self.preference_proof(chosen, rejected)
        changed = replace(chosen, receipt_refs=list(chosen.receipt_refs))
        receipt = self.store.read_json(changed.receipt_refs[0])
        receipt["behaviorLogProbsRef"] = self.store.put_json([-0.1])
        changed.receipt_refs[0] = self.store.put_json(receipt)
        for validation in (proof, self.preference_proof(changed, rejected)):
            with self.assertRaises(ContractError):
                await PreferenceDatasetBuilder(self.store).build([(changed, rejected, validation)])

    @unittest.skipUnless(
        importlib.util.find_spec("transformers"), "requires tokenizer test environment"
    )
    async def test_synthetic_qa_uses_real_tokenizer_and_cannot_fake_native_evidence(self):
        import torch
        from gear.training.storage.models import seal_hf
        from safetensors.torch import save_file
        from tokenizers import Tokenizer
        from tokenizers.models import WordLevel
        from tokenizers.pre_tokenizers import Whitespace
        from transformers import PreTrainedTokenizerFast

        vocab = {"[UNK]": 0, "user": 1, "question": 2, "assistant": 3, "answer": 4}
        backend = Tokenizer(WordLevel(vocab, unk_token="[UNK]"))
        backend.pre_tokenizer = Whitespace()
        tokenizer = PreTrainedTokenizerFast(tokenizer_object=backend, unk_token="[UNK]")
        tokenizer.chat_template = (
            "{% for message in messages %}{{ message['role'] }} "
            "{% if message['role'] == 'assistant' %}{% generation %}{{ message['content'] }}"
            "{% endgeneration %}{% else %}{{ message['content'] }}{% endif %} {% endfor %}"
        )
        model_dir = self.root / "tiny-tokenizer"
        model_dir.mkdir()
        tokenizer.save_pretrained(model_dir)
        atomic_json(
            model_dir / "config.json",
            {
                "model_type": "gpt2",
                "architectures": ["GPT2LMHeadModel"],
                "torch_dtype": "float32",
                "vocab_size": len(vocab),
                "bos_token_id": None,
                "eos_token_id": None,
            },
        )
        save_file({"weight": torch.ones(1)}, model_dir / "model.safetensors")
        model = seal_hf(self.store, model_dir)
        example = {
            "question": "question",
            "answer": "answer",
            "materialProtocol": "feedback_only",
            "source": {
                "taskId": "train",
                "family": "family",
                "taskDigest": self.fixture.ref["digest"],
            },
        }
        proof = self.store.put_json(
            {
                "schemaVersion": 1,
                "kind": "verified-procedural-example",
                "verified": True,
                "exampleDigest": digest_json(example),
                "evidenceRef": self.fixture.ref,
                "materialProtocols": ["feedback_only"],
            }
        )
        builder = ProceduralDatasetBuilder(self.store)
        result = await builder.build(
            [(example, proof)], model_ref=model["modelRef"], max_sequence_tokens=64
        )
        dataset = self.store.read_json(result["datasetRef"])
        record = self.store.read_json(dataset["records"][0])
        self.assertEqual([t for t, m in zip(record["tokens"], record["lossMask"]) if m], [4])
        self.assertEqual(self.store.read_json(result["supervisionRef"])["labelSource"], "synthetic")
        self.assertNotIn("sourceTrajectory", record)
        with self.assertRaisesRegex(ContractError, "exact synthetic"):
            await builder.build(
                [(dict(example, answer="changed"), proof)],
                model_ref=model["modelRef"],
                max_sequence_tokens=64,
            )


if __name__ == "__main__":
    unittest.main()
