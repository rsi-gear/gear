from copy import deepcopy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "probes"))
from audit_training_capture import audit
from gear_training.content import ContentStore, ContractError, atomic_json


class CaptureAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.store = ContentStore(self.root / "cas")
        self.request = {"trainingRunId": "train", "recipeDigest": "recipe", "datasetSplitDigest": "split",
                        "trainer": {"updatesPerCandidate": 1}}
        metadata = {"episodeId": "episode", "runId": "run", "policyVersion": 1, "receiptIds": ["r0", "r1"]}
        self.sample = {"tokens": [10, 20, 30, 40], "response_length": 3, "loss_mask": [1, 0, 1],
                       "rollout_log_probs": [-.25, 0., -.5], "metadata": metadata}
        receipts = []
        for index, (inputs, outputs, behavior) in enumerate([([10], [20], [-.25]), ([10, 20, 30], [40], [-.5])]):
            receipts.append(self.store.put_json({"id": "r" + str(index), "complete": True, "callIndex": index,
                "finishReason": "tool-call" if index == 0 else "stop", **{k: metadata[k] for k in ("episodeId", "runId", "policyVersion")},
                "inputTokenIdsRef": self.store.put_json(inputs), "outputTokenIdsRef": self.store.put_json(outputs),
                "behaviorLogProbsRef": self.store.put_json(behavior)}))
        self.batch = {**{k: self.request[k] for k in ("trainingRunId", "recipeDigest", "datasetSplitDigest")},
                      "policyVersion": 1, "samplesRef": self.store.put_json([[self.sample]]), "sourceEvidenceRefs": receipts}
        self.captured = {"rollout_position": 0, "sample_index": 0, "tokens": self.sample["tokens"],
                         "response_lengths": 3, "loss_masks": self.sample["loss_mask"],
                         "rollout_log_probs": self.sample["rollout_log_probs"], "log_probs": [-.3, -99., -.55]}
        self.payload = {"format_version": 2, "rollout_id": 0, "rank": 0, "samples": [self.captured]}
        self.path = self.root / "rollout-0-rank-0.pt"

    def run_audit(self):
        batch_ref = self.store.put_json(self.batch)
        cursor = self.store.put_json({"committedUpdate": 1, "batchRef": batch_ref})
        checkpoint = self.store.put_json({"committedUpdate": 1, "dataCursorRef": cursor})
        commit = self.store.put_json({"committedUpdate": 1, "dataCursorRef": cursor, "checkpointRef": checkpoint,
                                     "consumedBatchDigest": batch_ref["digest"]})
        artifacts = {"updateCommitRefs": [commit], "checkpointRef": checkpoint}
        atomic_json(self.path, self.payload)
        return audit(self.store, self.request, artifacts, self.root, lambda p: json.loads(p.read_text()))

    def test_masked_tool_logprobs_are_excluded_but_receipts_are_exact(self):
        report = self.run_audit()
        self.assertTrue(report["passed"])
        self.assertAlmostEqual(report["updates"][0]["meanAbsoluteDifference"], .05)
        self.assertEqual(report["updates"][0]["samples"][0]["maskedTokens"], 1)
        self.assertNotIn("tokens", report["updates"][0]["samples"][0])

    def test_token_mask_order_logprob_drift_and_nonfinite_actor_fail(self):
        original = deepcopy(self.captured)
        for key, value in [("tokens", [10, 21, 30, 40]), ("loss_masks", [1, 1, 1]), ("sample_index", 1),
                           ("rollout_log_probs", [-.2, 0., -.5]), ("log_probs", [-.3, float("nan"), -.55]),
                           ("log_probs", [-.9, -99., -.9])]:
            with self.subTest(key=key, value=value):
                self.payload["samples"] = [{**original, key: value}]
                with self.assertRaises((ContractError, ValueError)): self.run_audit()

    def test_sealed_sample_and_capture_cannot_jointly_relabel_native_tokens(self):
        modified = deepcopy(self.sample); modified["tokens"][1] = 21
        self.batch["samplesRef"] = self.store.put_json([[modified]])
        self.captured["tokens"] = modified["tokens"]
        with self.assertRaisesRegex(ContractError, "native receipts"): self.run_audit()

    def test_other_frozen_request_and_rollout_are_rejected(self):
        self.batch["recipeDigest"] = "other"
        with self.assertRaisesRegex(ContractError, "commit chain"): self.run_audit()
        self.batch["recipeDigest"] = "recipe"; self.payload["rollout_id"] = 1
        with self.assertRaisesRegex(ContractError, "layout"): self.run_audit()

if __name__ == "__main__": unittest.main()
