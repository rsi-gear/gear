"""Four plain stages for sealed assistant supervision on the native Slime actor.

The rollout stage reads an authorized deterministic window without generation.
Only DatasetBuilder seals the window consumed by Slime's supervised-loss data
projection. No behavior-policy tokens, rewards, native lease or Hitch job is
created. Exact token roles/masks come from the sealed offline authoring contract.
"""
from .content import require, atomic_json
from .loop import TrainingLoop
from .offline import read_dataset, window, seal_batch
from .online_rl import SlimeModelUpdater
from .recipes.registry import is_sft


def selection(runtime, rollout_id):
    data = read_dataset(runtime.store, runtime.request)
    config = runtime.request["offlineTraining"]
    size = runtime.request["trainer"]["rolloutBatchSize"]
    position = rollout_id * size
    require(position + size <= len(data["records"]) * config["maxEpochs"], "offline-dataset-exhausted", "bounded offline epoch limit exhausted")
    return {"rolloutId": rollout_id, "datasetRef": config["datasetRef"],
            "recordRefs": window(data["records"], config["shuffleSeed"], position, size)}


class DatasetTaskSource:
    stage_id = "gear.offline-sft.dataset-window:v1"
    def __init__(self, runtime): self.runtime = runtime
    def generate(self, ctx):
        self.runtime.check_cancel()
        return selection(self.runtime, self.runtime.parent_start + ctx.round_index)


class OfflineRolloutExecutor:
    stage_id = "gear.offline-sft.read-records:v1"
    def __init__(self, runtime): self.runtime = runtime
    def execute(self, ctx, tasks):
        runtime = self.runtime
        rollout_id = runtime.parent_start + ctx.round_index
        runtime.prepare_round(rollout_id, checkpoint=ctx.checkpoint)
        require(tasks == selection(runtime, rollout_id), "offline-selection-drift", "task source must select this authorized deterministic window")
        return {**tasks, "records": [runtime.store.read_json(ref) for ref in tasks["recordRefs"]]}


class AssistantDatasetBuilder:
    stage_id = "gear.offline-sft.assistant-mask-dataset:v1"
    def __init__(self, runtime): self.runtime = runtime
    def build(self, ctx, trajectories):
        runtime = self.runtime
        rollout_id = runtime.parent_start + ctx.round_index
        selected = selection(runtime, rollout_id)
        expected = {**selected, "records": [runtime.store.read_json(ref) for ref in selected["recordRefs"]]}
        require(trajectories == expected, "offline-selection-drift", "dataset may not replace sealed assistant supervision")
        ref = seal_batch(runtime.store, runtime.request, rollout_id)
        atomic_json(runtime.job_dir / "batch.json", {"rolloutId": rollout_id, "batchRef": ref})
        return {"schemaVersion": 1, "kind": "offline-sft-dataset", "rolloutId": rollout_id,
                "batchRef": ref, "preUpdateHfRef": ctx.checkpoint["hfSnapshotRef"]}


def build_loop(config, runtime):
    require(is_sft(runtime.request), "offline-recipe-required", "offline stages require the sealed supervised objective")
    return TrainingLoop(DatasetTaskSource(runtime), OfflineRolloutExecutor(runtime),
                        AssistantDatasetBuilder(runtime), SlimeModelUpdater(runtime))
