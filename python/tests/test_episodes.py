from contextlib import contextmanager
import tempfile
import time
import unittest
from unittest.mock import patch

from gear_training.content import ContractError, digest_bytes
from gear_training.episodes import EpisodeJournal
from gear_training.samples import build_episode, seal_batch
from episode_fixture import EpisodeFixture


class EpisodeJournalTest(unittest.TestCase):
    @contextmanager
    def contract(self, code):
        with self.assertRaises(ContractError) as raised:
            yield
        self.assertEqual(raised.exception.code, code)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.f = EpisodeFixture(self.tmp.name)

    def tearDown(self):
        self.f.close(); self.tmp.cleanup()

    def test_native_tool_observations_and_feedback_replay_without_task_bodies(self):
        f = self.f; intent = f.publish(); address = f.address(intent)
        refs = f.generate(intent); result = f.feedback(intent)
        self.assertEqual(f.journal.admit(address, result), {"valid": True})
        self.assertEqual(f.journal.resolve(address, result), {"accepted": True})
        reopened = EpisodeJournal(f.directory)
        try:
            self.assertEqual(reopened.resolve(address, result), {"accepted": True})
            self.assertEqual(reopened.result(intent["id"]), result)
            with self.contract("episode-result-conflict"):
                reopened.resolve(address, {**result, "outcome": "cancelled", "reason": "cancelled"})
        finally: reopened.close()
        self.assertEqual(f.ledger.db.execute("SELECT COUNT(*) FROM feedback").fetchone()[0], 1)
        sample = build_episode(f.store, f.store.read_json(result["episodeRef"]), [f.store.read_json(r) for r in refs],
            f.store.read_json(result["feedbackRef"]), f.ledger.context(intent["id"]), assembly=f.store.read_json(result["assemblyRef"]))
        self.assertEqual(sample.tokens, [1, 2, 3, 4, 90, 91, 5])
        self.assertEqual(sample.loss_mask, [1, 1, 0, 0, 1]); self.assertEqual(sample.reward, 0)
        self.assertFalse(f.store.path(f.private["digest"]).exists())
        f.journal.consume(intent["id"])
        self.assertEqual(f.journal.list()["entries"], [])

    def test_admission_rejection_is_durable_and_does_not_commit_feedback(self):
        f = self.f; intent = f.publish(); address = f.address(intent)
        f.generate(intent, bad_history=True); result = f.feedback(intent)
        self.assertEqual(f.journal.admit(address, result), {"valid": False, "reason": "nonlinear-token-history"})
        self.assertIsNone(f.journal.result(intent["id"]))
        with self.contract("nonlinear-token-history"): f.journal.resolve(address, result)
        rejected = {"schemaVersion": 2, "outcome": "rejected", "evalId": result["evalId"], "reason": "nonlinear-token-history"}
        f.journal.resolve(address, rejected); f.journal.resolve(address, rejected)
        self.assertEqual(f.ledger.db.execute("SELECT COUNT(*) FROM feedback").fetchone()[0], 0)

    def test_wrong_fence_incarnation_eval_run_and_assembly_cannot_be_relabelled(self):
        f = self.f; intent = f.publish(); address = f.address(intent)
        for field in ("fencingToken", "incarnation", "inputDigest", "policyVersion"):
            with self.contract("episode-address-drift"):
                f.journal.acknowledge({**address, field: "changed"}, {"evalId": "eval_" + "b" * 32})
        f.generate(intent); result = f.feedback(intent)
        with self.contract("episode-eval-drift"): f.journal.admit(address, {**result, "evalId": "eval_" + "b" * 32})
        assembly = f.store.read_json(result["assemblyRef"]); assembly["taskDigest"] = f.ref["digest"]
        self.assertEqual(f.journal.admit(address, {**result, "assemblyRef": f.store.put_json(assembly)}), {"valid": False, "reason": "controller-assembly-drift"})
        episode = f.store.read_json(result["episodeRef"]); episode["runId"] = "run_" + "c" * 32
        with self.contract("episode-run-drift"): f.journal.admit(address, {**result, "episodeRef": f.store.put_json(episode)})

    def test_pending_native_request_requires_confirmed_stop_before_cancel_and_resume(self):
        f = self.f; intent = f.publish(); address = f.address(intent)
        context = f.ledger.bind_run(digest_bytes(intent["credential"].encode()), "runtime-1", "run_" + "d" * 32, intent["binding"]["bindingId"])
        f.ledger.begin_request(context, "pending-native", "request", 16)
        f.journal.acknowledge(address, {"evalId": "eval_" + "e" * 32})
        result = {"schemaVersion": 2, "outcome": "cancelled", "evalId": "eval_" + "e" * 32, "reason": "cancelled"}
        with self.contract("generation-still-running"): f.journal.resolve(address, result)
        with self.contract("controller-episodes-pending"): f.journal.reconcile_stopped()
        f.journal.resolve(address, result, confirmed_stopped=True); f.journal.reconcile_stopped()
        self.assertEqual(f.ledger.usage()["rolloutTokens"], 16)
        self.assertEqual(f.ledger.lease("batch-0")["state"], "closed")

    def test_expired_controller_contact_fences_generation_and_cannot_be_renewed(self):
        f = self.f; intent = f.publish()
        with patch("gear_training.ledger.time.time", return_value=time.time() + 20):
            with self.contract("controller-contact-expired"): f.ledger.assert_serving("batch-0")
            self.assertTrue(f.journal.list(renew=True)["entries"][0]["cancelRequested"])
        self.assertEqual(f.ledger.lease("batch-0")["state"], "draining")
        with self.contract("lease-fenced"): f.ledger.authorize(digest_bytes(intent["credential"].encode()), "runtime-1")

    def test_pagination_keeps_unconsumed_completed_slots_from_hiding_pending_work(self):
        f = self.f
        for slot in range(65):
            intent = f.publish(slot)
            if slot < 64: f.journal.resolve(f.address(intent), {"schemaVersion": 2, "outcome": "cancelled", "evalId": None, "reason": "cancelled"})
        page = f.journal.list(); self.assertEqual(len(page["entries"]), 64)
        last = f.journal.list(cursor=page["nextCursor"])
        self.assertEqual([entry["intent"]["id"] for entry in last["entries"]], ["episode-64"])
        self.assertIsNone(last["nextCursor"])
        with self.contract("controller-episodes-pending"): f.journal.reconcile_stopped()

    def test_cancelled_unconsumed_slot_rejects_late_hitch_acknowledgement(self):
        f = self.f; intent = f.publish(); address = f.address(intent)
        f.journal.resolve(address, {"schemaVersion": 2, "outcome": "cancelled", "evalId": None, "reason": "cancelled"})
        with self.contract("episode-already-cancelled"):
            f.journal.acknowledge(address, {"evalId": "eval_" + "b" * 32})

    def test_v2_batch_evidence_is_reachable_and_bound_to_manifest(self):
        f = self.f; samples = []; refs = []
        for slot in range(2):
            intent = f.publish(slot); native = f.generate(intent); result = f.feedback(intent, reward=slot)
            f.journal.resolve(f.address(intent), result)
            samples.append(build_episode(f.store, f.store.read_json(result["episodeRef"]), [f.store.read_json(r) for r in native],
                f.store.read_json(result["feedbackRef"]), f.ledger.context(intent["id"]), assembly=f.store.read_json(result["assemblyRef"])))
            refs.extend([result["episodeRef"], result["feedbackRef"], result["assemblyRef"], *native])
        f.ledger.drain("batch-0"); lease = f.ledger.close_lease("batch-0")
        batch = f.store.read_json(seal_batch(f.store, [samples], f.request, lease, refs))
        self.assertEqual(batch["schemaVersion"], 2); self.assertEqual(batch["sourceEvidenceRefs"], refs)
