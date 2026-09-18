import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "probes"))
from verify_instance_migration import verify
from gear_training.content import ContentStore, ContractError, atomic_json, digest_file


class MigrationTests(unittest.TestCase):
    def test_payload_digest_is_required_even_when_inventory_sizes_match(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store = ContentStore(root / "cas")
            ref = store.put_bytes(b"optimizer and RNG", "application/octet-stream")
            manifest = store.put_json({"format": "trainer-files", "files": [
                {"contentRef": ref, "sha256": ref["digest"], "size": 17, "path": "state.distcp"}]})
            pending = root / "pending.json"; atomic_json(pending, {"trainerStateRef": manifest})
            inventory = {"instanceId": 1, "stopped": True, "entries": [
                {"path": p.relative_to(root).as_posix(), "bytes": p.stat().st_size} for p in root.rglob("*") if p.is_file()]}
            expected = {"sourceInstanceId": 1, "files": [{"path": "pending.json", "size": pending.stat().st_size,
                "sha256": digest_file(pending)}], "git": [], "storePath": "cas", "pendingPath": "pending.json"}
            self.assertTrue(verify(root, inventory, expected)["passed"])
            store.path(ref["digest"]).write_bytes(b"X" * 17)
            with self.assertRaisesRegex(ContractError, "original digest"): verify(root, inventory, expected)
            store.path(ref["digest"]).unlink()
            with self.assertRaisesRegex(ContractError, "missing"): verify(root, inventory, expected)


if __name__ == "__main__": unittest.main()
