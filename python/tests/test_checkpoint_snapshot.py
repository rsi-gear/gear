"""Commit the exact durable pending snapshot without rereading mutable saves."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gear_training.content import ContentStore, ContractError
from gear_training.export import commit_checkpoint, seal_directory
from gear_training.ledger import Ledger


class CheckpointSnapshotTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.root = Path(temp.name); self.store = ContentStore(self.root / "cas")
        self.ledger = Ledger(self.root / "ledger.sqlite"); self.addCleanup(self.ledger.close)
        self.trainer = self.root / "trainer"; self.trainer.mkdir()
        (self.trainer / "state.pt").write_bytes(b"synchronously saved actor optimizer scheduler RNG")
        self.state = seal_directory(self.store, self.trainer)
        self.parent = dict(tokenizerDigest="tokenizer", chatTemplateDigest="template", architecture="model", dtype="bfloat16")
        self.hf = self.store.put_json(dict(self.parent, weightsDigest="weights"))
        self.kwargs = dict(request=dict(trainingRunId="run", parentModel=self.parent), committed_update=1,
            trainer_directory=self.trainer, trainer_state_ref=self.state, hf_directory=self.root / "hf",
            data_cursor=dict(committedUpdate=1), rng_state_ref=self.state, compatibility_digest="compatible",
            batch_ref=self.store.put_json(dict(batch=1)))

    def test_commit_retains_pending_snapshot_even_if_backend_directory_changes(self):
        (self.trainer / "state.pt").write_bytes(b"later mutable backend state")
        with patch("gear_training.export.seal_directory", return_value=self.hf) as seal:
            checkpoint, commit = commit_checkpoint(self.store, self.ledger, **self.kwargs)
        seal.assert_called_once_with(self.store, self.root / "hf", serving=True, verify_finite=True)
        body = self.store.read_json(checkpoint)
        for key in ("actorStateRef", "optimizerStateRef", "schedulerAndRngRef"):
            self.assertEqual(body[key], self.state)
        self.assertEqual(self.store.read_json(commit)["rngRef"], self.state)
        original = self.store.read_json(self.state)["files"][0]["contentRef"]
        self.assertEqual(self.store.read_bytes(original), b"synchronously saved actor optimizer scheduler RNG")
        self.assertEqual(self.ledger.db.execute("SELECT COUNT(*) FROM commits").fetchone()[0], 1)

    def test_other_snapshot_format_cannot_be_used_as_trainer(self):
        for manifest in ({"schemaVersion": 1, "format": "hf-safetensors", "files": [{}]},
                         {"schemaVersion": 1, "format": "trainer-files", "files": []}):
            ref = self.store.put_json(manifest)
            with self.assertRaisesRegex(ContractError, "complete trainer"):
                commit_checkpoint(self.store, self.ledger, **dict(self.kwargs, trainer_state_ref=ref, rng_state_ref=ref))
        self.assertEqual(self.ledger.db.execute("SELECT COUNT(*) FROM commits").fetchone()[0], 0)

    def test_mismatched_rng_cannot_commit(self):
        with self.assertRaisesRegex(ContractError, "same synchronous trainer"):
            commit_checkpoint(self.store, self.ledger, **dict(self.kwargs, rng_state_ref=self.hf))
        self.assertEqual(self.ledger.db.execute("SELECT COUNT(*) FROM commits").fetchone()[0], 0)
