"""Actual CPU retail rollback, UCT search and repair; every LLM response is a fixture."""

import asyncio
import copy
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

EXAMPLES = Path(__file__).resolve().parents[2] / "examples/curriculum-harness"
sys.path.insert(0, str(EXAMPLES))
import test_sentinel_retail as source_fixture  # noqa: E402
from agentr_execution import restore, rollback  # noqa: E402
from agentr_retail import RetailAgentR, main, replay_generated  # noqa: E402
from agentr_search import RetailTree  # noqa: E402
from fixtures.agentr_calls import AgentRCalls  # noqa: E402
from ifeval import read_json, write_json  # noqa: E402
from sentinel_collect import RetailCollector  # noqa: E402
from sentinel_generate import EXPLORER_PROMPT, RetailGenerator  # noqa: E402
from sentinel_retail import RetailSession, load_backend  # noqa: E402
from test_sentinel_collect import SolverCalls  # noqa: E402
from test_sentinel_retail import FixtureCalls, database, observation  # noqa: E402

TAU_SOURCE = os.environ.get("GEAR_SENTINEL_TAU2_PATH")


class UCTTests(unittest.TestCase):
    def test_completed_rewards_unvisited_priority_and_closed_children(self):
        initial = {"environment_id": "env", "steps": [], "status": "incomplete"}
        tree = RetailTree(initial, max_depth=4, exploration=0.25, seed=17)
        children = []
        for name, reward in (("a", 1), ("b", 0)):
            trace = {**initial, "steps": [name]}
            child, _ = tree.add(tree.root, trace, origin="fixture")
            children.append(child)
            terminal = {**initial, "steps": [name, "finish"], "status": "completed"}
            leaf, added = tree.add(
                child, terminal, origin="fixture", grading={"reward": reward, "complete": True}
            )
            self.assertTrue(added)
            self.assertEqual(tree.nodes[leaf]["visits"], 1)
            _, added = tree.add(
                child, terminal, origin="duplicate", grading={"reward": reward, "complete": True}
            )
            self.assertFalse(added)
        self.assertEqual(tree.nodes[tree.root]["visits"], 2)
        self.assertEqual(tree.select(tree.root, 0)[0], children[0])
        unseen, _ = tree.add(tree.root, {**initial, "steps": ["unseen"]}, origin="fixture")
        self.assertEqual(tree.select(tree.root, 0)[0], unseen)
        self.assertIsNone(tree.select(tree.root, 0)[1]["uct"][unseen])
        tree.nodes[unseen]["closed"] = True
        tree.nodes[children[0]]["closed"] = True
        self.assertEqual(tree.select(tree.root, 1)[0], children[1])
        self.assertEqual(tree.select(tree.root, 1), tree.select(tree.root, 1))

    def test_depth_exhaustion_stays_unknown_and_does_not_backpropagate(self):
        initial = {"environment_id": "env", "steps": [], "status": "incomplete"}
        tree = RetailTree(initial, max_depth=1, exploration=0.25, seed=17)
        child, _ = tree.add(
            tree.root,
            {**initial, "steps": ["read"]},
            origin="fixture",
            grading={"reward": None, "complete": False},
        )
        tree.nodes[tree.root]["expanded"] = True
        tree.close(child)
        self.assertTrue(tree.nodes[tree.root]["closed"])
        self.assertEqual(tree.nodes[tree.root]["visits"], 0)
        self.assertIsNone(tree.nodes[child]["grading"]["reward"])
        with self.assertRaisesRegex(ValueError, "closed"):
            tree.select(tree.root, 0)


@unittest.skipUnless(TAU_SOURCE and importlib.util.find_spec("tau2"), "requires pinned Tau2")
class AgentRFixture(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.backend = load_backend(TAU_SOURCE)
        data = database()
        data["orders"]["#G200"] = {**copy.deepcopy(data["orders"]["#G100"]), "order_id": "#G200"}
        data["users"]["gear_alex"]["orders"].append("#G200")
        fixture = source_fixture.NativeRetailTests()
        fixture.backend = self.backend
        generation = fixture.config(
            database=data,
            observations=[
                observation(
                    "source", environment=RetailSession(self.backend, data, "gear_alex").identity
                )
            ],
        )
        result = asyncio.run(
            RetailGenerator(
                self.root / "reference", TAU_SOURCE, generation, FixtureCalls()
            ).generate()
        )
        self.reference = read_json(self.root / "reference/reference.json")
        self.source_config = {
            "schema_version": 1,
            "partition": "train",
            "family": "retail-train",
            "database": data,
            "user_id": "gear_alex",
            "task": result["task"],
            "reference": self.reference,
            "model": "explicit-fixture",
            "effort": "low",
            "harness": EXPLORER_PROMPT,
            "max_steps": 8,
            "max_calls": 24,
            "sample_id": "actual-wrong-write",
            "attempt": 0,
        }
        steps = copy.deepcopy(self.reference["steps"])
        steps[3]["action"]["arguments"]["order_id"] = "#G200"
        source = RetailCollector(
            self.root / "source", TAU_SOURCE, self.source_config, SolverCalls(steps, policy=False)
        )
        self.source = asyncio.run(source.collect())
        self.assertFalse(self.source["observation"]["record"]["passed"])
        self.config = {
            "schema_version": 1,
            "partition": "train",
            "family": "retail-train",
            "source_workspace": str(self.root / "source"),
            "policy_id": self.source["observation"]["record"]["policy_id"],
            "iterations": 1,
            "branch_samples": 2,
            "exploration": 0.25,
            "seed": 17,
            "max_calls": 100,
        }

    def generate(self, *, calls=None, directory="agentr", config=None):
        calls = calls or AgentRCalls(self.reference["steps"])
        caller = RetailAgentR(self.root / directory, TAU_SOURCE, config or self.config, calls)
        return calls, asyncio.run(caller.generate())


class AgentRExecutionTests(AgentRFixture):
    def test_late_critic_boundary_still_restores_common_ancestor(self):
        calls = AgentRCalls(self.reference["steps"])
        calls.boundary_at = 4
        _, result = self.generate(calls=calls)
        self.assertEqual(result["status"], "ready")
        root = self.root / "agentr"
        self.assertEqual(read_json(root / "boundary.json")["through_step"], 5)
        self.assertEqual(read_json(root / "rollback.json")["before"]["steps"], 5)
        self.assertEqual(read_json(root / "rollback.json")["after"]["steps"], 3)
        self.assertEqual(read_json(root / "repair/context.json")["restored_steps"], 3)

    def test_search_revisits_tree_and_stops_when_all_branches_close(self):
        _, result = self.generate(config={**self.config, "iterations": 4})
        self.assertEqual(result["status"], "ready")
        tree = read_json(self.root / "agentr/tree.json")
        self.assertEqual(tree["stop"], "exhausted")
        self.assertGreater(len(tree["iterations"]), 1)
        self.assertLess(len(tree["iterations"]), 4)
        self.assertTrue(tree["nodes"][tree["root"]]["closed"])
        self.assertTrue(all(node["closed"] for node in tree["nodes"].values()))

    def test_actual_wrong_write_is_undone_before_fresh_suffix_and_semantic_mask(self):
        calls, result = self.generate()
        root = self.root / "agentr"
        self.assertEqual(result["status"], "ready")
        self.assertFalse(result["training_eligible"])
        self.assertFalse(result["effect_verified"])
        self.assertEqual(read_json(root / "pair.json")["common_steps"], 3)
        self.assertEqual(read_json(root / "boundary.json")["through_step"], 4)
        proof = read_json(root / "rollback.json")
        self.assertNotEqual(proof["before"]["database_digest"], proof["after"]["database_digest"])
        source = read_json(self.root / "source/trajectory.json")
        self.assertEqual(source["final"]["orders"]["#G200"]["status"], "cancelled")
        checkpoint = read_json(root / "repair/checkpoint.json")
        self.assertEqual(checkpoint["final"]["orders"]["#G200"]["status"], "pending")
        trace = read_json(root / "repair/trajectory.json")
        self.assertEqual(trace["final"]["orders"]["#G100"]["status"], "cancelled")
        self.assertEqual(trace["final"]["orders"]["#G200"]["status"], "pending")
        self.assertEqual(read_json(root / "repair/grading.json")["native"]["reward"], 1)
        proposal = read_json(root / "repair/supervision.json")
        self.assertEqual(
            [(row["start_step"], row["stop_step"], row["loss"]) for row in proposal["spans"]],
            [(0, 3, False), (3, 5, True)],
        )
        self.assertEqual(proposal["material_protocols"], ["feedback_only"])
        self.assertTrue(
            all(
                row["trajectory_ref"]["path"] == "repair/trajectory.json"
                for row in proposal["spans"]
            )
        )
        self.assertIn("repair/3/action", calls.submissions)
        tree = read_json(root / "tree.json")
        completed = [
            node
            for node in tree["nodes"].values()
            if node["grading"] is not None and node["grading"]["complete"]
        ]
        self.assertEqual(tree["nodes"][tree["root"]]["visits"], len(completed))
        self.assertTrue(
            any(
                sample["duplicate"]
                for path in (root / "expansions").glob("*.json")
                for sample in read_json(path)["samples"]
            )
        )
        self.assertEqual(result["model_usage"]["logical_calls"], len(calls.submissions))

    def test_actor_and_critic_see_only_public_material_and_fixed_model(self):
        calls, _ = self.generate()
        for key, (request, _) in calls.receipts.items():
            data = json.loads(request[0])
            self.assertEqual(request[2]["model"], self.source_config["model"])
            self.assertEqual(request[2]["effort"], self.source_config["effort"])
            if key.endswith("/action"):
                expected = {"policy", "tools", "conversation"}
                if key.startswith("repair/"):
                    expected.add("repair")
                    self.assertEqual(
                        set(data["repair"]),
                        {"failed_conversation", "critic", "restored_steps", "reset_mechanism"},
                    )
                self.assertEqual(set(data), expected)
                self.assertNotIn("evaluation_criteria", request[0])
                self.assertNotIn("user_scenario", request[0])
                self.assertNotIn("good_branch", request[0])
            elif key.startswith("critic/"):
                self.assertEqual(
                    set(data), {"policy", "conversation", "step_index", "task_outcome"}
                )
                self.assertEqual(data["step_index"], 3)
            elif key.endswith("/user"):
                self.assertEqual(set(data), {"goal", "customer", "conversation"})
                self.assertTrue(
                    all(
                        row["role"] in ("user", "assistant") and set(row) == {"role", "content"}
                        for row in data["conversation"]
                    )
                )

    def test_restore_rejects_changed_feedback_state_and_nonprefix_rollback(self):
        trace = read_json(self.root / "source/trajectory.json")
        bad = copy.deepcopy(trace["steps"])
        bad[3]["execution"]["after"] = "tampered"
        with self.assertRaisesRegex(ValueError, "checkpoint"):
            restore(self.backend, self.source_config, bad)
        with self.assertRaisesRegex(ValueError, "earlier shared prefix"):
            rollback(self.backend, self.source_config, trace["steps"][:4], trace["steps"][1:3])
        with self.assertRaisesRegex(ValueError, "earlier shared prefix"):
            rollback(self.backend, self.source_config, trace["steps"][:3], trace["steps"][:3])

    def test_no_good_path_or_no_proposed_boundary_emits_no_repair(self):
        for mode, boundary, expected in (
            ("no_success", "bad", "no_success"),
            ("success", "uncertain", "no_boundary"),
        ):
            with self.subTest(mode=mode):
                calls, result = self.generate(
                    calls=AgentRCalls(self.reference["steps"], mode=mode, boundary=boundary),
                    directory=mode,
                )
                self.assertEqual(result["status"], expected)
                self.assertIsNone(result["material"])
                self.assertFalse(any(key.startswith("repair/") for key in calls.submissions))

    def test_unsuccessful_and_incomplete_fresh_suffixes_do_not_reuse_tree_success(self):
        for mode, expected in (
            ("repair_failed", "repair_failed"),
            ("repair_incomplete", "incomplete"),
        ):
            with self.subTest(mode=mode):
                _, result = self.generate(
                    calls=AgentRCalls(self.reference["steps"], mode=mode), directory=mode
                )
                self.assertEqual(result["status"], expected)
                self.assertIsNone(result["material"])
                verdict = read_json(self.root / mode / "repair/grading.json")
                self.assertEqual(verdict["reward"], 0 if mode == "repair_failed" else None)
                self.assertFalse((self.root / mode / "repair/supervision.json").exists())

    def test_depth_limited_search_preserves_unknown_leaves(self):
        _, result = self.generate(calls=AgentRCalls(self.reference["steps"], mode="incomplete"))
        self.assertEqual(result["status"], "no_success")
        tree = read_json(self.root / "agentr/tree.json")
        unknown = [
            node
            for node in tree["nodes"].values()
            if node["closed"] and node["trace"]["status"] != "completed"
        ]
        self.assertTrue(unknown)
        self.assertTrue(all(node["grading"]["reward"] is None for node in unknown))
        self.assertEqual(tree["nodes"][tree["root"]]["visits"], 1)


class AgentRRecoveryTests(AgentRFixture):
    def test_paid_response_loss_resumes_without_duplicate_submission(self):
        calls = AgentRCalls(self.reference["steps"])
        calls.interrupt_key = "repair/3/action"
        with self.assertRaisesRegex(OSError, "lost completed"):
            self.generate(calls=calls)
        completed = set(calls.submissions)
        self.assertFalse((self.root / "agentr/result.json").exists())
        _, result = self.generate(calls=calls)
        self.assertEqual(result["status"], "ready")
        self.assertEqual(len(calls.submissions), len(set(calls.submissions)))
        self.assertTrue(completed.issubset(calls.submissions))
        before = list(calls.submissions)
        _, resumed = self.generate(calls=calls)
        self.assertEqual(result, resumed)
        self.assertEqual(before, calls.submissions)
        self.assertEqual(asyncio.run(replay_generated(self.root / "agentr", TAU_SOURCE)), result)

    def test_unknown_result_and_exhausted_quota_are_not_failure_or_zero_reward(self):
        calls = AgentRCalls(self.reference["steps"])
        calls.unknown_key = "repair/3/action"
        with self.assertRaisesRegex(RuntimeError, "incomplete or unknown"):
            self.generate(calls=calls)
        self.assertFalse((self.root / "agentr/repair/grading.json").exists())
        self.assertFalse((self.root / "agentr/result.json").exists())
        calls = AgentRCalls(self.reference["steps"], max_calls=1)
        with self.assertRaisesRegex(RuntimeError, "quota"):
            self.generate(calls=calls, directory="quota", config={**self.config, "max_calls": 1})
        self.assertEqual(len(calls.submissions), 1)
        self.assertFalse((self.root / "quota/result.json").exists())

    def test_offline_replay_detects_artifact_request_and_source_tampering(self):
        _, result = self.generate()
        root = self.root / "agentr"
        self.assertEqual(asyncio.run(replay_generated(root, TAU_SOURCE)), result)
        for relative, edit in (
            ("rollback.json", lambda data: data.update(mechanism="fake-reset")),
            (
                "model/repair/3/action.json",
                lambda data: data["input"]["data"].update(private_answer="leak"),
            ),
            ("result.json", lambda data: data.update(training_eligible=True)),
        ):
            path = root / relative
            original = path.read_bytes()
            data = read_json(path)
            edit(data)
            write_json(path, data)
            with self.subTest(relative=relative), self.assertRaisesRegex(ValueError, "changed"):
                asyncio.run(replay_generated(root, TAU_SOURCE))
            path.write_bytes(original)
        path = self.root / "source/trajectory.json"
        data = read_json(path)
        data["final"]["orders"]["#G200"]["status"] = "pending"
        write_json(path, data)
        with self.assertRaisesRegex(ValueError, "changed"):
            asyncio.run(replay_generated(root, TAU_SOURCE))

    def test_private_policy_mismatch_and_unknown_sources_rejected_before_model_calls(self):
        calls = AgentRCalls(self.reference["steps"])
        with self.assertRaisesRegex(ValueError, "declared policy"):
            self.generate(calls=calls, config={**self.config, "policy_id": "another-policy"})
        self.assertEqual(calls.submissions, [])
        for name, changes in (("private", {"partition": "test"}), ("unknown", {"max_steps": 4})):
            source = RetailCollector(
                self.root / name,
                TAU_SOURCE,
                {**self.source_config, **changes},
                SolverCalls(self.reference["steps"]),
            )
            result = asyncio.run(source.collect())
            config = {
                **self.config,
                "source_workspace": str(self.root / name),
                "policy_id": result["observation"]["record"]["policy_id"],
            }
            with (
                self.subTest(name=name),
                self.assertRaisesRegex(ValueError, "training family|complete observed failure"),
            ):
                self.generate(calls=calls, directory="reject-" + name, config=config)
        self.assertEqual(calls.submissions, [])

    def test_cli_preflight_and_offline_replay_never_open_sdk(self):
        config_path = self.root / "config.json"
        write_json(config_path, self.config)
        args = [
            "agentr_retail.py",
            "--input",
            str(config_path),
            "--tau2-source",
            TAU_SOURCE,
            "--workspace",
        ]
        with patch(
            "model_calls.TextCalls.__aenter__", side_effect=AssertionError("SDK must stay closed")
        ):
            with (
                patch.object(sys, "argv", args + [str(self.root / "preflight"), "--preflight"]),
                redirect_stdout(io.StringIO()) as output,
            ):
                main()
            self.assertEqual(
                json.loads(output.getvalue()), {"status": "preflight", "model_calls": 0}
            )
            self.assertFalse((self.root / "preflight/model").exists())
            _, result = self.generate()
            with (
                patch.object(sys, "argv", args + [str(self.root / "agentr"), "--replay"]),
                redirect_stdout(io.StringIO()) as output,
            ):
                main()
            self.assertEqual(json.loads(output.getvalue()), result)


if __name__ == "__main__":
    unittest.main()
