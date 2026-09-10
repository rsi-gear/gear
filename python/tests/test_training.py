import asyncio
import copy
import json
import math
import os
import struct
import tempfile
import unittest
from pathlib import Path
from datetime import datetime, timedelta, timezone

from gear_training.content import ContentStore, ContractError, digest_bytes, digest_json
from gear_training.gateway import ExactGateway
from gear_training.ledger import Ledger
from gear_training.samples import build_episode, admit_group, seal_batch
from gear_training.recipes.agent_grpo import effective_sampling
from gear_training.export import seal_directory, materialize, safetensors_layout


class TrainingTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = ContentStore(self.tmp.name)
        self.ledger = Ledger(Path(self.tmp.name) / "ledger.sqlite")
        self.ref = self.store.put_json({"test": "fixed"})
        self.sampling = {"temperature": 1, "top_p": 1, "top_k": -1, "repetition_penalty": 1, "max_new_tokens": 16,
                         "skip_special_tokens": False, "spaces_between_special_tokens": False, "no_stop_trim": True}
        self.context = {"id": "ep-0", "groupId": "group-0", "slot": 0, "runId": "run_" + "a" * 32, "taskId": "task-a", "logicalAttempt": 1,
                        "policyVersion": "runtime-1/update-0", "runtimeInstanceId": "runtime-1", "tokenizerDigest": self.ref["digest"],
                        "chatTemplateDigest": self.ref["digest"], "harnessRef": self.ref, "taskRef": self.ref, "environmentRef": self.ref,
                        "sampling": self.sampling, "maxContextTokens": 128, "maxEpisodeSteps": 4, "verifierVersion": self.ref["digest"],
                        "trainingRunId": "train-0", "batchId": "batch-0", "bindingId": "binding-0", "wireModel": "policy",
                        "generationContractDigest": self.ref["digest"]}
        self.lease = {"schemaVersion": 1, "trainingRunId": "train-0", "batchId": "batch-0", "policyVersion": self.context["policyVersion"],
                      "parentModelVersionId": self.ref["digest"], "synchronizedWeightsRef": self.ref, "runtimeInstanceId": "runtime-1",
                      "samplingDigest": digest_json(self.sampling), "fencingToken": "fence-0", "expiresAt": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(), "state": "serving"}
        self.ledger.open_lease(self.lease, [{"weightsDigest": self.ref["digest"], "runtimeInstanceId": "runtime-1", "policyVersion": self.lease["policyVersion"], "replicaId": "engine-0"}])

    def tearDown(self):
        self.ledger.close(); self.tmp.cleanup()

    def receipt(self, index, inputs, outputs, probs):
        return {"schemaVersion": 1, "id": "receipt-" + str(index), "episodeId": self.context["id"], "callIndex": index, "requestId": "req-" + str(index),
                **{k: self.context[k] for k in ("runId", "taskId", "logicalAttempt", "policyVersion", "runtimeInstanceId", "tokenizerDigest", "chatTemplateDigest")},
                "effectiveSamplingRef": self.store.put_json(self.sampling), "inputTokenIdsRef": self.store.put_json(inputs), "outputTokenIdsRef": self.store.put_json(outputs),
                "behaviorLogProbsRef": self.store.put_json(probs), "rawRequestRef": self.ref, "rawResponseRef": self.ref, "finishReason": "stop", "complete": True}

    def bundle(self):
        receipts = [self.receipt(0, [1, 2, 3], [4, 5], [-0.1, -0.2]), self.receipt(1, [1, 2, 3, 4, 5, 90, 91, 92], [6, 7, 8], [-0.3, -0.4, -0.5])]
        feedback = {"schemaVersion": 1, "id": "feedback", "episodeId": self.context["id"], "runId": self.context["runId"],
                    "receiptIds": [r["id"] for r in receipts], "verifierVersion": self.context["verifierVersion"], "verifierEvidenceRef": self.ref, "outcome": "valid", "reward": 0}
        episode = {"schemaVersion": 1, **{k: self.context[k] for k in ("id", "groupId", "slot", "runId", "policyVersion", "harnessRef", "taskRef", "environmentRef")},
                   "receiptIds": feedback["receiptIds"], "feedbackId": feedback["id"], "termination": "terminated", "eligibility": "eligible", "rejectionReasons": []}
        return episode, receipts, feedback

    def test_two_tool_turns_mask_only_native_tokens_and_keep_valid_failure(self):
        e, r, f = self.bundle()
        sample = build_episode(self.store, e, r, f, self.context)
        self.assertEqual(sample.tokens, [1, 2, 3, 4, 5, 90, 91, 92, 6, 7, 8])
        self.assertEqual(sample.response_length, 8)
        self.assertEqual(sample.loss_mask, [1, 1, 0, 0, 0, 1, 1, 1])
        self.assertEqual(sample.rollout_log_probs, [-0.1, -0.2, 0, 0, 0, -0.3, -0.4, -0.5])
        self.assertEqual(sample.reward, 0)

    def test_wrong_policy_tail_logprob_and_history_fail_admission(self):
        mutations = [lambda e, r, f: r[1].update(policyVersion="old-policy"), lambda e, r, f: r[1].update(complete=False),
            lambda e, r, f: r[1].update(behaviorLogProbsRef=self.store.put_json([-0.3])),
            lambda e, r, f: r[1].update(inputTokenIdsRef=self.store.put_json([1, 2, 999])),
            lambda e, r, f: f.update(verifierVersion="changed"), lambda e, r, f: r[1].update(requestId=r[0]["requestId"])]
        for mutate in mutations:
            e, r, f = self.bundle(); mutate(e, r, f)
            with self.assertRaises(ContractError): build_episode(self.store, e, r, f, self.context)

    def test_truncation_abort_infra_are_distinct_rejections(self):
        for reason in ("truncated", "aborted", "infra-error"):
            e, r, f = self.bundle(); e["termination"] = reason
            with self.assertRaises(ContractError) as error: build_episode(self.store, e, r, f, self.context)
            self.assertEqual(error.exception.code, "episode-" + reason)

    def test_group_zero_variance_and_task_mixing(self):
        e, r, f = self.bundle(); a = build_episode(self.store, e, r, f, self.context)
        b = copy.deepcopy(a); b.metadata.update(slot=1, episodeId="ep-1", runId="run_" + "b" * 32)
        with self.assertRaisesRegex(ContractError, "constant-reward"): admit_group([a, b], 2)
        self.assertEqual(len(admit_group([a, b], 2, "keep")), 2)
        b.reward = 1
        self.assertEqual(len(admit_group([a, b], 2)), 2)
        b.metadata["taskDigest"] = "other-task"
        with self.assertRaises(ContractError): admit_group([a, b], 2)

    def test_batch_never_seals_incomplete_groups_or_open_lease(self):
        request = {"trainingRunId": "train-0", "recipeDigest": self.ref["digest"], "datasetSplitDigest": self.ref["digest"],
                   "trainer": {"rolloutBatchSize": 1}, "rollout": {"groupSize": 2, "zeroVarianceGroup": "keep"}}
        with self.assertRaises(ContractError): seal_batch(self.store, [], request, self.lease, [])
        with self.assertRaises(ContractError): seal_batch(self.store, [], request, {**self.lease, "state": "closed"}, [])

    def test_sampling_locks_cannot_be_overridden_or_widened(self):
        for body in ({"temperature": 0}, {"top_p": .9}, {"max_tokens": 17}, {"seed": 2}, {"stop": ["x"]}, {"logit_bias": {}}):
            with self.assertRaises(ContractError): effective_sampling(self.sampling, body, 10, 128)
        self.assertEqual(effective_sampling(self.sampling, {"max_tokens": 8}, 10, 128)["max_new_tokens"], 8)
        self.assertEqual(effective_sampling(self.sampling, {}, 124, 128)["max_new_tokens"], 4)

    def test_logical_slots_request_and_feedback_retries_are_idempotent(self):
        self.ledger.register_episode(self.context, "tokenhash")
        self.ledger.register_episode(self.context, "tokenhash")
        conflict = {**self.context, "id": "other-episode"}
        with self.assertRaises(ContractError): self.ledger.register_episode(conflict, "new-token")
        index, old = self.ledger.begin_request(self.context, "r-0", "body-0")
        self.assertEqual(index, 0); self.assertIsNone(old)
        with self.assertRaises(ContractError): self.ledger.begin_request(self.context, "r-1", "body-1")
        self.ledger.complete_request("r-0", self.ref)
        self.assertEqual(self.ledger.begin_request(self.context, "r-0", "body-0"), (0, self.ref))
        with self.assertRaises(ContractError): self.ledger.begin_request(self.context, "r-0", "changed-body")
        _, _, f = self.bundle(); self.ledger.add_feedback(f); self.ledger.add_feedback(f)
        with self.assertRaises(ContractError): self.ledger.add_feedback({**f, "reward": 1})

    def test_failed_hf_export_never_commits_or_retrains_and_retry_uses_fresh_directory(self):
        from unittest.mock import Mock, patch
        from gear_training.driver import export_committed_actor
        actor = Mock()
        actor.export_hf.side_effect = [RuntimeError("partial shard"), None]
        checkpoint = {"committed_update": 1, "request": {"trainingRunId": "run"}, "batch_ref": self.ref}
        with patch("gear_training.driver.commit_checkpoint", return_value=(self.ref, self.ref)) as commit:
            with self.assertRaisesRegex(RuntimeError, "partial shard"):
                export_committed_actor(actor, self.store, self.ledger, export_root=self.tmp.name, **checkpoint)
            commit.assert_not_called()
            result = export_committed_actor(actor, self.store, self.ledger, export_root=self.tmp.name, **checkpoint)
            self.assertEqual(result, (self.ref, self.ref))
            commit.assert_called_once()
            actor.async_train.assert_not_called()
            self.assertNotEqual(actor.export_hf.call_args_list[0].args[0], actor.export_hf.call_args_list[1].args[0])
            self.assertEqual(commit.call_args.kwargs["batch_ref"], self.ref)

    def test_token_reservations_bound_concurrency_and_survive_failed_native_output(self):
        context = {**self.context, "maxRolloutTokens": 20}
        self.ledger.register_episode(context, "budget-token")
        self.ledger.begin_request(context, "budget-1", "body-1", 16)
        self.ledger.fail_request("budget-1", confirmed_stopped=True)
        self.assertEqual(self.ledger.usage()["rolloutTokens"], 16)
        with self.assertRaises(ContractError) as error:
            self.ledger.begin_request(context, "budget-2", "body-2", 16)
        self.assertEqual(error.exception.code, "rollout-token-budget")
        self.ledger.begin_request(context, "budget-2", "body-2", 4)
        self.ledger.charge("generation/budget-2", tokens=2)
        self.ledger.complete_request("budget-2", self.ref)
        self.assertEqual(self.ledger.usage()["rolloutTokens"], 18)
        self.assertEqual(self.ledger.begin_request(context, "budget-2", "body-2", 4), (1, self.ref))

    def test_existing_materialization_rejects_traversal_and_extra_files(self):
        root = Path(self.tmp.name) / "materialized"; root.mkdir()
        content = self.store.put_bytes(b"ok", "application/octet-stream")
        entry = {"path": "../escape", "size": 2, "sha256": content["digest"], "contentRef": content}
        ref = self.store.put_json({"schemaVersion": 1, "format": "trainer-files", "files": [entry]})
        with self.assertRaises(ContractError): materialize(self.store, ref, root)
        entry["path"] = "expected"; ref = self.store.put_json({"schemaVersion": 1, "format": "trainer-files", "files": [entry]})
        (root / "expected").write_bytes(b"ok"); (root / "injected").write_bytes(b"bad")
        with self.assertRaises(ContractError): materialize(self.store, ref, root)

    def test_drain_waits_for_runs_and_receipt_writes_and_fences_retries(self):
        self.ledger.register_episode(self.context, "tokenhash")
        self.ledger.begin_request(self.context, "r-0", "body")
        self.ledger.drain("batch-0")
        with self.assertRaises(ContractError): self.ledger.begin_request(self.context, "r-late", "body")
        with self.assertRaises(ContractError): self.ledger.close_lease("batch-0")
        self.ledger.complete_request("r-0", self.ref)
        with self.assertRaises(ContractError): self.ledger.close_lease("batch-0")
        self.ledger.finish_episode(self.context["id"])
        closed = self.ledger.close_lease("batch-0"); self.assertEqual(closed["state"], "closed")
        self.ledger.seal("batch-0", self.ref)
        with self.assertRaises(ContractError): self.ledger.add_feedback(self.bundle()[2])

    def test_restart_does_not_reopen_old_lease_and_update_commits_are_atomic(self):
        self.ledger.drain("batch-0"); self.ledger.close_lease("batch-0")
        with self.assertRaises(ContractError): self.ledger.open_lease(self.lease, [{"replicaId": "replica", "weightsDigest": self.ref["digest"], "runtimeInstanceId": "runtime-1", "policyVersion": self.lease["policyVersion"]}])
        self.ledger.commit_update(1, "batch-digest", self.ref); self.ledger.commit_update(1, "batch-digest", self.ref)
        with self.assertRaises(ContractError): self.ledger.commit_update(3, "next-batch", self.ref)
        with self.assertRaises(Exception): self.ledger.commit_update(2, "batch-digest", self.ref)
        self.assertEqual(self.ledger.db.execute("SELECT COUNT(*) FROM commits").fetchone()[0], 1)

    async def test_gateway_captures_actual_token_ids_version_and_retry(self):
        secret = "s" * 64; self.ledger.register_episode(self.context, digest_bytes(secret.encode()))
        class Native:
            expected_weight_version = "7"
            calls = 0
            async def generate(inner, payload):
                inner.calls += 1; self.assertEqual(payload["input_ids"], [100, 200]); self.assertTrue(payload["return_logprob"])
                return {"text": "display text need not round-trip", "meta_info": {"weight_version": "7", "completion_tokens": 2, "finish_reason": {"type": "stop"}, "output_token_logprobs": [[-0.2, 444, ""], [-0.4, 555, ""]]}}
            async def abort(inner, rid): return True
        native = Native()
        gateway = ExactGateway(self.store, self.ledger, native, "runtime-1", self.ref["digest"], self.ref["digest"], lambda body: [100, 200],
            lambda data, body, i, o: {"choices": [{"finish_reason": "stop", "message": {"content": "hello"}}]})
        body = {"model": "policy", "messages": [{"role": "user", "content": "test"}]}
        _, receipt = await gateway.generate(secret, body, "request-0")
        self.assertEqual(self.store.read_json(receipt["outputTokenIdsRef"]), [444, 555])
        self.assertEqual(self.store.read_json(receipt["behaviorLogProbsRef"]), [-0.2, -0.4])
        await gateway.generate(secret, body, "request-0"); self.assertEqual(native.calls, 1)
        self.assertEqual(self.ledger.usage()["rolloutTokens"], 2)
        native.expected_weight_version = "8"
        with self.assertRaisesRegex(ContractError, "weight version"): await gateway.generate(secret, body, "request-1")

    def test_export_rejects_truncated_bytes_bad_index_and_symlinks(self):
        path = Path(self.tmp.name) / "tensor.safetensors"
        header = json.dumps({"weight": {"dtype": "F32", "shape": [2], "data_offsets": [0, 8]}}).encode()
        path.write_bytes(struct.pack("<Q", len(header)) + header + struct.pack("<ff", 1, 2))
        self.assertEqual(safetensors_layout(path)["weight"]["shape"], [2])
        path.write_bytes(path.read_bytes()[:-1])
        with self.assertRaises(ContractError): safetensors_layout(path)
        directory = Path(self.tmp.name) / "export"; directory.mkdir()
        (directory / "file").symlink_to(path)
        with self.assertRaises(ContractError): seal_directory(self.store, directory)

    def test_cas_detects_corruption_and_materialization_traversal(self):
        self.store.path(self.ref["digest"]).write_bytes(b"changed")
        with self.assertRaises(ContractError): self.store.read_json(self.ref)
        manifest = self.store.put_json({"schemaVersion": 1, "format": "trainer-files", "files": [{"path": "../escape", "contentRef": self.ref, "size": 0, "sha256": self.ref["digest"]}]})
        with self.assertRaises(ContractError): materialize(self.store, manifest, Path(self.tmp.name) / "target")


if __name__ == "__main__":
    unittest.main()
