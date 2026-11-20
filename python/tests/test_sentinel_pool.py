"""Offline validation and exact source quotas for the concrete retail caller."""

import asyncio
import copy
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

EXAMPLES = Path(__file__).resolve().parents[2] / "examples/curriculum-harness"
sys.path.insert(0, str(EXAMPLES))
import test_sentinel_retail as fixture  # noqa: E402
from sentinel_generate import RetailGenerator  # noqa: E402
from sentinel_pool import build_pool, replay_generated  # noqa: E402
from sentinel_retail import load_backend  # noqa: E402

TAU_SOURCE = os.environ.get("GEAR_SENTINEL_TAU2_PATH")


@unittest.skipUnless(
    TAU_SOURCE and importlib.util.find_spec("tau2"), "requires pinned Tau2 checkout and package"
)
class RetailPoolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        source = fixture.NativeRetailTests()
        source.backend = load_backend(TAU_SOURCE)
        self.config = source.config()
        self.generated_root = self.root / "generated"
        self.calls = fixture.FixtureCalls()
        generator = RetailGenerator(self.generated_root, TAU_SOURCE, self.config, self.calls)
        self.generated = asyncio.run(generator.generate())
        self.reference = json.loads((self.generated_root / "reference.json").read_text())
        task = copy.deepcopy(self.generated["task"])
        task.update(
            id="authored-fixed-cancellation",
            ticket="Please cancel pending order #G100; I no longer need it.",
        )
        self.pool_config = {
            **{
                key: self.config[key]
                for key in ("schema_version", "partition", "family", "database", "user_id")
            },
            "fixed": [
                {
                    "task": task,
                    "reference": self.reference,
                    "evidence_refs": [{"fixture": "explicit authored task"}],
                }
            ],
            "generated": [str(self.generated_root)],
            "fixed_count": 1,
            "generated_count": 1,
            "seed": 17,
        }

    def pool(self, config=None, name="pool"):
        return asyncio.run(build_pool(self.root / name, TAU_SOURCE, config or self.pool_config))

    def test_exact_mix_replays_real_tools_without_a_model_client(self):
        before = {
            path.relative_to(self.generated_root): path.read_bytes()
            for path in self.generated_root.rglob("*.json")
        }
        submissions = list(self.calls.submissions)
        result = self.pool()
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["requested"], {"fixed": 1, "generated": 1})
        self.assertEqual(
            [row["provenance"]["kind"] for row in result["selected"]], ["fixed", "generated"]
        )
        self.assertFalse(result["training_eligible"])
        self.assertEqual(self.pool(), result)
        self.assertEqual(self.calls.submissions, submissions)
        self.assertEqual(
            before,
            {
                path.relative_to(self.generated_root): path.read_bytes()
                for path in self.generated_root.rglob("*.json")
            },
        )

    def test_shortage_never_uses_the_other_source_as_a_fallback(self):
        config = {**self.pool_config, "generated_count": 2}
        result = self.pool(config)
        self.assertEqual(result["status"], "insufficient")
        self.assertEqual(result["shortage"], {"fixed": 0, "generated": 1})
        self.assertEqual(result["selected"], [])

    def test_recorded_request_and_tool_observation_tampering_rejected(self):
        for change in ("request", "observation", "missing", "result"):
            with self.subTest(change=change):
                files = {path: path.read_bytes() for path in self.generated_root.rglob("*.json")}
                if change in ("request", "missing"):
                    path = self.generated_root / "model/explore/0.json"
                    if change == "missing":
                        path.unlink()
                    else:
                        data = json.loads(path.read_text())
                        data["input"]["prompt"] += " changed"
                        path.write_text(json.dumps(data))
                else:
                    path = self.generated_root / (
                        "reference.json" if change == "observation" else "result.json"
                    )
                    data = json.loads(path.read_text())
                    if change == "observation":
                        data["steps"][0]["execution"]["response"]["content"] = "forged observation"
                    else:
                        data["selected"] = []
                    path.write_text(json.dumps(data))
                with self.assertRaises(ValueError):
                    asyncio.run(replay_generated(self.generated_root, TAU_SOURCE))
                for path, raw in files.items():
                    path.write_bytes(raw)

    def test_duplicate_and_foreign_task_scopes_fail_before_selection(self):
        for change in ("duplicate", "partition", "family", "database"):
            config = copy.deepcopy(self.pool_config)
            if change == "duplicate":
                config["fixed"][0]["task"] = copy.deepcopy(self.generated["task"])
            elif change == "partition":
                config["partition"] = "test"
            elif change == "family":
                config["family"] = "foreign"
            else:
                config["database"]["orders"]["#G100"]["status"] = "delivered"
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.pool(config, name=change)

    def test_pool_sampling_is_seeded_and_independent_of_fixed_input_order(self):
        config = copy.deepcopy(self.pool_config)
        for index in range(3):
            row = copy.deepcopy(config["fixed"][0])
            row["task"].update(
                id=f"fixed-{index}", ticket=f"Cancel my order #G100 please, request {index}."
            )
            config["fixed"].append(row)
        first = self.pool(config)
        config["fixed"].reverse()
        second = self.pool(config, name="reordered")
        self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
