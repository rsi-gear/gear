import base64
import json
import tempfile
import unittest
from pathlib import Path

from gear.benchmark import BenchmarkError, compile_benchmark
from gear.benchmark.harbor import compile_harbor
from gear.benchmark.importer import prepare_import
from gear.benchmark.manifest import build_manifest, seal_harbor
from gear.benchmark.native import native_tasks, required_images


def fixture(root):
    for identifier in ("alpha", "beta"):
        task = root / identifier
        for relative in ("environment/candidate", "environment/simulator", "tests"):
            (task / relative).mkdir(parents=True)
        (task / "task.toml").write_text(
            'version="1.0"\nartifacts=[{source="/evidence/snapshot.json",service="simulator"}]\n'
            f'[metadata]\ncategory="workflow"\ndomain="{identifier}"\n'
            '[verifier]\nenvironment_mode="separate"\n[environment]\n'
        )
        (task / "instruction.md").write_text("Solve " + identifier)
        (task / "environment/candidate/Dockerfile.main").write_text(
            "FROM candidate:tag\nWORKDIR /app\n"
        )
        (task / "environment/simulator/Dockerfile").write_text("FROM simulator:tag\n")
        (task / "tests/Dockerfile").write_text("FROM judge:tag\nCOPY . /tests\n")
        (task / "tests/test.sh").write_text("#!/bin/sh\nprintf 1 > /logs/verifier/reward.txt\n")
        (task / "tests/test.sh").chmod(0o755)
        # Hash protocol distinguishes Unicode, uppercase and punctuation ordering.
        for name in ("Z.txt", "é.txt", "e\u0301.txt", "a-1.txt"):
            (task / "tests" / name).write_text(name)
        (task / "environment/docker-compose.yml").write_text(
            "services:\n  main:\n    build:\n      context: candidate\n      dockerfile: Dockerfile.main\n"
            "    depends_on:\n      simulator:\n        condition: service_healthy\n"
            "    environment:\n      API_URL: http://simulator:8765\n"
            "  simulator:\n    build: simulator\n    healthcheck:\n      test: [CMD, 'true']\n"
        )


def manifest(root):
    entries, _, _ = native_tasks(root)
    body = {
        "schema_version": "1",
        "kind": "gear-harbor-benchmark",
        "benchmark": {"id": "external-fixture", "revision": "1" * 40},
        "adapter": {
            "id": "fixture-producer",
            "revision": "sha256:" + "2" * 64,
            "output_protocol": "gear-harbor-eval-result-v1",
        },
        "scoring": {
            name: {
                "source_metric": metric,
                "direction": "maximize",
                "range": [0, 1],
                "reducer": "task-macro-mean",
            }
            for name, metric in (("total_score", "correct"), ("process_score", "partial_credit"))
        },
        "raw_metrics": {
            "schema_version": "1",
            "metrics": [{"id": "detail", "nested": {"é": 1, "Z": 1e-7}}],
        },
    }
    value = build_manifest(
        body, [{"id": entry["task"]["id"], "files": entry["files"]} for entry in entries]
    )
    (root / "benchmark.adapter.json").write_text(json.dumps(value, ensure_ascii=False) + "\n")
    (root / "source-manifest.json").write_text(
        '{"schema_version":"1","source_commit":"original","usage_conditions":["preserve"]}\n'
    )
    return value


def materialize(root, plan):
    for file in plan["files"]:
        output = root / plan["directory"] / file["path"]
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(base64.b64decode(plan["blobs"][file["digest"]]))
        output.chmod(0o755 if file["executable"] else 0o644)


class NativeEnvironmentTests(unittest.TestCase):
    def test_planning_retains_declarations_without_materializing_task_payloads(self):
        try:
            import tomllib
        except ImportError:
            import tomli as tomllib

        from gear.benchmark.environment import read_environment

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture(root / "source")
            for task in ("alpha", "beta"):
                (root / "source" / task / "environment/candidate/large-source").write_bytes(
                    b"x" * 1024**2
                )
            pins = {
                name + ":tag": name + "@sha256:" + "3" * 64
                for name in ("candidate", "simulator", "judge")
            }
            plan = prepare_import(str(root / "source"), template="harbor", image_digests=pins)
            materialize(root, plan)
            benchmark = compile_benchmark(root, plan["config"])
            tasks = [task["id"] for task in benchmark["tasks"]]
            full = compile_harbor(benchmark, str(root / "full"), tasks, "unused@sha256:" + "4" * 64)
            planning = compile_harbor(
                benchmark,
                str(root / "planning"),
                tasks,
                "unused@sha256:" + "4" * 64,
                planning_only=True,
            )
            self.assertEqual(full["environments"], planning["environments"])
            for task in tasks:
                first, second = root / "full" / task, root / "planning" / task
                config = tomllib.loads((first / "task.toml").read_text())
                self.assertEqual(read_environment(first, config), read_environment(second, config))
                self.assertEqual(
                    (first / "task.toml").read_bytes(), (second / "task.toml").read_bytes()
                )
                self.assertFalse((second / "environment/candidate/large-source").exists())
                self.assertFalse((second / "tests/test.sh").exists())
                self.assertFalse((second / "instruction.md").exists())
            self.assertLess(
                sum(
                    path.stat().st_size for path in (root / "planning").rglob("*") if path.is_file()
                ),
                10_000,
            )

    def test_compose_and_manifest_survive_import_subset_and_carrier_materialization(self):
        with tempfile.TemporaryDirectory() as directory:
            root, pins = (
                Path(directory),
                {
                    name + ":tag": name + "@sha256:" + "3" * 64
                    for name in ("candidate", "simulator", "judge")
                },
            )
            source = root / "source"
            fixture(source)
            original = manifest(source)
            self.assertEqual(required_images(str(source)), sorted(pins))
            plan = prepare_import(str(source), template="harbor", image_digests=pins)
            materialize(root, plan)
            benchmark = compile_benchmark(root, plan["config"])
            self.assertTrue(benchmark["splits"]["held_out"])
            self.assertEqual(benchmark["adapter_manifest"]["scoring"], original["scoring"])
            self.assertEqual(benchmark["adapter_manifest"]["raw_metrics"], original["raw_metrics"])
            output = root / "compiled"
            rendered = compile_harbor(
                benchmark, str(output), ["alpha"], "unused@sha256:" + "4" * 64
            )
            self.assertEqual(
                rendered["environments"]["alpha"]["mains"]["environment"],
                {
                    "context": "environment/candidate",
                    "dockerfile": "environment/candidate/Dockerfile.main",
                },
            )
            self.assertFalse((output / "alpha/environment/docker-compose.yml").exists())
            self.assertEqual(
                (output / "source-manifest.json").read_bytes(),
                (source / "source-manifest.json").read_bytes(),
            )
            self.assertEqual(
                (output / "source-benchmark.adapter.json").read_bytes(),
                (source / "benchmark.adapter.json").read_bytes(),
            )
            entries, _, metadata = native_tasks(output)
            self.assertEqual([task["task_id"] for task in metadata["manifest"]["tasks"]], ["alpha"])
            self.assertEqual(entries[0]["config"]["artifacts"][0]["service"], "simulator")
            composition = json.loads((output / "alpha/environment/docker-compose.yaml").read_text())
            self.assertEqual(
                composition["services"]["main"]["depends_on"]["simulator"],
                {"condition": "service_healthy"},
            )
            before = metadata["manifest"]["dataset_digest"]
            dockerfile = output / "alpha/environment/candidate/Dockerfile.main"
            dockerfile.write_text(dockerfile.read_text() + "\nCOPY gear-target /app/target\n")
            with self.assertRaisesRegex(BenchmarkError, "digest mismatch"):
                native_tasks(output)
            seal_harbor(benchmark, str(output), ["alpha"])
            _, _, metadata = native_tasks(output)
            self.assertNotEqual(metadata["manifest"]["dataset_digest"], before)
            self.assertEqual(metadata["manifest"]["scoring"], original["scoring"])

    def test_rejects_manifest_changes_unknown_contracts_and_unfrozen_compose_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture(root)
            manifest(root)
            path = root / "benchmark.adapter.json"
            value = json.loads(path.read_text())
            value["scoring"]["process_score"]["source_metric"] = "changed"
            path.write_text(json.dumps(value))
            with self.assertRaisesRegex(BenchmarkError, "digest mismatch"):
                required_images(str(root))
            value["schema_version"] = "2"
            path.write_text(json.dumps(value))
            with self.assertRaisesRegex(BenchmarkError, "unsupported native"):
                required_images(str(root))
            path.unlink()
            compose = root / "alpha/environment/docker-compose.yml"
            for text, reason in (
                ("services:\n  main: {build: ../../private}\n", "contained local"),
                ("services:\n  main: {image: '${HOST_IMAGE}'}\n", "interpolation"),
                ("services:\n  main: {environment: [SECRET]}\n", "host variables"),
                ("services:\n  main: {volumes: ['/tmp:/host']}\n", "unsupported Compose"),
                ("services:\n  main: {}\n  main: {}\n", "unique strings"),
                (
                    "services:\n  main: {build: {context: candidate, dockerfile: Dockerfile.main, target: base}}\n",
                    "final stage",
                ),
            ):
                compose.write_text(text)
                with self.subTest(reason=reason), self.assertRaisesRegex(BenchmarkError, reason):
                    native_tasks(root)

    def test_image_services_pin_without_losing_candidate_build(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture(root / "source")
            for identifier in ("alpha", "beta"):
                (root / "source" / identifier / "environment/docker-compose.yml").write_text(
                    "services:\n  main: {image: candidate:tag}\n  simulator: {image: simulator:tag}\n"
                )
            pins = {
                name + ":tag": name + "@sha256:" + "4" * 64
                for name in ("candidate", "simulator", "judge")
            }
            plan = prepare_import(str(root / "source"), template="harbor", image_digests=pins)
            materialize(root, plan)
            benchmark = compile_benchmark(root, plan["config"])
            layout = benchmark["verifiers"]["alpha"]["native_environment"]
            self.assertEqual(
                layout["mains"]["environment"]["context"], "environment/gear-main-image"
            )
            path = root / plan["directory"] / "tasks/alpha/environment"
            composition = json.loads((path / "docker-compose.yaml").read_text())
            self.assertNotIn("image", composition["services"]["main"])
            self.assertEqual(composition["services"]["simulator"]["image"], pins["simulator:tag"])
