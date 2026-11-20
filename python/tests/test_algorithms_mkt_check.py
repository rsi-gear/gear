import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from test_native_environment import fixture, manifest, materialize

from gear import Project, Report
from gear.benchmark import BenchmarkError, compile_benchmark
from gear.benchmark.importer import prepare_import

spec = importlib.util.spec_from_file_location(
    "algorithms_mkt_check",
    Path(__file__).resolve().parents[2] / "scripts/check-algorithms-mkt.py",
)
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class AlgorithmsMktCheckTests(unittest.TestCase):
    def prepare(self, root):
        source = root / "source"
        fixture(source)
        original = manifest(source)
        pins = {
            name + ":tag": name + "@sha256:" + "3" * 64
            for name in ("candidate", "simulator", "judge")
        }
        plan = prepare_import(str(source), template="harbor", mode="research", image_digests=pins)
        materialize(root, plan)
        benchmark_path = root / plan["directory"] / "benchmark.yaml"
        benchmark_path.write_text(json.dumps(plan["config"]))
        (root / "gear.yaml").write_text(
            json.dumps({"benchmark": str(benchmark_path.relative_to(root))})
        )
        selection = {
            "dataset_digest": original["dataset_digest"],
            "selection": {"task_ids": ["alpha", "beta"]},
        }
        return plan, selection

    def test_imported_and_source_identities_are_distinct_and_both_checked(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, selection = self.prepare(root)
            benchmark = check.compile_project_benchmark(root)
            imported = benchmark["adapter_manifest"]["dataset_digest"]
            self.assertNotEqual(imported, selection["dataset_digest"])
            self.assertEqual(check.check_dataset(benchmark, selection), imported)
            self.assertEqual(check.check_dataset(benchmark, selection, imported), imported)
            with self.assertRaisesRegex(AssertionError, "Selected source dataset changed"):
                check.check_dataset(benchmark, {**selection, "dataset_digest": "wrong"})
            with self.assertRaisesRegex(AssertionError, "Prepared dataset changed"):
                check.check_dataset(benchmark, selection, "wrong")

    def test_changed_imported_files_are_rejected_before_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plan, _ = self.prepare(root)
            instruction = root / plan["config"]["source"] / "alpha/instruction.md"
            instruction.write_text("Changed task")
            with self.assertRaisesRegex(BenchmarkError, "digest mismatch"):
                check.compile_project_benchmark(root)

    def test_missing_source_manifest_does_not_allow_a_different_dataset(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plan, selection = self.prepare(root)
            (root / plan["config"]["source"] / "source-benchmark.adapter.json").unlink()
            benchmark = compile_benchmark(root, plan["config"])
            with self.assertRaisesRegex(AssertionError, "missing its source manifest"):
                check.check_dataset(benchmark, selection)

    def test_verify_only_reads_report_without_executing_or_resuming(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run = root / "output/OPRO/.gear/runs/run_existing"
            run.mkdir(parents=True)
            (run / "journal.json").write_text("{}")
            selection = root / "selection.json"
            selection.write_text(
                json.dumps({"selection": {"task_ids": [f"marketing-{n}" for n in range(10)]}})
            )
            project = Mock(spec=Project)
            project.report.return_value = Report({"status": "failed"})
            with (
                patch(
                    "sys.argv",
                    [
                        "check",
                        "--template",
                        str(root),
                        "--output",
                        str(root / "output"),
                        "--selection",
                        str(selection),
                        "--algorithm",
                        "OPRO",
                        "--verify-only",
                    ],
                ),
                patch.object(check, "compile_project_benchmark"),
                patch.object(check, "check_dataset", return_value="prepared"),
                patch.object(check.Project, "open", return_value=project),
                patch("builtins.print"),
                self.assertRaises(SystemExit) as raised,
            ):
                check.main()
            self.assertEqual(raised.exception.code, 1)
            project.report.assert_called_once_with("run_existing")
            project.resume.assert_not_called()
            project.refine.assert_not_called()


if __name__ == "__main__":
    unittest.main()
