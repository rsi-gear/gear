import asyncio
import importlib.util
import json
import socket
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

from gear_training.content import digest_bytes
from gear_training.episodes import EpisodeJournal
from gear_training.rollout import collect_rollout
from episode_fixture import EpisodeFixture


@unittest.skipUnless(importlib.util.find_spec("aiohttp"), "install the gateway extra for the real HTTP fixture")
class ControllerRolloutTest(unittest.IsolatedAsyncioTestCase):
    async def test_v2_full_batch_uses_controller_journal_and_exact_gateway_without_hitch_on_node(self):
        import aiohttp
        with tempfile.TemporaryDirectory() as root:
            f = EpisodeFixture(root)
            self.addCleanup(f.close)
            with socket.socket() as bound:
                bound.bind(("127.0.0.1", 0)); port = bound.getsockname()[1]
            f.config["gatewayPort"] = port; f.persist()
            # collect_rollout owns its own DB connection, just as on the GPU node.
            journal = EpisodeJournal(f.directory)
            self.addCleanup(journal.close)
            args = types.SimpleNamespace(rollout_batch_size=1, n_samples_per_prompt=2, global_batch_size=2, advantage_estimator="grpo", hf_checkpoint="fixture")
            class Native:
                expected_weight_version = "0"
                async def generate(self, payload):
                    output = [3, 4] if len(payload["input_ids"]) == 2 else [5]
                    return {"text": "fixture", "output_ids": output, "meta_info": {"weight_version": "0", "completion_tokens": len(output),
                        "output_token_logprobs": [[-.1, token] for token in output], "finish_reason": {"type": "stop"}}}
            def protocol(*args):
                return lambda body: body["fixture_tokens"], lambda data, body, inputs, outputs: {"choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": data["text"]}}]}
            async def controller():
                completed = set()
                async with aiohttp.ClientSession() as session:
                    while len(completed) < 2:
                        for entry in journal.list(renew=True)["entries"]:
                            intent = entry["intent"]
                            if intent["id"] in completed: continue
                            auth = {"Authorization": "Bearer " + intent["credential"]}
                            run_id = "run_" + str(intent["context"]["slot"]).zfill(32)
                            async with session.post(f"http://127.0.0.1:{port}/v1/hitch/run", headers=auth,
                                json={"runId": run_id, "bindingId": intent["binding"]["bindingId"]}) as response:
                                self.assertEqual(response.status, 200)
                            for tokens in ([1, 2], [1, 2, 3, 4, 90, 91]):
                                async with session.post(f"http://127.0.0.1:{port}/v1/chat/completions", headers=auth,
                                    json={"model": intent["lease"]["policyVersion"], "fixture_tokens": tokens}) as response:
                                    self.assertEqual(response.status, 200, await response.text())
                            result = f.feedback(intent, reward=intent["context"]["slot"])
                            address = f.address(intent)
                            self.assertEqual(journal.admit(address, result), {"valid": True})
                            journal.resolve(address, result)
                            completed.add(intent["id"])
                        await asyncio.sleep(.03)
            transformer = types.SimpleNamespace(AutoTokenizer=types.SimpleNamespace(from_pretrained=Mock(return_value=object())))
            with patch.dict(sys.modules, {"transformers": transformer}), patch("gear_training.rollout.slime_protocol", protocol), \
                 patch("gear_training.rollout.NativeSGLang", return_value=Native()), \
                 patch("gear_training.rollout.HitchClient", side_effect=AssertionError("Hitch must stay on the controller")), \
                 patch("gear_training.rollout.materialize", side_effect=AssertionError("task files must stay off the model node")):
                results = await asyncio.wait_for(asyncio.gather(collect_rollout(args, 0, f.directory), controller()), timeout=15)
            groups, usage = results[0]
            self.assertEqual(len(groups), 1); self.assertEqual(len(groups[0]), 2)
            self.assertEqual([sample.reward for sample in groups[0]], [0, 1])
            self.assertEqual(groups[0][0].loss_mask, [1, 1, 0, 0, 1])
            self.assertEqual(usage["rolloutTokens"], 6)
            self.assertEqual(f.ledger.lease("batch-0")["state"], "closed")
            self.assertFalse(f.store.path(f.private["digest"]).exists())
            batch = f.store.read_json(json.loads((f.directory / "batch.json").read_text())["batchRef"])
            self.assertEqual(batch["schemaVersion"], 2)
            self.assertEqual(len(batch["sourceEvidenceRefs"]), 10)
