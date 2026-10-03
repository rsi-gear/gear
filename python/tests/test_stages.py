import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from gear_training.agent_stage import run_agent_stage
from gear_training.agents import AgentResult
from gear_training.content import ContentStore, ContractError, atomic_json
from gear_training.stage_journal import StageJournal
from gear_training.stages import persist_trajectory, SFTDatasetBuilder, GRPODatasetBuilder
from episode_fixture import EpisodeFixture
import test_training


class StageTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name); self.store = ContentStore(self.root / "store")
        self.config = {"runner": "test-other-provider", "options": {}, "instructionsRef": self.store.put_bytes(b"Select the group", "text/plain"), "maxRepairs": 1, "timeoutSeconds": 2}
        self.payload = {"trainingRunId": "run", "trajectories": [{"episode": {"id": "a"}, "receipts": []}, {"episode": {"id": "b"}, "receipts": []}]}

    async def test_bounded_repair_then_immutable_replay_without_agent(self):
        calls = []
        class Runner:
            async def run(inner, request):
                calls.append(request)
                atomic_json(request.workspace / "outputs/manifest.json", {"selectedEpisodeIds": ["a"] if len(calls) == 1 else ["a", "b"], "analysis": "selection"})
                return AgentResult("completed", recovery_id="other-provider-thread")
        runner = Runner()
        result = await run_agent_stage(self.store, self.root / "stages", "dataset-builder", self.config, self.payload, runner=runner)
        self.assertEqual(len(calls), 2); self.assertEqual(calls[1].recovery_id, "other-provider-thread")
        replay = await run_agent_stage(self.store, self.root / "stages", "dataset-builder", self.config, self.payload, runner=runner)
        self.assertEqual(result, replay); self.assertEqual(len(calls), 2)
        self.store.path(result["outputRef"]["digest"]).write_bytes(b"corrupt")
        with self.assertRaises(ContractError): await run_agent_stage(self.store, self.root / "stages", "dataset-builder", self.config, self.payload, runner=runner)

    async def test_generated_task_snapshot_preserves_executables_and_empty_directories_on_replay_and_node(self):
        from gear_training.export import seal_directory, materialize
        source = self.root / "source" / "train"; source.mkdir(parents=True)
        (source / "task.toml").write_text("[task]\n"); (source / "instruction.md").write_text("source exercise")
        source_ref = seal_directory(self.store, source, dataset=True)
        payload = {"trainingRunId": "run", "rolloutId": 0, "maxTasks": 1, "tasks": [{"id": "train", "family": "family", "taskRef": source_ref, "environmentRef": self.store.put_json({"environment": "policy"})}]}
        calls = []
        class Runner:
            async def run(inner, request):
                calls.append(request)
                output = request.workspace / "outputs"; task = output / "generated"; task.mkdir()
                (task / "empty").mkdir(); (task / "tests").mkdir()
                (task / "__init__.py").write_bytes(b"")
                (task / "task.toml").write_text("[task]\n"); (task / "instruction.md").write_text("generated exercise")
                script = task / "tests/test.sh"; script.write_text("#!/bin/sh\nexit 0\n"); script.chmod(0o755)
                atomic_json(output / "manifest.json", {"tasks": [{"id": "generated", "family": "family", "directory": "generated", "sourceTaskId": "train"}]})
                return AgentResult("completed")
        result = await run_agent_stage(self.store, self.root / "mode-stage", "task-source", self.config, payload, runner=Runner())
        replay = await run_agent_stage(self.store, self.root / "mode-stage", "task-source", self.config, payload, runner=Runner())
        self.assertEqual(result, replay); self.assertEqual(len(calls), 1)
        task_ref = self.store.read_json(result["outputRef"])["tasks"][0]["taskRef"]
        task = materialize(self.store, task_ref, self.root / "restored-task")
        self.assertEqual((task / "tests/test.sh").stat().st_mode & 0o777, 0o755); self.assertTrue((task / "empty").is_dir())
        node = ContentStore(self.root / "node-modes")
        for ref in (result["snapshotRef"], task_ref):
            node.put_bytes(self.store.read_bytes(ref), ref["mediaType"])
            for file in self.store.read_json(ref)["files"]: node.put_bytes(self.store.read_bytes(file["contentRef"]), file["contentRef"]["mediaType"])
        restored = materialize(node, result["snapshotRef"], self.root / "remote-stage")
        self.assertEqual((restored / "generated/tests/test.sh").stat().st_mode & 0o777, 0o755)
        self.assertTrue((restored / "generated/empty").is_dir())

    async def test_wrong_json_types_enter_bounded_validation_repair(self):
        calls = []
        class Runner:
            async def run(inner, request):
                calls.append(request)
                value = [] if len(calls) == 1 else {"selectedEpisodeIds": [{}], "analysis": "wrong type"} if len(calls) == 2 else {"selectedEpisodeIds": ["a", "b"], "analysis": "fixed"}
                (request.workspace / "outputs/manifest.json").write_text(json.dumps(value))
                return AgentResult("completed", recovery_id="type-repair")
        result = await run_agent_stage(self.store, self.root / "wrong-types", "dataset-builder", {**self.config, "maxRepairs": 2}, self.payload, runner=Runner())
        self.assertEqual(len(calls), 3); self.assertEqual(self.store.read_json(result["outputRef"])["selectedEpisodeIds"], ["a", "b"])

    async def test_crashed_runner_recovers_persisted_native_thread(self):
        calls = []
        class Runner:
            async def run(inner, request):
                calls.append(request.recovery_id)
                if len(calls) == 1:
                    atomic_json(request.workspace / "runner.json", {"recoveryId": "persisted-before-turn"})
                    raise RuntimeError("transport lost")
                atomic_json(request.workspace / "outputs/manifest.json", {"selectedEpisodeIds": ["a", "b"], "analysis": "retry"})
                return AgentResult("completed", recovery_id=request.recovery_id)
        runner = Runner()
        with self.assertRaisesRegex(ContractError, "transport lost"):
            await run_agent_stage(self.store, self.root / "stages", "dataset-builder", self.config, self.payload, runner=runner)
        await run_agent_stage(self.store, self.root / "stages", "dataset-builder", self.config, self.payload, runner=runner)
        self.assertEqual(calls, [None, "persisted-before-turn"])

    async def test_custom_runner_timeout_and_preregistration_cancel_are_enforced(self):
        finished = asyncio.Event()
        class Runner:
            async def run(inner, request):
                try: await asyncio.sleep(30)
                finally: finished.set()
        with self.assertRaisesRegex(ContractError, "timeout"):
            await run_agent_stage(self.store, self.root / "stages", "dataset-builder", {**self.config, "timeoutSeconds": .01}, self.payload, runner=Runner())
        self.assertTrue(finished.is_set())
        cancel = self.root / "execution/cancel.json"; atomic_json(cancel, {"cancelled": True})
        runner = Runner()
        with self.assertRaisesRegex(ContractError, "cancelled"):
            await run_agent_stage(self.store, self.root / "other", "dataset-builder", self.config, self.payload, runner=runner, cancel_path=cancel)
        self.assertFalse((self.root / "other").exists())

    async def test_sft_requires_explicit_success_or_verified_prefix_and_keeps_failed_raw(self):
        fixture = test_training.TrainingTest(); fixture.setUp(); self.addCleanup(fixture.tearDown)
        episode, receipts, feedback = fixture.bundle(); episode["termination"] = "truncated"
        raw, ref = persist_trajectory(fixture.store, self.root, episode, feedback, [fixture.store.put_json(item) for item in receipts], fixture.context)
        request = {"rollout": {"groupSize": 2, "zeroVarianceGroup": "keep"}}
        with self.assertRaises(ContractError): await GRPODatasetBuilder(fixture.store, request).build([raw])
        builder = SFTDatasetBuilder(fixture.store)
        self.assertEqual(fixture.store.read_json(await builder.build([raw]))["samples"], [])
        proof = fixture.store.put_json({"kind": "verified-prefix", "episodeId": episode["id"], "runId": episode["runId"],
            "verified": True, "receiptCount": 1, "receiptDigests": [raw.receipt_refs[0]["digest"]], "evidenceRef": fixture.ref})
        samples = fixture.store.read_json(await builder.build([raw], verifications={episode["id"]: proof}))["samples"]
        self.assertEqual(samples[0]["tokens"], [1, 2, 3, 4, 5]); self.assertEqual(samples[0]["lossMask"], [1, 1])
        self.assertEqual(fixture.store.read_json(raw.episode_ref)["termination"], "truncated")
        self.assertEqual(fixture.store.read_json(raw.feedback_ref)["reward"], 0)

    async def test_verified_success_is_explicit_even_when_final_reward_is_zero(self):
        fixture = test_training.TrainingTest(); fixture.setUp(); self.addCleanup(fixture.tearDown)
        episode, receipts, feedback = fixture.bundle()
        raw, _ = persist_trajectory(fixture.store, self.root, episode, feedback, [fixture.store.put_json(item) for item in receipts], fixture.context)
        proof = fixture.store.put_json({"kind": "verified-success", "episodeId": episode["id"], "runId": episode["runId"], "verified": True,
            "receiptDigests": [ref["digest"] for ref in raw.receipt_refs], "evidenceRef": fixture.ref})
        result = fixture.store.read_json(await SFTDatasetBuilder(fixture.store).build([raw], verifications={episode["id"]: proof}))
        self.assertEqual(len(result["samples"]), 1)
        self.assertEqual(result["samples"][0]["tokens"], [1, 2, 3, 4, 5, 90, 91, 92, 6, 7, 8])
        self.assertEqual(fixture.store.read_json(raw.feedback_ref)["reward"], 0)

    async def test_v2_sft_validates_assembly_without_private_task_materials(self):
        f = EpisodeFixture(self.root / "v2-sft"); self.addCleanup(f.close)
        intent = f.publish(); receipts = f.generate(intent); result = f.feedback(intent)
        episode = f.store.read_json(result["episodeRef"]); feedback = f.store.read_json(result["feedbackRef"])
        context = f.ledger.context(intent["id"]); assembly = f.store.read_json(result["assemblyRef"])
        raw, _ = persist_trajectory(f.store, f.directory, episode, feedback, receipts, context, assembly)
        proof = f.store.put_json({"kind": "verified-success", "episodeId": episode["id"], "runId": episode["runId"], "verified": True,
            "receiptDigests": [ref["digest"] for ref in receipts], "evidenceRef": f.ref})
        output = f.store.read_json(await SFTDatasetBuilder(f.store).build([raw], verifications={episode["id"]: proof}))
        self.assertEqual(len(output["samples"]), 1); self.assertFalse(f.store.path(f.private["digest"]).exists())
        prefix = f.store.put_json({"kind": "verified-prefix", "episodeId": episode["id"], "runId": episode["runId"], "verified": True,
            "receiptCount": 1, "receiptDigests": [receipts[0]["digest"]], "evidenceRef": f.ref})
        prefix_output = f.store.read_json(await SFTDatasetBuilder(f.store).build([raw], verifications={episode["id"]: prefix}))
        self.assertEqual(prefix_output["samples"][0]["tokens"], [1, 2, 3, 4])
        from dataclasses import replace
        bad = replace(raw, assembly_ref=f.store.put_json({**assembly, "taskDigest": f.ref["digest"]}))
        with self.assertRaises(ContractError): await SFTDatasetBuilder(f.store).build([bad], verifications={episode["id"]: proof})

    async def test_split_store_candidate_provenance_retains_opaque_agent_outputs(self):
        from gear_training.node_artifacts import retain_graph
        config = {**self.config, "maxRepairs": 0}
        from gear_training.export import seal_directory
        source = self.root / "retention-source" / "train"; source.mkdir(parents=True)
        (source / "task.toml").write_text("[task]\n"); (source / "instruction.md").write_text("source task")
        environment_ref = self.store.put_json({"policy": "frozen source environment"})
        payload = {"trainingRunId": "run", "behaviorPolicyRef": self.store.put_json({"modelWeights": "must stay private"}),
                   "maxTasks": 1, "tasks": [{"id": "train", "family": "f", "taskRef": seal_directory(self.store, source, dataset=True), "environmentRef": environment_ref}]}
        class Runner:
            async def run(inner, request):
                task = request.workspace / "outputs" / "generated"; task.mkdir()
                (task / "empty").mkdir(); (task / "tests").mkdir()
                (task / "__init__.py").write_bytes(b"")
                (task / "task.toml").write_text("[task]\n"); (task / "instruction.md").write_text("generated task")
                script = task / "tests/test.sh"; script.write_text("#!/bin/sh\nexit 0\n"); script.chmod(0o755)
                # A JSON task file is opaque, even if it resembles a CAS ref.
                (task / "data.json").write_text('{"uri":"cas:sha256:' + 'a' * 64 + '","digest":"sha256:' + 'a' * 64 + '","mediaType":"application/json"}')
                atomic_json(request.workspace / "outputs/manifest.json", {"tasks": [{"id": "generated", "family": "f", "directory": "generated", "sourceTaskId": "train"}]})
                return AgentResult("completed", log="")
        sealed = await run_agent_stage(self.store, self.root / "retention-stage", "task-source", config, payload, runner=Runner())
        self.assertEqual(self.store.read_json(sealed["runner"]["logRef"]), {"schemaVersion": 1, "kind": "agent-stage-log", "text": ""})
        node = ContentStore(self.root / "node")
        task = self.store.read_json(sealed["outputRef"])["tasks"][0]
        for ref in (sealed["inputRef"], sealed["outputRef"], sealed["snapshotRef"], sealed["runner"]["logRef"], task["taskRef"], task["environmentRef"], environment_ref):
            node.put_bytes(self.store.read_bytes(ref), ref["mediaType"])
        for ref in (sealed["snapshotRef"], task["taskRef"]):
            for file in self.store.read_json(ref)["files"]: node.put_bytes(self.store.read_bytes(file["contentRef"]), file["contentRef"]["mediaType"])
        stage_ref = node.put_json(sealed)
        batch_ref = node.put_json({"sourceEvidenceRefs": [stage_ref]})
        checkpoint_ref = node.put_json({"checkpoint": "complete"})
        commit_ref = node.put_json({"schemaVersion": 1, "checkpointRef": checkpoint_ref, "consumedBatchDigest": batch_ref["digest"]})
        response = retain_graph(node, {"nodeId": "test", "generation": "boot"}, {"roots": [commit_ref]})
        self.assertIn("receipt", response)
        self.assertFalse(node.path(payload["behaviorPolicyRef"]["digest"]).exists())
        self.assertTrue(any(item["kind"] == "file" for item in response["receipt"]["objects"]))
        from gear_training.export import materialize
        restored = materialize(node, task["taskRef"], self.root / "retained-generated")
        self.assertEqual((restored / "tests/test.sh").stat().st_mode & 0o777, 0o755)
        self.assertTrue((restored / "empty").is_dir())

    async def test_real_cli_stop_before_registration_prevents_custom_runner_execution(self):
        import os, subprocess, sys
        stage_root = self.root / "cli-stage"; execution = self.root / "cli-execution"; response = execution / "response.json"
        command = [sys.executable, "-m", "gear_training.stages", "--store-root", str(self.store.root), "--workspace", str(stage_root),
                   "--execution-root", str(execution), "--response-file", str(response)]
        stopped = subprocess.run([*command, "--stop"], capture_output=True, text=True, check=True)
        self.assertTrue(json.loads(stopped.stdout)["stopped"])
        marker = self.root / "runner-was-called"
        module = self.root / "custom_cli_runner.py"
        module.write_text("from pathlib import Path\ndef factory(provider, options):\n    Path(" + repr(str(marker)) + ").write_text('called')\n    raise RuntimeError('must not run after pause')\n")
        env = {**os.environ, "GEAR_AGENT_RUNNER_FACTORY": "custom_cli_runner:factory", "PYTHONPATH": str(self.root) + os.pathsep + os.environ.get("PYTHONPATH", "")}
        completed = subprocess.run(command, input=json.dumps({"stage": "dataset-builder", "config": self.config, "payload": self.payload}), env=env, capture_output=True, text=True)
        self.assertNotEqual(completed.returncode, 0); self.assertFalse(marker.exists())
        self.assertEqual(json.loads(response.read_text())["outcome"], "infra-error")

    async def test_journal_fences_closed_leases_and_retries_infra_on_new_incarnation(self):
        f = EpisodeFixture(self.root / "journal"); self.addCleanup(f.close)
        journal = StageJournal(f.directory, f.store)
        config = {"runner": "other"}; payload = {"trainingRunId": "train-test"}
        identity = journal.publish("task-source", config, payload, f.lease)
        journal.resolve(identity, {"outcome": "infra-error", "message": "temporary transport failure"}, lease=f.lease)
        f.ledger.drain(f.lease["batchId"]); f.ledger.close_lease(f.lease["batchId"])
        self.assertTrue(journal.list()["entries"][0]["cancelRequested"])
        lease = {**f.lease, "runtimeInstanceId": "runtime-2", "batchId": "batch-new", "policyVersion": "new-policy"}
        replay = journal.publish("task-source", config, payload, lease)
        self.assertEqual(replay, identity); self.assertIsNone(journal.list()["entries"][0]["result"])
        with self.assertRaises(ContractError): journal.inputs("sha256:../../escape")
