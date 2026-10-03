"""Real four-stage driver + HTTP capture/journal, with CPU Slime actor doubles."""
import asyncio
from contextlib import contextmanager
import json
import os
from pathlib import Path
import socket
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from episode_fixture import EpisodeFixture
import test_driver_memory as driver_fixture
from test_placement import MemoryRuntime, Remote, Ref, HYPERPARAMETERS
from gear_training.content import ContractError, atomic_json, digest_json
from gear_training.driver import run, SlimeRoundRuntime
from gear_training.episodes import EpisodeJournal
from gear_training.ledger import Ledger
from gear_training.placement import resource_plan
from gear_training.rollout import generate_rollout
from gear_training import dev_grpo


class Sample:
    class Status: COMPLETED = "completed"
    def __init__(self): self.metadata = {}


class Output:
    def __init__(self, samples, metrics): self.samples, self.metrics = samples, metrics


class DevGRPOTests(unittest.TestCase):
    def setUp(self):
        self.d = driver_fixture.DriverMemoryTests(); self.d.setUp(); self.addCleanup(self.d.doCleanups)
        old_store = self.d.store
        self.f = EpisodeFixture(self.d.root / "native-fixture"); self.addCleanup(self.f.close)
        self.f.ledger.drain(self.f.lease["batchId"]); self.f.ledger.close_lease(self.f.lease["batchId"])
        self.d.root, self.d.store = self.f.directory, self.f.store
        for ref in (self.d.hf, self.d.state_ref, self.d.request["trainer"]["hyperparametersRef"]):
            self.d.store.put_bytes(old_store.read_bytes(ref), ref["mediaType"])
        request = self.f.request
        request["trainer"].update({key: value for key, value in self.d.request["trainer"].items() if key != "placement"})
        source = self.d.store.put_bytes(b"from gear_training.dev_grpo import build_loop\n", "application/octet-stream")
        request["trainer"]["script"] = {"entrypoint": "recipe:build_loop", "sourceRef": self.d.store.put_json({"schemaVersion": 1, "kind": "training-script-source", "files": [{"path": "recipe.py", "contentRef": source}]})}
        request["trainer"]["runtimeLock"]["protocolDigest"] = self.f.ref["digest"]
        request["parentModel"].update(self.d.request["parentModel"])
        request["deployment"] = {"modelRuntime": {"nodeId": "cpu-fixture"}, "gpuScheduling": {"actorRollout": "colocated"}}
        request["referenceModelRef"] = self.d.store.put_json({"hfSnapshotRef": self.d.hf})
        request["trainDataset"]["tasks"] = [{**request["trainDataset"]["tasks"][0], "id": name} for name in ("train-a", "train-b")]
        self.d.request = request
        self.config = {**self.f.config, "slimePath": str(self.d.root)}
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0)); self.config["gatewayPort"] = sock.getsockname()[1]
        self.d.args.hf_checkpoint = "cpu-fixture"
        self.native_events, self.preprocessed, self.native_calls, self.controller_errors = [], [], [], []
        self.reject_first_group = False
        self.reset_runtime()

    def reset_runtime(self):
        self.d.rt = MemoryRuntime(); self.d.rt.events = self.native_events
        engine = SimpleNamespace(get_url=Remote(lambda: "http://native-double"), get_weight_version=Remote(lambda: 1))
        self.d.rt.manager.get_updatable_engines_and_lock = Remote(lambda: ([engine], None, None, None, None, None))
        self.d.rt.manager.generate = Remote(self.preprocess)
        self.d.rt.manager.dispose = Remote(lambda: self.d.rt.event("dispose"))
        self.d.rt.ray.init = lambda **kwargs: self.d.assertEqual(kwargs["num_gpus"], 1)
        self.d.rt.ray.shutdown = lambda: self.d.rt.event("shutdown")
        self.d.rt.actor.async_train = lambda rollout_id, data: Ref(lambda: self.train(rollout_id, data))

    def preprocess(self, rollout_id):
        self.assertTrue(self.d.rt.weights and self.d.rt.kv)
        self.d.rt.event("preprocess")
        runtime = json.loads((self.d.root / "runtime.json").read_text())
        self.assertIn("replayBatchRef", runtime)
        output = generate_rollout(self.d.args, rollout_id, None)
        self.preprocessed.append(output)
        return {"preprocessed": output, "slime_backend_object": True}

    def train(self, rollout_id, data):
        self.assertTrue(data["slime_backend_object"])
        samples = data["preprocessed"].samples[0]
        self.assertEqual([sample.tokens for sample in samples], [[1, 2, 3, 4, 90, 91, 5]] * 2)
        self.assertEqual(samples[0].loss_mask, [1, 1, 0, 0, 1])
        self.assertEqual(samples[0].rollout_log_probs, [-.1, -.1, 0.0, 0.0, -.1])
        self.assertEqual([sample.reward for sample in samples], [0, 1])
        self.d.rt.train()

    async def controller(self, stopped):
        import aiohttp
        journal = EpisodeJournal(self.d.root)
        proxy = SimpleNamespace(journal=journal, ledger=journal.ledger, private=self.f.private,
                                store=self.d.store, ref=self.f.ref, address=EpisodeFixture.address)
        try:
            async with aiohttp.ClientSession() as session:
                while not stopped.is_set():
                    for entry in journal.list(renew=True)["entries"]:
                        if entry["result"] or entry["cancelRequested"]: continue
                        intent = entry["intent"]; auth = {"Authorization": "Bearer " + intent["credential"]}
                        endpoint = f"http://127.0.0.1:{intent['gateway']['nodePort']}"
                        run_id = "run_" + digest_json(intent["id"])[7:39]
                        async with session.post(endpoint + "/v1/hitch/run", headers=auth,
                            json={"runId": run_id, "bindingId": intent["binding"]["bindingId"]}) as response:
                            self.assertEqual(response.status, 200, await response.text())
                        for tokens in ([1, 2], [1, 2, 3, 4, 90, 91]):
                            async with session.post(endpoint + "/v1/chat/completions", headers=auth,
                                json={"model": intent["lease"]["policyVersion"], "fixture_tokens": tokens}) as response:
                                self.assertEqual(response.status, 200, await response.text())
                        reward = 0 if self.reject_first_group and intent["context"]["groupId"].endswith("-group-0") else intent["context"]["slot"]
                        result = EpisodeFixture.feedback(proxy, intent, reward=reward)
                        journal.resolve(EpisodeFixture.address(intent), result)
                    await asyncio.sleep(.01)
        finally: journal.close()

    @contextmanager
    def cpu_runtime(self, controller=True):
        atomic_json(self.d.root / "request.json", self.d.request); atomic_json(self.d.root / "config.json", self.config)
        _, values, _ = resource_plan(self.d.request, HYPERPARAMETERS["slimeArgs"])
        for key, value in values.items(): setattr(self.d.args, key[2:].replace("-", "_"), value)
        modules = {"ray": self.d.rt.ray, "slime.utils.arguments": SimpleNamespace(parse_args=lambda: self.d.args),
            "slime.ray.placement_group": SimpleNamespace(create_placement_groups=lambda args: {"rollout": None, "actor": None},
                create_rollout_manager=self.d.create_manager, create_training_models=self.d.create_actor),
            "slime.utils.logging_utils": SimpleNamespace(configure_logger=lambda: None, init_tracking=lambda *args: None, finish_tracking=lambda *args: None),
            "slime.utils.types": SimpleNamespace(Sample=Sample), "slime.rollout.base_types": SimpleNamespace(RolloutFnTrainOutput=Output),
            "transformers": SimpleNamespace(AutoTokenizer=SimpleNamespace(from_pretrained=Mock(return_value=object())))}
        owner = self
        class Native:
            expected_weight_version = "1"
            async def generate(self, payload):
                owner.native_calls.append(payload)
                output = [3, 4] if len(payload["input_ids"]) == 2 else [5]
                return {"text": "native fixture", "output_ids": output, "meta_info": {"weight_version": "1", "completion_tokens": len(output),
                    "output_token_logprobs": [[-.1, token] for token in output], "finish_reason": {"type": "stop"}}}
        def protocol(*args):
            return lambda body: body["fixture_tokens"], lambda data, body, inputs, outputs: {"choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": data["text"]}}]}
        stopped = threading.Event()
        def worker():
            try: asyncio.run(self.controller(stopped))
            except BaseException as error: self.controller_errors.append(error)
        thread = threading.Thread(target=worker)
        with patch.dict(sys.modules, modules), patch.dict(os.environ, {"GEAR_TRAINING_JOB": str(self.d.root)}),              patch.object(sys, "argv", []), patch.object(sys, "path", sys.path[:]),              patch("gear_training.gpu_visibility.verify_visible_devices"),              patch("gear_training.driver.materialize", side_effect=self.d.materialize),              patch("gear_training.checkpoint_export.checkpoint_exporter", side_effect=self.d.exporter),              patch("gear_training.export.seal_directory", return_value=self.d.state_ref),              patch("gear_training.driver.commit_checkpoint", side_effect=self.d.commit),              patch("gear_training.rollout.slime_protocol", protocol), patch("gear_training.rollout.NativeSGLang", return_value=Native()):
            if controller: thread.start()
            try: yield
            finally:
                stopped.set()
                if controller: thread.join(5); self.assertFalse(thread.is_alive())
                self.assertEqual(self.controller_errors, [])

    def stage(self, name, index=0):
        return json.loads((self.d.root / "four-stage-loop/rounds" / f"{index:06d}" / name / "result.json").read_text())["output"]

    def test_real_driver_uses_raw_builder_and_native_preprocessing_in_two_rounds(self):
        with self.cpu_runtime(): run(self.d.root)
        self.assertEqual(self.native_events.count("train"), 2); self.assertEqual(self.native_events.count("preprocess"), 2)
        self.assertEqual([self.stage("task-source", index)[0]["id"] for index in range(2)], ["train-a", "train-b"])
        # Two fresh rounds, each with G=2 episodes and two native requests.
        # Updater preprocessing must not resample, nor may round 1 reuse round 0.
        self.assertEqual(len(self.native_calls), 8)
        rounds = [self.stage("rollout-executor", index) for index in range(2)]
        self.assertEqual([value["rolloutId"] for value in rounds], [0, 1])
        self.assertNotEqual(rounds[0]["lease"]["policyVersion"], rounds[1]["lease"]["policyVersion"])
        run_ids = [{self.d.store.read_json(raw["context_ref"])["runId"]
                    for group in value["groups"] for raw in group} for value in rounds]
        self.assertEqual([len(ids) for ids in run_ids], [2, 2])
        self.assertFalse(run_ids[0] & run_ids[1])
        raw = self.stage("rollout-executor")
        self.assertEqual(raw["kind"], "raw-grpo-round"); self.assertNotIn("batchRef", raw)
        self.assertEqual(raw["lease"]["state"], "closed")
        dataset = self.stage("dataset-builder"); updater = self.stage("model-updater")
        self.assertEqual(dataset["batchRef"]["digest"], self.d.store.read_json(updater["commitRef"])["consumedBatchDigest"])
        self.assertEqual(updater["committedUpdate"], 1)
        checkpoint = self.d.store.read_json(updater["checkpointRef"])
        self.assertNotIn("replayOfBatch", self.d.store.read_json(checkpoint["dataCursorRef"]))
        self.assertFalse(self.d.store.path(self.f.private["digest"]).exists())

    def test_bounded_whole_group_resampling_keeps_exact_zero_reward(self):
        self.d.request["trainer"]["updatesPerCandidate"] = 1
        self.d.request["rollout"]["zeroVarianceGroup"] = "skip-with-bounded-resampling"; self.reject_first_group = True
        with self.cpu_runtime(): run(self.d.root)
        self.assertEqual(self.f.ledger.usage()["groupResamples"], 1)
        self.assertEqual(self.f.ledger.usage()["rolloutTokens"], 12)
        raw = self.stage("rollout-executor")
        selected = self.d.store.read_json(raw["groups"][0][0]["context_ref"])
        self.assertEqual(selected["taskId"], "train-b"); self.assertTrue(selected["groupId"].endswith("-group-1"))
        self.assertEqual([sample.reward for sample in self.preprocessed[0].samples[0]], [0, 1])

    def test_raw_and_sealed_builder_gaps_resume_without_new_generation(self):
        self.d.request["trainer"]["updatesPerCandidate"] = 1
        normal = dev_grpo.GRPODatasetBuilder.build
        for seal_first in (False, True):
            if seal_first:
                # Reuse another clean fixture, so each gap is a complete job.
                self.doCleanups(); self.setUp(); self.d.request["trainer"]["updatesPerCandidate"] = 1
            async def interrupted(builder, ctx, trajectories):
                if seal_first: await normal(builder, ctx, trajectories)
                raise RuntimeError("builder result gap")
            with self.cpu_runtime(), patch.object(dev_grpo.GRPODatasetBuilder, "build", interrupted), self.assertRaisesRegex(RuntimeError, "builder result gap"):
                run(self.d.root)
            captured = len(self.native_calls)
            self.assertEqual(self.native_events.count("train"), 0)
            self.assertEqual(self.stage("rollout-executor")["kind"], "raw-grpo-round")
            self.reset_runtime()
            with self.cpu_runtime(): run(self.d.root)
            self.assertEqual(len(self.native_calls), captured); self.assertEqual(self.native_events.count("train"), 1)
            self.assertEqual(self.native_events.count("preprocess"), 1)

    def test_native_commit_reply_gap_finishes_public_result_without_cuda(self):
        self.d.request["trainer"]["updatesPerCandidate"] = 1; self.d.fail_commit_reply = True
        with self.cpu_runtime(), self.assertRaisesRegex(OSError, "commit response lost"): run(self.d.root)
        self.assertFalse((self.d.root / "four-stage-loop/rounds/000000/model-updater/result.json").exists())
        before = self.native_events[:]; captured = len(self.native_calls)
        with patch("gear_training.gpu_visibility.verify_visible_devices", side_effect=AssertionError("CUDA must not restart")):
            run(self.d.root)
        self.assertEqual(self.native_events, before); self.assertEqual(len(self.native_calls), captured)
        self.assertEqual(self.stage("model-updater")["committedUpdate"], 1)
        self.assertTrue((self.d.root / "four-stage-loop/result.json").exists())

    def test_pending_export_only_recovery_does_not_repeat_preprocessing_or_gradient(self):
        self.d.request["trainer"]["updatesPerCandidate"] = 1
        self.d.rt.actor.export_hf = lambda path: (_ for _ in ()).throw(OSError("export interrupted"))
        with self.cpu_runtime(), self.assertRaisesRegex(OSError, "export interrupted"): run(self.d.root)
        self.assertTrue((self.d.root / "pending-update.json").exists())
        before_train = self.native_events.count("train"); captured = len(self.native_calls)
        self.reset_runtime()
        with self.cpu_runtime(): run(self.d.root)
        self.assertEqual(self.native_events.count("train"), before_train); self.assertEqual(len(self.native_calls), captured)
        self.assertEqual(self.native_events.count("preprocess"), 1)
        self.assertEqual(self.d.created_components[-2:], ["exporter", "exporter-released"])
        self.assertEqual(self.stage("model-updater")["committedUpdate"], 1)

    def test_frozen_custom_factory_has_uniform_config_and_native_capabilities(self):
        code = b"""from gear_training.dev_grpo import build_loop as builtin, FrozenTaskSource
class CustomTasks(FrozenTaskSource):
    stage_id='custom-frozen-task-source:v1'
    async def generate(self,ctx):
        assert ctx.config.parameters == {'custom':True}
        (self.runtime.job_dir/'custom-task-source').write_text('called')
        return await super().generate(ctx)
def build_loop(config,runtime):
    assert set(config)=={'rounds','initialCheckpoint','parameters'}
    assert config['parameters']=={'custom':True}
    assert callable(runtime.hitch.collect) and callable(runtime.slime.update)
    loop=builtin(config,runtime)
    loop.stages=((loop.stages[0][0],CustomTasks(runtime),'generate'),*loop.stages[1:])
    return loop
"""
        ref=self.d.store.put_bytes(code,'application/octet-stream')
        self.d.request['trainer']['script']['sourceRef']=self.d.store.put_json({'schemaVersion':1,'kind':'training-script-source','files':[{'path':'recipe.py','contentRef':ref}]})
        self.d.request['trainer']['scriptConfig']={'custom':True}
        self.d.request['trainer']['updatesPerCandidate']=1
        with self.cpu_runtime(): run(self.d.root)
        self.assertTrue((self.d.root/'custom-task-source').exists())
        self.assertEqual(self.stage('model-updater')['committedUpdate'],1)

    def test_wrong_pipeline_and_legacy_upgrade_are_rejected_before_cuda(self):
        self.d.request["trainer"]["pipeline"] = "misspelled"
        atomic_json(self.d.root / "request.json", self.d.request); atomic_json(self.d.root / "config.json", self.config)
        with patch("gear_training.gpu_visibility.verify_visible_devices", side_effect=AssertionError("CUDA")), self.assertRaisesRegex(ContractError, "use a frozen trainer.script"):
            run(self.d.root)
        del self.d.request["trainer"]["pipeline"]
        self.d.original_batch()
        atomic_json(self.d.root / "request.json", self.d.request)
        with patch("gear_training.gpu_visibility.verify_visible_devices", side_effect=AssertionError("CUDA")), self.assertRaisesRegex(ContractError, "legacy jobs cannot upgrade"):
            run(self.d.root)
