"""Actual CPU tools and native scores; LLM/embedding responses are named fixtures."""

import asyncio
import copy
import io
import json
import os
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

EXAMPLES = Path(__file__).resolve().parents[2] / "examples/curriculum-harness"
sys.path.insert(0, str(EXAMPLES))
from fixtures.selfdirection_calls import EmbeddingFixture, SelfDirectionCalls  # noqa: E402
from gear.canonical import digest  # noqa: E402
from ifeval_experiment import read_json, write_json  # noqa: E402
from selfdirection_data import public_failure  # noqa: E402
from selfdirection_lessons import MiniLM, checked_vector, lookup  # noqa: E402
from selfdirection_retail import RetailSelfDirection, main, replay_generated  # noqa: E402
from sentinel_collect import RetailCollector  # noqa: E402
from test_agentr_retail import TAU_SOURCE, AgentRFixture  # noqa: E402
from test_sentinel_collect import SolverCalls  # noqa: E402


class LessonLookupTests(unittest.TestCase):
    def test_cosine_threshold_scope_stable_ties_and_same_goal_setting(self):
        embedding = EmbeddingFixture.identity
        scope = {"family": "train"}
        lesson = {
            "goal": "cancel an order",
            "scope": scope,
            "embedding_identity": digest(embedding),
            "vector": [0.6, 0.8],
        }
        lessons = [{**lesson, "lesson_id": name} for name in ("b", "a")]
        result = lookup(
            "return an order",
            [1, 0],
            lessons,
            scope=scope,
            threshold=0.5,
            embedding_identity=embedding,
        )
        self.assertEqual(result["selected"], "a")
        self.assertEqual(result["candidates"][0]["score"], 0.6)
        for threshold, active_scope in ((0.7, scope), (0.5, {"family": "test"}), (1, scope)):
            self.assertIsNone(
                lookup(
                    "return an order",
                    [1, 0],
                    lessons,
                    scope=active_scope,
                    threshold=threshold,
                    embedding_identity=embedding,
                )["selected"]
            )
        self.assertEqual(
            lookup(
                "cancel an order",
                [0.6, 0.8],
                lessons,
                scope=scope,
                threshold=1,
                embedding_identity=embedding,
            )["selected"],
            "a",
        )
        with self.assertRaises(ValueError):
            checked_vector([float("nan"), 0], 2)
        with self.assertRaises(ValueError):
            checked_vector([0, 0], 2)

    def test_compact_failure_marks_omissions_and_excludes_private_trace_fields(self):
        trace = {
            "opening": "visible",
            "goal": "PRIVATE_GOAL",
            "initial": "PRIVATE_DB",
            "steps": [{"kind": "finish", "text": str(i)} for i in range(30)],
        }
        material = public_failure(trace)
        self.assertEqual(material["omitted_steps"], 6)
        self.assertEqual(material["retained_step_indices"], [*range(12), *range(18, 30)])
        self.assertNotIn("PRIVATE", json.dumps(material))

    @unittest.skipUnless(
        os.environ.get("GEAR_SELFDIRECTION_MINILM"),
        "requires explicitly installed CPU MiniLM dependencies and files",
    )
    def test_real_cpu_minilm_repeatability_and_no_silent_truncation(self):
        model = MiniLM(os.environ["GEAR_SELFDIRECTION_MINILM"])
        first = model.encode("Cancel my pending order.")
        second = model.encode("Cancel my pending order.")
        self.assertEqual(first, second)
        other = model.encode("Find a satellite image of a volcano.")
        self.assertLess(sum(a * b for a, b in zip(first["vector"], other["vector"])), 0.8)
        self.assertTrue(
            all(str(p.device) == "cpu" and not p.requires_grad for p in model.model.parameters())
        )
        with self.assertRaisesRegex(ValueError, "no silent truncation"):
            model.encode("word " * 300)


class SelfDirectionTests(AgentRFixture):
    def setUp(self):
        super().setUp()
        self.sd_config = {
            "schema_version": 1,
            "partition": "train",
            "family": "retail-train",
            "policy_id": self.source["observation"]["record"]["policy_id"],
            "source_workspaces": [str(self.root / "source")],
            "previous_workspace": None,
            "threshold": 0.7,
            "min_examples": 8,
            "max_examples": 8,
            "max_calls": 100,
        }

    def run_recipe(self, *, calls=None, name="selfdirection", config=None):
        calls = calls or SelfDirectionCalls(self.reference["steps"])
        caller = RetailSelfDirection(
            self.root / name, TAU_SOURCE, config or self.sd_config, calls, EmbeddingFixture()
        )
        return calls, asyncio.run(caller.run())

    def another_source(
        self, name, *, passed=False, incomplete=False, partition="train", ticket=None
    ):
        config = copy.deepcopy(self.source_config)
        config.update(sample_id=name, partition=partition)
        if ticket is not None:
            config["task"]["ticket"] = ticket
        if incomplete:
            steps = [self.reference["steps"][1]] * config["max_steps"]
        elif passed:
            steps = self.reference["steps"]
        else:
            steps = read_json(self.root / "source/trajectory.json")["steps"]
        result = asyncio.run(
            RetailCollector(
                self.root / name, TAU_SOURCE, config, SolverCalls(steps, policy=passed)
            ).collect()
        )
        return str(self.root / name), result

    def test_generated_qa_native_retry_and_offline_replay(self):
        calls, result = self.run_recipe()
        episode = result["episodes"][0]
        self.assertEqual(episode["route"], "generate")
        self.assertEqual(episode["failure_state"], "resolved")
        self.assertEqual(episode["resolved_by"], episode["lesson_id"])
        self.assertIsNone(episode["fallback"])
        self.assertFalse(result["weights_updated"])
        self.assertFalse(result["effect_verified"])
        root = self.root / "selfdirection/episodes/0"
        trace = read_json(root / "retry/trajectory.json")
        self.assertEqual(trace["final"]["orders"]["#G100"]["status"], "cancelled")
        self.assertEqual(trace["final"]["orders"]["#G200"]["status"], "pending")
        self.assertEqual(read_json(root / "retry/grading.json")["native"]["reward"], 1)
        proposal = read_json(root / "data/supervision.json")
        self.assertEqual(proposal["kind"], "synthetic_procedural")
        self.assertEqual(proposal["label_source"], "synthetic")
        self.assertEqual(proposal["spans"], [])
        self.assertEqual(len(proposal["examples"]), 8)
        self.assertEqual(result["model_usage"]["logical_calls"], len(calls.submissions))
        self.assertEqual(
            sum(row["logical_calls"] for row in result["phase_usage"].values()),
            len(calls.submissions),
        )
        self.assertEqual(
            asyncio.run(replay_generated(self.root / "selfdirection", TAU_SOURCE)), result
        )

    def test_reuse_skips_generation_next_source_has_original_base_and_fresh_state(self):
        second, _ = self.another_source("second")
        calls, result = self.run_recipe(
            config={
                **self.sd_config,
                "source_workspaces": [*self.sd_config["source_workspaces"], second],
            }
        )
        self.assertEqual([row["route"] for row in result["episodes"]], ["generate", "reuse"])
        self.assertEqual(len(result["lessons"]), 1)
        self.assertFalse(any(key.startswith("episodes/1/data/") for key in calls.submissions))
        self.assertEqual(
            read_json(Path(second) / "input.json")["config"]["harness"],
            self.source_config["harness"],
        )
        for index in range(2):
            start = read_json(self.root / f"selfdirection/episodes/{index}/retry/start.json")
            self.assertEqual(
                start["state"]["database_digest"],
                digest(read_json(self.root / "source/trajectory.json")["initial"]),
            )
            self.assertEqual(start["state"]["steps"], 0)

    def test_prior_run_registry_is_replayed_before_reuse_and_drift_is_rejected(self):
        _, prior = self.run_recipe(name="first")
        second, _ = self.another_source("second")
        config = {
            **self.sd_config,
            "previous_workspace": str(self.root / "first"),
            "source_workspaces": [second],
        }
        calls, result = self.run_recipe(config=config)
        self.assertEqual(result["episodes"][0]["route"], "reuse")
        self.assertFalse(any("/data/" in key for key in calls.submissions))
        self.assertEqual(result["lessons"], prior["lessons"])
        self.assertEqual(result["imported_costs"]["model_usage"], prior["model_usage"])
        self.assertEqual(len(result["source_case_ids"]), 2)
        self.assertEqual(
            asyncio.run(replay_generated(self.root / "selfdirection", TAU_SOURCE)), result
        )
        value = read_json(self.root / "first/episodes/0/data/lesson.json")
        value["examples"][0]["answer"] = "Changed without revalidation"
        write_json(self.root / "first/episodes/0/data/lesson.json", value)
        with self.assertRaises(ValueError):
            self.run_recipe(config=config, name="drift")

    def test_low_similarity_routes_to_generation_and_prior_samples_cannot_repeat(self):
        self.run_recipe(name="first")
        second, _ = self.another_source(
            "second", ticket="Please assist with cancellation of my pending purchase."
        )
        calls, result = self.run_recipe(
            config={
                **self.sd_config,
                "source_workspaces": [second],
                "previous_workspace": str(self.root / "first"),
                "threshold": 1,
            }
        )
        self.assertEqual(result["episodes"][0]["route"], "generate")
        # Repeated QAs fail exact novelty and do not create another lesson.
        self.assertIsNone(result["episodes"][0]["lesson_id"])
        self.assertIn("episodes/0/data/generate", calls.submissions)
        with self.assertRaisesRegex(ValueError, "duplicate source"):
            self.run_recipe(
                name="duplicate",
                config={**self.sd_config, "previous_workspace": str(self.root / "first")},
            )

    def test_public_feedback_only_generation_and_scoped_retry_material(self):
        calls, _ = self.run_recipe()
        for key, (request, _) in calls.receipts.items():
            data = json.loads(request[0])
            self.assertEqual(request[2]["model"], self.source_config["model"])
            self.assertEqual(request[2]["effort"], self.source_config["effort"])
            if key.endswith("/generate"):
                self.assertEqual(data["cases"][0]["record"]["feedback"], "wrong_answer")
                self.assertEqual(data["failure_reason"], "wrong_answer")
                self.assertEqual(data["material_protocol"], "feedback_only")
                self.assertNotIn("evaluation_criteria", request[0])
                self.assertNotIn("user_scenario", request[0])
                self.assertNotIn("native", request[0])
                self.assertNotIn(str(self.root), request[0])
            if key.endswith("/action"):
                self.assertEqual(set(data), {"policy", "tools", "conversation", "lesson"})
                self.assertEqual(set(data["lesson"]), {"lesson_id", "examples", "material"})
                self.assertNotIn("rationale", data["lesson"]["examples"][0])

    def test_semantic_unknown_rejection_duplicates_and_minimum_count_never_register(self):
        for mode in ("too_few", "duplicate", "semantic_reject", "semantic_unknown"):
            with self.subTest(mode=mode):
                calls, result = self.run_recipe(
                    name=mode, calls=SelfDirectionCalls(self.reference["steps"], mode=mode)
                )
                self.assertEqual(result["lessons"], [])
                self.assertIsNone(result["episodes"][0]["retry"])
                self.assertEqual(result["episodes"][0]["resolved_by"], "base")
                self.assertFalse(any("/retry/" in key for key in calls.submissions))
        with self.assertRaisesRegex(ValueError, "cover each draft"):
            self.run_recipe(
                name="missing_review",
                calls=SelfDirectionCalls(self.reference["steps"], mode="missing_review"),
            )

    def test_base_fallback_resolution_and_unresolved_failure(self):
        for mode in ("retry_failed", "both_failed"):
            with self.subTest(mode=mode):
                calls, result = self.run_recipe(
                    name=mode, calls=SelfDirectionCalls(self.reference["steps"], mode=mode)
                )
                row = result["episodes"][0]
                self.assertEqual(row["retry"]["reward"], 0)
                self.assertEqual(row["resolved_by"], "base" if mode == "retry_failed" else None)
                self.assertEqual(
                    row["failure_state"], "resolved" if mode == "retry_failed" else "open"
                )
                for key, (request, _) in calls.receipts.items():
                    if "/fallback/" in key and key.endswith("/action"):
                        self.assertEqual(
                            set(json.loads(request[0])), {"policy", "tools", "conversation"}
                        )
                        self.assertNotIn("procedural lesson", request[1])

    def test_incomplete_retry_does_not_trigger_fallback_or_resolve(self):
        calls, result = self.run_recipe(
            calls=SelfDirectionCalls(self.reference["steps"], mode="retry_incomplete")
        )
        row = result["episodes"][0]
        self.assertIsNone(row["retry"]["reward"])
        self.assertIsNone(row["fallback"])
        self.assertEqual(row["failure_state"], "open")
        self.assertFalse(any("/fallback/" in key for key in calls.submissions))

    def test_successful_and_unknown_base_sources_skip_adaptation(self):
        success, _ = self.another_source("success", passed=True)
        unknown, _ = self.another_source("unknown", incomplete=True)
        calls, result = self.run_recipe(
            config={**self.sd_config, "source_workspaces": [success, unknown]}
        )
        self.assertEqual(
            [row["base_outcome"] for row in result["episodes"]], ["success", "unknown"]
        )
        self.assertEqual(calls.submissions, [])
        self.assertEqual(result["lessons"], [])

    def test_completed_calls_survive_interruptions_at_generation_review_and_write(self):
        for key in (
            "episodes/0/data/generate",
            "episodes/0/data/validate",
            "episodes/0/retry/3/action",
        ):
            with self.subTest(key=key):
                calls = SelfDirectionCalls(self.reference["steps"])
                calls.interrupt_key = key
                name = key.rsplit("/", 1)[-1]
                with self.assertRaises(OSError):
                    self.run_recipe(calls=calls, name=name)
                _, result = self.run_recipe(calls=calls, name=name)
                self.assertEqual(result["episodes"][0]["failure_state"], "resolved")
                self.assertEqual(calls.submissions.count(key), 1)
                before = list(calls.submissions)
                self.assertEqual(self.run_recipe(calls=calls, name=name)[1], result)
                self.assertEqual(before, calls.submissions)

    def test_unknown_paid_result_stays_pending_and_budget_exhaustion_never_falls_back(self):
        calls = SelfDirectionCalls(self.reference["steps"])
        calls.unknown_key = "episodes/0/retry/0/action"
        for _ in range(2):
            with self.assertRaisesRegex(RuntimeError, "unknown"):
                self.run_recipe(calls=calls)
        self.assertEqual(calls.submissions.count(calls.unknown_key), 1)
        self.assertFalse(any("/fallback/" in key for key in calls.submissions))
        calls = SelfDirectionCalls(self.reference["steps"], max_calls=2)
        with self.assertRaisesRegex(RuntimeError, "quota exhausted"):
            self.run_recipe(calls=calls, name="budget", config={**self.sd_config, "max_calls": 2})
        self.assertEqual(len(calls.submissions), 2)

    def test_preflight_and_cli_replay_open_no_sdk_and_reject_config_drift(self):
        calls = SelfDirectionCalls(self.reference["steps"])
        caller = RetailSelfDirection(
            self.root / "selfdirection", TAU_SOURCE, self.sd_config, calls, EmbeddingFixture()
        )
        self.assertEqual(asyncio.run(caller.run(preflight=True))["model_calls"], 0)
        self.assertEqual(calls.submissions, [])
        _, result = self.run_recipe(calls=calls)
        path = self.root / "config.json"
        write_json(path, self.sd_config)
        args = [
            "selfdirection_retail.py",
            "--input",
            str(path),
            "--workspace",
            str(self.root / "selfdirection"),
            "--tau2-source",
            TAU_SOURCE,
            "--replay",
        ]
        output = io.StringIO()
        with (
            patch.object(sys, "argv", args),
            patch(
                "selfdirection_retail.TextCalls",
                side_effect=AssertionError("SDK should remain closed"),
            ),
            redirect_stdout(output),
        ):
            main()
        self.assertEqual(json.loads(output.getvalue()), result)
        with self.assertRaises(ValueError):
            self.run_recipe(calls=calls, config={**self.sd_config, "threshold": 0.8})

    def test_foreign_partition_policy_duplicates_and_source_tampering_reject_before_model(self):
        private, _ = self.another_source("private", partition="test")
        for config in (
            {**self.sd_config, "source_workspaces": [private]},
            {**self.sd_config, "policy_id": "another-policy"},
            {**self.sd_config, "source_workspaces": self.sd_config["source_workspaces"] * 2},
        ):
            calls = SelfDirectionCalls(self.reference["steps"])
            with self.assertRaises(ValueError):
                self.run_recipe(calls=calls, name=digest(config)[7:], config=config)
            self.assertEqual(calls.submissions, [])
        trace = read_json(self.root / "source/trajectory.json")
        trace["final"]["orders"]["#G200"]["status"] = "pending"
        write_json(self.root / "source/trajectory.json", trace)
        calls = SelfDirectionCalls(self.reference["steps"])
        with self.assertRaises(ValueError):
            self.run_recipe(calls=calls)
        self.assertEqual(calls.submissions, [])


if __name__ == "__main__":
    unittest.main()
