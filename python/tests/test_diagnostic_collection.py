"""Offline diagnostic evidence rejects reused runs and broken update chains."""
import tempfile
import unittest

from gear_training.content import ContentStore, ContractError
from probes.collect_controller_training_smoke import verify_updates


class DiagnosticCollectionTests(unittest.TestCase):
    def setUp(self):
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        self.store = ContentStore(root.name)

    def artifacts(self, *, reused_run=False, broken_chain=False, bad_logprobs=False):
        commits = []
        for update in (1, 2):
            policy = f"runtime/update-{update - 1}/weight-{update}"
            samples = [{"metadata": {"runId": f"run_{update}_{slot}", "policyVersion": policy},
                        "rollout_log_probs": [-0.5, 0], "loss_mask": [1, 0],
                        "response_length": 2, "reward": 0} for slot in (0, 1)]
            if update == 2 and reused_run: samples[0]["metadata"]["runId"] = "run_1_0"
            if update == 2 and bad_logprobs: samples[0]["rollout_log_probs"] = [-0.5]
            batch = self.store.put_json({"policyVersion": policy, "samplesRef": self.store.put_json([samples])})
            cursor = self.store.put_json({"committedUpdate": update, "batchRef": batch})
            checkpoint = self.store.put_json({"committedUpdate": update, "dataCursorRef": cursor})
            commit = {"committedUpdate": update, "dataCursorRef": cursor,
                      "consumedBatchDigest": batch["digest"], "checkpointRef": checkpoint}
            if update == 2: commit["previousCommitRef"] = batch if broken_chain else commits[0]
            commits.append(self.store.put_json(commit))
        return {"updateCommitRefs": commits, "checkpointRef": checkpoint}

    def test_two_updates_keep_four_physical_runs(self):
        result = verify_updates(self.store, self.artifacts(), 2)
        self.assertEqual([r["committedUpdate"] for r in result], [1, 2])
        self.assertEqual(len({run for r in result for run in r["runs"]}), 4)

    def test_first_update_run_cannot_supply_the_next_update(self):
        with self.assertRaises(ContractError) as caught:
            verify_updates(self.store, self.artifacts(reused_run=True), 2)
        self.assertEqual(caught.exception.code, "diagnostic-group-drift")

    def test_commits_must_preserve_the_preceding_checkpoint_chain(self):
        with self.assertRaises(ContractError) as caught:
            verify_updates(self.store, self.artifacts(broken_chain=True), 2)
        self.assertEqual(caught.exception.code, "diagnostic-commit-drift")

    def test_response_without_aligned_behavior_logprobs_is_not_evidence(self):
        with self.assertRaises(ContractError) as caught:
            verify_updates(self.store, self.artifacts(bad_logprobs=True), 2)
        self.assertEqual(caught.exception.code, "diagnostic-logprob-drift")


if __name__ == "__main__": unittest.main()
