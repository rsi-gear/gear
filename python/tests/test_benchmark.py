import csv
import json
import tempfile
import unittest
from pathlib import Path

from gear.benchmark import BenchmarkError, compile_benchmark, score_output


class BenchmarkTests(unittest.TestCase):
    def test_files_reject_dot_and_nul_paths(self):
        for name in (".", "file\0.txt"):
            for assertion in (None, "done", {"/answer": 42}):
                with self.subTest(name=name, assertion=assertion):
                    with self.assertRaisesRegex(ValueError, "contained and normalized"):
                        score_output("", {name: assertion}, {"kind": "files"}, {})

    def test_files_compilation_locates_invalid_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in (".", "file\0.txt"):
                for assertion in (None, "done", {"/answer": 42}):
                    with self.subTest(name=name, assertion=assertion):
                        self.fixture(
                            root,
                            [("a", "write a file", json.dumps({name: assertion}), "a", "seed")],
                        )
                        with self.assertRaises(BenchmarkError) as error:
                            compile_benchmark(
                                root, {"version": 1, "source": "tasks.csv", "template": "files"}
                            )
                        self.assertEqual(error.exception.location, "tasks.csv:2:fixtures")
                        self.assertIn("contained and normalized", str(error.exception))

    def test_files_normalized_paths_keep_all_assertion_kinds(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("result.txt", "nested/result.json"):
                for assertion, content in (
                    (None, ""),
                    ("done", "done"),
                    ({"/answer": 42}, '{"answer":42}'),
                ):
                    with self.subTest(name=name, assertion=assertion):
                        expected = {name: assertion}
                        self.assertEqual(
                            score_output("", expected, {"kind": "files"}, {name: content}).value, 1
                        )
                        self.assertEqual(score_output("", expected, {"kind": "files"}, {}).value, 0)
                        self.fixture(
                            root, [("a", "write a file", json.dumps(expected), "a", "seed")]
                        )
                        result = compile_benchmark(
                            root, {"version": 1, "source": "tasks.csv", "template": "files"}
                        )
                        self.assertEqual(result["verifiers"]["a"]["expected"], expected)
                        self.assertEqual(result["checks"]["verifier_fixtures"], "passed")

    def fixture(self, root, rows):
        with (root / "tasks.csv").open("w", newline="") as stream:
            writer = csv.writer(stream)
            writer.writerow(["id", "instruction", "expected", "family", "split"])
            writer.writerows(rows)

    def test_private_expected_and_zero_model_fixture_checks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(
                root,
                [
                    ("a", "add", "SECRET_5", "arithmetic", "seed"),
                    ("b", "caps", "APPLE", "caps", "held_out"),
                ],
            )
            result = compile_benchmark(
                root, {"version": 1, "source": "tasks.csv", "template": "text"}
            )
            self.assertNotIn("SECRET_5", str(result["tasks"]))
            self.assertEqual(result["verifiers"]["a"]["expected"], "SECRET_5")
            self.assertEqual(result["checks"]["verifier_fixtures"], "passed")
            self.assertEqual(result["checks"]["environment"], "not_run")
            self.assertEqual(
                result["digest"],
                compile_benchmark(
                    root, {"version": 1, "source": "tasks.csv", "template": "text"}
                )["digest"],
            )

    def test_duplicate_ids_and_family_leakage_locate_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for second in [
                ("a", "b", "2", "b", "held_out"),
                ("b", "b", "2", "a", "held_out"),
            ]:
                self.fixture(root, [("a", "a", "1", "a", "seed"), second])
                with self.assertRaises(BenchmarkError) as error:
                    compile_benchmark(root, {"version": 1, "source": "tasks.csv"})
                self.assertIn("tasks.csv:3", error.exception.location)

    def test_nonfinite_and_duplicate_json_outputs_fail_even_in_unasserted_fields(self):
        for extra in ["NaN", "Infinity", "-Infinity", "1e999", "[NaN]", '{"nested":Infinity}']:
            actual = '{"answer":42,"other":' + extra + '}'
            with self.subTest(extra=extra):
                direct = score_output(actual, {"/answer": 42}, {"kind": "json"})
                file = score_output("", {"result.json": {"/answer": 42}},
                                    {"kind": "files"}, {"result.json": actual})
                self.assertEqual((direct.status, direct.value), ("valid", 0.0))
                self.assertEqual((file.status, file.value), ("valid", 0.0))
        self.assertEqual(score_output('{"answer":0,"answer":42}', {"/answer": 42},
                                      {"kind": "json"}).value, 0.0)
        self.assertEqual(score_output('{"answer":42,"other":1e100}', {"/answer": 42},
                                      {"kind": "json"}).value, 1.0)

    def test_valid_zero_json_type_and_file_assertions(self):
        self.assertEqual(score_output("no", "yes", {"kind": "text"}).value, 0)
        self.assertEqual(
            score_output('{"n": true}', {"/n": 1}, {"kind": "json"}).value, 0
        )
        self.assertEqual(
            score_output("invalid", {"/n": 1}, {"kind": "json"}).status, "valid"
        )
        self.assertEqual(
            score_output(
                "", {"result.txt": "done"}, {"kind": "files"}, {"result.txt": "done"}
            ).value,
            1,
        )
        with self.assertRaises(ValueError):
            score_output("", {"../escape": None}, {"kind": "files"}, {})
