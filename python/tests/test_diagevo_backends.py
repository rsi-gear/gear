"""Native SDK receipt contracts and actual tiny CPU BERT inference, without paid calls."""

import asyncio
import importlib.util
import json
import math
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from gear.curriculum import ModelInput
from gear.training.recipes import diagevo_backends as backend
from gear.training.storage.content import ContentStore, ContractError


@unittest.skipUnless(importlib.util.find_spec("openai_codex"), "install the agents extra")
class DiagnosisBackendTests(unittest.TestCase):
    def setUp(self):
        from openai_codex.generated.v2_all import (
            ItemCompletedNotification,
            ThreadTokenUsageUpdatedNotification,
            Turn,
            TurnCompletedNotification,
        )

        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.diagnosis = backend.CodexDiagnosis(
            self.root, model="fixture-model", model_provider="fixture", max_calls=1
        )
        self.input = ModelInput(
            "Return a diagnostic label.",
            {
                "type": "object",
                "properties": {"cause": {"type": "string"}},
                "required": ["cause"],
                "additionalProperties": False,
            },
            {
                "question": "A test question.",
                "failure": "A captured response with an incorrect inference.",
            },
        )
        self.message = {
            "id": "answer",
            "type": "agentMessage",
            "text": '{"cause":"boundary"}',
            "phase": "final_answer",
        }
        self.turn = Turn.model_validate(
            {
                "id": "turn",
                "status": "completed",
                "itemsView": "full",
                "items": [
                    {
                        "type": "userMessage",
                        "id": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": json.dumps(self.input.data, ensure_ascii=False),
                            }
                        ],
                    },
                    self.message,
                ],
            }
        )
        usage = {
            "inputTokens": 10,
            "outputTokens": 5,
            "totalTokens": 15,
            "cachedInputTokens": 2,
            "reasoningOutputTokens": 1,
        }
        self.events = [
            ItemCompletedNotification.model_validate(
                {
                    "threadId": "thread",
                    "turnId": "turn",
                    "completedAtMs": 1,
                    "item": self.message,
                }
            ),
            ThreadTokenUsageUpdatedNotification.model_validate(
                {
                    "threadId": "thread",
                    "turnId": "turn",
                    "tokenUsage": {"last": usage, "total": usage},
                }
            ),
            TurnCompletedNotification.model_validate({"threadId": "thread", "turn": self.turn}),
        ]
        self.client = SimpleNamespace(
            thread_start=AsyncMock(
                return_value=SimpleNamespace(
                    thread=SimpleNamespace(id="thread"),
                    model="fixture-model",
                    model_provider="fixture",
                )
            ),
            turn_start=AsyncMock(return_value=SimpleNamespace(turn=self.turn)),
            thread_read=AsyncMock(
                return_value=SimpleNamespace(thread=SimpleNamespace(id="thread", turns=[self.turn]))
            ),
            unregister_turn_notifications=Mock(),
            next_turn_notification=AsyncMock(
                side_effect=[SimpleNamespace(payload=row) for row in self.events]
            ),
        )
        self.diagnosis.client = self.client

    def test_native_usage_schema_and_exact_key_replay(self):
        result = asyncio.run(self.diagnosis.diagnose("key", self.input))
        self.assertEqual(result, {"cause": "boundary"})
        self.assertEqual(asyncio.run(self.diagnosis.diagnose("key", self.input)), result)
        self.assertEqual(
            asyncio.run(self.diagnosis.recover("key")), {"state": "completed", "output": result}
        )
        self.assertEqual(self.client.turn_start.await_count, 1)
        receipt = self.diagnosis.receipt("key")
        self.assertEqual(receipt["usage"]["total"]["totalTokens"], 15)
        self.assertEqual(receipt["model"], "fixture-model")
        self.assertIsNone(receipt["usd"])
        self.assertFalse(receipt["recovered"])
        changed = ModelInput(self.input.prompt, self.input.schema, {"failure": "different"})
        with self.assertRaisesRegex(ContractError, "submitted call"):
            asyncio.run(self.diagnosis.diagnose("key", changed))

    def test_lost_completed_receipt_recovers_native_turn_and_previously_recorded_usage(self):
        with (
            patch.object(backend, "_finish", side_effect=OSError("receipt write failed")),
            self.assertRaisesRegex(OSError, "receipt write"),
        ):
            asyncio.run(self.diagnosis.diagnose("key", self.input))
        recovered = asyncio.run(self.diagnosis.recover("key"))
        self.assertEqual(recovered, {"state": "completed", "output": {"cause": "boundary"}})
        self.assertEqual(self.client.turn_start.await_count, 1)
        self.client.thread_read.assert_awaited_once_with("thread", include_turns=True)
        receipt = self.diagnosis.receipt("key")
        self.assertTrue(receipt["recovered"])
        self.assertEqual(receipt["usage"]["total"]["totalTokens"], 15)

    def test_unknown_submission_is_never_retried_and_still_uses_the_quota(self):
        self.client.turn_start.side_effect = ConnectionError("lost response")
        with self.assertRaises(ConnectionError):
            asyncio.run(self.diagnosis.diagnose("key", self.input))
        self.client.thread_read.return_value.thread.turns = []
        self.assertEqual(asyncio.run(self.diagnosis.recover("key")), {"state": "unknown"})
        with self.assertRaisesRegex(ContractError, "unresolved"):
            asyncio.run(self.diagnosis.diagnose("key", self.input))
        with self.assertRaisesRegex(ContractError, "quota exhausted"):
            asyncio.run(self.diagnosis.diagnose("another", self.input))
        self.assertEqual(self.client.thread_start.await_count, 1)
        self.assertEqual(self.client.turn_start.await_count, 1)

    def test_failed_schema_preserves_paid_receipt_without_retry(self):
        self.message["text"] = '{"unexpected":"value"}'
        self.events[0].item.root.text = self.message["text"]
        for _ in range(2):
            with self.assertRaises(ValueError):
                asyncio.run(self.diagnosis.diagnose("key", self.input))
        self.assertTrue((backend._directory(self.root, "key") / "result.json").exists())
        self.assertEqual(self.client.turn_start.await_count, 1)

    def test_native_model_drift_is_rejected_before_inference(self):
        self.client.thread_start.return_value.model = "different"
        with self.assertRaisesRegex(ContractError, "native model differs"):
            asyncio.run(self.diagnosis.diagnose("key", self.input))
        self.client.turn_start.assert_not_awaited()

    def test_root_identity_and_receipt_content_changes_are_detected(self):
        asyncio.run(self.diagnosis.diagnose("key", self.input))
        with self.assertRaisesRegex(ContractError, "backend input changed"):
            backend.CodexDiagnosis(self.root, model="different", max_calls=1)
        path = backend._directory(self.root, "key") / "result.json"
        record = json.loads(path.read_text())
        record["receipt"]["response"] = '{"cause":"tampered"}'
        path.write_text(json.dumps(record))
        with self.assertRaisesRegex(ContractError, "native receipt differs"):
            asyncio.run(self.diagnosis.recover("key"))


@unittest.skipUnless(
    all(
        importlib.util.find_spec(name)
        for name in ("torch", "transformers", "tokenizers", "safetensors")
    ),
    "install the CPU training dependencies",
)
class EmbeddingBackendTests(unittest.TestCase):
    def setUp(self):
        import torch
        from tokenizers import Tokenizer
        from tokenizers.models import WordPiece
        from tokenizers.pre_tokenizers import Whitespace
        from tokenizers.processors import TemplateProcessing
        from transformers import BertConfig, BertModel, PreTrainedTokenizerFast

        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.store = ContentStore(self.root / "content")
        model_dir = self.root / "source"
        vocab = ["[PAD]", "[UNK]", "[CLS]", "[SEP]", "count", "overlap", "preserve", "boundaries"]
        tokenizer = Tokenizer(
            WordPiece({word: i for i, word in enumerate(vocab)}, unk_token="[UNK]")
        )
        tokenizer.pre_tokenizer = Whitespace()
        tokenizer.post_processor = TemplateProcessing(
            single="[CLS] $A [SEP]", special_tokens=[("[CLS]", 2), ("[SEP]", 3)]
        )
        wrapped = PreTrainedTokenizerFast(
            tokenizer_object=tokenizer,
            unk_token="[UNK]",
            pad_token="[PAD]",
            cls_token="[CLS]",
            sep_token="[SEP]",
        )
        wrapped.save_pretrained(model_dir)
        (model_dir / "special_tokens_map.json").write_text(json.dumps(wrapped.special_tokens_map))
        (model_dir / "vocab.txt").write_text("\n".join(vocab) + "\n")
        with torch.random.fork_rng(devices=[]):
            torch.manual_seed(17)
            model = BertModel(
                BertConfig(
                    vocab_size=len(vocab),
                    hidden_size=8,
                    num_hidden_layers=1,
                    num_attention_heads=2,
                    intermediate_size=16,
                    max_position_embeddings=32,
                )
            )
        model.save_pretrained(model_dir, safe_serialization=True)
        self.model_ref = backend.seal_bge_model(
            self.store, model_dir, model_id="tiny-random-bert-fixture", revision="a" * 40
        )
        self.embedding = backend.BGEEmbedding(
            self.store,
            self.root / "embedding",
            model_ref=self.model_ref,
            max_tokens=16,
            max_calls=2,
        )

    def test_actual_model_vector_replay_and_safe_recomputation_after_local_gap(self):
        vector = asyncio.run(self.embedding.embed("key", "count overlap"))
        self.assertEqual(len(vector), 8)
        self.assertAlmostEqual(math.sqrt(sum(x * x for x in vector)), 1.0, places=6)
        receipt = self.embedding.receipt("key")
        self.assertEqual(receipt["inputTokens"], 4)
        self.assertEqual(receipt["externalModelCalls"], 0)
        path = backend._directory(self.embedding.root, "key") / "result.json"
        path.unlink()
        recovered = asyncio.run(self.embedding.recover("key"))
        self.assertEqual(recovered, {"state": "completed", "output": vector})
        fresh = backend.BGEEmbedding(
            self.store, self.embedding.root, model_ref=self.model_ref, max_tokens=16, max_calls=2
        )
        with patch.object(
            fresh, "_load", side_effect=AssertionError("cached result must not reload weights")
        ):
            self.assertEqual(asyncio.run(fresh.embed("key", "count overlap")), vector)

    def test_overlong_input_is_rejected_without_truncation_or_result(self):
        with self.assertRaisesRegex(ContractError, "token limit"):
            asyncio.run(self.embedding.embed("long", "count " * 20))
        self.assertFalse((backend._directory(self.embedding.root, "long") / "result.json").exists())

    def test_changed_model_bytes_and_same_key_different_text_are_rejected(self):
        asyncio.run(self.embedding.embed("key", "count overlap"))
        with self.assertRaisesRegex(ContractError, "native receipt differs"):
            asyncio.run(self.embedding.embed("key", "preserve boundaries"))
        ref = self.store.read_json(self.model_ref)["files"][1]["contentRef"]
        self.store.path(ref["digest"]).write_bytes(b"corrupted weights")
        fresh = backend.BGEEmbedding(
            self.store, self.root / "new", model_ref=self.model_ref, max_tokens=16
        )
        with self.assertRaises(ContractError):
            asyncio.run(fresh.embed("key", "count overlap"))


if __name__ == "__main__":
    unittest.main()
