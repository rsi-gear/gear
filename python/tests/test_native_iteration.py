"""CPU process/CAS checks. These do not certify Megatron or GPU learning."""

import json
import os
import pickle
import random
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from test_placement import HYPERPARAMETERS, PATHS, request_fixture

from gear.training.backends.slime.driver import build_argv, validate_native_resume
from gear.training.runtime.job import JobService, experiment_deadline_expired
from gear.training.runtime.preflight import compatibility_digest
from gear.training.runtime.recovery import update_recovery
from gear.training.storage.content import ContentStore, ContractError
from gear.training.storage.ledger import Ledger
from gear.training.storage.snapshots import seal_directory


class NativeIterationTests(unittest.TestCase):
    def test_resume_owns_optimizer_rng_scheduler_and_native_load_flags(self):
        request = request_fixture()
        request["resumeCheckpointRef"] = {"digest": "saved-checkpoint"}
        argv = build_argv(request, HYPERPARAMETERS, PATHS, 4)
        self.assertEqual(argv.count("--use-checkpoint-opt-param-scheduler"), 1)
        self.assertEqual(argv[argv.index("--start-rollout-id") + 1], "4")
        self.assertEqual(argv[argv.index("--num-rollout") + 1], "6")
        for flag in (
            "--reset-optimizer-states",
            "--override-opt-param-scheduler",
            "--ckpt-step",
            "--no-load-optim",
            "--no-load-rng",
            "--finetune",
        ):
            with (
                self.subTest(flag=flag),
                self.assertRaisesRegex(ContractError, "checkpoint arguments"),
            ):
                build_argv(
                    request,
                    {**HYPERPARAMETERS, "slimeArgs": [*HYPERPARAMETERS["slimeArgs"], flag]},
                    PATHS,
                    4,
                )

    def test_native_resume_rejects_hf_fallback_and_all_state_reset_modes(self):
        args = SimpleNamespace(use_checkpoint_opt_param_scheduler=True)
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(ContractError, "complete Megatron checkpoint"):
                validate_native_resume(args, root, True)
            Path(root, "latest_checkpointed_iteration.txt").write_text("4")
            validate_native_resume(args, root, True)
            for name in (
                "no_load_optim",
                "no_load_rng",
                "finetune",
                "reset_optimizer_states",
                "override_opt_param_scheduler",
                "use_stateless_adam",
            ):
                with (
                    self.subTest(name=name),
                    self.assertRaisesRegex(ContractError, "retain optimizer"),
                ):
                    validate_native_resume(
                        SimpleNamespace(**{**vars(args), name: True}), root, True
                    )
            with self.assertRaisesRegex(ContractError, "saved scheduler"):
                validate_native_resume(
                    SimpleNamespace(use_checkpoint_opt_param_scheduler=False), root, True
                )
            # Pinned Slime explicitly sets these when loading the initial HF model.
            validate_native_resume(
                SimpleNamespace(no_load_optim=True, no_load_rng=True, finetune=True), root, False
            )

    def test_fresh_process_materializes_complete_native_state_and_data_cursor(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            store = ContentStore(root / "cas")
            saved = root / "saved"
            saved.mkdir()
            generator = random.Random(932)
            generator.random()
            state = {
                "actor": [0.15, -0.4],
                "optimizer": {"step": 7, "exp_avg": [0.3, 0.8]},
                "scheduler": {"num_steps": 28, "lr_decay_steps": 400},
                "rng": generator.getstate(),
            }
            (saved / "latest_checkpointed_iteration.txt").write_text("1")
            (saved / "state.pkl").write_bytes(pickle.dumps(state))
            snapshot = seal_directory(store, saved)
            request = request_fixture()
            request.update(trainingRunId="second-round", experimentId="cpu-fixture")
            hf = store.put_json({"fixture": "immutable-hf"})
            cursor = store.put_json(
                {"committedUpdate": 1, "position": 28, "source": "frozen-training-data"}
            )
            checkpoint = store.put_json(
                {
                    "schemaVersion": 1,
                    "actorStateRef": snapshot,
                    "optimizerStateRef": snapshot,
                    "schedulerAndRngRef": snapshot,
                    "dataCursorRef": cursor,
                    "hfExportRef": hf,
                    "actorWeightsDigest": "fixture-weights",
                    "committedUpdate": 1,
                    "compatibilityDigest": compatibility_digest(request),
                }
            )
            request["resumeCheckpointRef"] = checkpoint
            program = """
import json, pickle, random, sys
from pathlib import Path
from types import SimpleNamespace
from gear.training.storage.content import ContentStore
from gear.training.storage.ledger import Ledger
from gear.training.storage.snapshots import materialize
from gear.training.runtime.recovery import update_recovery
from gear.training.backends.slime.driver import validate_native_resume
body=json.load(sys.stdin); root=Path(body['root']); store=ContentStore(root/'cas')
work=root/'new-process'; work.mkdir(); ledger=Ledger(work/'ledger.sqlite')
recovered=update_recovery(work,body['request'],store,ledger)
checkpoint=store.read_json(recovered['checkpointRef'])
native=materialize(store,checkpoint['actorStateRef'],work/'native')
validate_native_resume(SimpleNamespace(use_checkpoint_opt_param_scheduler=True),native,True)
state=pickle.loads((native/'state.pkl').read_bytes()); random.setstate(state.pop('rng'))
print(json.dumps(dict(state=state,randomValue=random.random(),cursor=store.read_json(checkpoint['dataCursorRef']),start=recovered['start'])))
ledger.close()
"""
            observed = subprocess.run(
                [sys.executable, "-c", program],
                input=json.dumps({"root": str(root), "request": request}),
                capture_output=True,
                text=True,
                check=True,
                timeout=30,
                env=os.environ,
            )
            result = json.loads(observed.stdout)
            self.assertEqual(
                result["state"], {key: value for key, value in state.items() if key != "rng"}
            )
            self.assertEqual(result["randomValue"], generator.random())
            self.assertEqual(result["cursor"], store.read_json(cursor))
            self.assertEqual(result["start"], 1)
            # An optimizer-only or HF-only substitute cannot pass the same parent contract.
            changed = store.read_json(checkpoint)
            changed["optimizerStateRef"] = hf
            request["resumeCheckpointRef"] = store.put_json(changed)
            work = root / "reject-incomplete"
            work.mkdir()
            ledger = Ledger(work / "ledger.sqlite")
            try:
                with self.assertRaisesRegex(ContractError, "complete synchronous actor"):
                    update_recovery(work, request, store, ledger)
            finally:
                ledger.close()

    def test_expired_experiment_cannot_launch_another_worker_or_refresh_its_deadline(self):
        now = datetime.now(timezone.utc)
        request = {"deadlineAt": (now - timedelta(seconds=1)).isoformat()}
        self.assertTrue(experiment_deadline_expired(request, now))
        self.assertFalse(
            experiment_deadline_expired(
                {"deadlineAt": (now + timedelta(seconds=1)).isoformat()}, now
            )
        )
        with tempfile.TemporaryDirectory() as root:
            config = {
                "schemaVersion": 1,
                "storeRoot": root,
                "jobsRoot": str(Path(root) / "jobs"),
                "slimePath": root,
                "megatronPath": root,
                "gatewayBindHost": "127.0.0.1",
                "gatewayAdvertisedHost": "127.0.0.1",
                "hitchRoot": root,
                "hitchPath": root,
                "episodeTimeoutSeconds": 30,
            }
            service = JobService(config)
            with patch(
                "gear.training.runtime.job.preflight",
                side_effect=AssertionError("GPU preflight must not run"),
            ):
                with self.assertRaisesRegex(ContractError, "wall clock deadline"):
                    service.submit(request, "expired-round")
            self.assertEqual(list((Path(root) / "jobs").glob("job_*/identity.json")), [])


if __name__ == "__main__":
    unittest.main()
