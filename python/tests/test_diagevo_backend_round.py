"""Committed native-contract fixtures joined to explicit offline backend receipts."""

import asyncio
import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

import test_diagevo_generation
from gear.core._json import json_value
from gear.training.contracts import TrainingConfig, TrainingContext
from gear.training.recipes.diagevo_committed_memory import update_committed_memory
from gear.training.storage.content import ContractError, require


class ReceiptFixture:
    def __init__(self):
        self.identity = {"kind": "explicit-offline-diagnostic-receipt-fixture"}
        self.max_calls = 8
        self.receipts = {}
        self.submissions = 0

    async def diagnose(self, key, request):
        self.submissions += 1
        output = {"matched_cause_id": "cause", "error_cause": None}
        usage = dict(
            inputTokens=10,
            outputTokens=5,
            totalTokens=15,
            cachedInputTokens=2,
            reasoningOutputTokens=1,
        )
        self.receipts[key] = {
            "request": {"key": key, "backend": self.identity, "input": json_value(request)},
            "threadId": "fixture-thread/" + key,
            "turnId": "fixture-turn/" + key,
            "response": json.dumps(output),
            "usage": {"total": usage},
        }
        return output

    async def embed(self, key, text):
        raise AssertionError("known recurrence with a single node needs no embedding")

    async def recover(self, key):
        if key in self.receipts:
            return {"state": "completed", "output": json.loads(self.receipts[key]["response"])}
        return {"state": "not_submitted"}

    def receipt(self, key):
        require(key in self.receipts, "missing-fixture-receipt", "missing native receipt")
        return self.receipts[key]


@unittest.skipUnless(
    all(importlib.util.find_spec(name) for name in ("nltk", "sklearn")),
    "install training-metrics for committed challenger fixtures",
)
class CommittedMemoryBackendTests(unittest.TestCase):
    def setUp(self):
        self.fixture = test_diagevo_generation.FreshGenerationTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.store = self.fixture.store
        self.builder, self.pool, questions, _, _ = self.fixture.solver_pool()
        native = self.fixture.native
        native.builder, native.pool = self.builder, self.pool
        question = next(iter(questions))
        first, _, _, _ = native.batch(0, self.fixture.fixed, question=question)
        c1, exported = native.commit(first, 1)
        second, _, _, _ = native.batch(1, exported, answers="ab", question=question)
        c2, exported = native.commit(second, 2, c1)
        self.commits = [c1, c2]
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.ctx = TrainingContext(
            0,
            {
                "checkpointRef": self.store.read_json(c2)["checkpointRef"],
                "hfSnapshotRef": exported,
                "committedUpdate": 2,
            },
            [],
            "committed-memory-operation",
            self.root,
            self.root,
            TrainingConfig(self.root, 1, parameters={"curriculumRef": self.pool}),
        )
        self.backend = ReceiptFixture()

    def update(self):
        return asyncio.run(
            update_committed_memory(
                self.ctx,
                self.builder,
                commit_refs=self.commits,
                curriculum_ref=self.pool,
                diagnosis=self.backend,
                embedding=self.backend,
            )
        )

    def test_consumed_failures_retain_native_receipts_and_replay_without_calls(self):
        ref = self.update()
        value = self.store.read_json(ref)
        self.assertEqual(value["usage"]["diagnosticTurns"], 3)
        self.assertEqual(value["usage"]["knownNativeTokens"]["totalTokens"], 45)
        self.assertTrue(value["usage"]["tokenUsageComplete"])
        self.assertEqual(len(value["callReceipts"]), 3)
        self.assertEqual(len(value["memory"]["attributions"]), 3)
        self.assertEqual(self.update(), ref)
        self.assertEqual(self.backend.submissions, 3)
        for item in value["callReceipts"]:
            self.assertEqual(
                self.store.read_json(item["receiptRef"])["request"]["key"], item["key"]
            )

    def test_missing_native_receipt_does_not_regenerate_a_completed_diagnosis(self):
        self.update()
        self.backend.receipts.pop(next(iter(self.backend.receipts)))
        with self.assertRaisesRegex(ContractError, "missing native receipt"):
            self.update()
        self.assertEqual(self.backend.submissions, 3)

    def test_unknown_native_usage_is_reported_as_incomplete_not_zero(self):
        original = self.backend.diagnose

        async def missing_usage(key, request):
            result = await original(key, request)
            if self.backend.submissions == 1:
                self.backend.receipts[key]["usage"] = None
            return result

        self.backend.diagnose = missing_usage
        value = self.store.read_json(self.update())
        self.assertFalse(value["usage"]["tokenUsageComplete"])
        self.assertEqual(len(value["usage"]["unknownUsageKeys"]), 1)
        self.assertEqual(value["usage"]["knownNativeTokens"]["totalTokens"], 30)

    def test_native_output_and_repeated_turns_cannot_be_relabelled_as_new_calls(self):
        self.update()
        keys = list(self.backend.receipts)
        original = copy.deepcopy(self.backend.receipts[keys[0]])
        self.backend.receipts[keys[0]]["response"] = '{"matched_cause_id":null,"error_cause":null}'
        with self.assertRaisesRegex(ContractError, "native output differs"):
            self.update()
        self.backend.receipts[keys[0]] = original
        for key in keys[1:]:
            for field in ("threadId", "turnId"):
                self.backend.receipts[key][field] = original[field]
        with self.assertRaisesRegex(ContractError, "counted twice"):
            self.update()

    def test_wrong_final_checkpoint_fails_before_external_work(self):
        self.ctx.checkpoint["hfSnapshotRef"] = self.fixture.fixed
        with self.assertRaisesRegex(ContractError, "final consumed update"):
            self.update()
        self.assertEqual(self.backend.submissions, 0)


if __name__ == "__main__":
    unittest.main()
