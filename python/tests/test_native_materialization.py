import errno
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gear.benchmark.payload import NativeMaterializer, Payload, content_bytes
from gear.benchmark.source import BenchmarkError


class NativeMaterializationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.payload = Payload()
        self.file = self.payload.add("dependency", b"original bytes", False)
        self.writer = NativeMaterializer(self.payload.blobs)

    def test_identical_blobs_decode_once_and_writable_outputs_remain_isolated(self):
        with patch("gear.benchmark.payload.content_bytes", wraps=content_bytes) as decode:
            self.writer.write(self.file, self.root / "one")
            self.writer.write({**self.file, "executable": True}, self.root / "two")
        self.assertEqual(decode.call_count, 1)
        self.assertEqual((self.root / "one").stat().st_mode & 0o777, 0o644)
        self.assertEqual((self.root / "two").stat().st_mode & 0o777, 0o755)
        self.assertNotEqual((self.root / "one").stat().st_ino, (self.root / "two").stat().st_ino)
        self.assertEqual((self.root / "two").stat().st_nlink, 1)
        (self.root / "two").write_bytes(b"changed task")
        self.assertEqual((self.root / "one").read_bytes(), b"original bytes")
        self.assertEqual(self.writer.content(self.file), b"original bytes")

    def test_cache_revalidates_size_and_changed_encoded_bytes(self):
        self.writer.content(self.file)
        with self.assertRaisesRegex(BenchmarkError, "size mismatch"):
            self.writer.content({**self.file, "size": 2})
        self.payload.blobs[self.file["digest"]] = "aW52YWxpZA=="
        with self.assertRaisesRegex(BenchmarkError, "digest or size mismatch"):
            self.writer.content(self.file)

    def test_decoded_cache_is_bounded_and_evictions_are_revalidated(self):
        writer = NativeMaterializer(self.payload.blobs, cache_bytes=3)
        first = self.payload.add("one", b"one")
        second = self.payload.add("two", b"two")
        with patch("gear.benchmark.payload.content_bytes", wraps=content_bytes) as decode:
            for file in (first, second, first, self.file):
                writer.content(file)
                self.assertLessEqual(writer.cached_bytes, 3)
        self.assertEqual(decode.call_count, 4)

    @unittest.skipUnless(os.name == "posix", "POSIX clone simulation")
    def test_clone_and_fallback_paths_preserve_bytes_and_reject_io_failures(self):
        def clone(target, request, source):
            self.assertEqual(request, 0x40049409)
            os.write(target, os.read(source, 1024))

        self.writer.clone_available = True
        self.writer.write(self.file, self.root / "one")
        with patch("fcntl.ioctl", side_effect=clone) as ioctl:
            self.writer.write(self.file, self.root / "two")
        ioctl.assert_called_once()
        self.assertEqual((self.root / "two").read_bytes(), b"original bytes")
        with patch("fcntl.ioctl", side_effect=OSError(errno.EOPNOTSUPP, "no CoW")) as ioctl:
            self.writer.write(self.file, self.root / "three")
            self.writer.write(self.file, self.root / "four")
        self.assertEqual(ioctl.call_count, 1)
        self.assertEqual((self.root / "four").read_bytes(), b"original bytes")
        self.writer.clone_available = True
        with patch("fcntl.ioctl", side_effect=OSError(errno.ENOSPC, "full")):
            with self.assertRaises(OSError):
                self.writer.write(self.file, self.root / "five")

    @unittest.skipUnless(os.name == "posix", "POSIX clone simulation")
    def test_changed_clone_source_is_not_admitted(self):
        self.writer.clone_available = True
        self.writer.write(self.file, self.root / "one")
        (self.root / "one").write_bytes(b"tampered bytes")
        with patch(
            "fcntl.ioctl",
            side_effect=lambda target, request, source: os.write(target, os.read(source, 1024)),
        ):
            with self.assertRaisesRegex(BenchmarkError, "cloned native resource changed"):
                self.writer.write(self.file, self.root / "two")
