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
from gear.training.data.builders import SFTDatasetBuilder
from gear.training.data.offline import read_dataset, seal_batch
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

    def offline_scope(self):
        model = {
            key: self.fixture.context[key] for key in ("tokenizerDigest", "chatTemplateDigest")
        }
        return {
            "model_ref": self.store.put_json(model),
            "train_tasks": [{"id": "task-a", "family": "family", "taskRef": self.fixture.ref}],
            "max_sequence_tokens": 128,
        }

    def offline_request(self, sealed, scope):
        return {
            "trainingRunId": "offline-repair",
            "recipeDigest": digest_json("offline-sft-v1"),
            "datasetSplitDigest": digest_json(scope["train_tasks"]),
            "trainer": {"recipe": "offline-sft-v1", "rolloutBatchSize": 1},
            "parentModel": self.store.read_json(scope["model_ref"]),
            "trainDataset": {"tasks": scope["train_tasks"]},
            "offlineTraining": {
                "datasetRef": sealed["datasetRef"],
                "maskContract": sealed["maskContract"],
                "maxSequenceTokens": scope["max_sequence_tokens"],
                "maxEpochs": 1,
                "shuffleSeed": 7,
            },
        }

    async def test_repair_capture_enters_existing_offline_sft_batch_without_reencoding(self):
        failed, revised = self.capture("failed"), self.capture("revised", output=10)
        repairs = [(failed, revised, self.repair_proof(failed, revised), self.success(revised))]
        scope = self.offline_scope()
        builder = RepairSFTDatasetBuilder(self.store)
        sealed = await builder.build_offline(repairs, **scope)
        self.assertEqual(sealed, await builder.build_offline(repairs, **scope))
        request = self.offline_request(sealed, scope)
        dataset = read_dataset(self.store, request)
        batch_ref = seal_batch(self.store, request, 0)
        self.assertEqual(batch_ref, seal_batch(self.store, request, 0))
        batch = self.store.read_json(batch_ref)
        self.assertEqual(batch["recordRefs"], dataset["records"])
        record = self.store.read_json(batch["samplesRef"])[0]
        self.assertEqual(record["tokens"], [1, 2, 3, 4, 5, 90, 91, 92, 10, 11, 12])
        self.assertEqual(record["lossMask"], [0] * 8 + [1, 1, 1])
        self.assertEqual(record["tokenRoles"][3:5], ["assistant", "assistant"])
        self.assertNotIn("rolloutLogProbs", record)
        provenance = self.store.read_json(sealed["supervisionRef"])
        intermediate = self.store.read_json(provenance["intermediateRef"])
        self.assertEqual(intermediate["samples"][0]["sourceTrajectory"], asdict(revised))
        self.assertEqual(intermediate["samples"][0]["failedSourceTrajectory"], asdict(failed))
        self.assertEqual(intermediate["samples"][0]["repairProofRef"], repairs[0][2])
        self.assertEqual(provenance["datasetRef"], sealed["datasetRef"])
        request["trainDataset"]["tasks"][0]["family"] = "held-out"
        with self.assertRaisesRegex(ContractError, "authorized train"):
            read_dataset(self.store, request)

    async def test_success_and_verified_prefix_keep_their_native_boundaries_offline(self):
        raw = self.capture("success", output=10)
        proof = self.store.read_json(self.success(raw))
        for count, expected in ((2, [1, 2, 3, 4, 5, 90, 91, 92, 10, 11, 12]), (1, [1, 2, 3, 4, 5])):
            value = {
                **proof,
                "kind": "verified-prefix" if count == 1 else "verified-success",
                "receiptCount": count,
                "receiptDigests": [ref["digest"] for ref in raw.receipt_refs[:count]],
            }
            result = await SFTDatasetBuilder(self.store).build_offline(
                [raw], verifications={"success": self.store.put_json(value)}, **self.offline_scope()
            )
            dataset = self.store.read_json(result["datasetRef"])
            record = self.store.read_json(dataset["records"][0])
            self.assertEqual(record["tokens"], expected)
            self.assertEqual(record["lossMask"][:5], [0, 0, 0, 1, 1])
            self.assertEqual(len(record["lossMask"]), len(expected))

    async def test_offline_capture_checks_scope_model_limits_and_original_proofs(self):
        failed, revised = self.capture("failed"), self.capture("revised", output=10)
        repairs = [(failed, revised, self.repair_proof(failed, revised), self.success(revised))]
        scope = self.offline_scope()
        model = self.store.read_json(scope["model_ref"])
        small_config = self.store.put_json({"vocab_size": 10, "max_position_embeddings": 128})
        snapshot = self.store.put_json(
            {
                "format": "hf-safetensors",
                "files": [{"path": "config.json", "contentRef": small_config}],
            }
        )
        changes = (
            {"model_ref": self.store.put_json({**model, "tokenizerDigest": "wrong"})},
            {"model_ref": self.store.put_json({**model, "chatTemplateDigest": "wrong"})},
            {"model_ref": self.store.put_json({**model, "hfSnapshotRef": snapshot})},
            {"train_tasks": [{"id": "held-out", "family": "family", "taskRef": self.fixture.ref}]},
            {"train_tasks": [{"id": "task-a", "family": "family", "taskRef": self.initial}]},
            {"train_tasks": []},
            {"max_sequence_tokens": 4},
            {"max_sequence_tokens": True},
        )
        for change in changes:
            with self.subTest(change=change), self.assertRaises(ContractError):
                await RepairSFTDatasetBuilder(self.store).build_offline(
                    repairs, **{**scope, **change}
                )
        false_proof = {**self.store.read_json(repairs[0][3]), "verified": False}
        with self.assertRaises(ContractError):
            await RepairSFTDatasetBuilder(self.store).build_offline(
                [(failed, revised, repairs[0][2], self.store.put_json(false_proof))], **scope
            )
        with self.assertRaisesRegex(ContractError, "unique"):
            await SFTDatasetBuilder(self.store).build_offline(
                [revised, revised], verifications={"revised": self.success(revised)}, **scope
            )

    @unittest.skipUnless(
        importlib.util.find_spec("torch"), "requires CPU training test environment"
    )
    async def test_repaired_offline_tokens_drive_cpu_loss_only_on_the_verified_suffix(self):
        import torch
        import torch.nn.functional as functional

        failed, revised = self.capture("failed"), self.capture("revised", output=10)
        scope = self.offline_scope()
        sealed = await RepairSFTDatasetBuilder(self.store).build_offline(
            [(failed, revised, self.repair_proof(failed, revised), self.success(revised))], **scope
        )
        request = self.offline_request(sealed, scope)
        batch = self.store.read_json(seal_batch(self.store, request, 0))
        record = self.store.read_json(batch["samplesRef"])[0]
        tokens = torch.tensor(record["tokens"])
        mask = torch.tensor(record["lossMask"][1:], dtype=torch.bool)
        model = torch.nn.Embedding(128, 128)
        torch.nn.init.zeros_(model.weight)
        optimizer = torch.optim.SGD(model.parameters(), lr=0.1)

        def loss():
            return functional.cross_entropy(model(tokens[:-1])[mask], tokens[1:][mask])

        before = float(loss().detach())
        loss().backward()
        changed = set(torch.nonzero(model.weight.grad.abs().sum(dim=1)).flatten().tolist())
        self.assertEqual(changed, {92, 10, 11})
        optimizer.step()
        self.assertLess(float(loss().detach()), before)

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
