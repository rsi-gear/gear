import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from gear import Project, ProjectError, Report, Run

spec = importlib.util.spec_from_file_location(
    "refine_supervisor",
    Path(__file__).resolve().parents[2] / "examples/unattended-refine/supervisor.py",
)
supervisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervisor)


class RefineSupervisorTests(unittest.TestCase):
    def project(self):
        project = Mock(spec=Project)
        project.report.return_value = Report({"status": "needs_recovery"})
        project.resume.return_value = Run("run_original", Report({"status": "completed"}))
        return project

    def test_warning_prefixed_recoverable_error_reuses_run_and_preserves_raw_log(self):
        raw = b'warning\n{"code":"provider-environment-unavailable","message":"retry","run_id":"run_other"}\n'
        project = self.project()
        project.resume.side_effect = [ProjectError.from_stderr(raw), project.resume.return_value]
        with tempfile.TemporaryDirectory() as root, patch.object(supervisor.time, "sleep") as sleep:
            output = Path(root) / "supervision"
            self.assertEqual(
                supervisor.supervise(project, "run_original", output, min_free_bytes=0), 0
            )
            self.assertEqual((output / "execution-0.stderr.log").read_bytes(), raw)
            self.assertEqual(json.loads((output / "status.json").read_text())["state"], "finished")
            self.assertEqual(
                project.resume.call_args_list, [unittest.mock.call("run_original")] * 2
            )
            sleep.assert_called_once_with(30)

    def test_unknown_or_malformed_terminal_error_stops_without_recovery(self):
        for raw in (
            b'{"code":"run-identity-mismatch","message":"changed"}',
            b'{"code":"hitch-call-failed","message":"retry"}\ntrailing log',
            b'{"log":{"code":"hitch-call-failed","message":"retry"}}',
        ):
            with (
                self.subTest(raw=raw),
                tempfile.TemporaryDirectory() as root,
                patch.object(supervisor.time, "sleep") as sleep,
            ):
                project = self.project()
                project.resume.side_effect = ProjectError.from_stderr(raw)
                output = Path(root) / "supervision"
                self.assertEqual(
                    supervisor.supervise(project, "run_original", output, min_free_bytes=0), 1
                )
                self.assertEqual(project.resume.call_count, 1)
                sleep.assert_not_called()
                self.assertEqual(
                    json.loads((output / "status.json").read_text())["state"], "needs_attention"
                )
                self.assertEqual((output / "execution-0.stderr.log").read_bytes(), raw)

    def test_repeated_recovery_is_bounded_and_does_not_overwrite_an_earlier_session(self):
        project = self.project()
        project.resume.side_effect = ProjectError("hitch-call-failed", "retry", stderr=b"private")
        with tempfile.TemporaryDirectory() as root, patch.object(supervisor.time, "sleep") as sleep:
            output = Path(root) / "supervision"
            self.assertEqual(
                supervisor.supervise(project, "run_original", output, min_free_bytes=0), 1
            )
            self.assertEqual(project.resume.call_count, 12)
            self.assertEqual(sleep.call_count, 11)
            self.assertEqual(len(list(output.glob("*.stderr.log"))), 12)
            self.assertEqual(
                json.loads((output / "status.json").read_text())["reason"],
                "bounded recovery limit reached",
            )
            with self.assertRaises(FileExistsError):
                supervisor.supervise(project, "run_original", output)
            self.assertEqual(project.resume.call_count, 12)

    def test_terminal_run_or_low_disk_stops_before_resuming(self):
        for status in ("completed", "cancelled", "needs_recovery"):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as root:
                project = self.project()
                project.report.return_value = Report({"status": status})
                with patch.object(supervisor.shutil, "disk_usage", return_value=Mock(free=0)):
                    code = supervisor.supervise(project, "run_original", Path(root) / "supervision")
                self.assertEqual(code, 1 if status == "needs_recovery" else 0)
                project.resume.assert_not_called()


if __name__ == "__main__":
    unittest.main()
