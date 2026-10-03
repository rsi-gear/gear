import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from gear_training import TrainingLoop, TrainingConfig
from gear_training.content import ContractError
from gear_training import loop as loop_module


class Source:
    def __init__(self, calls): self.calls = calls
    def generate(self, ctx):
        self.calls.append(("tasks", ctx.round_index, ctx.checkpoint["value"], len(ctx.history), ctx.workspace))
        return [{"value": ctx.checkpoint["value"]}]


class Executor:
    def __init__(self, calls): self.calls = calls
    def execute(self, ctx, tasks):
        self.calls.append(("rollout", ctx.round_index, ctx.checkpoint["value"], len(ctx.history), ctx.workspace))
        return {"previous": tasks[0]["value"], "step": 1}


class Builder:
    def __init__(self, calls, fail_round=None): self.calls, self.fail_round = calls, fail_round
    def build(self, ctx, trajectories):
        self.calls.append(("dataset", ctx.round_index, ctx.checkpoint["value"], len(ctx.history), ctx.workspace))
        if ctx.round_index == self.fail_round: raise RuntimeError("builder interrupted")
        return {"step": trajectories["step"]}


class Updater:
    stage_id = "test-counter:v1"
    def __init__(self, calls): self.calls = calls
    def update(self, ctx, dataset):
        self.calls.append(("update", ctx.round_index, ctx.checkpoint["value"], len(ctx.history), ctx.workspace))
        return {"value": ctx.checkpoint["value"] + dataset["step"]}


class LoopTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name); self.calls = []
        self.config = TrainingConfig(self.root, 3, {"value": 0}, {"说明": "ordinary JSON"})

    def loop(self, builder=None, source=None, executor=None, updater=None):
        return TrainingLoop(source or Source(self.calls), executor or Executor(self.calls), builder or Builder(self.calls), updater or Updater(self.calls))

    def test_fixed_order_checkpoint_history_artifacts_and_completed_replay(self):
        result = self.loop().run(self.config)
        self.assertEqual(result.checkpoint, {"value": 3}); self.assertEqual(result.rounds_completed, 3)
        self.assertEqual([item[0] for item in self.calls], ["tasks", "rollout", "dataset", "update"] * 3)
        self.assertEqual([item[2] for item in self.calls], [0] * 4 + [1] * 4 + [2] * 4)
        self.assertEqual([item[3] for item in self.calls], [0] * 4 + [1] * 4 + [2] * 4)
        self.assertEqual(len({item[4] for item in self.calls}), 12)
        for name in ("task-source", "rollout-executor", "dataset-builder", "model-updater"):
            record = json.loads((self.root / "rounds/000000" / name / "result.json").read_text())
            self.assertEqual(record["inputDigest"], json.loads((self.root / "rounds/000000" / name / "input.json").read_text())["inputDigest"])
            self.assertEqual(record["outputDigest"], loop_module._digest(record["output"]))
        self.assertEqual(self.loop().run(self.config), result); self.assertEqual(len(self.calls), 12)

    def test_partial_failure_resumes_only_unfinished_stage_and_later_rounds(self):
        with self.assertRaisesRegex(RuntimeError, "builder interrupted"):
            self.loop(builder=Builder(self.calls, fail_round=1)).run(self.config)
        before = list(self.calls)
        result = self.loop().run(self.config)
        self.assertEqual(result.checkpoint, {"value": 3})
        self.assertEqual([item[:2] for item in self.calls[len(before):]], [("dataset", 1), ("update", 1), ("tasks", 2), ("rollout", 2), ("dataset", 2), ("update", 2)])

    def test_config_and_explicit_stage_identity_drift_are_rejected(self):
        self.loop().run(self.config)
        for config in (TrainingConfig(self.root, 4, {"value": 0}, self.config.parameters),
                       TrainingConfig(self.root, 3, {"value": 9}, self.config.parameters),
                       TrainingConfig(self.root, 3, {"value": 0}, {"learning_rate": 1})):
            with self.assertRaisesRegex(ContractError, "another configuration"): self.loop().run(config)
        updater = Updater(self.calls); updater.stage_id = "test-counter:v2"
        with self.assertRaisesRegex(ContractError, "another configuration"): self.loop(updater=updater).run(self.config)

    def test_corrupt_result_and_null_identity_are_rejected(self):
        self.loop().run(self.config)
        path = self.root / "rounds/000000/task-source/result.json"
        value = json.loads(path.read_text()); value["output"][0]["value"] = 99; path.write_text(json.dumps(value))
        with self.assertRaisesRegex(ContractError, "failed its identity or digest"): self.loop().run(self.config)
        (self.root / "identity.json").write_text("null")
        with self.assertRaisesRegex(ContractError, "must contain an object"): self.loop().run(self.config)

    def test_null_completed_update_record_is_rejected_without_rerunning_updater(self):
        self.loop().run(self.config)
        count = len(self.calls)
        (self.root / "rounds/000000/model-updater/result.json").write_text("null")
        with self.assertRaisesRegex(ContractError, "must contain an object"): self.loop().run(self.config)
        self.assertEqual(len(self.calls), count)

    def test_missing_successful_stage_is_rejected_instead_of_repeating_update(self):
        self.loop().run(self.config)
        count = len(self.calls)
        (self.root / "rounds/000002/model-updater/result.json").unlink()
        with self.assertRaisesRegex(ContractError, "missing a successful stage"): self.loop().run(self.config)
        self.assertEqual(len(self.calls), count)
        (self.root / "result.json").unlink()
        (self.root / "rounds/000000/model-updater/result.json").unlink()
        with self.assertRaisesRegex(ContractError, "continuous prefix"): self.loop().run(self.config)
        self.assertEqual(len(self.calls), count)

    def test_started_later_stage_proves_previous_result_must_not_be_reexecuted(self):
        class FailingSource(Source):
            def generate(inner, ctx):
                value = super().generate(ctx)
                if ctx.round_index == 1: raise RuntimeError("source interrupted")
                return value
        source = FailingSource(self.calls)
        with self.assertRaisesRegex(RuntimeError, "source interrupted"): self.loop(source=source).run(self.config)
        count = len(self.calls)
        (self.root / "rounds/000000/model-updater/result.json").unlink()
        with self.assertRaisesRegex(ContractError, "continuous prefix"): self.loop(source=source).run(self.config)
        self.assertEqual(len(self.calls), count)

    def test_independent_workspaces_have_distinct_update_operation_ids(self):
        self.loop().run(self.config)
        first = json.loads((self.root / "rounds/000000/model-updater/result.json").read_text())["operationId"]
        another = self.root / "independent"
        config = TrainingConfig(another, self.config.rounds, self.config.initial_checkpoint, self.config.parameters)
        self.loop().run(config)
        second = json.loads((another / "rounds/000000/model-updater/result.json").read_text())["operationId"]
        self.assertNotEqual(first, second)
        self.loop().run(self.config)
        self.assertEqual(first, json.loads((self.root / "rounds/000000/model-updater/result.json").read_text())["operationId"])
        (self.root / "identity.json").unlink()
        with self.assertRaisesRegex(ContractError, "run identity is missing"): self.loop().run(self.config)

    def test_missing_update_checkpoint_is_an_error(self):
        class ForgotReturn(Updater):
            def update(inner, ctx, dataset): pass
        with self.assertRaisesRegex(ContractError, "must return a JSON checkpoint"):
            self.loop(updater=ForgotReturn(self.calls)).run(self.config)
        self.assertFalse((self.root / "rounds/000000/model-updater/result.json").exists())

    def test_stage_input_artifacts_use_history_chain_without_repeating_trajectories(self):
        class LargeExecutor(Executor):
            def execute(inner, ctx, tasks): return {"step": 1, "trajectory": "x" * 20000}
        self.loop(executor=LargeExecutor(self.calls)).run(self.config)
        sizes = []
        for index in range(3):
            path = self.root / "rounds" / f"{index:06d}" / "model-updater/input.json"
            record = json.loads(path.read_text()); sizes.append(path.stat().st_size)
            self.assertIn("historyDigest", record["inputs"])
            self.assertNotIn("history", record["inputs"])
            self.assertNotIn("arguments", record["inputs"])
        self.assertLess(max(sizes), 1000)
        self.assertEqual(sizes[0], sizes[2])

    def test_private_copies_prevent_stage_mutations_from_polluting_recovery(self):
        class MutatingExecutor(Executor):
            def execute(inner, ctx, tasks):
                tasks[0]["value"] = 900; ctx.checkpoint["value"] = 900; ctx.config.parameters["说明"] = "changed"
                if ctx.history: ctx.history[0]["checkpoint"]["value"] = 900
                return {"step": 1}
        result = self.loop(executor=MutatingExecutor(self.calls)).run(self.config)
        self.assertEqual(result.checkpoint, {"value": 3})
        self.assertEqual(result.history[0]["tasks"], [{"value": 0}])
        self.assertEqual(result.history[0]["checkpoint"], {"value": 1})
        self.assertEqual(self.config.parameters["说明"], "ordinary JSON")
        replay = self.loop(executor=MutatingExecutor(self.calls)).run(self.config)
        self.assertEqual(replay, result)

    def test_non_json_results_and_checkpoint_are_rejected_before_update(self):
        class NonJSONBuilder(Builder):
            def build(inner, ctx, trajectories): return {"object": object()}
        with self.assertRaisesRegex(ContractError, "JSON values"): self.loop(builder=NonJSONBuilder(self.calls)).run(self.config)
        self.assertFalse(any(item[0] == "update" for item in self.calls))
        with self.assertRaises(ContractError): self.loop().run(TrainingConfig(self.root / "nan", 1, {"x": float("nan")}))

    def test_update_crash_boundary_requires_updater_idempotency_and_preserves_operation_id(self):
        for idempotent in (False, True):
            operations, external = [], {}
            class ExternalUpdater:
                stage_id = "external:v1"
                def update(inner, ctx, dataset):
                    operations.append(ctx.operation_id)
                    if idempotent and ctx.operation_id in external: return external[ctx.operation_id]
                    output = {"value": len(external) + 1}
                    external[ctx.operation_id if idempotent else str(len(external))] = output
                    return output
            config = TrainingConfig(self.root / str(idempotent), 1, {"value": 0})
            normal_write = loop_module._write
            def crash_after_update(path, value):
                if path.name == "result.json" and path.parent.name == "model-updater": raise OSError("disk unavailable after external update")
                return normal_write(path, value)
            with patch.object(loop_module, "_write", crash_after_update), self.assertRaisesRegex(OSError, "disk unavailable"):
                self.loop(updater=ExternalUpdater()).run(config)
            result = self.loop(updater=ExternalUpdater()).run(config)
            self.assertEqual(operations[0], operations[1])
            self.assertEqual(result.checkpoint["value"], 1 if idempotent else 2)
            self.assertEqual(len(external), 1 if idempotent else 2)

    def test_real_cpu_example_updates_model_and_replays_completed_run(self):
        example = Path(__file__).resolve().parents[2] / "examples/training-loop/linear_cpu.py"
        command = [sys.executable, str(example), "--workspace", str(self.root / "linear"), "--rounds", "12"]
        first = subprocess.run(command, capture_output=True, text=True, check=True)
        result = json.loads(first.stdout)
        self.assertLess(result["final_loss"], result["initial_loss"] / 1_000_000)
        self.assertLess(abs(result["checkpoint"]["weight"] - 3.0), 0.001)
        second = subprocess.run(command, capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(second.stdout), result)


class AsyncLoopTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    async def test_mixed_async_and_sync_stages_and_run_guard(self):
        class Tasks:
            def generate(self, ctx): return asyncio.sleep(0, result=[ctx.checkpoint])
        class Rollouts:
            async def execute(self, ctx, tasks): return tasks[0] + 1
        class Dataset:
            def build(self, ctx, trajectories): return trajectories
        class Update:
            async def update(self, ctx, dataset): return dataset
        loop = TrainingLoop(Tasks(), Rollouts(), Dataset(), Update())
        config = {"workspace": self.root, "rounds": 3, "initial_checkpoint": 0}
        with self.assertRaisesRegex(ContractError, "arun"): loop.run(config)
        result = await loop.arun(config)
        self.assertEqual(result.checkpoint, 3)
        self.assertEqual((await loop.arun(config)).checkpoint, 3)

    async def test_workspace_mutex_rejects_concurrent_loop_without_waiting(self):
        entered, release = asyncio.Event(), asyncio.Event()
        class Tasks:
            async def generate(self, ctx): entered.set(); await release.wait(); return []
        class Next:
            def execute(self, ctx, tasks): return []
            def build(self, ctx, trajectories): return []
            def update(self, ctx, dataset): return 1
        loop = TrainingLoop(Tasks(), Next(), Next(), Next()); config = TrainingConfig(self.root, 1, 0)
        running = asyncio.create_task(loop.arun(config)); await entered.wait()
        try:
            with self.assertRaisesRegex(ContractError, "another loop owns"): await loop.arun(config)
        finally: release.set()
        self.assertEqual((await running).checkpoint, 1)


if __name__ == "__main__": unittest.main()
