"""Skill-tree scope, immutable allocation, and the executable training caller."""

import importlib
import json
import sys
import tempfile
import unittest
from dataclasses import asdict, replace
from pathlib import Path
from unittest.mock import patch

from gear.canonical import digest
from gear.core import clone
from gear.curriculum import (
    ExtractOutcomeCases,
    OutcomeRecord,
    PlanSkillPractice,
    ProposeSubskills,
    SkillTree,
    SkillTreeAction,
    Subskill,
)


def binding(tree):
    return digest(json.loads(json.dumps(asdict(tree))))


def cases():
    return ExtractOutcomeCases()(
        (
            OutcomeRecord(
                "task",
                "family",
                "sample",
                0,
                "policy",
                "environment",
                "completed",
                False,
                True,
                "instruction",
                "failure feedback",
                ("evidence",),
            ),
        )
    )


class SkillTreeTests(unittest.TestCase):
    def test_expansion_and_delta_allocation_preserve_tree_and_evidence(self):
        tree = SkillTree("root", "Root skill", ("family",))
        observations = cases()
        proposer = ProposeSubskills()
        response = {
            "subskills": [
                {
                    "skill_id": "child",
                    "description": "A subskill",
                    "families": ["family"],
                    "source_case_ids": [observations[0].case_id],
                }
            ]
        }
        action = proposer.parse(response, tree=tree, count=2, allocation=3, cases=observations)
        op = PlanSkillPractice()
        plan = op(tree, action, budget=3)
        self.assertEqual(tree.subskills, ())
        self.assertEqual(plan.targets[0].source_case_ids, (observations[0].case_id,))
        self.assertEqual(plan.total_allocation, 3)
        updated = op(
            plan.tree,
            SkillTreeAction(binding(plan.tree), "exploit", allocation_delta=(("child", -3),)),
            budget=0,
        )
        self.assertEqual(updated.total_allocation, 0)
        self.assertEqual(updated.targets, ())
        self.assertEqual(plan.tree.subskills[0].allocation, 3)
        for operator in (proposer, op):
            self.assertEqual(clone(operator).describe().to_dict(), operator.describe().to_dict())
        self.assertEqual(clone(op)(tree, action, budget=3), plan)

    def test_stale_scope_duplicate_and_budget_changes_are_rejected(self):
        tree = SkillTree(
            "root", "Root skill", ("family",), (Subskill("a", "First skill", ("family",), 2),)
        )
        op = PlanSkillPractice()
        invalid = (
            SkillTreeAction("different", "exploit", allocation_delta=(("a", 1),)),
            SkillTreeAction(binding(tree), "exploit"),
            SkillTreeAction(binding(tree), "exploit", allocation_delta=(("a", True),)),
            SkillTreeAction(binding(tree), "exploit", allocation_delta=(("a", -3),)),
            SkillTreeAction(binding(tree), "exploit", allocation_delta=(("a", 1), ("a", 1))),
            SkillTreeAction(
                binding(tree), "explore", (Subskill("b", "Different", ("private",), 1),)
            ),
            SkillTreeAction(
                binding(tree), "explore", (Subskill("b", "FIRST SKILL", ("family",), 1),)
            ),
            SkillTreeAction(
                binding(tree), "explore", (Subskill("b", "Second", ("family",), 1),), (("a", 0),)
            ),
        )
        for action in invalid:
            with self.subTest(action=action), self.assertRaises(ValueError):
                op(tree, action, budget=4)
        with self.assertRaisesRegex(ValueError, "budget"):
            op(
                tree,
                SkillTreeAction(binding(tree), "exploit", allocation_delta=(("a", 3),)),
                budget=4,
            )
        with self.assertRaisesRegex(ValueError, "subskill limit"):
            PlanSkillPractice(max_subskills=1)(
                tree,
                SkillTreeAction(
                    binding(tree), "explore", (Subskill("b", "Second", ("family",), 1),)
                ),
                budget=4,
            )

    def test_subskill_proposals_cannot_fabricate_failures_or_expand_source_families(self):
        tree = SkillTree("root", "Root skill", ("family",))
        observations = cases()
        proposer = ProposeSubskills()
        response = {
            "subskills": [
                {
                    "skill_id": "child",
                    "description": "A subskill",
                    "families": ["family"],
                    "source_case_ids": ["invented"],
                }
            ]
        }
        with self.assertRaisesRegex(ValueError, "complete failures"):
            proposer.parse(response, tree=tree, count=1, allocation=1, cases=observations)
        response["subskills"][0]["source_case_ids"] = []
        action = proposer.parse(response, tree=tree, count=1, allocation=1, cases=observations)
        self.assertEqual(action.new_subskills[0].source_case_ids, ())
        wrong = replace(observations[0], record=replace(observations[0].record, family="private"))
        with self.assertRaisesRegex(ValueError, "scope"):
            proposer.prepare(tree, count=1, allocation=1, cases=(wrong,))
        with self.assertRaisesRegex(ValueError, "limit"):
            proposer.prepare(tree, count=9, allocation=1)


EXAMPLE_ROOT = Path(__file__).resolve().parents[2] / "examples/training-loop"
sys.path.insert(0, str(EXAMPLE_ROOT))
example = importlib.import_module("dataenvgym_cpu")


class SkillTreeCallerTests(unittest.TestCase):
    def test_multi_round_updates_explore_exploit_and_resume(self):
        with tempfile.TemporaryDirectory() as directory:
            result = example.run_example(directory)
            self.assertEqual(result["checkpoint"], {"negative": 1.0, "positive": 3.0})
            self.assertLess(result["final_held_out_mse"], result["initial_held_out_mse"])
            self.assertEqual(
                {kind for row in result["actions"] for kind in row.values()}, {"explore", "exploit"}
            )
            self.assertTrue(
                all(
                    row["admitted"] <= row["generated"] <= row["requested"] <= 8
                    for row in result["counts"]
                )
            )
            root = Path(directory)
            snapshots = {str(path): path.read_bytes() for path in root.rglob("*.json")}
            self.assertEqual(example.run_example(directory), result)
            self.assertEqual(
                snapshots, {str(path): path.read_bytes() for path in root.rglob("*.json")}
            )
            used = set()
            for path in sorted(root.glob("rounds/*/task-source/result.json")):
                tasks = json.loads(path.read_text())["output"]
                self.assertTrue(all(set(task) == {"x", "target"} for task in tasks))
                self.assertFalse(used & {task["x"] for task in tasks})
                used.update(task["x"] for task in tasks)
                record = json.loads((path.parent / "workspace/teacher.json").read_text())["record"]
                for row in record["observations"]:
                    self.assertEqual(row["policy_id"], record["policy_id"])
                    self.assertLessEqual(abs(json.loads(row["instruction"])["x"]), 4)
            self.assertNotIn(100, used)
            self.assertEqual(result["observed_gain"][0], {"positive": None, "negative": None})

    def test_recovery_after_subskill_proposal_generation_and_validation(self):
        for name in ("teacher_action", "generate", "validate"):
            with self.subTest(phase=name), tempfile.TemporaryDirectory() as directory:
                original = getattr(example, name)

                def interrupted(*args, **kwargs):
                    original(*args, **kwargs)
                    raise RuntimeError("simulated interruption")

                with patch.object(example, name, side_effect=interrupted):
                    with self.assertRaisesRegex(RuntimeError, "simulated interruption"):
                        example.run_example(directory)
                self.assertEqual(example.run_example(directory)["checkpoint"]["positive"], 3.0)

    def test_changed_parameters_or_validation_evidence_cannot_resume(self):
        with tempfile.TemporaryDirectory() as directory:
            example.run_example(directory)
            with self.assertRaises(ValueError):
                example.run_example(directory, per_root_budget=6)
            proof = next(Path(directory).glob("rounds/*/task-source/workspace/validation/*.json"))
            value = json.loads(proof.read_text())
            value["oracle"] = 999
            proof.write_text(json.dumps(value))
            with self.assertRaisesRegex(ValueError, "validation evidence changed"):
                example.run_example(directory)


if __name__ == "__main__":
    unittest.main()
