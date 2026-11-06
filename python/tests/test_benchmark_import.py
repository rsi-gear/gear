import json
import os
import tempfile
import unittest
from pathlib import Path

from gear.benchmark import BenchmarkError, compile_benchmark
from gear.benchmark.importer import prepare_import
from gear.benchmark.splits import propose_splits


class BenchmarkImportTests(unittest.TestCase):
    def task(self, identifier, family=None, instruction=None):
        return {
            "id": identifier,
            "family": family or identifier,
            "instruction": instruction or identifier,
            "resources": [],
        }

    def test_split_proposal_preserves_annotations_and_groups_duplicate_inputs(self):
        tasks = [
            self.task("a", "one", "same"),
            self.task("b", "two", "same"),
            self.task("c", "two"),
            self.task("d"),
        ]
        first = propose_splits(tasks, {"a": "seed"})
        self.assertEqual(first["seed"], ["a", "b", "c"])
        self.assertEqual(first["held_out"], ["d"])
        self.assertEqual(first, propose_splits(list(reversed(tasks)), {"a": "seed"}))
        with self.assertRaisesRegex(BenchmarkError, "conflicting"):
            propose_splits(tasks, {"a": "seed", "c": "held_out"})
        with self.assertRaisesRegex(BenchmarkError, "two family"):
            propose_splits(tasks[:3], {})
        research = propose_splits(tasks[:3], {}, "research")
        self.assertFalse(research["held_out"])
        self.assertIn("未做独立验证", research["allocation"]["note"])

    def test_import_freezes_resources_and_saves_a_reviewable_manifest(self):
        import base64

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "input.txt").write_text("input-data")
            source = root / "tasks.jsonl"
            source.write_text(
                "\n".join(
                    json.dumps(row)
                    for row in [
                        {
                            "id": "a",
                            "instruction": "alpha",
                            "expected": "SECRET",
                            "attachments": ["input.txt"],
                        },
                        {"id": "b", "instruction": "beta", "expected": "other"},
                    ]
                )
            )
            plan = prepare_import(str(source))
            self.assertEqual(plan, prepare_import(str(source)))
            self.assertNotIn("SECRET", json.dumps(plan["summary"]))
            self.assertEqual(plan["summary"]["model_requests"], 0)
            destination = root / plan["directory"]
            for file in plan["files"]:
                path = destination / file["path"]
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(base64.b64decode(plan["blobs"][file["digest"]]))
            (root / "input.txt").write_text("changed after preview")
            compiled = compile_benchmark(root, plan["config"])
            self.assertEqual(
                compiled["tasks"][0]["resources"][0]["content_base64"],
                base64.b64encode(b"input-data").decode(),
            )
            self.assertEqual(compiled["splits"]["held_out"], plan["summary"]["splits"]["held_out"])
            self.assertEqual(compiled["importer"]["name"], "tabular-v1")
            manifest = destination / "splits.json"
            data = json.loads(manifest.read_text())
            data["seed"] += data["held_out"]
            manifest.write_text(json.dumps(data))
            with self.assertRaisesRegex(BenchmarkError, "overlap"):
                compile_benchmark(root, plan["config"])

    def test_physical_jsonl_lines_and_duplicate_json_fields_are_reported(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "tasks.jsonl"
            source.write_text('\n\n{"id":"a","id":"b"}\n')
            with self.assertRaises(BenchmarkError) as error:
                compile_benchmark(root, {"version": 1, "source": source.name})
            self.assertEqual(error.exception.location, "tasks.jsonl:3")
            self.assertIn("duplicate JSON field", str(error.exception))
            source.write_text('\n{"id":"a","instruction":"","expected":"x","split":"seed"}\n')
            with self.assertRaises(BenchmarkError) as error:
                compile_benchmark(root, {"version": 1, "source": source.name})
            self.assertEqual(error.exception.location, "tasks.jsonl:2:instruction")

    def test_bad_csv_columns_json_numbers_and_unsupported_fixtures_fail_locally(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "tasks.csv"
            source.write_text("id,instruction,expected,id\na,do,x,b\n")
            with self.assertRaisesRegex(BenchmarkError, "duplicate CSV"):
                prepare_import(str(source))
            source = root / "tasks.jsonl"
            source.write_text('{"id":"a","instruction":"go","expected":NaN}\n')
            with self.assertRaisesRegex(BenchmarkError, "non-finite"):
                prepare_import(str(source), mode="research")
            source.write_text('{"id":"a","instruction":"go","expected":{"bad-pointer":1}}\n')
            with self.assertRaises(BenchmarkError) as error:
                prepare_import(str(source), template="json", mode="research")
            self.assertEqual(error.exception.location, "tasks.jsonl:1:expected")


class NativeHarborImportTests(unittest.TestCase):
    def fixture(self, root, image=None, prebuilt=False):
        image = image or "python@sha256:" + "1" * 64
        for identifier in ("a", "b"):
            task = root / identifier
            (task / "environment").mkdir(parents=True)
            (task / "tests").mkdir()
            (task / "task.toml").write_text(
                f'version="1.0"\n[metadata]\nfamily="{identifier}"\n[environment]\n'
                + (f'docker_image="{image}"\n' if prebuilt else "")
            )
            (task / "instruction.md").write_text("Solve task " + identifier)
            (task / "environment/Dockerfile").write_text("FROM " + image + "\nWORKDIR /app\n")
            (task / "tests/test.sh").write_text("#!/bin/sh\nprintf 1 > /logs/verifier/reward.txt\n")
            (task / "tests/test.sh").chmod(0o755)
            (task / "tests/expected.txt").write_text("SECRET_NATIVE_EXPECTED")

    def materialize(self, root, plan):
        import base64

        for name in plan["directories"]:
            (root / plan["directory"] / name).mkdir(parents=True, exist_ok=True)
        for file in plan["files"]:
            path = root / plan["directory"] / file["path"]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(base64.b64decode(plan["blobs"][file["digest"]]))
            path.chmod(0o755 if file["executable"] else 0o644)

    def test_preserves_native_verifiers_and_dockerfiles_without_public_expected(self):
        from gear.benchmark.harbor import compile_harbor

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "native"
            self.fixture(source)
            (source / ".git").mkdir()
            (source / "a/environment/inputs").mkdir()
            plan = prepare_import(str(source), template="harbor")
            self.materialize(root, plan)
            benchmark = compile_benchmark(root, plan["config"])
            self.assertNotIn("SECRET_NATIVE_EXPECTED", json.dumps(benchmark["tasks"]))
            self.assertEqual(benchmark["checks"]["verifier_fixtures"], "not_run")
            destination = root / "compiled"
            compile_harbor(benchmark, str(destination), ["a"], "unused@sha256:" + "2" * 64)
            self.assertEqual(
                (destination / "a/tests/expected.txt").read_text(), "SECRET_NATIVE_EXPECTED"
            )
            self.assertEqual(
                (destination / "a/environment/Dockerfile").read_text(),
                (source / "a/environment/Dockerfile").read_text(),
            )
            self.assertEqual((destination / "a/tests/test.sh").stat().st_mode & 0o777, 0o755)
            self.assertTrue((destination / "a/environment/inputs").is_dir())
            self.assertEqual(list((destination / "a/environment/inputs").iterdir()), [])
            self.assertFalse((destination / "b").exists())

    def test_repeated_runtime_is_transported_once_and_materialized_exactly(self):
        from gear.benchmark.harbor import compile_harbor

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "native"
            self.fixture(source)
            shared = b"common-runtime\n" * 80_000
            for identifier in ("a", "b"):
                for index in range(9):
                    (source / identifier / "environment" / f"runtime-{index}.bin").write_bytes(
                        shared
                    )
            plan = prepare_import(str(source), template="harbor")
            self.assertGreater(sum(file["size"] for file in plan["files"]), 16 * 1024 * 1024)
            self.assertLess(len(json.dumps(plan)), 2 * 1024 * 1024)
            runtime = [file for file in plan["files"] if "runtime-" in file["path"]]
            self.assertEqual(len({file["digest"] for file in runtime}), 1)
            self.assertTrue(all("content_base64" not in file for file in plan["files"]))
            self.materialize(root, plan)
            benchmark = compile_benchmark(root, plan["config"])
            self.assertLess(len(json.dumps(benchmark)), 2 * 1024 * 1024)
            output = root / "compiled"
            compile_harbor(benchmark, str(output), ["a"], "unused@sha256:" + "2" * 64)
            self.assertEqual((output / "a/environment/runtime-8.bin").read_bytes(), shared)
            self.assertFalse((output / "b").exists())

    def test_native_blob_integrity_and_separate_limits(self):
        from unittest.mock import patch

        from gear.benchmark.harbor import compile_harbor
        from gear.benchmark.payload import Payload
        from gear.canonical import digest

        with patch.dict(os.environ, {"GEAR_BENCHMARK_LIMITS_JSON": json.dumps({
            "maxUniqueBytes": 6, "maxMaterializedBytes": 9,
        })}):
            payload = Payload()
            payload.add("a", b"12345")
            with self.assertRaisesRegex(BenchmarkError, "unique payload"):
                payload.add("b", b"67")
            payload = Payload()
            payload.add("a", b"12345")
            with self.assertRaisesRegex(BenchmarkError, "maxMaterializedBytes"):
                payload.add("b", b"12345")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root / "native")
            plan = prepare_import(str(root / "native"), template="harbor")
            self.materialize(root, plan)
            benchmark = compile_benchmark(root, plan["config"])
            reference = benchmark["verifiers"]["a"]["native_files"][0]["digest"]
            benchmark["native_blobs"][reference] = "Y2hhbmdlZA=="
            benchmark["digest"] = digest(
                {key: value for key, value in benchmark.items() if key != "digest"}
            )
            with self.assertRaisesRegex(BenchmarkError, "resource digest or size"):
                compile_harbor(benchmark, str(root / "broken"), ["a"], "unused@sha256:" + "2" * 64)

    def test_independent_verifier_images_are_pinned_and_prebuilt_images_normalized(self):
        from gear.benchmark.native import required_images

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "native"
            self.fixture(source)
            (source / "a/tests/Dockerfile").write_text("FROM judge:tag\nCOPY . /tests\n")
            (source / "b/task.toml").write_text(
                '[verifier]\nenvironment_mode="separate"\n[verifier.environment]\ndocker_image="judge:prebuilt"\n'
            )
            self.assertEqual(required_images(str(source)), ["judge:prebuilt", "judge:tag"])
            with self.assertRaisesRegex(BenchmarkError, "immutable digest"):
                prepare_import(str(source), template="harbor")
            pins = {image: "judge@sha256:" + "3" * 64 for image in required_images(str(source))}
            plan = prepare_import(str(source), template="harbor", image_digests=pins)
            self.materialize(root, plan)
            destination = root / plan["directory"] / "tasks"
            self.assertIn(pins["judge:tag"], (destination / "a/tests/Dockerfile").read_text())
            self.assertEqual(
                (destination / "b/tests/Dockerfile").read_text(),
                "FROM " + pins["judge:prebuilt"] + "\n",
            )
            self.assertNotIn("docker_image", (destination / "b/task.toml").read_text())
            compile_benchmark(root, plan["config"])

    def test_resolves_prebuilt_images_and_removes_the_carrier_bypass(self):
        from gear.benchmark.native import required_images

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "native"
            self.fixture(source, "python:tag", True)
            self.assertEqual(required_images(str(source)), ["python:tag"])
            with self.assertRaisesRegex(BenchmarkError, "immutable digest"):
                prepare_import(str(source), template="harbor")
            pin = "python@sha256:" + "3" * 64
            plan = prepare_import(str(source), template="harbor", image_digests={"python:tag": pin})
            self.materialize(root, plan)
            self.assertEqual(
                (root / plan["directory"] / "tasks/a/environment/Dockerfile").read_text(),
                "FROM " + pin + "\n",
            )
            self.assertNotIn(
                "docker_image", (root / plan["directory"] / "tasks/a/task.toml").read_text()
            )
            compile_benchmark(root, plan["config"])

    def test_rejects_native_links_and_unsupported_environment_shapes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "native"
            self.fixture(source)
            (source / "a/tests/escape").symlink_to(root / "b")
            with self.assertRaisesRegex(BenchmarkError, "symlink"):
                prepare_import(str(source), template="harbor")
            (source / "a/tests/escape").unlink()
            (source / "a/environment/docker-compose.yaml").write_text("services: {}")
            with self.assertRaisesRegex(BenchmarkError, "requires services"):
                prepare_import(str(source), template="harbor")
