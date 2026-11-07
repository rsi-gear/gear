import unittest

from examples.algorithms import prepare_meta_harness_tb2
from examples.algorithms.run_meta_harness_tb2 import (
    REFERENCE_DATASET_COMMIT,
    REFERENCE_DATASET_REVISION,
    REFERENCE_TASK_IDS,
    is_reference_proposer_model,
    seed_task_id_error,
)


class MetaHarnessRunnerTests(unittest.TestCase):
    def test_pinned_reference_task_set_has_expected_size(self):
        import hashlib

        self.assertEqual(len(REFERENCE_TASK_IDS), 89)
        digest = hashlib.sha256(
            ("\n".join(sorted(REFERENCE_TASK_IDS)) + "\n").encode()
        ).hexdigest()
        self.assertEqual(
            digest, "3778b86071c74c8a342222cfff41089916adb5c7338d1afa69f42c9cae21fe3e"
        )
        self.assertTrue(is_reference_proposer_model("anthropic/claude-opus-4-6"))
        self.assertFalse(is_reference_proposer_model("gpt-6-astra"))
        self.assertFalse(is_reference_proposer_model("claude-opus-4-60"))

    def test_dataset_revision_is_pinned_to_the_reference_manifest(self):
        self.assertEqual(
            REFERENCE_DATASET_REVISION,
            f"terminal-bench/terminal-bench-2-1@{REFERENCE_DATASET_COMMIT}",
        )

    def test_accepts_exact_pinned_task_set_with_qualified_ids(self):
        task_ids = [f"terminal-bench/{task_id}" for task_id in sorted(REFERENCE_TASK_IDS)]
        self.assertIsNone(seed_task_id_error(task_ids))

    def test_rejects_missing_task(self):
        task_ids = sorted(REFERENCE_TASK_IDS - {"write-compressor"})
        error = seed_task_id_error(task_ids)
        self.assertIn("write-compressor", error)
        self.assertIn("missing=", error)

    def test_rejects_unexpected_and_duplicate_tasks(self):
        task_ids = [*sorted(REFERENCE_TASK_IDS), "not-a-reference-task", "write-compressor"]
        error = seed_task_id_error(task_ids)
        self.assertIn("not-a-reference-task", error)
        self.assertIn("write-compressor", error)
        self.assertIn("duplicates=", error)

    def test_reads_model_ids_from_profiles_selected_by_gear_yaml(self):
        import json
        import os
        from pathlib import Path
        from tempfile import TemporaryDirectory
        from unittest.mock import patch

        import yaml
        from examples.algorithms.run_meta_harness_tb2 import (
            configured_meta_sampling,
            configured_models,
        )

        with TemporaryDirectory() as directory:
            root = Path(directory)
            profile_root = root / "profiles"
            profile_root.mkdir()
            (root / "gear.yaml").write_text(
                yaml.safe_dump(
                    {"meta": {"profile": "proposer"}, "target": {"profile": "evaluation"}}
                ),
                encoding="utf-8",
            )
            (profile_root / "proposer.json").write_text(
                json.dumps({"kind": "codex", "configuration": {"model": "claude-opus-4-6"}}),
                encoding="utf-8",
            )
            (profile_root / "evaluation.json").write_text(
                json.dumps({"kind": "hitch", "model": "anthropic/claude-opus-4-6"}),
                encoding="utf-8",
            )
            with patch.dict(os.environ, {"GEAR_PROFILE_ROOT": str(profile_root)}):
                self.assertEqual(
                    configured_models(root),
                    {
                        "meta": {"profile": "proposer", "model": "claude-opus-4-6"},
                        "target": {
                            "profile": "evaluation",
                            "model": "anthropic/claude-opus-4-6",
                        },
                    },
                )
                self.assertEqual(configured_meta_sampling(root), {})

    def test_records_provider_specific_meta_sampling_without_secrets(self):
        from pathlib import Path
        from tempfile import TemporaryDirectory

        import yaml
        from examples.algorithms.run_meta_harness_tb2 import configured_meta_sampling

        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "gear.yaml").write_text(
                yaml.safe_dump(
                    {
                        "metaSampling": {
                            "reasoningEffort": "max",
                            "temperature": 0.2,
                        }
                    }
                ),
                encoding="utf-8",
            )
            self.assertEqual(
                configured_meta_sampling(root),
                {"reasoningEffort": "max", "temperature": 0.2},
            )

            (root / "gear.yaml").write_text(
                yaml.safe_dump({"metaSampling": {"apiKey": "must-not-be-exported"}}),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "unsupported fields"):
                configured_meta_sampling(root)

    def test_rejects_a_selected_profile_without_a_model_identifier(self):
        import os
        from pathlib import Path
        from tempfile import TemporaryDirectory
        from unittest.mock import patch

        import yaml
        from examples.algorithms.run_meta_harness_tb2 import configured_models

        with TemporaryDirectory() as directory:
            root = Path(directory)
            profile_root = root / "profiles"
            profile_root.mkdir()
            (root / "gear.yaml").write_text(
                yaml.safe_dump(
                    {"meta": {"profile": "proposer"}, "target": {"profile": "evaluation"}}
                ),
                encoding="utf-8",
            )
            for name in ("proposer", "evaluation"):
                (profile_root / f"{name}.json").write_text("{}", encoding="utf-8")
            with patch.dict(os.environ, {"GEAR_PROFILE_ROOT": str(profile_root)}):
                with self.assertRaisesRegex(ValueError, "meta profile does not declare"):
                    configured_models(root)


    def test_model_labels_match_selected_profiles_and_reference_model(self):
        from examples.algorithms.run_meta_harness_tb2 import model_label_error

        meta_profile = {"profile": "proposer", "model": "anthropic/claude-opus-4-6"}
        target_profile = {
            "profile": "evaluation",
            "model": "anthropic/claude-opus-4-6",
        }
        self.assertIsNone(model_label_error("meta", meta_profile["model"], meta_profile))
        self.assertIsNone(model_label_error("target", target_profile["model"], target_profile))
        self.assertIn(
            "--evaluation-model must match",
            model_label_error("target", "other-model", target_profile),
        )
        wrong_target = {"profile": "evaluation", "model": "gpt-5.6"}
        self.assertIn(
            "anthropic/claude-opus-4-6",
            model_label_error("target", wrong_target["model"], wrong_target),
        )
        wrong_reference = {"profile": "proposer", "model": "gpt-6-astra"}
        self.assertIn("Claude Opus 4.6", model_label_error("meta", "gpt-6-astra", wrong_reference))

    def test_prepare_task_tree_labels_seed_and_held_out_without_mutating_sources(self):
        from pathlib import Path
        from tempfile import TemporaryDirectory
        from unittest.mock import patch

        import tomllib

        with TemporaryDirectory() as directory:
            root = Path(directory)
            seed_source, heldout_source = root / "seed", root / "holdout"
            seed_source.mkdir()
            heldout_source.mkdir()
            for name, family, instruction in (
                ("seed-a", "seed-family", "Seed task A"),
                ("seed-b", "another-family", "Seed task B"),
            ):
                task = seed_source / name
                task.mkdir()
                (task / "task.toml").write_text(
                    f'[metadata]\nfamily = "{family}"\n', encoding="utf-8"
                )
                (task / "instruction.md").write_text(instruction, encoding="utf-8")
            heldout = heldout_source / "holdout-c"
            heldout.mkdir()
            (heldout / "task.toml").write_text(
                '[metadata]\nfamily = "heldout-family"\n', encoding="utf-8"
            )
            (heldout / "instruction.md").write_text("Independent holdout", encoding="utf-8")
            destination = root / "prepared" / "tasks"
            with patch.object(
                prepare_meta_harness_tb2,
                "REFERENCE_TASK_IDS",
                frozenset({"seed-a", "seed-b"}),
            ):
                summary = prepare_meta_harness_tb2.prepare_task_tree(
                    seed_source, heldout_source, destination
                )

            self.assertEqual((summary["seed_count"], summary["held_out_count"]), (2, 1))
            self.assertEqual(
                tomllib.loads((destination / "seed-a" / "task.toml").read_text())["metadata"][
                    "split"
                ],
                "seed",
            )
            self.assertEqual(
                tomllib.loads((destination / "holdout-c" / "task.toml").read_text())[
                    "metadata"
                ]["split"],
                "held_out",
            )
            source_metadata = tomllib.loads(
                (seed_source / "seed-a" / "task.toml").read_text()
            )["metadata"]
            self.assertNotIn("split", source_metadata)

    def test_prepare_task_tree_rejects_holdout_reusing_seed_family(self):
        from pathlib import Path
        from tempfile import TemporaryDirectory
        from unittest.mock import patch

        with TemporaryDirectory() as directory:
            root = Path(directory)
            seed_source, heldout_source = root / "seed", root / "holdout"
            seed_source.mkdir()
            heldout_source.mkdir()
            for parent, name, instruction in (
                (seed_source, "seed-a", "Seed"),
                (heldout_source, "holdout-b", "Holdout"),
            ):
                task = parent / name
                task.mkdir()
                (task / "task.toml").write_text(
                    '[metadata]\nfamily = "reused-family"\n', encoding="utf-8"
                )
                (task / "instruction.md").write_text(instruction, encoding="utf-8")
            destination = root / "prepared"
            with patch.object(
                prepare_meta_harness_tb2,
                "REFERENCE_TASK_IDS",
                frozenset({"seed-a"}),
            ):
                with self.assertRaisesRegex(ValueError, "shares a family"):
                    prepare_meta_harness_tb2.prepare_task_tree(
                        seed_source, heldout_source, destination
                    )
            self.assertFalse(destination.exists())

    def test_prepare_task_tree_rejects_reused_input_content(self):
        from pathlib import Path
        from tempfile import TemporaryDirectory
        from unittest.mock import patch

        with TemporaryDirectory() as directory:
            root = Path(directory)
            seed_source, heldout_source = root / "seed", root / "holdout"
            seed_source.mkdir()
            heldout_source.mkdir()
            for parent, name, family, instruction in (
                (seed_source, "seed-a", "seed-family", "Seed"),
                (heldout_source, "holdout-b", "heldout-family", "Holdout"),
            ):
                task = parent / name
                input_directory = task / "environment" / "inputs"
                input_directory.mkdir(parents=True)
                (task / "task.toml").write_text(
                    f'[metadata]\nfamily = "{family}"\n', encoding="utf-8"
                )
                (task / "instruction.md").write_text(instruction, encoding="utf-8")
                (input_directory / "input.txt").write_text("shared data", encoding="utf-8")
            destination = root / "prepared"
            with patch.object(
                prepare_meta_harness_tb2,
                "REFERENCE_TASK_IDS",
                frozenset({"seed-a"}),
            ):
                with self.assertRaisesRegex(ValueError, "input content"):
                    prepare_meta_harness_tb2.prepare_task_tree(
                        seed_source, heldout_source, destination
                    )
            self.assertFalse(destination.exists())

    def test_dataset_revision_requires_clean_checkout_and_matching_manifest(self):
        from pathlib import Path
        from subprocess import CompletedProcess
        from tempfile import TemporaryDirectory
        from unittest.mock import patch

        with TemporaryDirectory() as directory:
            repository = Path(directory)
            tasks = repository / "tasks"
            tasks.mkdir()
            (tasks / "dataset.toml").write_text(
                '[[tasks]]\nname = "org/seed-a"\n\n[[tasks]]\nname = "org/seed-b"\n',
                encoding="utf-8",
            )
            expected = "a" * 40
            with patch.object(
                prepare_meta_harness_tb2, "REFERENCE_DATASET_COMMIT", expected
            ), patch.object(
                prepare_meta_harness_tb2,
                "REFERENCE_TASK_IDS",
                frozenset({"seed-a", "seed-b"}),
            ), patch(
                "examples.algorithms.prepare_meta_harness_tb2.subprocess.run",
                side_effect=[
                    CompletedProcess([], 0, stdout=expected + "\n", stderr=""),
                    CompletedProcess([], 0, stdout="", stderr=""),
                ],
            ):
                prepare_meta_harness_tb2._verify_dataset_revision(repository)

            with patch.object(
                prepare_meta_harness_tb2, "REFERENCE_DATASET_COMMIT", expected
            ), patch(
                "examples.algorithms.prepare_meta_harness_tb2.subprocess.run",
                side_effect=[
                    CompletedProcess([], 0, stdout=expected + "\n", stderr=""),
                    CompletedProcess([], 0, stdout=" M tasks/task.toml\n", stderr=""),
                ],
            ):
                with self.assertRaisesRegex(ValueError, "clean working tree"):
                    prepare_meta_harness_tb2._verify_dataset_revision(repository)

            (tasks / "dataset.toml").write_text(
                '[[tasks]]\nname = "org/not-seed-a"\n', encoding="utf-8"
            )
            with patch.object(
                prepare_meta_harness_tb2, "REFERENCE_DATASET_COMMIT", expected
            ), patch(
                "examples.algorithms.prepare_meta_harness_tb2.subprocess.run",
                side_effect=[
                    CompletedProcess([], 0, stdout=expected + "\n", stderr=""),
                    CompletedProcess([], 0, stdout="", stderr=""),
                ],
            ):
                with self.assertRaisesRegex(ValueError, "manifest task IDs"):
                    prepare_meta_harness_tb2._verify_dataset_revision(repository)

    def test_prepare_task_tree_rejects_output_inside_either_source(self):
        from pathlib import Path
        from tempfile import TemporaryDirectory

        with TemporaryDirectory() as directory:
            root = Path(directory)
            seed_source, heldout_source = root / "seed", root / "holdout"
            seed_source.mkdir()
            heldout_source.mkdir()
            with self.assertRaisesRegex(ValueError, "outside both source directories"):
                prepare_meta_harness_tb2.prepare_task_tree(
                    seed_source, heldout_source, seed_source / "prepared"
                )
            with self.assertRaisesRegex(ValueError, "outside both source directories"):
                prepare_meta_harness_tb2.prepare_task_tree(
                    seed_source, heldout_source, heldout_source / "prepared"
                )


if __name__ == "__main__":
    unittest.main()
