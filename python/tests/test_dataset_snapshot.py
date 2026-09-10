import copy
from pathlib import Path
import tempfile
import unittest

from gear_training.content import ContentStore, ContractError
from gear_training.export import dataset_destination, materialize, seal_directory


class DatasetSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / "dataset"
        (self.source / "one/tests").mkdir(parents=True)
        (self.source / "one/empty").mkdir()
        (self.source / "one/task.toml").write_text('version = "1"\n')
        (self.source / "one/tests/test.sh").write_text('#!/bin/sh\nexit 0\n')
        (self.source / "one/tests/test.sh").chmod(0o755)
        (self.source / "one/tests").chmod(0o750)
        self.store = ContentStore(self.root / "content")
        self.ref = seal_directory(self.store, self.source, dataset=True)
        self.manifest = self.store.read_json(self.ref)

    def test_roundtrip_preserves_name_permissions_and_empty_directories(self):
        destination = dataset_destination(self.manifest, self.root / "cache" / self.ref["digest"][7:])
        restored = materialize(self.store, self.ref, destination)
        self.assertEqual(restored.name, self.source.name)
        self.assertEqual(seal_directory(self.store, restored, dataset=True), self.ref)
        self.assertTrue((restored / "one/empty").is_dir())
        self.assertEqual((restored / "one/tests/test.sh").stat().st_mode & 0o7777, 0o755)
        self.assertEqual((restored / "one/tests").stat().st_mode & 0o7777, 0o750)
        self.assertEqual(materialize(self.store, self.ref, destination), restored)

    def test_existing_mode_and_directory_drift_are_rejected(self):
        destination = self.root / "restored"
        materialize(self.store, self.ref, destination)
        file = destination / "one/tests/test.sh"; file.chmod(0o644)
        with self.assertRaisesRegex(ContractError, "permissions changed"): materialize(self.store, self.ref, destination)
        file.chmod(0o755); (destination / "one/empty").rmdir()
        with self.assertRaisesRegex(ContractError, "directories or root permissions"): materialize(self.store, self.ref, destination)

    def test_invalid_directory_tree_is_rejected_before_writing(self):
        for directories in ([{"path": "../outside", "mode": 0o755}], [],
                            [*self.manifest["directories"], {"path": "one/task.toml", "mode": 0o755}]):
            with self.subTest(directories=directories):
                bad = {**self.manifest, "directories": directories}
                destination = self.root / "bad"
                with self.assertRaises(ContractError): materialize(self.store, self.store.put_json(bad), destination)
                self.assertFalse(destination.exists())

    def test_invalid_name_and_mode_are_rejected(self):
        for name in ("..", "/outside", "a/b", "a\\b", "", "a\0b"):
            with self.subTest(name=name), self.assertRaises(ContractError):
                dataset_destination({**self.manifest, "name": name}, self.root / "bad")
        bad = copy.deepcopy(self.manifest); bad["files"][0]["mode"] = True
        with self.assertRaises(ContractError): materialize(self.store, self.store.put_json(bad), self.root / "bad")


if __name__ == "__main__": unittest.main()
