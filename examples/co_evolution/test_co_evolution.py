"""Deterministic tests for the synthetic co-evolution scaffold."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

_EXAMPLES_ROOT = Path(__file__).resolve().parents[1]
if str(_EXAMPLES_ROOT) not in sys.path:
    sys.path.insert(0, str(_EXAMPLES_ROOT))

from co_evolution.harness_backend import optimize_harness
from co_evolution.ledger import JointLedger
from co_evolution.model_backend import update_model
from co_evolution.run import budget_plan, run_comparison, should_update_harness, should_update_model
from co_evolution.world import (
    INITIAL_HARNESS,
    INITIAL_MODEL,
    digest,
    evaluate_split,
    load_split,
    score_task,
)


class SplitIsolationTests(unittest.TestCase):
    def test_splits_are_disjoint_and_known(self) -> None:
        split = load_split()
        train, seed, held = set(split["train"]), set(split["seed"]), set(split["held_out"])
        self.assertFalse(train & seed)
        self.assertFalse(train & held)
        self.assertFalse(seed & held)
        self.assertEqual(len(train), 4)
        self.assertEqual(len(seed), 4)
        self.assertEqual(len(held), 5)


class ScoringTests(unittest.TestCase):
    def test_score_is_deterministic(self) -> None:
        first = score_task("held_align_a", INITIAL_MODEL, INITIAL_HARNESS)
        second = score_task("held_align_a", INITIAL_MODEL, INITIAL_HARNESS)
        self.assertEqual(first, second)
        self.assertGreaterEqual(first["reward"], 0.0)
        self.assertLessEqual(first["reward"], 1.0)

    def test_reinforce_prefers_alignment(self) -> None:
        strong_model = {
            "schemaVersion": 1,
            "skills": {"a": 0.9, "b": 0.1},
            "steps": 3,
        }
        good_harness = {
            "schemaVersion": 1,
            "routing": "a",
            "prompt_strength": 0.8,
            "tool_bias": 0.2,
            "version": 1,
        }
        bad_harness = {
            "schemaVersion": 1,
            "routing": "b",
            "prompt_strength": 0.8,
            "tool_bias": -0.2,
            "version": 1,
        }
        good = score_task("held_align_a", strong_model, good_harness)
        bad = score_task("held_align_a", strong_model, bad_harness)
        self.assertGreater(good["reward"], bad["reward"])


class BackendTests(unittest.TestCase):
    def test_model_update_changes_checkpoint(self) -> None:
        split = load_split()
        with tempfile.TemporaryDirectory() as tmp:
            result = update_model(
                workspace=Path(tmp) / "model",
                checkpoint=INITIAL_MODEL,
                harness=INITIAL_HARNESS,
                train_tasks=split["train"],
                train_digest=digest({"tasks": split["train"]}),
            )
        self.assertTrue(result["updated"])
        self.assertEqual(result["checkpoint"]["steps"], 1)
        self.assertEqual(result["rollouts"], len(split["train"]))

    def test_harness_search_uses_seed_only(self) -> None:
        split = load_split()
        result = optimize_harness(
            checkpoint=INITIAL_MODEL,
            harness=INITIAL_HARNESS,
            seed_tasks=split["seed"],
            candidate_limit=3,
        )
        self.assertIn("afterId", result)
        self.assertGreaterEqual(result["rollouts"], len(split["seed"]))
        # Candidates are ranked; champion seed reward is at least baseline.
        self.assertGreaterEqual(
            result["championSeed"]["meanReward"],
            result["baselineSeed"]["meanReward"],
        )


class OrchestratorTests(unittest.TestCase):
    def test_update_gates(self) -> None:
        self.assertFalse(should_update_model(0, "fixed_baseline", "every_round"))
        self.assertTrue(should_update_model(0, "model_only", "every_round"))
        self.assertFalse(should_update_model(1, "co_evolution", "model_every_2"))
        self.assertTrue(should_update_harness(0, "harness_only", "every_round"))
        self.assertFalse(should_update_harness(1, "co_evolution", "harness_every_2"))

    def test_four_settings_share_budget_and_write_ledger(self) -> None:
        split = load_split()
        rounds = 3
        budget = budget_plan(rounds, len(split["train"]), len(split["seed"]), len(split["held_out"]), 3)
        with tempfile.TemporaryDirectory() as tmp:
            comparison = run_comparison(
                workspace=Path(tmp) / "cmp",
                rounds=rounds,
                budget=budget,
                order="model_then_harness",
                frequency="every_round",
                candidate_limit=3,
                learning_rate=0.2,
            )
            self.assertEqual(set(comparison["settings"]), {
                "fixed_baseline",
                "model_only",
                "harness_only",
                "co_evolution",
            })
            for name, payload in comparison["settings"].items():
                self.assertLessEqual(payload["spent"], budget)
                self.assertIsNotNone(payload["heldOutFinal"])
            # Fixed baseline spends only held-out rollouts per round.
            self.assertEqual(
                comparison["results"]["fixed_baseline"]["budget"]["spent"],
                rounds * len(split["held_out"]),
            )
            # Ledger joins identities.
            ledger_path = (
                Path(tmp)
                / "cmp"
                / "co_evolution"
                / "model_then_harness__every_round"
                / "ledger.jsonl"
            )
            rows = JointLedger(ledger_path).rows()
            self.assertEqual(len(rows), rounds)
            for row in rows:
                self.assertIn("modelId", row)
                self.assertIn("harnessId", row)
                self.assertIn("trainDigest", row)
                self.assertIn("seedDigest", row)
                self.assertIn("heldOut", row)
                self.assertEqual(row["heldOutDigest"], digest({"tasks": split["held_out"]}))

            # Held-out never appears in train/seed digests.
            self.assertNotEqual(rows[0]["trainDigest"], rows[0]["heldOutDigest"])
            self.assertNotEqual(rows[0]["seedDigest"], rows[0]["heldOutDigest"])

            comparison_path = Path(tmp) / "cmp" / "comparison.json"
            self.assertTrue(comparison_path.exists())
            loaded = json.loads(comparison_path.read_text(encoding="utf-8"))
            self.assertIn("disclaimer", loaded)

    def test_budget_equalization_across_settings(self) -> None:
        split = load_split()
        budget = budget_plan(4, len(split["train"]), len(split["seed"]), len(split["held_out"]), 2)
        with tempfile.TemporaryDirectory() as tmp:
            comparison = run_comparison(
                workspace=Path(tmp) / "eq",
                rounds=4,
                budget=budget,
                order="harness_then_model",
                frequency="every_round",
                candidate_limit=2,
                learning_rate=0.15,
            )
            spends = [comparison["settings"][name]["spent"] for name in comparison["settings"]]
            self.assertTrue(all(spend <= budget for spend in spends))
            # Co-evolution should consume more of the shared budget than baseline.
            self.assertGreater(
                comparison["settings"]["co_evolution"]["spent"],
                comparison["settings"]["fixed_baseline"]["spent"],
            )


if __name__ == "__main__":
    unittest.main()
