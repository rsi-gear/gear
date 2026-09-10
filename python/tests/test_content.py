import errno
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gear_training.content import ContentStore, ContractError


class FileImportTests(unittest.TestCase):
    def test_verified_checkpoint_reuse_needs_no_space_for_a_second_copy(self):
        with tempfile.TemporaryDirectory() as root:
            store = ContentStore(Path(root) / "cas")
            source = Path(root) / "checkpoint.bin"
            source.write_bytes(b"complete-checkpoint")
            ref = store.put_file(source)
            with patch("gear_training.content.shutil.copyfileobj", side_effect=OSError(errno.ENOSPC, "disk full")):
                self.assertEqual(store.put_file(source), ref)
                source.write_bytes(b"next-complete-checkpoint")
                with self.assertRaises(OSError) as error: store.put_file(source)
                self.assertEqual(error.exception.errno, errno.ENOSPC)
            self.assertEqual(store.read_bytes(ref), b"complete-checkpoint")
            self.assertEqual(list(store.root.rglob("*.tmp")), [])

    def test_reuse_still_rejects_corrupted_cas_bytes(self):
        with tempfile.TemporaryDirectory() as root:
            store = ContentStore(Path(root) / "cas")
            source = Path(root) / "checkpoint.bin"
            source.write_bytes(b"checkpoint")
            ref = store.put_file(source)
            store.path(ref["digest"]).write_bytes(b"corruption")
            with self.assertRaises(ContractError) as error: store.put_file(source)
            self.assertEqual(error.exception.code, "corrupt-content")
            self.assertEqual(list(store.root.rglob("*.tmp")), [])
