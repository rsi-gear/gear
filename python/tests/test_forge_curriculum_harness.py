"""Scheduling, mutation admission, and caller recovery for the Forge recipe."""

import asyncio
import json
import os
import sys
import tempfile
import unittest
from dataclasses import asdict
from pathlib import Path
from unittest.mock import patch

from gear.canonical import digest
from gear.core import DeterministicRandom

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "examples/curriculum-harness"))

from fixtures.forge_provider import FixtureBenchmark  # noqa: E402
from forge_experiment import EpochSampler, ForgeStudy, front_weights, select_parent  # noqa: E402
from formal_experiment import freeze  # noqa: E402
from ifeval_experiment import INITIAL_HARNESS, read_json  # noqa: E402


def config(**overrides):
    return {
        "student": "offline-fixture",
        "teacher": "offline-fixture",
        "effort": "low",
        "split_seed": 1,
        "train_count": 2,
        "dev_count": 2,
        "test_count": 1,
        "seed": 5,
        "steps": 3,
        "patience": 1,
        "batch_size": 2,
        "synthesis_attempts": 4,
        "max_synthesis_events": 1,
        "max_calls": 100,
        **overrides,
    }


class FixtureStudy(ForgeStudy):
    reject_negative = False
    interrupt = False

    def event(self, **data):
        pass

    async def evaluate(self, key, harness, tasks):
        if any("TEST" in task["prompt"] for task in tasks):
            raise AssertionError("optimization opened final test")
        return [
            {
                "task": task,
                "response": "valid answer" if i == 0 else "wrong, answer",
                "policy_id": digest(harness),
                "call_key": key + "/" + task["id"],
                **self.benchmark.grade(task, "valid answer" if i == 0 else "wrong, answer"),
            }
            for i, task in enumerate(tasks)
        ]

    async def model_json(self, key, prepared):
        path = self.root / "fixture-model" / (digest(key).removeprefix("sha256:") + ".json")
        binding = digest(asdict(prepared))
        if path.exists():
            saved = read_json(path)
            if saved["binding"] != binding:
                raise ValueError("fixture input changed on recovery")
            return saved["response"]
        serialized = json.dumps(asdict(prepared))
        if "PRIVATE_DEV" in serialized or "PRIVATE_TEST" in serialized:
            raise AssertionError("validation or test leaked to diagnosis/generation")
        data = prepared.data
        if key.endswith("/diagnose"):
            response = {
                "modes": [
                    {
                        "mode_id": "punctuation",
                        "description": "Omitted punctuation condition",
                        "support_case_ids": [
                            row["case_id"] for row in data["cases"] if row["outcome"] == "failure"
                        ],
                        "counterexample_case_ids": [],
                    }
                ]
            }
        elif key.endswith("/generate"):
            slot = data["slots"][0]
            negative = data["plan"]["mutation"].startswith("negative")
            response = {
                "practices": [
                    {
                        "instruction": "Write a friendly greeting for " + key,
                        "family": slot["family"],
                        "data": {
                            "slot": 0,
                            "source_task_id": slot["source_task_id"],
                            "instruction_id_list": [
                                "change_case:english_lowercase"
                                if negative
                                else "punctuation:no_comma"
                            ],
                            "kwargs": [{}],
                        },
                        "reference": {"answer": "hello world"},
                        "verifier": {"source_task_id": slot["source_task_id"]},
                    }
                ]
            }
        else:
            response = {
                "valid": True,
                "faithful": not (self.reject_negative and data["mutation"] == "negative"),
                "reason": "Offline fixture semantic judgment",
            }
        freeze(
            path, {"key": key, "binding": binding, "input": asdict(prepared), "response": response}
        )
        return response

    async def search(self, *args, **kwargs):
        return await super().search(
            *args, **kwargs, provider_script=ROOT / "python/tests/fixtures/forge_provider.py"
        )

    async def search_step(self, step, parent, tasks):
        result = await super().search_step(step, parent, tasks)
        if self.interrupt and step == 1:
            self.interrupt = False
            raise RuntimeError("lost outer acknowledgement")
        return result


class SchedulingTests(unittest.TestCase):
    def test_front_frequency_excludes_dominated_not_equal_candidates(self):
        candidates = [
            {"dev_scores": scores} for scores in ((1, 1, 0), (0, 0, 1), (0, 0, 0), (1, 1, 0))
        ]
        self.assertEqual(front_weights(candidates), [2, 1, 0, 2])
        choices = [
            select_parent(candidates, DeterministicRandom("seed"), step) for step in range(100)
        ]
        self.assertEqual(set(choices), {0, 1, 3})
        with self.assertRaises(ValueError):
            front_weights([{"dev_scores": [float("nan")]}])

    def test_refresh_prioritizes_unseen_and_new_without_padding_duplicates(self):
        sampler = EpochSampler(["a", "b", "c"], 3)
        consumed = sampler.take(2)
        remaining = set(sampler.order) - set(consumed)
        sampler.append(["d", "e"])
        self.assertEqual(set(sampler.take(3)), remaining | {"d", "e"})
        self.assertEqual(set(sampler.take(8)), set(consumed))
        self.assertEqual(len(sampler.take(8)), 5)
        with self.assertRaises(ValueError):
            sampler.append(["a"])

        # A second synthesis before visiting the old tail must not promote
        # already-consumed tasks back into the unseen group.
        sampler = EpochSampler(["a", "b", "c"], 3)
        consumed = set(sampler.take(2))
        sampler.append(["d", "e"])
        newly_seen = set(sampler.take(1))
        sampler.append(["f"])
        self.assertEqual(
            set(sampler.take(3)), {"a", "b", "c", "d", "e", "f"} - consumed - newly_seen
        )

    def test_mutations_require_semantic_acceptance_and_freeze_components(self):
        async def run(root):
            study = FixtureStudy(
                root, FixtureBenchmark(root), {"train": [], "dev": [], "test": []}, config()
            )
            study.reject_negative = True
            task = study.splits["train"][0]
            cases = study.cases(
                [
                    {
                        "task": task,
                        "call_key": "train/0",
                        "policy_id": digest(INITIAL_HARNESS),
                        "response": "wrong, answer",
                        **study.benchmark.grade(task, "wrong, answer"),
                    }
                ]
            )
            prepared = study.diagnoser.prepare(cases)
            modes = study.diagnoser.parse(
                await study.model_json("0/diagnose", prepared), cases=cases
            )
            bank = {case.case_id: case for case in cases}
            tasks = await study.synthesize(0, modes, bank, study.splits["train"])
            saved = read_json(Path(root) / "synthesis-0/synthesis.json")
            self.assertEqual(
                [attempt["mutation"] for attempt in saved["attempts"]],
                ["positive", "negative", "boundary", "stress"],
            )
            self.assertEqual(saved["rejected"], 1)
            self.assertEqual(len(tasks), 3)
            self.assertEqual(tasks, await study.synthesize(0, modes, bank, study.splits["train"]))
            checks = saved["attempts"][1]["final_validation"]["results"][0]["checks"]
            fidelity = next(check for check in checks if check["check"] == "target_fidelity")
            self.assertEqual((fidelity["kind"], fidelity["status"]), ("semantic", "failed"))
            with self.assertRaisesRegex(ValueError, "frozen experiment"):
                FixtureStudy(
                    root,
                    FixtureBenchmark(root),
                    {"train": [], "dev": [], "test": []},
                    config(),
                    fidelity_prompt="changed semantic policy",
                )

        with tempfile.TemporaryDirectory() as root:
            asyncio.run(run(root))


@unittest.skipUnless(os.environ.get("GEAR_TEST_FORGE_RUNTIME"), "explicit CLI/worker integration")
class RuntimeTests(unittest.TestCase):
    def test_cross_run_admission_training_gate_fronts_and_outer_recovery(self):
        async def run(root):
            previous = {"train": [], "dev": [], "test": []}
            study = FixtureStudy(root, FixtureBenchmark(root), previous, config())
            study.interrupt = True
            with self.assertRaisesRegex(RuntimeError, "lost outer acknowledgement"):
                await study.optimize()
            submitted = Path(root) / "operations/submitted.jsonl"
            first_ids = submitted.read_text().splitlines()
            restored = FixtureStudy(root, FixtureBenchmark(root), previous, config())
            result = await restored.optimize()
            after = submitted.read_text().splitlines()
            self.assertEqual(len(after), len(set(after)))
            self.assertEqual(after[: len(first_ids)], first_ids)
            self.assertEqual(len(result["candidates"]), 4)
            self.assertEqual(result["selected_index"], 0)  # Equal total dev scores keep the first.
            self.assertFalse(result["test_opened"])
            self.assertEqual(len(result["pool"]), 6)
            generated = set(result["trace"][0]["added_ids"])
            self.assertTrue(set(result["trace"][1]["train_ids"]) <= generated)
            runs = list(Path(root).glob("seed-*/forge/round-*/project/.gear/runs/*/journal.json"))
            self.assertEqual(len(runs), 3)
            for path in runs:
                journal = read_json(path)
                self.assertFalse(journal["heldOutEvidence"])
                gates = [
                    r
                    for d in journal["operators"]["decisions"]
                    for r in d["decision"]["records"]
                    if r["kind"] == "training_acceptance"
                ]
                self.assertEqual([g["accepted"] for g in gates], [True])
            diagnosed = [read_json(p) for p in (Path(root) / "fixture-model").glob("*.json")]
            following = next(row for row in diagnosed if row["key"] == "forge/step-1/diagnose")
            self.assertEqual(following["input"]["data"]["memory"], [])
            before_replay = submitted.read_text()
            again = FixtureStudy(root, FixtureBenchmark(root), previous, config())
            self.assertEqual(result, await again.optimize())
            self.assertEqual(submitted.read_text(), before_replay)

        with (
            tempfile.TemporaryDirectory() as root,
            patch.dict(
                os.environ,
                {
                    "GEAR_PROFILE_ROOT": str(Path(root) / "profiles"),
                    "GEAR_PYTHON": sys.executable,
                    "GEAR_COMMAND": json.dumps(["node", str(ROOT / "lib/cli.js")]),
                    "PYTHONPATH": str(ROOT / "python"),
                },
            ),
        ):
            asyncio.run(run(root))


if __name__ == "__main__":
    unittest.main()
