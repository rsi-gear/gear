"""Exercise the real driver with CPU Ray actors and a durable SQLite/CAS store."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from gear_training.content import ContentStore, ContractError, atomic_json, digest_json
from gear_training.driver import run
from gear_training.ledger import Ledger
from gear_training.placement import resource_plan
from gear_training.preflight import compatibility_digest
from gear_training.recipes.agent_grpo import sampling_params
from test_placement import HYPERPARAMETERS, MemoryRuntime, Remote, request_fixture


class DriverMemoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.store = ContentStore(self.root / "content")
        self.request = request_fixture()
        self.hf = self.store.put_json({**self.request["parentModel"], "weightsDigest": "sha256:" + "b" * 64})
        self.state_ref = self.store.put_json({"fixture": "full optimizer/RNG checkpoint"})
        self.request["parentModel"].update(id="initial", hfSnapshotRef=self.hf)
        self.request.update(trainingRunId="run", referenceModelRef=self.store.put_json({"hfSnapshotRef": self.hf}),
                            budgets={"totalGpuSeconds": 600}, recipeDigest="recipe", datasetSplitDigest="train")
        self.request["trainer"]["hyperparametersRef"] = self.store.put_json(HYPERPARAMETERS)
        self.rt = MemoryRuntime()
        self.runtime = None
        self.fail_commit_reply = False
        self.barrier = "sealed"
        self.created_components = []
        self.args = SimpleNamespace(tensor_model_parallel_size=1, pipeline_model_parallel_size=1,
            rollout_batch_size=1, n_samples_per_prompt=2, global_batch_size=2, advantage_estimator="grpo",
            colocate=True, offload_train=True, offload_rollout=True, use_critic=False, release_train=False, rollout_external=False,
            update_weight_mode="full", update_weight_transport="nccl", no_save_optim=False, no_save_rng=False, async_save=False,
            check_weight_update_equal=True, rollout_global_dataset=False)
        engine = SimpleNamespace(get_url=Remote(lambda: "http://fake"), get_weight_version=Remote(lambda: 1))
        self.rt.manager.get_updatable_engines_and_lock = Remote(lambda: ([engine], None, None, None, None, None))
        self.rt.manager.generate = Remote(self.generate)
        self.rt.manager.dispose = Remote(lambda: self.rt.event("dispose"))
        self.rt.ray.init = lambda **kwargs: self.assertEqual(kwargs["num_gpus"], 1)
        self.rt.ray.shutdown = lambda: self.rt.event("shutdown")

    def generate(self, rollout_id):
        self.assertTrue(self.rt.weights and self.rt.kv)
        self.rt.event("generate")
        self.runtime = json.loads((self.root / "runtime.json").read_text())
        self.assertEqual(self.runtime["lease"]["samplingDigest"], digest_json(sampling_params(self.request["rollout"])))
        if not self.runtime.get("replayBatchRef"):
            self.seal_batch(self.runtime["lease"], self.runtime["replicas"], rollout_id)
        return "rollout-data"

    def seal_batch(self, lease, replicas, rollout_id):
        ledger = Ledger(self.root / "ledger.sqlite")
        try:
            ledger.open_lease(lease, replicas)
            ref = self.store.put_json({"policyVersion": lease["policyVersion"], "rolloutId": rollout_id})
            if self.barrier != "serving":
                ledger.drain(lease["batchId"]); ledger.close_lease(lease["batchId"])
                if self.barrier == "sealed": ledger.seal(lease["batchId"], ref)
            atomic_json(self.root / "batch.json", {"rolloutId": rollout_id, "batchRef": ref})
            return ref
        finally: ledger.close()

    def commit(self, store, ledger, **kwargs):
        self.assertFalse(self.rt.actor_awake or self.rt.weights or self.rt.kv)
        self.assertEqual(kwargs["trainer_state_ref"], self.state_ref)
        self.assertEqual(kwargs["trainer_state_ref"], kwargs["rng_state_ref"])
        cursor = store.put_json(kwargs["data_cursor"])
        cp = store.put_json({"schemaVersion": 1, "optimizerStateRef": self.state_ref, "schedulerAndRngRef": self.state_ref, "dataCursorRef": cursor, "committedUpdate": kwargs["committed_update"], "hfExportRef": self.hf,
            "actorWeightsDigest": "sha256:" + "b" * 64, "actorStateRef": self.state_ref, "compatibilityDigest": compatibility_digest(self.request)})
        commit = store.put_json({"checkpointRef": cp, "committedUpdate": kwargs["committed_update"],
            "trainingRunId": self.request["trainingRunId"], "consumedBatchDigest": kwargs["batch_ref"]["digest"],
            "rngRef": self.state_ref, "dataCursorRef": cursor,
            **({"previousCommitRef": kwargs["previous_commit"]} if kwargs.get("previous_commit") else {})})
        ledger.commit_update(kwargs["committed_update"], kwargs["batch_ref"]["digest"], commit)
        if self.fail_commit_reply: raise OSError("commit response lost")
        return cp, commit

    def run_driver(self):
        atomic_json(self.root / "request.json", self.request)
        atomic_json(self.root / "config.json", {"storeRoot": str(self.root / "content"), "slimePath": str(self.root)})
        _, values, _ = resource_plan(self.request, HYPERPARAMETERS["slimeArgs"])
        for key, value in values.items(): setattr(self.args, key[2:].replace("-", "_"), value)
        modules = {"ray": self.rt.ray,
            "slime.utils.arguments": SimpleNamespace(parse_args=lambda: self.args),
            "slime.ray.placement_group": SimpleNamespace(create_placement_groups=lambda args: {"rollout": None, "actor": None},
                create_rollout_manager=self.create_manager, create_training_models=self.create_actor),
            "slime.utils.logging_utils": SimpleNamespace(configure_logger=lambda: None, init_tracking=lambda *a: None, finish_tracking=lambda *a: None)}
        with patch.dict(sys.modules, modules), patch.object(sys, "argv", []), patch.object(sys, "path", sys.path[:]), \
                patch("gear_training.gpu_visibility.verify_visible_devices"), \
                patch("gear_training.driver.materialize", side_effect=lambda store, ref, path: Path(path)), \
                patch("gear_training.checkpoint_export.checkpoint_exporter", side_effect=self.exporter), \
                patch("gear_training.export.seal_directory", return_value=self.state_ref), \
                patch("gear_training.driver.commit_checkpoint", side_effect=self.commit):
            run(self.root)

    def create_manager(self, *args):
        self.created_components.append("rollout")
        return self.rt.manager, None

    def create_actor(self, *args):
        self.created_components.append("trainer")
        return self.rt.actor, None

    @contextmanager
    def exporter(self, args, pgs, update):
        self.created_components.append("exporter")
        self.assertEqual(update, 1)
        try: yield self.rt.actor
        finally: self.created_components.append("exporter-released")

    def test_real_driver_runs_two_updates_and_exports_while_rollout_is_offloaded(self):
        self.run_driver()
        self.assertEqual(self.rt.events.count("train"), 2)
        self.assertEqual(self.rt.events.count("offload_rollout"), 2)
        self.assertEqual(self.rt.events.count("export"), 2)
        self.assertNotIn("clear", self.rt.events)
        self.assertEqual(self.rt.events[-2:], ["dispose", "shutdown"])
        self.assertEqual(json.loads((self.root / "outcome.json").read_text()), {"outcome": "completed", "committedUpdate": 2})

    def test_real_driver_rejects_missing_durable_barrier_before_offload(self):
        self.barrier = "serving"
        with self.assertRaisesRegex(ContractError, "durable batch sealing"): self.run_driver()
        self.assertNotIn("offload_rollout", self.rt.events)
        self.assertNotIn("train", self.rt.events)
        self.assertEqual(self.rt.events[-2:], ["dispose", "shutdown"])

    def test_real_driver_rejects_closed_but_unsealed_batch(self):
        self.barrier = "closed-but-unsealed"
        with self.assertRaisesRegex(ContractError, "durable batch sealing"): self.run_driver()
        self.assertNotIn("offload_rollout", self.rt.events)
        self.assertNotIn("train", self.rt.events)

    def test_real_driver_recovers_pending_export_without_generation_or_retraining(self):
        self.request["trainer"]["updatesPerCandidate"] = 1
        batch = self.original_batch()
        atomic_json(self.root / "pending-update.json", {"committedUpdate": 1, "compatibilityDigest": compatibility_digest(self.request),
            "trainerStateRef": self.state_ref, "batchRef": batch, "dataCursor": {"committedUpdate": 1, "batchRef": batch}})
        self.run_driver()
        self.assertEqual(self.rt.events, ["export", "shutdown"])
        self.assertEqual(self.created_components, ["exporter", "exporter-released"])
        self.assertFalse((self.root / "pending-update.json").exists())
        self.assertEqual(json.loads((self.root / "progress.json").read_text())["committedUpdate"], 1)

    def test_pending_export_releases_before_loading_full_state_for_remaining_update(self):
        batch = self.original_batch()
        atomic_json(self.root / "pending-update.json", {"committedUpdate": 1, "compatibilityDigest": compatibility_digest(self.request),
            "trainerStateRef": self.state_ref, "batchRef": batch, "dataCursor": {"committedUpdate": 1, "batchRef": batch}})
        self.run_driver()
        self.assertEqual(self.created_components, ["exporter", "exporter-released", "rollout", "trainer"])
        self.assertEqual(self.rt.events.count("train"), 1)
        self.assertEqual(json.loads((self.root / "outcome.json").read_text())["committedUpdate"], 2)

    def original_batch(self):
        lease = {"state": "serving", "batchId": "old-batch", "policyVersion": "original-policy", "runtimeInstanceId": "original-runtime", "synchronizedWeightsRef": self.hf}
        replicas = [{"replicaId": "old", "weightsDigest": self.hf["digest"], "runtimeInstanceId": "original-runtime", "policyVersion": "original-policy"}]
        return self.seal_batch(lease, replicas, 0)

    def test_real_driver_replays_closed_batch_with_original_policy_identity(self):
        ref = self.original_batch()
        self.request["trainer"]["updatesPerCandidate"] = 1
        self.run_driver()
        self.assertEqual(self.runtime["replayBatchRef"], ref)
        self.assertEqual(self.store.read_json(ref)["policyVersion"], "original-policy")
        self.assertEqual(self.rt.events.count("train"), 1)
        self.assertLess(self.rt.events.index("offload_rollout"), self.rt.events.index("train"))

    def test_commit_reply_loss_recovers_only_metadata_without_cuda_or_another_update(self):
        self.request["trainer"]["updatesPerCandidate"] = 1
        self.fail_commit_reply = True
        with self.assertRaisesRegex(OSError, "commit response lost"): self.run_driver()
        self.assertTrue((self.root / "pending-update.json").exists())
        before = list(self.rt.events)
        # No Slime modules or patched actor are installed on the recovery path.
        with patch("gear_training.gpu_visibility.verify_visible_devices", side_effect=AssertionError("GPU restart")):
            run(self.root)
        self.assertEqual(self.rt.events, before)
        self.assertEqual(before.count("train"), 1)
        self.assertFalse((self.root / "pending-update.json").exists())
        self.assertEqual(json.loads((self.root / "outcome.json").read_text()), {"outcome": "completed", "committedUpdate": 1})
        first = (self.root / "artifacts.body.json").read_bytes()
        run(self.root)
        self.assertEqual((self.root / "artifacts.body.json").read_bytes(), first)

    def test_conflicting_pending_after_commit_is_rejected_before_cuda(self):
        self.request["trainer"]["updatesPerCandidate"] = 1
        self.fail_commit_reply = True
        with self.assertRaises(OSError): self.run_driver()
        pending = json.loads((self.root / "pending-update.json").read_text())
        pending["trainerStateRef"] = self.store.put_json({"different": "optimizer"})
        atomic_json(self.root / "pending-update.json", pending)
        with patch("gear_training.gpu_visibility.verify_visible_devices", side_effect=AssertionError("GPU restart")):
            with self.assertRaisesRegex(ContractError, "differs from its committed update"): run(self.root)
        self.assertTrue((self.root / "pending-update.json").exists())

    def test_pending_export_failure_retries_export_without_backpropagating(self):
        self.request["trainer"]["updatesPerCandidate"] = 1
        export = self.rt.actor.export_hf
        self.rt.actor.export_hf = lambda path: (_ for _ in ()).throw(OSError("partial HF writer"))
        with self.assertRaisesRegex(OSError, "partial HF writer"): self.run_driver()
        pending = (self.root / "pending-update.json").read_bytes()
        self.assertEqual(self.rt.events.count("train"), 1)
        self.rt.actor.export_hf = export
        self.run_driver()
        self.assertEqual(self.rt.events.count("train"), 1)
        self.assertEqual(self.rt.events.count("generate"), 1)
        self.assertFalse((self.root / "pending-update.json").exists())
        self.assertEqual(json.loads(pending)["committedUpdate"], 1)

    def test_missing_pending_batch_cannot_authorize_export_recovery(self):
        self.request["trainer"]["updatesPerCandidate"] = 1
        batch = self.store.put_json({"unsealed": "batch"})
        atomic_json(self.root / "pending-update.json", {"committedUpdate": 1, "compatibilityDigest": compatibility_digest(self.request),
            "trainerStateRef": self.state_ref, "batchRef": batch, "dataCursor": {"committedUpdate": 1, "batchRef": batch}})
        with self.assertRaisesRegex(ContractError, "original sealed and drained batch"): self.run_driver()
        self.assertEqual(self.rt.events, [])


if __name__ == "__main__": unittest.main()
