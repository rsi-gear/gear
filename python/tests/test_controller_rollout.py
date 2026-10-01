import asyncio
import importlib.util
import json
import socket
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch
from pathlib import Path

from gear_training.content import digest_json
from gear_training.stage_journal import StageJournal
from gear_training.agent_stage import run_agent_stage
from gear_training.agents import AgentResult
from gear_training.export import seal_directory
from gear_training.episodes import EpisodeJournal
from gear_training.rollout import collect_rollout
from episode_fixture import EpisodeFixture


@unittest.skipUnless(importlib.util.find_spec("aiohttp"), "install the gateway extra for the real HTTP fixture")
class ControllerRolloutTest(unittest.IsolatedAsyncioTestCase):
    def fixture(self, batch_size=1):
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        fixture = EpisodeFixture(root.name)
        self.addCleanup(fixture.close)
        fixture.request["trainer"]["rolloutBatchSize"] = batch_size
        with socket.socket() as bound:
            bound.bind(("127.0.0.1", 0))
            fixture.config["gatewayPort"] = bound.getsockname()[1]
        return fixture

    async def collect_batch(self, f, rollout_id=0):
        import aiohttp
        previous_batch = f.lease["batchId"]
        if previous_batch != "batch-" + str(rollout_id) and f.ledger.lease(previous_batch)["state"] == "serving":
            f.ledger.drain(previous_batch)
            f.ledger.close_lease(previous_batch)
        f.lease["batchId"] = "batch-" + str(rollout_id)
        f.persist(rollout_id=rollout_id)
        port = f.config["gatewayPort"]
        batch_size = f.request["trainer"]["rolloutBatchSize"]
        # Separate journal connections exercise the controller/node boundary.
        journal = EpisodeJournal(f.directory)
        self.addCleanup(journal.close)
        args = types.SimpleNamespace(rollout_batch_size=batch_size, n_samples_per_prompt=2,
            global_batch_size=2, advantage_estimator="grpo", hf_checkpoint="fixture")
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
                while len(completed) < batch_size * 2 or getattr(f, "agent_runner", None) and not (f.directory / "batch.json").exists():
                    if getattr(f, "agent_runner", None):
                        stages = StageJournal(f.directory, f.store)
                        for stage in stages.list()["entries"]:
                            if stage["result"]: continue
                            payload = f.store.read_json(stage["intent"]["payloadRef"])
                            stages.inputs(stage["id"])
                            result = await run_agent_stage(f.store, f.directory / "controller-stages", stage["intent"]["stage"], stage["intent"]["config"], payload, runner=f.agent_runner)
                            stages.resolve(stage["id"], {"outcome": "completed", "result": result}, lease=stage["lease"])
                    for entry in journal.list(renew=True)["entries"]:
                        intent = entry["intent"]
                        if intent["id"] in completed: continue
                        auth = {"Authorization": "Bearer " + intent["credential"]}
                        run_id = "run_" + digest_json(intent["id"])[7:39]
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
            results = await asyncio.wait_for(asyncio.gather(collect_rollout(args, rollout_id, f.directory), controller()), timeout=15)
        return results[0]

    async def test_task_rotation_across_update_positions(self):
        cases = [
            ("successive updates", [0, 1, 2], 1, ["train-a", "train-b", "train-c"]),
            ("nonzero update", [2], 1, ["train-c"]),
            ("multiple groups wrap", [1, 2], 2, ["train-c", "train-a", "train-b", "train-c"]),
        ]
        for name, rollout_ids, batch_size, expected in cases:
            with self.subTest(name=name):
                f = self.fixture(batch_size)
                f.request["trainDataset"]["tasks"] = [
                    {**f.request["trainDataset"]["tasks"][0], "id": task_id}
                    for task_id in ("train-a", "train-b", "train-c")]
                selected = []
                for rollout_id in rollout_ids:
                    groups, _ = await self.collect_batch(f, rollout_id)
                    selected.extend(f.ledger.context(group[0].metadata["episodeId"])["taskId"] for group in groups)
                self.assertEqual(selected, expected)

    async def test_v2_full_batch_uses_controller_journal_and_exact_gateway_without_hitch_on_node(self):
        f = self.fixture()
        groups, usage = await self.collect_batch(f)
        self.assertEqual(len(groups), 1); self.assertEqual(len(groups[0]), 2)
        self.assertEqual([sample.reward for sample in groups[0]], [0, 1])
        self.assertEqual(groups[0][0].loss_mask, [1, 1, 0, 0, 1])
        self.assertEqual(usage["rolloutTokens"], 6)
        self.assertEqual(f.ledger.lease("batch-0")["state"], "closed")
        self.assertFalse(f.store.path(f.private["digest"]).exists())
        batch = f.store.read_json(json.loads((f.directory / "batch.json").read_text())["batchRef"])
        self.assertEqual(batch["schemaVersion"], 2)
        self.assertEqual(len(batch["sourceEvidenceRefs"]), 14)
        self.assertEqual(sum(f.store.read_json(ref).get("kind") == "raw-trajectory" for ref in batch["sourceEvidenceRefs"]), 2)

    async def test_generated_tasks_and_custom_dataset_runner_use_real_collection_bridge(self):
        f = self.fixture()
        source = f.directory / "source" / "train"; source.mkdir(parents=True)
        (source / "task.toml").write_text("[task]\n")
        (source / "instruction.md").write_text("Train-only exercise")
        f.request["trainDataset"]["tasks"][0].update(family="train-family", taskRef=seal_directory(f.store, source, dataset=True))
        config = {"runner": "custom-test-provider", "options": {}, "instructionsRef": f.store.put_bytes(b"Generate or select the requested training data", "text/plain"), "maxRepairs": 1, "timeoutSeconds": 3}
        f.request["stages"] = {"taskSource": config, "datasetBuilder": config}
        calls = []
        class Runner:
            async def run(self, request):
                payload = json.loads((request.workspace / "inputs/index.json").read_text())
                outputs = request.workspace / "outputs"
                if "tasks" in payload:
                    calls.append("task-source")
                    self_test.assertEqual(payload["behaviorPolicyRef"], f.lease["synchronizedWeightsRef"])
                    self_test.assertEqual(payload["history"], [])
                    generated = outputs / "generated-a"; generated.mkdir()
                    (generated / "task.toml").write_text("[task]\n")
                    (generated / "instruction.md").write_text("New agent-generated training exercise")
                    manifest = {"tasks": [{"id": "generated-a", "family": "train-family", "sourceTaskId": "train", "directory": "generated-a"}]}
                else:
                    calls.append("dataset-builder")
                    self_test.assertTrue((request.workspace / "inputs/trajectory-0-call-0-rawResponseRef.json").exists())
                    manifest = {"selectedEpisodeIds": [t["episode"]["id"] for t in payload["trajectories"]], "analysis": "Keep complete native group"}
                (outputs / "manifest.json").write_text(json.dumps(manifest))
                return AgentResult("completed", log="custom runner", recovery_id="custom-id")
        self_test = self
        f.agent_runner = Runner()
        groups, usage = await self.collect_batch(f)
        self.assertEqual(calls, ["task-source", "dataset-builder"])
        self.assertEqual(f.ledger.context(groups[0][0].metadata["episodeId"])["taskId"], "generated-a")
        self.assertEqual(groups[0][0].tokens, [1, 2, 3, 4, 90, 91, 5])
        self.assertEqual([item.reward for item in groups[0]], [0, 1])
        self.assertEqual(usage["rolloutTokens"], 6)
        frozen = json.loads((f.directory / "task-source-inputs/0.json").read_text())
        self.assertEqual(frozen["payload"]["history"], [])
        self.assertFalse(f.store.path(f.private["digest"]).exists())
