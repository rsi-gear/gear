import contextlib
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from gear_training.content import ContractError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "probes"))
import collect_training_failure as probe


class FailureLogProbeTests(unittest.TestCase):
    def test_collects_only_current_incarnation_and_bounds_log_payload(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            incarnation = "a" * 32
            current = root / ("slime-" + incarnation + ".log")
            raw = b"unrelated earlier output\n" * 6000 + b"RuntimeError: restore failed\n"
            current.write_bytes(raw)
            (root / ("slime-" + "b" * 32 + ".log")).write_text("other incarnation private data")
            (root / "trainer-state.distcp").write_text("checkpoint must not be collected")
            (root / "worker.json").write_text(json.dumps({"incarnation": incarnation}))
            status = {"execution": "failed", "resourcesReleased": True}
            context = (SimpleNamespace(identity={"generation": "fixture"}),
                       SimpleNamespace(inspect=lambda handle: status), root, {}, {"jobId": "fixture"})
            output = io.StringIO()
            with patch.object(probe, "context", return_value=context), \
                    patch.object(sys, "argv", ["probe", "--node-config", "fixture"]), \
                    contextlib.redirect_stdout(output):
                probe.main()
            report = json.loads(output.getvalue())
            self.assertEqual(len(report["logs"]), 1)
            tail = report["logs"][0]
            self.assertEqual(tail["tailBytes"], 64 * 1024)
            self.assertEqual(tail["offset"], len(raw) - 64 * 1024)
            self.assertEqual(tail["tailDigest"], "sha256:" + hashlib.sha256(raw[-64 * 1024:]).hexdigest())
            self.assertTrue(tail["text"].endswith("RuntimeError: restore failed\n"))
            self.assertNotIn("private data", output.getvalue())
            self.assertNotIn("checkpoint must", output.getvalue())

    def test_active_jobs_path_escape_and_symlinks_are_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            status = {"execution": "running", "resourcesReleased": False}
            context = (SimpleNamespace(identity={}), SimpleNamespace(inspect=lambda handle: status), root, {}, {})
            with patch.object(probe, "context", return_value=context), \
                    patch.object(sys, "argv", ["probe", "--node-config", "fixture"]):
                with self.assertRaisesRegex(ContractError, "physical release"):
                    probe.main()
                status.update(execution="failed", resourcesReleased=True)
                (root / "worker.json").write_text(json.dumps({"incarnation": "../../secret"}))
                with self.assertRaisesRegex(ContractError, "invalid diagnostic incarnation"):
                    probe.main()
            source = root / "private.txt"
            source.write_text("private")
            link = root / "slime.log"
            link.symlink_to(source)
            with self.assertRaisesRegex(ContractError, "ordinary file"):
                probe.log_tail(link)


if __name__ == "__main__":
    unittest.main()
