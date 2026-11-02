import copy
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from test_native_environment import manifest

from gear.benchmark import BenchmarkError, compile_benchmark
from gear.benchmark.harbor import compile_harbor
from gear.benchmark.native import native_tasks
from gear.benchmark.shared_runtime import LABEL, bind, prepare, verify_image
from gear.benchmark.shared_runtime_plan import copy_paths, instructions, plan_tasks

BASE = "python@sha256:" + "1" * 64


def fixture(root):
    for identifier in ("alpha", "beta"):
        task = root / identifier
        for area in ("environment", "tests"):
            (task / area / "src/empty").mkdir(parents=True)
            (task / area / "src/module.py").write_text("print('shared')\n")
            (task / area / "src/module.py").chmod(0o755)
            (task / area / "src/row.json").write_text(json.dumps({"task": identifier}))
            (task / area / "Dockerfile").write_text(
                f'FROM {BASE}\nCOPY src /code\nWORKDIR /code\nCMD ["python", "module.py"]\n'
            )
        (task / "tests/test.sh").write_text("#!/bin/sh\necho 1\n")
        (task / "instruction.md").write_text("Solve " + identifier)
        (task / "task.toml").write_text(
            f'[metadata]\nfamily="{identifier}"\nsplit="seed"\n'
            '[verifier]\nenvironment_mode="separate"\n'
        )
    manifest(root)
    return {
        "schema_version": "1",
        "platform": "linux/amd64",
        "tasks": ["alpha", "beta"],
        "builds": [
            {
                "context": area,
                "dockerfile": "Dockerfile",
                "prefix_lines": 2,
                "varying": ["src/row.json"],
            }
            for area in ("environment", "tests")
        ],
        "image_only": ["environment/src", "tests/src"],
    }


class SharedRuntimeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "source"
        self.plan = fixture(self.source)

    def prepare(self):
        self.prepared = self.root / "prepared"
        self.record = prepare(self.source, self.plan, self.prepared)
        self.images = {key: "runtime@" + key for key in self.record["recipes"]}
        return self.record

    def inspect(self, reference):
        labels = {} if reference == BASE else {LABEL: reference.split("@")[1]}
        return {
            "RepoDigests": [reference],
            "Os": "linux",
            "Architecture": "amd64",
            "Config": {"Labels": labels},
        }

    def test_shared_source_written_once_and_native_execution_stays_lean(self):
        record = self.prepare()
        self.assertEqual(len(record["recipes"]), 1)
        self.assertEqual(record["removed_task_bytes"], 4 * len("print('shared')\n"))
        out = self.root / "bound"
        result = bind(self.prepared, self.images, out, inspect=self.inspect)
        entries, _, metadata = native_tasks(out)
        self.assertEqual(metadata["manifest"], result)
        self.assertNotEqual(result["dataset_digest"], record["source_manifest"]["dataset_digest"])
        self.assertEqual(result["scoring"], record["source_manifest"]["scoring"])
        self.assertEqual(
            (out / "source-manifest.json").read_bytes(),
            (self.source / "source-manifest.json").read_bytes(),
        )
        for entry in entries:
            task = out / entry["task"]["id"]
            self.assertFalse((task / "environment/src/module.py").exists())
            self.assertFalse((task / "environment/src/empty").exists())
            self.assertEqual(
                (task / "instruction.md").read_bytes(),
                (self.source / task.name / "instruction.md").read_bytes(),
            )
            self.assertIn(
                'COPY ["src", "/code"]',
                (task / "environment/Dockerfile").read_text(),
            )
        benchmark = compile_benchmark(
            self.root, {"version": 1, "template": "harbor", "source": "bound"}
        )
        compiled = self.root / "compiled"
        compile_harbor(benchmark, str(compiled), ["alpha", "beta"], BASE)
        self.assertFalse((compiled / "alpha/environment/src/module.py").exists())
        (compiled / "alpha/environment/src/row.json").write_text("changed")
        self.assertEqual(
            json.loads((compiled / "beta/environment/src/row.json").read_text()), {"task": "beta"}
        )

    def test_changed_code_or_executable_bit_gets_another_image_recipe(self):
        entries, payload, _ = native_tasks(self.source)
        entries[1]["files"] = [
            dict(f, executable=False) if f["path"].endswith("module.py") else f
            for f in entries[1]["files"]
        ]
        recipes, _ = plan_tasks(entries, payload.blobs, self.plan)
        self.assertEqual(len(recipes), 2)

    def test_retains_files_still_consumed_by_a_suffix_or_host(self):
        entries, payload, _ = native_tasks(self.source)
        for entry in entries:
            name = "environment/Dockerfile"
            entry["dockerfiles"][name] += "COPY src /other\n"
            entry["files"] = [
                payload.text(name, entry["dockerfiles"][name]) if f["path"] == name else f
                for f in entry["files"]
            ]
        _, tasks = plan_tasks(entries, payload.blobs, self.plan)
        self.assertEqual(tasks[0]["removed"], {"tests/src/module.py"})
        plan = {**self.plan, "image_only": []}
        _, tasks = plan_tasks(entries, payload.blobs, plan)
        self.assertFalse(tasks[0]["removed"])

    def test_unsupported_syntax_is_rejected_before_preparation(self):
        for content in (
            f"FROM {BASE}\nCOPY . /code\n",
            f"FROM {BASE}\nADD src /code\n",
            f"FROM {BASE} AS stage\n",
            f"FROM {BASE}\nRUN --mount=x true\n",
            f"# syntax=docker/dockerfile:1\nFROM {BASE}\n",
            f"FROM {BASE}\nRUN echo hi \\\n there\n",
            f"FROM {BASE}\nCOPY foo\u00a0bar /code\n",
            f"FROM {BASE}\nCOPY foo\u2028bar /code\n",
        ):
            with self.subTest(content=content), self.assertRaises(BenchmarkError):
                for _, op, arg in instructions(content):
                    if op == "COPY":
                        copy_paths(arg)
        for argument in (
            "--from=other a /b",
            "src/* /b",
            "${INPUT} /b",
            "../a /b",
            "src relative",
            "src /a/../b",
        ):
            with self.subTest(argument=argument), self.assertRaises(BenchmarkError):
                copy_paths(argument)

    def test_varying_files_must_not_be_observed_by_shared_commands(self):
        entries, payload, _ = native_tasks(self.source)
        for count in (1, 3, 4):
            plan = copy.deepcopy(self.plan)
            plan["builds"][0]["prefix_lines"] = count
            with self.subTest(count=count), self.assertRaises(BenchmarkError):
                plan_tasks(entries, payload.blobs, plan)

    def test_tampering_and_wrong_image_cannot_publish_a_dataset(self):
        self.prepare()
        key, recipe = next(iter(self.record["recipes"].items()))
        for mutation in (
            {"RepoDigests": []},
            {"Architecture": "arm64"},
            {"Config": {"Labels": {}}},
            {"Config": {"OnBuild": ["RUN true"]}},
            {"Config": {"Volumes": {"/data": {}}}},
        ):
            with self.subTest(mutation=mutation), self.assertRaises(BenchmarkError):
                verify_image(
                    self.images[key], recipe, key, lambda ref: {**self.inspect(ref), **mutation}
                )
        file = self.prepared / "templates/alpha/tests/test.sh"
        file.write_text("modified")
        with self.assertRaisesRegex(BenchmarkError, "templates changed"):
            bind(self.prepared, self.images, self.root / "bound", inspect=self.inspect)
        self.assertFalse((self.root / "bound").exists())

    def test_rejects_overlap_existing_output_ignored_and_undeclared_consumers(self):
        with self.assertRaises(BenchmarkError):
            prepare(self.source, self.plan, self.source / "nested")
        entries, payload, _ = native_tasks(self.source)
        for plan in (
            {**self.plan, "builds": self.plan["builds"][:1]},
            {**self.plan, "image_only": ["../private"]},
        ):
            with self.assertRaises(BenchmarkError):
                plan_tasks(entries, payload.blobs, plan)
        entries[0]["files"].append({"path": "environment/.dockerignore"})
        with self.assertRaisesRegex(BenchmarkError, "ignore files"):
            plan_tasks(entries, payload.blobs, self.plan)

    @unittest.skipUnless(os.name == "posix", "POSIX reflink simulation")
    def test_rewritten_dockerfiles_are_never_reused_as_original_clone_sources(self):
        def clone(target, request, source):
            self.assertEqual(request, 0x40049409)
            os.write(target, os.read(source, os.fstat(source).st_size))

        with patch("fcntl.ioctl", side_effect=clone):
            self.prepare()
        first = self.prepared / "templates/alpha/environment/Dockerfile"
        second = self.prepared / "templates/beta/environment/Dockerfile"
        self.assertEqual(first.read_bytes(), second.read_bytes())
        first.write_text("private edit")
        self.assertNotEqual(first.read_bytes(), second.read_bytes())

    def test_empty_directory_still_used_by_suffix_survives(self):
        for identifier in self.plan["tasks"]:
            file = self.source / identifier / "environment/Dockerfile"
            file.write_text(file.read_text() + "COPY src/empty /empty\n")
        (self.source / "benchmark.adapter.json").unlink()
        manifest(self.source)
        self.prepare()
        for identifier in self.plan["tasks"]:
            self.assertTrue(
                (self.prepared / "templates" / identifier / "environment/src/empty").is_dir()
            )

    def test_entrypoint_after_boundary_cannot_reset_a_prefix_cmd(self):
        entries, payload, _ = native_tasks(self.source)
        name = "environment/Dockerfile"
        text = entries[0]["dockerfiles"][name] + 'ENTRYPOINT ["sh"]\n'
        entries[0]["dockerfiles"][name] = text
        entries[0]["files"] = [
            payload.text(name, text) if f["path"] == name else f for f in entries[0]["files"]
        ]
        with self.assertRaisesRegex(BenchmarkError, "ENTRYPOINT after"):
            plan_tasks(entries, payload.blobs, self.plan)

    def test_wrong_context_cannot_select_a_different_source_tree(self):
        for identifier in self.plan["tasks"]:
            root = self.source / identifier / "environment"
            (root / "candidate/src").mkdir(parents=True)
            (root / "candidate/src/value").write_text("the actual input")
            (root / "Dockerfile").rename(root / "candidate/Dockerfile")
            (root / "docker-compose.yaml").write_text(
                json.dumps(
                    {
                        "services": {
                            "main": {"build": {"context": "candidate", "dockerfile": "Dockerfile"}}
                        }
                    }
                )
            )
        (self.source / "benchmark.adapter.json").unlink()
        manifest(self.source)
        self.plan["builds"][0]["dockerfile"] = "candidate/Dockerfile"
        with self.assertRaisesRegex(BenchmarkError, "context does not match"):
            self.prepare()

    def test_restored_inputs_survive_an_overlapping_build_consuming_them(self):
        for identifier in self.plan["tasks"]:
            root = self.source / identifier / "environment"
            (root / "Dockerfile.other").write_text(f"FROM {BASE}\nCOPY src /code\n")
            (root / "docker-compose.yaml").write_text(
                json.dumps(
                    {
                        "services": {
                            "main": {"build": {"context": ".", "dockerfile": "Dockerfile"}},
                            "other": {"build": {"context": ".", "dockerfile": "Dockerfile.other"}},
                        }
                    }
                )
            )
        (self.source / "benchmark.adapter.json").unlink()
        manifest(self.source)
        self.plan["builds"].append(
            {"context": "environment", "dockerfile": "Dockerfile.other", "prefix_lines": 2}
        )
        self.prepare()
        for identifier in self.plan["tasks"]:
            file = self.prepared / "templates" / identifier / "environment/src/row.json"
            self.assertEqual(json.loads(file.read_text()), {"task": identifier})

    def test_rewritten_dockerfile_and_wildcard_leaf_copies_are_rejected(self):
        entries, payload, _ = native_tasks(self.source)
        name = "environment/Dockerfile"
        text = entries[0]["dockerfiles"][name] + "COPY Dockerfile /snapshot\n"
        entries[0]["dockerfiles"][name] = text
        entries[0]["files"] = [
            payload.text(name, text) if f["path"] == name else f for f in entries[0]["files"]
        ]
        with self.assertRaisesRegex(BenchmarkError, "rewritten Dockerfile"):
            plan_tasks(entries, payload.blobs, self.plan)
        entries, payload, _ = native_tasks(self.source)
        entries[0]["files"].append(payload.text("environment/src/[1].json", "varying"))
        self.plan["builds"][0]["varying"] = ["src/[1].json"]
        with self.assertRaisesRegex(BenchmarkError, "patterns"):
            plan_tasks(entries, payload.blobs, self.plan)

    def test_root_copy_and_tab_separated_from(self):
        self.assertEqual(copy_paths("src /"), (["src"], "/"))
        self.prepare()
        key, recipe = next(iter(self.record["recipes"].items()))
        recipe = {**recipe, "dockerfile": recipe["dockerfile"].replace("FROM ", "FROM\t")}
        verify_image(self.images[key], recipe, key, self.inspect)

    def test_native_control_files_survive_an_accidental_image_only_declaration(self):
        for identifier in self.plan["tasks"]:
            root = self.source / identifier
            compose = json.dumps(
                {
                    "services": {
                        "main": {"build": {"context": ".", "dockerfile": "Dockerfile"}},
                        "sidecar": {"image": BASE},
                    }
                }
            )
            (root / "environment/docker-compose.yaml").write_text(compose)
            (root / "environment/.env").write_text("EXAMPLE=literal\n")
            file = root / "environment/Dockerfile"
            file.write_text(file.read_text().replace("COPY src /code\n", ""))
            file.write_text(
                file.read_text().replace(
                    f"FROM {BASE}\n",
                    f"FROM {BASE}\nCOPY docker-compose.yaml .env /config/\nCOPY src /code\n",
                )
            )
            file = root / "tests/Dockerfile"
            file.write_text(
                file.read_text().replace(
                    f"FROM {BASE}\n", f"FROM {BASE}\nCOPY test.sh /tests/test.sh\n"
                )
            )
        (self.source / "benchmark.adapter.json").unlink()
        manifest(self.source)
        for spec in self.plan["builds"]:
            spec["prefix_lines"] = 3
        self.plan["image_only"].extend(
            ["environment/docker-compose.yaml", "environment/.env", "tests/test.sh"]
        )
        self.prepare()
        bind(self.prepared, self.images, self.root / "bound", inspect=self.inspect)
        for identifier in self.plan["tasks"]:
            for name in ("environment/docker-compose.yaml", "environment/.env", "tests/test.sh"):
                self.assertEqual(
                    (self.root / "bound" / identifier / name).read_bytes(),
                    (self.source / identifier / name).read_bytes(),
                )

    def test_generated_dockerfile_name_cannot_activate_an_inactive_ignore_file(self):
        for identifier in self.plan["tasks"]:
            root = self.source / identifier / "environment"
            (root / "Dockerfile").rename(root / "Dockerfile.custom")
            (root / "Dockerfile.dockerignore").write_text("src/module.py\n")
            (root / "docker-compose.yaml").write_text(
                json.dumps(
                    {
                        "services": {
                            "main": {"build": {"context": ".", "dockerfile": "Dockerfile.custom"}}
                        }
                    }
                )
            )
        (self.source / "benchmark.adapter.json").unlink()
        manifest(self.source)
        self.plan["builds"][0]["dockerfile"] = "Dockerfile.custom"
        with self.assertRaisesRegex(BenchmarkError, "ignore files"):
            self.prepare()

    def test_metadata_changed_during_image_inspection_cannot_be_published(self):
        self.prepare()

        def inspect(reference):
            (self.prepared / "metadata/source-manifest.json").write_text('{"changed": true}\n')
            return self.inspect(reference)

        with self.assertRaisesRegex(BenchmarkError, "metadata changed while binding"):
            bind(self.prepared, self.images, self.root / "bound", inspect=inspect)
        self.assertFalse((self.root / "bound").exists())

    def test_base_config_from_another_platform_cannot_admit_a_runtime(self):
        self.prepare()
        key, recipe = next(iter(self.record["recipes"].items()))

        def inspect(reference):
            info = self.inspect(reference)
            return {**info, "Architecture": "arm64"} if reference == BASE else info

        with self.assertRaisesRegex(BenchmarkError, "base image platform differs"):
            verify_image(self.images[key], recipe, key, inspect)


if __name__ == "__main__":
    unittest.main()
