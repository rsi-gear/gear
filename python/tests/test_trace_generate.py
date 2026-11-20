"""Actual source replay and isolated generated environments; model outputs are fixtures."""

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
from fixtures.trace_calls import TraceCalls  # noqa: E402
from ifeval_experiment import read_json  # noqa: E402
from sentinel_collect import RetailCollector  # noqa: E402
from sentinel_generate import EXPLORER_PROMPT  # noqa: E402
from test_sentinel_collect import SolverCalls  # noqa: E402
from test_sentinel_search import TAU_SOURCE, RetailSearchFixture  # noqa: E402
from test_trace_calibrate import THRESHOLDS  # noqa: E402
from trace_generate import TraceGenerator, main, replay_generated  # noqa: E402

IMAGE = os.environ.get("GEAR_TRACE_PYTHON_IMAGE")


@unittest.skipUnless(IMAGE, "requires an explicit local CPU Python Docker image ID")
class TraceGenerationTests(RetailSearchFixture):
    def setUp(self):
        super().setUp()
        success = self.collect("success", True)
        self.collect("failure", False)
        self.trace_config = {
            "schema_version": 1,
            "partition": "train",
            "family": self.generation_config["family"],
            "source_workspaces": [str(self.root / name) for name in ("success", "failure")],
            "policy_id": success["observation"]["record"]["policy_id"],
            "capability_parameters": {
                "max_capabilities": 2,
                "coverage_threshold": 0.1,
                "gap_threshold": 0.2,
                "minimum_consistent_runs": 2,
            },
            "labeling_runs": 2,
            "generator": {"model": "explicit-fixture", "effort": "low"},
            "solver": {
                "model": "explicit-fixture",
                "effort": "low",
                "harness": EXPLORER_PROMPT,
                "max_steps": 8,
            },
            "image": IMAGE,
            "seeds": [17, 18],
            "group_size": 2,
            "thresholds": copy.deepcopy(THRESHOLDS),
            "max_calls": 64,
            "max_revisions": 0,
        }

    def collect(self, name, passed, **overrides):
        config = {
            **{
                key: self.generation_config[key]
                for key in (
                    "schema_version",
                    "partition",
                    "family",
                    "database",
                    "user_id",
                    "model",
                    "effort",
                )
            },
            "task": self.fixed_task,
            "reference": self.reference,
            "harness": EXPLORER_PROMPT,
            "max_steps": 8,
            "max_calls": 24,
            "sample_id": name,
            "attempt": 0,
            **overrides,
        }
        steps = (
            self.reference["steps"]
            if passed
            else [{"kind": "finish", "text": "I would verify your account."}]
        )
        return asyncio.run(
            RetailCollector(self.root / name, TAU_SOURCE, config, SolverCalls(steps)).collect()
        )

    def generate(self, *, calls=None, config=None, name="trace", preflight=False):
        generator = TraceGenerator(
            self.root / name, TAU_SOURCE, config or self.trace_config, calls or TraceCalls()
        )
        return asyncio.run(generator.generate(preflight=preflight))

    def test_full_contrast_environment_rollout_calibration_recovery_and_offline_replay(self):
        calls = TraceCalls()
        calls.interrupt_key = "candidates/0/samples/17/0/solve/2"
        with self.assertRaisesRegex(OSError, "lost completed"):
            self.generate(calls=calls)
        self.assertFalse((self.root / "trace/result.json").exists())
        result = self.generate(calls=calls)
        self.assertEqual(result["status"], "ready")
        self.assertEqual(len(result["selected"]), 1)
        self.assertFalse(result["training_eligible"])
        self.assertEqual(result["model_usage"]["completed_calls"], 15)
        self.assertEqual(result["model_usage"]["tokens"], 15)
        self.assertEqual(len(calls.submissions), 15)
        attempt = result["attempts"][0]
        self.assertEqual(attempt["draft"]["plan"]["kind"], "environment")
        self.assertEqual(attempt["calibration"]["status"], "ready")
        self.assertEqual(attempt["calibration"]["metrics"]["success_rate"], 0.5)
        self.assertEqual(attempt["calibration"]["metrics"]["pass_at_k"], {"1": 1, "2": 1})
        self.assertNotEqual(result["source_policy_id"], attempt["calibration_policy_id"])
        discover = json.loads(calls.receipts["discover"][0][0])
        self.assertEqual(
            set(discover["trajectories"]), {row["case_id"] for row in discover["cases"]}
        )
        labels = [json.loads(calls.receipts[f"label-{index}"][0][0]) for index in range(2)]
        self.assertEqual(labels[0]["capabilities"], labels[1]["capabilities"])
        self.assertNotIn("labels", labels[1])
        assessment = read_json(self.root / "trace/assessments.json")[0]
        self.assertEqual(assessment["passing_runs"], 2)
        self.assertEqual(assessment["mean_gap"], 1)
        with patch(
            "model_calls.TextCalls.__aenter__",
            side_effect=AssertionError("replay must not open SDK"),
        ):
            replayed = asyncio.run(replay_generated(self.root / "trace", TAU_SOURCE))
        self.assertEqual(replayed, result)
        self.assertEqual(len(calls.submissions), 15)
        # Replaying from the saved proposal must also detect changed executable
        # bytes in the original artifact, not only recomputed JSON summaries.
        path = self.root / "trace/candidates/0/environment/environment.py"
        path.write_text(path.read_text() + "\n# changed executable artifact\n")
        with self.assertRaisesRegex(ValueError, "artifacts changed.*environment.py"):
            asyncio.run(replay_generated(self.root / "trace", TAU_SOURCE))

    def test_invalid_code_has_bounded_revision_with_execution_feedback(self):
        calls = TraceCalls(code_prefixes=("raise ValueError('explicit broken generation')\n", ""))
        result = self.generate(calls=calls, config={**self.trace_config, "max_revisions": 1})
        self.assertEqual(
            [row["status"] for row in result["attempts"]], ["invalid_environment", "ready"]
        )
        self.assertIn("explicit broken generation", result["attempts"][0]["reason"])
        request = json.loads(calls.receipts["candidates/1/generate"][0][0])
        self.assertEqual(request["previous_attempts"], result["attempts"][:1])
        self.assertEqual(len(calls.submissions), 16)
        self.assertNotIn("candidates/0/audit", calls.submissions)

    def test_semantic_rejection_prevents_solver_spend_and_duplicate_code_is_not_retested(self):
        calls = TraceCalls(novel=False)
        result = self.generate(calls=calls, config={**self.trace_config, "max_revisions": 1})
        self.assertEqual(result["status"], "rejected")
        self.assertEqual(
            [row["status"] for row in result["attempts"]], ["semantic_rejection", "duplicate"]
        )
        self.assertFalse(any("/samples/" in key for key in calls.submissions))
        self.assertEqual(len(calls.submissions), 6)
        self.assertEqual(result["selected"], [])

    def test_easy_environment_fails_actual_calibration_and_unknown_api_is_not_rejection(self):
        calls = TraceCalls(passed=True)
        result = self.generate(calls=calls)
        self.assertEqual(result["status"], "rejected")
        self.assertEqual(result["attempts"][0]["calibration"]["metrics"]["success_rate"], 1)
        self.assertEqual(result["selected"], [])
        unknown = TraceCalls()
        unknown.unknown_key = "candidates/0/samples/17/0/solve/0"
        with self.assertRaisesRegex(RuntimeError, "incomplete or unknown"):
            self.generate(calls=unknown, name="unknown")
        self.assertFalse((self.root / "unknown/result.json").exists())
        self.assertFalse((self.root / "unknown/candidates/0/calibration.json").exists())

    def test_source_scope_changed_evidence_and_solver_mismatch_fail_before_models(self):
        for change in (
            {"policy_id": "different"},
            {"family": "different"},
            {"solver": {**self.trace_config["solver"], "harness": "different"}},
        ):
            calls = TraceCalls()
            with self.assertRaises(ValueError):
                self.generate(
                    calls=calls,
                    config={**self.trace_config, **change},
                    name="scope-" + next(iter(change)),
                )
            self.assertEqual(calls.submissions, [])
        path = self.root / "failure/trajectory.json"
        value = read_json(path)
        value["final"]["orders"]["#G100"]["status"] = "cancelled"
        path.write_text(json.dumps(value))
        calls = TraceCalls()
        with self.assertRaisesRegex(ValueError, "execution or grading changed"):
            self.generate(calls=calls)
        self.assertEqual(calls.submissions, [])

    def test_missing_contrast_stops_before_generation_and_cli_preflight_never_opens_sdk(self):
        calls = TraceCalls()
        config = {**self.trace_config, "source_workspaces": [str(self.root / "success")] * 2}
        result = self.generate(calls=calls, config=config)
        self.assertEqual(result["status"], "no_contrast")
        self.assertEqual(result["model_usage"]["completed_calls"], 0)
        input_path = self.root / "trace-input.json"
        input_path.write_text(json.dumps(self.trace_config))
        output = io.StringIO()
        argv = [
            "trace_generate.py",
            "--input",
            str(input_path),
            "--workspace",
            str(self.root / "preflight"),
            "--tau2-source",
            TAU_SOURCE,
            "--preflight",
        ]
        with (
            patch.object(sys, "argv", argv),
            patch(
                "model_calls.TextCalls.__aenter__",
                side_effect=AssertionError("preflight must not open SDK"),
            ),
            redirect_stdout(output),
        ):
            main()
        self.assertEqual(
            json.loads(output.getvalue()),
            {"status": "preflight", "has_contrast": True, "model_calls": 0},
        )


if __name__ == "__main__":
    unittest.main()
