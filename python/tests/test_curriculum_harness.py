"""Offline checks for the real-LLM example's comparisons and request recovery."""

import asyncio
import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from gear.canonical import digest

SOURCE = Path(__file__).resolve().parents[2] / "examples/curriculum-harness/ifeval_experiment.py"
SPEC = importlib.util.spec_from_file_location("curriculum_harness_example", SOURCE)
example = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(example)


def rows(values):
    return [{"task": {"id": str(index)}, "passed": value} for index, value in enumerate(values)]


class ComparisonTests(unittest.TestCase):
    def test_paired_test_counts_repairs_and_regressions(self):
        result = example.paired_comparison(
            rows([True, False, True, False]), rows([False, True, False, False])
        )
        self.assertEqual((result["wins"], result["losses"]), (2, 1))
        self.assertEqual(result["difference"], 0.25)
        self.assertEqual(result["mcnemar_exact_p"], 1.0)
        self.assertLessEqual(result["paired_bootstrap_95_ci"][0], 0)

    def test_identical_and_all_discordant_results_have_known_exact_statistics(self):
        identical = example.paired_comparison(rows([True, False]), rows([True, False]))
        self.assertEqual(identical["paired_bootstrap_95_ci"], [0, 0])
        self.assertEqual(identical["mcnemar_exact_p"], 1.0)
        all_wins = example.paired_comparison(rows([True] * 6), rows([False] * 6))
        self.assertEqual(all_wins["mcnemar_exact_p"], 0.03125)
        self.assertEqual(all_wins["difference"], 1.0)

    def test_misaligned_test_tasks_are_rejected(self):
        with self.assertRaises(ValueError):
            example.paired_comparison(rows([True, False]), list(reversed(rows([True, False]))))

    def test_repeated_instruction_ids_retain_each_verdict(self):
        benchmark = example.Benchmark.__new__(example.Benchmark)
        benchmark.language_factory = types.SimpleNamespace(seed=None)
        benchmark.verifier_policy = {"language_detection_seed": 0}
        benchmark.descriptions = lambda task: []
        benchmark.evaluation = types.SimpleNamespace(
            InputExample=lambda *args: args,
            test_instruction_following_strict=lambda *args: types.SimpleNamespace(
                follow_all_instructions=False,
                instruction_id_list=["same", "same"],
                follow_instruction_list=[True, False],
            ),
        )
        task = {
            "key": 1,
            "prompt": "example",
            "instruction_id_list": ["same", "same"],
            "kwargs": [{}, {}],
        }
        self.assertEqual(
            benchmark.grade(task, "answer"),
            {
                "passed": False,
                "checks": {"0:same": True, "1:same": False},
            },
        )
        self.assertEqual(benchmark.language_factory.seed, 0)
        benchmark.language_factory.seed = 99
        benchmark.grade(task, "answer")
        self.assertEqual(benchmark.language_factory.seed, 0)


class ProposalTests(unittest.TestCase):
    def test_invalid_candidate_consumes_one_call_and_preserves_current_harness(self):
        for response in ('{"harness":"' + "x" * 1801 + '"}', "not JSON", '{"harness":42}'):
            with self.subTest(response=response[:30]), tempfile.TemporaryDirectory() as directory:
                experiment = example.Experiment.__new__(example.Experiment)
                experiment.root = Path(directory)
                experiment.call = AsyncMock(return_value={"response": response})
                proposal = asyncio.run(experiment.propose("fixed", 0, "current", []))
                self.assertFalse(proposal["valid"])
                self.assertEqual(proposal["harness"], "current")
                experiment.call.assert_awaited_once()
                self.assertEqual(
                    example.read_json(Path(directory) / "fixed/round-0/proposal.json"), proposal
                )

    def test_valid_candidate_is_returned_without_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            experiment = example.Experiment.__new__(example.Experiment)
            experiment.root = Path(directory)
            experiment.call = AsyncMock(return_value={"response": '{"harness":"improved"}'})
            self.assertEqual(
                asyncio.run(experiment.propose("failure", 0, "current", [])),
                {"valid": True, "harness": "improved"},
            )
            experiment.call.assert_awaited_once()


class RequestRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.experiment = example.Experiment.__new__(example.Experiment)
        self.experiment.root = Path(self.directory.name)
        self.experiment.student = "test-model"
        self.experiment.config = {"effort": "low", "max_calls": 1}
        self.experiment.semaphore = asyncio.Semaphore(1)
        self.experiment.client = types.SimpleNamespace(
            thread_start=AsyncMock(), thread_resume=AsyncMock()
        )
        self.request = {
            "key": "request",
            "model": "test-model",
            "effort": "low",
            "harness": example.INITIAL_HARNESS,
            "prompt": "prompt",
        }
        self.call_dir = self.experiment.root / "calls" / digest("request").removeprefix("sha256:")
        sdk = types.ModuleType("openai_codex")
        sdk.ApprovalMode = types.SimpleNamespace(deny_all="deny_all")
        sdk.Sandbox = types.SimpleNamespace(read_only="read_only")
        self.mock_sdk = patch.dict(sys.modules, {"openai_codex": sdk})
        self.mock_sdk.start()
        self.addCleanup(self.mock_sdk.stop)

    def test_completed_response_replays_without_calling_model(self):
        receipt = {"response": "answer", "usage": None}
        example.write_json(
            self.call_dir / "result.json",
            {
                "request": self.request,
                "receipt": receipt,
                "digest": digest(receipt),
            },
        )
        self.assertEqual(asyncio.run(self.experiment.call("request", "prompt")), receipt)
        self.experiment.client.thread_start.assert_not_called()
        with self.assertRaises(ValueError):
            asyncio.run(self.experiment.call("request", "changed prompt"))
        saved = example.read_json(self.call_dir / "result.json")
        saved["receipt"]["response"] = "tampered"
        example.write_json(self.call_dir / "result.json", saved)
        with self.assertRaises(ValueError):
            asyncio.run(self.experiment.call("request", "prompt"))

    def test_unknown_submission_is_not_automatically_repeated(self):
        example.write_json(self.call_dir / "pending.json", {"request": self.request})
        with self.assertRaisesRegex(RuntimeError, "unresolved submission"):
            asyncio.run(self.experiment.call("request", "prompt"))
        self.experiment.client.thread_start.assert_not_called()

    def test_recovery_requires_original_turn_identity(self):
        example.write_json(
            self.call_dir / "pending.json",
            {
                "request": self.request,
                "thread_id": "thread",
                "turn_id": "original",
            },
        )
        thread = types.SimpleNamespace(
            read=AsyncMock(
                return_value=types.SimpleNamespace(
                    thread=types.SimpleNamespace(turns=[types.SimpleNamespace(id="unrelated")])
                )
            )
        )
        self.experiment.client.thread_resume.return_value = thread
        with self.assertRaisesRegex(RuntimeError, "does not match"):
            asyncio.run(self.experiment.call("request", "prompt"))
        self.experiment.client.thread_start.assert_not_called()


if __name__ == "__main__":
    unittest.main()
