import unittest
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

from gear_training.content import digest_json
from gear_training.node_runtime import observe_runtime, observe_startup_runtime, package_version


class Distribution:
    metadata = {"Name": "psutil"}
    version = "7.2.2"

    def __init__(self, record): self.record = record
    def read_text(self, name): return self.record if name == "RECORD" else None


class NodeRuntimeTests(unittest.TestCase):
    def test_same_version_metadata_preserves_both_record_identities(self):
        with patch("gear_training.node_runtime.importlib.metadata.distributions", return_value=[Distribution("system"), Distribution("pip")]):
            observed = observe_startup_runtime()
        self.assertEqual(package_version(observed, "psutil"), "7.2.2")
        self.assertEqual(len(observed["packages"]), 2)
        self.assertNotEqual(observed["packages"][0]["recordDigest"], observed["packages"][1]["recordDigest"])
        self.assertEqual(observed["packagesDigest"], digest_json(observed["packages"]))
        self.assertNotEqual(observed["packagesDigest"], digest_json(observed["packages"][:1]))

    def test_conflicting_versions_still_fail_closed(self):
        self.assertIsNone(package_version({"packages": [{"name": "psutil", "version": version} for version in ("7.2.2", "5.9.5")]}, "psutil"))

    def test_missing_and_unrelated_packages_do_not_advertise_a_version(self):
        self.assertIsNone(package_version({"packages": [{"name": "torch", "version": "2.11.0"}]}, "psutil"))

    def test_import_added_metadata_does_not_change_startup_identity(self):
        before = observe_runtime()
        with tempfile.TemporaryDirectory() as directory:
            metadata = Path(directory) / "import_vendor-1.0.dist-info"
            metadata.mkdir()
            (metadata / "METADATA").write_text("Name: import-vendor\nVersion: 1.0\n")
            (metadata / "RECORD").write_text("vendor.py,sha256=first,1\n")
            with patch.object(sys, "path", [*sys.path, directory]):
                self.assertEqual(package_version(observe_startup_runtime(), "import-vendor"), "1.0")
                self.assertEqual(observe_runtime(), before)

    def test_configured_path_and_changed_record_remain_observable(self):
        with tempfile.TemporaryDirectory() as directory:
            metadata = Path(directory) / "startup_vendor-1.0.dist-info"
            metadata.mkdir()
            (metadata / "METADATA").write_text("Name: startup-vendor\nVersion: 1.0\n")
            record = metadata / "RECORD"
            record.write_text("vendor.py,sha256=first,1\n")
            paths = directory + os.pathsep + os.environ.get("PYTHONPATH", "")
            with patch.dict(os.environ, {"PYTHONPATH": paths}):
                before = observe_runtime()
                self.assertEqual(package_version(before, "startup-vendor"), "1.0")
                record.write_text("vendor.py,sha256=changed,2\n")
                after = observe_runtime()
                self.assertNotEqual(before["packagesDigest"], after["packagesDigest"])


if __name__ == "__main__": unittest.main()
