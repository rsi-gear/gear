"""Safety of the caller's real-model bridge and the formal study's split policy."""

import asyncio
import base64
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from gear.canonical import digest
from gear.core import CandidateRef, Meta, MetaInput
from gear.curriculum import ModelInput

EXAMPLES = Path(__file__).resolve().parents[2] / "examples/curriculum-harness"
sys.path.insert(0, str(EXAMPLES))
import formal_experiment as study  # noqa: E402
import formal_provider as provider  # noqa: E402
from model_calls import TextCalls, token_usage  # noqa: E402


class ScopeTests(unittest.TestCase):
    def test_meta_receives_only_declared_tasks_and_materials(self):
        candidate = CandidateRef("run", "anchor", digest("candidate"))
        call = Meta("Improve", {"type": "object"})(
            MetaInput(candidate, ("train",), data={"current_prompt": "initial"}), key="meta"
        )
        request = {
            "runId": "run",
            "operationId": digest("operation"),
            "operation": {"kind": "diagnose_seed", "task_ids": ["train"]},
            "operatorCall": {
                "effect": call.effect,
                "materials": [
                    {
                        "ref": {"kind": "assessment"},
                        "value": {"feedback": "TRAIN_FEEDBACK"},
                        "files": {"rule": {"content": base64.b64encode(b"rule text").decode()}},
                    }
                ],
            },
        }
        context = {
            "tasks": [
                {"id": "train", "instruction": "TRAIN_TASK"},
                {"id": "dev", "instruction": "PRIVATE_DEV"},
            ]
        }
        jobs = provider.prepare_jobs(context, request)
        self.assertIn("TRAIN_FEEDBACK", jobs[0]["prompt"])
        self.assertIn("rule text", jobs[0]["prompt"])
        self.assertNotIn("PRIVATE_DEV", jobs[0]["prompt"])
        request["generationLimits"] = {"tokens": 123}
        with self.assertRaisesRegex(ValueError, "cannot enforce"):
            provider.prepare_jobs(context, request)

    def test_provider_does_not_claim_hard_generation_limits_or_cancellation(self):
        with patch.object(provider, "implementation_identity", return_value=digest("test")):
            result = asyncio.run(provider.respond({"action": "describe"}))
        self.assertFalse(result["capabilities"]["generationBudget"])
        self.assertFalse(result["capabilities"]["cancel"])
        self.assertTrue(result["capabilities"]["operatorMeta"])
        self.assertEqual(token_usage([{"usage": None}]), {})
        self.assertEqual(token_usage([{"usage": {"total": {"total_tokens": 21}}}]), {"tokens": 21})

    def test_new_splits_exclude_every_previously_used_family(self):
        tasks = [{"id": str(i), "family": "source-" + str(i)} for i in range(12)]
        benchmark = SimpleNamespace(
            split=lambda seed, n, d, t: {"eligible_count": 12, "train": tasks[:n]}
        )
        previous = {
            "train": tasks[:1],
            "dev": tasks[1:2],
            "test": tasks[2:3],
            "excluded_ids": ["3", "4"],
        }
        splits = study.fresh_splits(
            benchmark,
            previous,
            {"split_seed": 1, "train_count": 2, "dev_count": 2, "test_count": 3},
        )
        selected = [row["id"] for part in ("train", "dev", "test") for row in splits[part]]
        self.assertEqual(len(set(selected)), 7)
        self.assertFalse(set(selected) & {"0", "1", "2", "3", "4"})
        self.assertEqual(splits["excluded_ids"], ["0", "1", "2", "3", "4"])


class RecoveryTests(unittest.TestCase):
    def test_bad_model_json_is_distinct_from_receipt_integrity_failure(self):
        async def run():
            caller = object.__new__(study.Study)
            caller.config = {"teacher": "fixture", "effort": "low"}
            caller.calls = SimpleNamespace(call=AsyncMock(return_value={"response": "not JSON"}))
            prepared = ModelInput("Reply", {"type": "object"}, {})
            with self.assertRaises(study.ModelResponseError):
                await caller.model_json("generate", prepared)
            caller.calls.call.side_effect = ValueError("model receipt bytes changed")
            with self.assertRaisesRegex(ValueError, "receipt bytes changed") as caught:
                await caller.model_json("generate", prepared)
            self.assertNotIsInstance(caught.exception, study.ModelResponseError)

        asyncio.run(run())

    def sdk_patch(self):
        return patch.dict(
            sys.modules,
            {
                "openai_codex": SimpleNamespace(
                    ApprovalMode=SimpleNamespace(deny_all="deny"),
                    Sandbox=SimpleNamespace(read_only="read"),
                )
            },
        )

    def test_unknown_submission_never_starts_another_turn(self):
        async def run(root):
            calls = TextCalls(root)
            calls.client = SimpleNamespace(
                thread_start=AsyncMock(side_effect=RuntimeError("lost start"))
            )
            with (
                self.sdk_patch(),
                patch("model_calls.importlib.metadata.version", return_value="test"),
            ):
                with self.assertRaisesRegex(RuntimeError, "lost start"):
                    await calls.call("key", "prompt", "harness", model="test")
                with self.assertRaisesRegex(RuntimeError, "unknown model result"):
                    await calls.call("key", "prompt", "harness", model="test")
            self.assertEqual(calls.client.thread_start.await_count, 1)

        with tempfile.TemporaryDirectory() as root:
            asyncio.run(run(root))

    def test_completed_turn_is_recovered_without_resubmission_or_invented_usage(self):
        async def run(root):
            calls = TextCalls(root)
            item = SimpleNamespace(
                type="agentMessage", phase=SimpleNamespace(value="final_answer"), text="response"
            )
            turn = SimpleNamespace(
                id="turn", status=SimpleNamespace(value="completed"), items=[item]
            )
            handle = SimpleNamespace(
                id="turn", run=AsyncMock(side_effect=TimeoutError("lost acknowledgement"))
            )
            thread = SimpleNamespace(
                id="thread",
                turn=AsyncMock(return_value=handle),
                read=AsyncMock(return_value=SimpleNamespace(thread=SimpleNamespace(turns=[turn]))),
            )
            calls.client = SimpleNamespace(
                thread_start=AsyncMock(return_value=thread),
                thread_resume=AsyncMock(return_value=thread),
            )
            with (
                self.sdk_patch(),
                patch("model_calls.importlib.metadata.version", return_value="test"),
            ):
                with self.assertRaises(TimeoutError):
                    await calls.call("key", "prompt", "harness", model="test")
                receipt = await calls.call("key", "prompt", "harness", model="test")
                self.assertEqual(receipt["response"], "response")
                self.assertIsNone(receipt["usage"])
                self.assertEqual(
                    await calls.call("key", "prompt", "harness", model="test"), receipt
                )
            self.assertEqual(thread.turn.await_count, 1)
            self.assertEqual(calls.client.thread_start.await_count, 1)

        with tempfile.TemporaryDirectory() as root:
            asyncio.run(run(root))


if __name__ == "__main__":
    unittest.main()
