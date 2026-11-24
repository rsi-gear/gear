"""Native solver memory publication with SDK message doubles and real tiny BERT."""

import copy
import importlib.util
import json
import sys
import unittest
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import patch

import test_diagevo_backends
import test_diagevo_construction_pipeline
import test_diagevo_fresh_pipeline
import test_diagevo_pipeline
from gear.training.backends.slime.driver import run
from gear.training.pipelines import diagevo_solver
from gear.training.recipes import diagevo_backends, diagevo_committed_memory
from gear.training.storage.content import ContractError, atomic_json


class DiagnosticSDKFixture:
    """An explicit model-service double, using the actual SDK notification types."""

    phrase = "Check all relevant boundary conditions before selecting the final arithmetic result"

    def __init__(self, on_submit):
        self.on_submit = on_submit
        self.threads, self.turns, self.events = {}, {}, {}
        self.connections = self.reads = 0
        self.lose_start_reply = self.hide_turn = False

    async def __aenter__(self):
        self.connections += 1
        return self

    async def initialize(self):
        pass

    async def close(self):
        pass

    async def __aexit__(self, *args):
        pass

    async def thread_start(self, request):
        key = "fixture-thread-" + str(len(self.threads))
        self.threads[key] = request
        return SimpleNamespace(
            thread=SimpleNamespace(id=key),
            model=request["model"],
            model_provider=request["modelProvider"],
        )

    async def turn_start(self, thread, text, options):
        from openai_codex.generated.v2_all import (
            ItemCompletedNotification,
            ThreadTokenUsageUpdatedNotification,
            Turn,
            TurnCompletedNotification,
        )

        self.on_submit()
        data = json.loads(text)
        properties = options["outputSchema"]["properties"]
        if "error_cause" in properties:
            output = {"matched_cause_id": None, "error_cause": self.phrase}
        elif "duplicate" in properties:
            output = {"duplicate": True, "matched_cause_id": data["candidates"][0]["cause_id"]}
        elif "create_new_node" in properties:
            output = {"create_new_node": True, "assigned_node": None, "new_node_label": self.phrase}
        else:
            raise AssertionError("unexpected diagnostic fixture operation")
        key = "fixture-turn-" + str(len(self.turns))
        message = {
            "id": "answer",
            "type": "agentMessage",
            "phase": "final_answer",
            "text": json.dumps(output),
        }
        turn = Turn.model_validate(
            {
                "id": key,
                "status": "completed",
                "itemsView": "full",
                "items": [
                    {
                        "id": "user",
                        "type": "userMessage",
                        "content": [{"type": "text", "text": text}],
                    },
                    message,
                ],
            }
        )
        usage = dict(
            inputTokens=10,
            outputTokens=5,
            totalTokens=15,
            cachedInputTokens=2,
            reasoningOutputTokens=1,
        )
        self.turns[thread] = turn
        self.events[key] = [
            ItemCompletedNotification.model_validate(
                {"threadId": thread, "turnId": key, "completedAtMs": 1, "item": message}
            ),
            ThreadTokenUsageUpdatedNotification.model_validate(
                {"threadId": thread, "turnId": key, "tokenUsage": {"last": usage, "total": usage}}
            ),
            TurnCompletedNotification.model_validate({"threadId": thread, "turn": turn}),
        ]
        if self.lose_start_reply:
            self.lose_start_reply = False
            raise ConnectionError("diagnostic turn start reply lost")
        return SimpleNamespace(turn=turn)

    async def next_turn_notification(self, key):
        return SimpleNamespace(payload=self.events[key].pop(0))

    def unregister_turn_notifications(self, key):
        pass

    async def thread_read(self, key, *, include_turns):
        self.reads += 1
        return SimpleNamespace(
            thread=SimpleNamespace(id=key, turns=[] if self.hide_turn else [self.turns[key]])
        )


@unittest.skipUnless(
    all(
        importlib.util.find_spec(name)
        for name in (
            "torch",
            "transformers",
            "tokenizers",
            "safetensors",
            "math_verify",
            "nltk",
            "sklearn",
            "openai_codex",
        )
    ),
    "install agents, CPU training-math and training-metrics dependencies",
)
class SolverMemoryPipelineTests(unittest.TestCase):
    def setUp(self):
        self.fixture = test_diagevo_pipeline.SolverPipelineTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.driver, self.store = self.fixture.driver, self.fixture.store
        self.root, self.request = self.driver.d.root, self.driver.d.request
        embedding = test_diagevo_backends.EmbeddingBackendTests()
        embedding.setUp()
        self.addCleanup(embedding.doCleanups)
        model = embedding.store.read_json(embedding.model_ref)
        for ref in [embedding.model_ref, *(row["contentRef"] for row in model["files"])]:
            self.store.put_bytes(embedding.store.read_bytes(ref), ref["mediaType"])
        self.options = {
            "diagnosis": {"model": "fixture-model", "model_provider": "fixture", "max_calls": 8},
            "embedding": {"model_ref": embedding.model_ref, "max_tokens": 32, "max_calls": 4},
        }
        self.request["trainer"]["scriptConfig"]["memoryUpdate"] = self.options
        self.client = DiagnosticSDKFixture(
            lambda: self.assertEqual(
                self.driver.native_events.count("train"),
                self.request["trainer"]["updatesPerCandidate"],
            )
        )

    @contextmanager
    def sdk(self):
        with patch("openai_codex.async_client.AsyncCodexClient", return_value=self.client):
            yield

    @contextmanager
    def native(self):
        import transformers

        loader = transformers.AutoTokenizer.from_pretrained

        def tokenizer(path, **kwargs):
            return object() if path == "cpu-fixture" else loader(path, **kwargs)

        with (
            self.driver.cpu_runtime(),
            self.fixture.native(),
            patch.dict(sys.modules, {"transformers": transformers}),
            patch.object(transformers.AutoTokenizer, "from_pretrained", side_effect=tokenizer),
            self.sdk(),
        ):
            yield

    @contextmanager
    def resumed(self):
        with (
            self.sdk(),
            patch(
                "gear.training.backends.slime.gpu_visibility.verify_visible_devices",
                side_effect=AssertionError("must not restart CUDA"),
            ),
        ):
            yield

    def result(self):
        artifacts = json.loads((self.root / "artifacts.body.json").read_text())
        provenance = self.store.read_json(artifacts["model"]["provenanceRef"])
        loop = self.store.read_json(provenance["trainingLoopRef"])
        ref = loop["checkpoint"]["memoryRef"]
        memory = self.store.read_json(ref)
        self.assertEqual(memory["checkpointRef"], artifacts["checkpointRef"])
        self.assertEqual(memory["input"]["commitRefs"], provenance["updateCommitRefs"])
        self.assertEqual(
            loop["checkpoint"]["committedUpdate"], self.request["trainer"]["updatesPerCandidate"]
        )
        return ref, memory

    def test_final_memory_and_actual_receipts_are_reachable_from_model_provenance(self):
        with self.native():
            run(self.root)
        _, memory = self.result()
        self.assertNotIn("memoryRef", self.driver.stage("model-updater", 0))
        self.assertEqual(len(memory["input"]["commitRefs"]), 2)
        self.assertEqual(len(memory["memory"]["attributions"]), 2)
        self.assertEqual(len(memory["memory"]["memory"]), 1)
        self.assertEqual(len(memory["memory"]["memory"][0]["episode_failure_ids"]), 2)
        self.assertEqual(memory["usage"]["diagnosticTurns"], 4)
        self.assertEqual(memory["usage"]["knownNativeTokens"]["totalTokens"], 60)
        embeddings = [
            self.store.read_json(row["receiptRef"])
            for row in memory["callReceipts"]
            if row["kind"] == "embedding"
        ]
        self.assertEqual(len(embeddings), 1)
        self.assertEqual(len(embeddings[0]["vector"]), 8)
        self.assertEqual(memory["usage"]["embeddingInputTokens"], embeddings[0]["inputTokens"])
        self.assertFalse(self.store.path(self.driver.f.private["digest"]).exists())
        before = (self.root / "artifacts.body.json").read_bytes()
        with (
            patch(
                "openai_codex.async_client.AsyncCodexClient",
                side_effect=AssertionError("must not connect"),
            ),
            patch.object(
                diagevo_backends.BGEEmbedding, "_load", side_effect=AssertionError("must not load")
            ),
        ):
            run(self.root)
        self.assertEqual((self.root / "artifacts.body.json").read_bytes(), before)
        self.assertEqual(len(self.client.turns), 4)

    def test_fresh_challenger_construction_continues_to_solver_memory(self):
        construction = test_diagevo_construction_pipeline.ConstructionPipelineTests()
        construction.setUp()
        self.addCleanup(construction.doCleanups)
        construction.ready_solver()
        ref, body, origin, _ = construction.first_job()
        previous = self.store
        embedding_ref = self.options["embedding"]["model_ref"]
        refs = [
            self.driver.d.hf,
            self.driver.d.state_ref,
            self.request["trainer"]["hyperparametersRef"],
            embedding_ref,
            *(row["contentRef"] for row in previous.read_json(embedding_ref)["files"]),
        ]
        self.store = construction.store
        for item in refs:
            self.store.put_bytes(previous.read_bytes(item), item["mediaType"])
        self.driver.d.store = self.driver.f.store = self.fixture.store = self.store
        self.driver.config["storeRoot"] = str(self.store.root)
        self.request = construction.solver_request(self.request, ref)
        self.request["trainer"]["scriptConfig"]["memoryUpdate"] = self.options
        self.driver.d.request = self.request
        self.fixture.questions = origin["questions"]
        committed = SimpleNamespace(
            driver=self.driver, request=self.request, updated=construction.solver_ref
        )
        self.driver.d.commit = lambda store, ledger, **kwargs: (
            test_diagevo_fresh_pipeline.FreshPipelineTests.commit(
                committed, store, ledger, **kwargs
            )
        )
        with self.native():
            run(self.root)
        _, memory = self.result()
        self.assertNotEqual(self.root, construction.root)
        self.assertEqual(memory["input"]["curriculumRef"], body["curriculumRef"])
        self.assertEqual(len(memory["memory"]["attributions"]), 1)
        self.assertEqual(memory["usage"]["diagnosticTurns"], 2)
        self.assertEqual(self.driver.native_events.count("train"), 1)
        self.assertFalse(self.store.path(self.driver.f.private["digest"]).exists())

    def test_last_native_commit_reply_gap_finishes_memory_without_retraining(self):
        self.request["trainer"]["updatesPerCandidate"] = 1
        self.driver.d.fail_commit_reply = True
        with self.native(), self.assertRaisesRegex(OSError, "commit response lost"):
            run(self.root)
        self.assertFalse(self.client.turns)
        before = self.driver.native_events[:]
        with self.resumed():
            run(self.root)
        self.assertEqual(self.driver.native_events, before)
        self.assertEqual(self.result()[1]["usage"]["diagnosticTurns"], 2)

    def test_lost_diagnostic_receipt_recovers_original_turn_and_token_usage(self):
        finish = diagevo_backends._finish

        def gap(directory, request, receipt):
            if receipt.get("kind") == diagevo_backends.CodexDiagnosis.stage_id:
                raise OSError("diagnostic receipt gap")
            return finish(directory, request, receipt)

        with (
            self.native(),
            patch.object(diagevo_backends, "_finish", gap),
            self.assertRaisesRegex(OSError, "diagnostic receipt gap"),
        ):
            run(self.root)
        before = self.driver.native_events[:]
        self.assertEqual(len(self.client.turns), 1)
        with self.resumed():
            run(self.root)
        self.assertEqual(self.driver.native_events, before)
        self.assertEqual(self.client.reads, 1)
        self.assertEqual(len(self.client.turns), 4)
        self.assertEqual(self.result()[1]["usage"]["knownNativeTokens"]["totalTokens"], 60)

    def test_memory_result_reply_gap_republishes_without_connecting_or_loading(self):
        original, refs = diagevo_committed_memory.update_committed_memory, []

        async def gap(*args, **kwargs):
            refs.append(await original(*args, **kwargs))
            raise RuntimeError("memory result gap")

        with (
            self.native(),
            patch.object(diagevo_committed_memory, "update_committed_memory", gap),
            self.assertRaisesRegex(RuntimeError, "memory result gap"),
        ):
            run(self.root)
        before = self.driver.native_events[:]
        with (
            patch(
                "openai_codex.async_client.AsyncCodexClient",
                side_effect=AssertionError("must not connect"),
            ),
            patch.object(
                diagevo_backends.BGEEmbedding, "_load", side_effect=AssertionError("must not load")
            ),
            patch(
                "gear.training.backends.slime.gpu_visibility.verify_visible_devices",
                side_effect=AssertionError("must not restart CUDA"),
            ),
        ):
            run(self.root)
        self.assertEqual(self.result()[0], refs[0])
        self.assertEqual(self.driver.native_events, before)
        self.assertEqual(len(self.client.turns), 4)

    def test_completed_stage_replay_requires_its_native_receipts(self):
        with self.native():
            run(self.root)
        path = next((self.root / "diagevo-memory-backends/diagnosis/calls").glob("*/result.json"))
        path.unlink()
        with (
            patch(
                "openai_codex.async_client.AsyncCodexClient",
                side_effect=AssertionError("must not connect"),
            ),
            self.assertRaisesRegex(ContractError, "no completed receipt"),
        ):
            run(self.root)
        self.assertEqual(len(self.client.turns), 4)

    def test_commit_list_drift_is_rejected_before_diagnostic_submission(self):
        original = diagevo_solver.online_rl.SlimeModelUpdater.update

        def drift(updater, *args):
            checkpoint = original(updater, *args)
            if checkpoint["committedUpdate"] == 2:
                updater.runtime.prior_commits = []
            return checkpoint

        with (
            self.native(),
            patch.object(diagevo_solver.online_rl.SlimeModelUpdater, "update", drift),
            self.assertRaisesRegex(ContractError, "actual committed solver"),
        ):
            run(self.root)
        self.assertFalse(self.client.turns)
        self.assertEqual(self.client.connections, 0)

    def test_cancellation_after_a_receipt_keeps_commits_and_resumes_unfinished_memory(self):
        original = diagevo_backends._finish

        def cancel(directory, request, receipt):
            result = original(directory, request, receipt)
            atomic_json(self.root / "cancel.json", {"reason": "test cancellation after receipt"})
            return result

        with self.native(), patch.object(diagevo_backends, "_finish", cancel):
            run(self.root)
        before = self.driver.native_events[:]
        self.assertEqual(len(self.client.turns), 1)
        self.assertFalse((self.root / "artifacts.body.json").exists())
        (self.root / "cancel.json").unlink()
        with self.resumed():
            run(self.root)
        self.assertEqual(self.driver.native_events, before)
        self.assertEqual(len(self.client.turns), 4)
        self.assertEqual(self.result()[1]["usage"]["diagnosticTurns"], 4)

    def test_unknown_turn_stops_without_resubmitting_and_reports_missing_usage_on_recovery(self):
        self.client.lose_start_reply = self.client.hide_turn = True
        with self.native(), self.assertRaisesRegex(ConnectionError, "turn start reply lost"):
            run(self.root)
        with self.resumed(), self.assertRaisesRegex(RuntimeError, "unknown external outcome"):
            run(self.root)
        self.assertEqual(len(self.client.turns), 1)
        self.client.hide_turn = False
        with self.resumed():
            run(self.root)
        usage = self.result()[1]["usage"]
        self.assertEqual(len(self.client.turns), 4)
        self.assertFalse(usage["tokenUsageComplete"])
        self.assertEqual(len(usage["unknownUsageKeys"]), 1)
        self.assertEqual(usage["knownNativeTokens"]["totalTokens"], 45)

    def test_invalid_memory_configuration_cannot_override_backend_storage(self):
        params = self.request["trainer"]["scriptConfig"]
        for value in (
            None,
            {},
            {**self.options, "extra": True},
            {**self.options, "diagnosis": {**self.options["diagnosis"], "root": "/elsewhere"}},
        ):
            config = {"parameters": {**copy.deepcopy(params), "memoryUpdate": value}}
            with (
                self.subTest(value=value),
                self.assertRaisesRegex(ContractError, "explicit diagnosis"),
            ):
                diagevo_solver.build_loop(
                    config, SimpleNamespace(store=self.store, request=self.request)
                )


if __name__ == "__main__":
    unittest.main()
