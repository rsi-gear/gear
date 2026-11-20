"""Actual retail exploration and native validation; all LLM responses are fixtures."""

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
from coevolve_retail import RetailCoEvolve, main, replay_generated  # noqa: E402
from ifeval_experiment import read_json  # noqa: E402
from sentinel_collect import RetailCollector  # noqa: E402
from sentinel_generate import EXPLORER_PROMPT  # noqa: E402
from sentinel_pool import build_pool  # noqa: E402
from sentinel_search import search  # noqa: E402
from test_sentinel_collect import SolverCalls  # noqa: E402
from test_sentinel_search import ROOT, TAU_SOURCE, RetailSearchFixture  # noqa: E402


class ExplorationCalls:
    identity = "explicit-coevolve-fixture-v1"

    def __init__(self, steps, *, max_calls=64, novel=True, complete=True):
        self.steps = copy.deepcopy(steps)
        self.max_calls = max_calls
        self.novel = novel
        self.complete = complete
        self.receipts = {}
        self.submissions = []
        self.interrupt = None
        for step in self.steps:
            if step["kind"] == "tool" and step["action"]["name"] == "cancel_pending_order":
                step["action"]["arguments"]["reason"] = "ordered by mistake"

    async def call(self, key, prompt, harness, **settings):
        request = [prompt, harness, settings]
        if key in self.receipts:
            previous, receipt = self.receipts[key]
            if previous != request:
                raise ValueError("fixture input changed")
            return receipt
        if len(self.submissions) >= self.max_calls:
            raise RuntimeError("fixture quota exhausted")
        data = json.loads(prompt)
        if key.endswith("/summarize"):
            response = {
                "summary": "The source shows the recorded outcome on cancellation.",
                "explanation": "Explore the measured signal, without inventing a failure.",
                "objectives": ["Complete a customer cancellation with a different reason."],
                "avoid": ["Finishing before the write is performed."],
            }
        elif key.endswith("/goal"):
            response = {"goal": "Cancel #G100, which Alex ordered by mistake."}
        elif "/user/" in key:
            response = {
                "message": "My email is alex@gear.example. Yes, cancel #G100, ordered by mistake, and refund my original card."
            }
        elif "/explore/" in key:
            index = int(key.rsplit("/", 1)[1])
            step = self.steps[index] if self.complete else self.steps[min(index, 1)]
            action = step.get("action", {"name": "", "arguments": {}})
            response = {
                "kind": step["kind"],
                "name": action["name"],
                "arguments_json": json.dumps(action["arguments"]),
                "text": step.get("text", "").replace("no longer needed", "ordered by mistake"),
            }
            response = {"action": response}
        elif key.endswith("/abstract"):
            assert len(data["explorations"]) == 2
            assert all(row["status"] == "valid" for row in data["explorations"])
            response = {
                "instruction": "I ordered #G100 by mistake. Please cancel it.",
                "user_instructions": "You are Alex, alex@gear.example. Cancel #G100 because you ordered it by mistake. You want the refund to your original card.",
                "run_id": "run-1",
            }
        elif key.endswith("/audit"):
            response = {
                "valid": True,
                "faithful": True,
                "policy_compliant": True,
                "hides_solution": True,
                "novel": self.novel,
                "reason": "Explicit semantic fixture, separate from native execution.",
            }
        else:
            raise AssertionError(key)
        receipt = {
            "status": "completed",
            "response": json.dumps(response),
            "fixture": True,
            "usage": {"total": {"total_tokens": 1}},
        }
        self.receipts[key] = request, receipt
        self.submissions.append(key)
        if self.interrupt and key.endswith(self.interrupt):
            self.interrupt = None
            raise OSError("lost completed response before write execution")
        return receipt


class CoEvolveFixture(RetailSearchFixture):
    def setUp(self):
        super().setUp()
        self.old = self.collect("old", True, harness=EXPLORER_PROMPT + " prior policy")
        self.current = self.collect("current", False)
        self.evolve_config = {
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
            "history": [
                {"workspace": str(self.root / "old"), "iteration": 0},
                {"workspace": str(self.root / "current"), "iteration": 1},
            ],
            "policy_id": self.current["observation"]["record"]["policy_id"],
            "signals": ["forgetting", "boundary", "rare"],
            "signal_config": {
                "history_window": 5,
                "boundary_threshold": 0.5,
                "rare_frequency": 0.05,
                "minimum_patterns": 20,
            },
            "seed": 23,
            "max_contexts": 1,
            "exploration_runs": 2,
            "max_steps": 8,
            "max_calls": 64,
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

    def generate(self, *, config=None, calls=None, name="evolve", preflight=False):
        calls = calls or ExplorationCalls(self.reference["steps"])
        caller = RetailCoEvolve(self.root / name, TAU_SOURCE, config or self.evolve_config, calls)
        return asyncio.run(caller.generate(preflight=preflight))

    def evolved_pool(self, result):
        config = {
            **self.pool_config,
            "generated": [
                {
                    "recipe": "coevolve",
                    "workspace": str(self.root / "evolve"),
                    "draft_id": result["selected"][0],
                }
            ],
        }
        return asyncio.run(build_pool(self.root / "evolved-pool", TAU_SOURCE, config))


class CoEvolveTests(CoEvolveFixture):
    def test_forgetting_full_trace_multi_run_abstraction_and_native_validation(self):
        calls = ExplorationCalls(self.reference["steps"])
        result = self.generate(calls=calls)
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["model_usage"]["completed_calls"], 19)
        self.assertEqual(result["model_usage"]["tokens"], 19)
        candidate = result["candidates"][0]
        self.assertEqual(candidate["signal"]["signals"], ["forgetting"])
        self.assertEqual(candidate["draft"]["plan"]["conditioning"], "signal")
        self.assertEqual(candidate["draft"]["reference"]["run_id"], "run-1")
        source = json.loads(calls.receipts["contexts/0/summarize"][0][0])
        self.assertEqual(source["trajectory"], read_json(self.root / "current/trajectory.json"))
        runs = read_json(self.root / "evolve/contexts/0/explorations.json")
        self.assertEqual([row["status"] for row in runs], ["valid", "valid"])
        for row in runs:
            self.assertEqual(row["trajectory"]["initial"]["orders"]["#G100"]["status"], "pending")
            self.assertEqual(row["trajectory"]["final"]["orders"]["#G100"]["status"], "cancelled")
            self.assertEqual(
                len(row["trajectory"]["final"]["orders"]["#G100"]["payment_history"]), 2
            )
        calibration = read_json(self.root / "evolve/contexts/0/calibration.json")
        self.assertEqual(
            [calibration[key]["reward"] for key in ("reference", "no_actions", "missing_writes")],
            [1, 0, 0],
        )
        self.assertFalse(result["training_eligible"])
        self.assertEqual(self.evolved_pool(result)["status"], "ready")

    def test_boundary_ablation_keeps_success_without_relabelling(self):
        success = self.collect("current-success", True)
        self.assertEqual(
            success["observation"]["record"]["policy_id"], self.evolve_config["policy_id"]
        )
        config = copy.deepcopy(self.evolve_config)
        config["history"].append({"workspace": str(self.root / "current-success"), "iteration": 1})
        config["signals"] = ["boundary"]
        # Even when rare signals would also fire, ablation must remove their
        # pattern annotation from the model-visible selected signal.
        config["signal_config"].update(minimum_patterns=1, rare_frequency=0.9)
        self.generate(config=config, preflight=True)
        signals = read_json(self.root / "evolve/signals.json")
        self.assertEqual(len(signals["eligible"]), 2)
        self.assertTrue(all(row["signals"] == ["boundary"] for row in signals["eligible"]))
        self.assertTrue(all(row["rare_patterns"] == [] for row in signals["eligible"]))
        self.assertEqual(
            {row["case"]["outcome"] for row in signals["observations"]}, {"success", "failure"}
        )
        # Across different iterations, opposite outcomes do not form a rollout group.
        config["history"][-1]["iteration"] = 2
        self.generate(config=config, preflight=True, name="separate")
        self.assertEqual(read_json(self.root / "separate/signals.json")["eligible"], [])

    def test_rare_success_uses_observed_patterns_and_enters_signal_generation(self):
        # The old complete failure authenticates and reads, but never performs a write.
        self.collect("read-only", True, harness=EXPLORER_PROMPT + " earlier", task=self.fixed_task)
        config = copy.deepcopy(self.evolve_config)
        # A current success contributes one new tool pattern.
        source_config = read_json(self.root / "read-only/input.json")["config"]
        source_config.update(sample_id="read-failure")
        steps = self.reference["steps"][:2] + [{"kind": "finish", "text": "I found your order."}]
        asyncio.run(
            RetailCollector(
                self.root / "read-failure", TAU_SOURCE, source_config, SolverCalls(steps)
            ).collect()
        )
        current = self.collect("rare-success", True)
        config["policy_id"] = current["observation"]["record"]["policy_id"]
        config["history"] = [
            {"workspace": str(self.root / "read-failure"), "iteration": 0},
            {"workspace": str(self.root / "rare-success"), "iteration": 1},
        ]
        config["signals"] = ["rare"]
        config["signal_config"].update(minimum_patterns=1, rare_frequency=0.3)
        calls = ExplorationCalls(self.reference["steps"])
        result = self.generate(config=config, calls=calls)
        self.assertEqual(result["status"], "ready")
        signal = result["candidates"][0]["signal"]
        self.assertEqual(signal["signals"], ["rare"])
        self.assertEqual(signal["rare_patterns"], ["cancel_pending_order"])
        summarized = json.loads(calls.receipts["contexts/0/summarize"][0][0])
        self.assertIs(summarized["source"]["record"]["passed"], True)
        abstracted = json.loads(calls.receipts["contexts/0/abstract"][0][0])
        self.assertEqual(abstracted["cases"][0]["outcome"], "success")

    def test_unknown_and_absent_signals_do_not_trigger_model_calls(self):
        partial = self.collect("partial", True, max_steps=1)
        config = copy.deepcopy(self.evolve_config)
        config["history"][-1]["workspace"] = str(self.root / "partial")
        config["policy_id"] = partial["observation"]["record"]["policy_id"]
        calls = ExplorationCalls(self.reference["steps"])
        result = self.generate(config=config, calls=calls)
        self.assertEqual(result["status"], "no_signals")
        self.assertEqual(calls.submissions, [])
        observations = read_json(self.root / "evolve/signals.json")["observations"]
        self.assertIsNone(observations[-1]["score"])
        config = {**self.evolve_config, "signals": ["rare"]}
        self.assertEqual(
            self.generate(config=config, calls=calls, name="no-rare")["status"], "no_signals"
        )

    def test_preflight_and_replay_use_no_sdk_and_preserve_source_artifacts(self):
        calls = ExplorationCalls(self.reference["steps"])
        before = {
            path: path.read_bytes()
            for name in ("old", "current")
            for path in (self.root / name).rglob("*.json")
        }
        with patch.dict(sys.modules, {"openai_codex": None}):
            self.assertEqual(self.generate(calls=calls, preflight=True)["model_calls"], 0)
            self.assertEqual(calls.submissions, [])
            result = self.generate(calls=calls)
            submissions = calls.submissions.copy()
            bundle = asyncio.run(
                replay_generated(self.root / "evolve", TAU_SOURCE, result["selected"][0])
            )
        self.assertEqual(bundle["task"], result["candidates"][0]["task"])
        self.assertEqual(calls.submissions, submissions)
        self.assertEqual(before, {path: path.read_bytes() for path in before})

    def test_cli_preflight_and_invalid_configuration_submit_nothing(self):
        path = self.root / "coevolve-input.json"
        path.write_text(json.dumps(self.evolve_config))
        output = io.StringIO()
        with (
            patch.dict(sys.modules, {"openai_codex": None}),
            patch.object(
                sys,
                "argv",
                [
                    "coevolve_retail.py",
                    "--input",
                    str(path),
                    "--workspace",
                    str(self.root / "cli"),
                    "--tau2-source",
                    TAU_SOURCE,
                    "--preflight",
                ],
            ),
            redirect_stdout(output),
        ):
            main()
        self.assertEqual(
            json.loads(output.getvalue()), {"status": "preflight", "contexts": 1, "model_calls": 0}
        )
        self.assertEqual(list((self.root / "cli/calls").rglob("pending.json")), [])
        variants = {
            "partition": {"partition": "test"},
            "policy": {"policy_id": "unobserved-policy"},
            "signals": {"signals": ["invented-signal"]},
            "chronology": {"history": list(reversed(self.evolve_config["history"]))},
            "quota": {"max_calls": 1},
            "steps": {"max_steps": 0},
        }
        for name, changes in variants.items():
            calls = ExplorationCalls(self.reference["steps"])
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.generate(
                    config={**self.evolve_config, **changes}, calls=calls, name="invalid-" + name
                )
            self.assertEqual(calls.submissions, [])

    def test_duplicate_sample_is_not_counted_and_changed_group_is_rejected(self):
        config = copy.deepcopy(self.evolve_config)
        config["history"].append(copy.deepcopy(config["history"][-1]))
        self.generate(config=config, preflight=True)
        self.assertEqual(len(read_json(self.root / "evolve/history.json")), 2)
        config["history"][-1]["iteration"] = 2
        with self.assertRaisesRegex(ValueError, "historical sample"):
            self.generate(config=config, preflight=True, name="changed-group")
        config = copy.deepcopy(self.evolve_config)
        config["history"][0]["iteration"] = 1
        with self.assertRaisesRegex(ValueError, "one fixed solver policy"):
            self.generate(config=config, preflight=True, name="mixed-policy")

    def test_source_receipts_scores_scope_and_tool_observations_are_replayed(self):
        files = {path: path.read_bytes() for path in (self.root / "current").rglob("*.json")}
        for change in ("request", "missing", "passed", "trace", "grading", "partition"):
            with self.subTest(change=change):
                if change in ("request", "missing"):
                    path = self.root / "current/model/solve/0.json"
                    if change == "missing":
                        path.unlink()
                    else:
                        value = read_json(path)
                        value["input"]["prompt"] += " changed"
                        path.write_text(json.dumps(value))
                else:
                    name = {
                        "passed": "result",
                        "trace": "trajectory",
                        "grading": "grading",
                        "partition": "input",
                    }[change]
                    path = self.root / f"current/{name}.json"
                    value = read_json(path)
                    if change == "passed":
                        value["observation"]["record"]["passed"] = True
                    elif change == "trace":
                        value["final"]["orders"]["#G100"]["status"] = "cancelled"
                    elif change == "grading":
                        value["native"]["reward"] = 1
                    else:
                        value["config"]["partition"] = "test"
                    path.write_text(json.dumps(value))
                calls = ExplorationCalls(self.reference["steps"])
                with self.assertRaises(ValueError):
                    self.generate(calls=calls, name=change)
                self.assertEqual(calls.submissions, [])
                for path, raw in files.items():
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(raw)

    def test_recovery_reuses_paid_receipts_and_does_not_repeat_refund(self):
        calls = ExplorationCalls(self.reference["steps"])
        calls.interrupt = "run-0/explore/3"
        with self.assertRaisesRegex(OSError, "lost completed"):
            self.generate(calls=calls)
        self.assertFalse((self.root / "evolve/result.json").exists())
        result = self.generate(calls=calls)
        self.assertEqual(len(calls.submissions), 19)
        (self.root / "evolve/result.json").unlink()
        self.assertEqual(result, self.generate(calls=calls))
        self.assertEqual(len(calls.submissions), 19)
        trace = read_json(self.root / "evolve/contexts/0/reference.json")
        self.assertEqual(len(trace["final"]["orders"]["#G100"]["payment_history"]), 2)

    def test_incomplete_exploration_rejection_and_quota_are_not_task_successes(self):
        calls = ExplorationCalls(self.reference["steps"], complete=False)
        result = self.generate(calls=calls)
        self.assertEqual(result["selected"], [])
        self.assertEqual(result["candidates"][0]["status"], "invalid_references")
        self.assertFalse(any(key.endswith("/abstract") for key in calls.submissions))
        result = self.generate(
            calls=ExplorationCalls(self.reference["steps"], novel=False), name="semantic-reject"
        )
        self.assertEqual(result["status"], "rejected")
        config = {**self.evolve_config, "max_calls": 1}
        calls = ExplorationCalls(self.reference["steps"], max_calls=1)
        with self.assertRaisesRegex(RuntimeError, "quota"):
            self.generate(config=config, calls=calls, name="quota")
        self.assertEqual(len(calls.submissions), 1)
        self.assertFalse((self.root / "quota/result.json").exists())

    def test_generated_evidence_tampering_is_rejected_before_pool_admission(self):
        result = self.generate()
        files = {path: path.read_bytes() for path in (self.root / "evolve").rglob("*.json")}
        for name in (
            "signals",
            "contexts/0/reference",
            "contexts/0/calibration",
            "contexts/0/validation-evidence",
            "result",
        ):
            with self.subTest(name=name):
                path = self.root / f"evolve/{name}.json"
                value = read_json(path)
                value["tampered"] = True
                path.write_text(json.dumps(value))
                with self.assertRaises(ValueError):
                    asyncio.run(
                        replay_generated(self.root / "evolve", TAU_SOURCE, result["selected"][0])
                    )
                for path, raw in files.items():
                    path.write_bytes(raw)
        self.assertEqual(self.evolved_pool(result)["status"], "ready")


@unittest.skipUnless(
    os.environ.get("GEAR_TEST_SENTINEL_RUNTIME") == "1", "requires built Gear CLI/worker"
)
class CoEvolveRuntimeTests(CoEvolveFixture):
    def test_generated_task_enters_formal_search_and_next_policy_history(self):
        generated = self.generate()
        pool = self.evolved_pool(generated)
        self.assertEqual(pool["requested"], {"fixed": 1, "generated": 1})
        self.assertEqual(pool["selected"][1]["provenance"]["recipe"], "coevolve-retail-v1")
        config = {**self.config, "pool_workspace": str(self.root / "evolved-pool")}
        with patch.dict(
            os.environ,
            {
                "GEAR_PROFILE_ROOT": str(self.root / "profiles"),
                "GEAR_PYTHON": sys.executable,
                "GEAR_COMMAND": json.dumps(["node", str(ROOT / "lib/cli.js")]),
                "PYTHONPATH": str(ROOT / "python"),
            },
        ):
            result = asyncio.run(
                search(
                    self.root / "search",
                    TAU_SOURCE,
                    config,
                    provider_script=ROOT / "python/tests/fixtures/sentinel_provider.py",
                )
            )
        self.assertIn("SOLVE_WITH_TOOLS", result["harness"])
        self.assertEqual([row["status"] for row in result["constraints"]], ["reject", "allow"])
        self.assertFalse(result["test_opened"])
        following = self.collect("following", True, harness=result["harness"])
        config = copy.deepcopy(self.evolve_config)
        config["history"].append({"workspace": str(self.root / "following"), "iteration": 2})
        config["policy_id"] = following["observation"]["record"]["policy_id"]
        self.assertNotEqual(config["policy_id"], self.evolve_config["policy_id"])
        calls = ExplorationCalls(self.reference["steps"])
        self.assertEqual(
            self.generate(config=config, calls=calls, name="following-evolution")["status"],
            "no_signals",
        )
        self.assertEqual(calls.submissions, [])


if __name__ == "__main__":
    unittest.main()
