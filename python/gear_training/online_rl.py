"""Frozen-task Hitch/Slime online policy recipes as four public stages.

The native driver calls build_loop: this composition is also the script recipe.
Slime lifecycle stays in its supervised driver, not hidden inside one stage.
Raw collection uses trusted admission probes for bounded group resampling;
DatasetBuilder alone seals the final training batch. All public stage values
are JSON/CAS identities. Slime objects never become framework JSON artifacts.
"""
from .loop import TrainingLoop
from .content import require, atomic_json
from .samples import seal_batch
from .recipes.registry import is_sft
from .stages import FrozenTaskSource as NativeTaskSource, GRPODatasetBuilder as NativeBuilder, RawTrajectory


class FrozenTaskSource:
    stage_id = "gear.dev-grpo.frozen-tasks:v1"
    def __init__(self, runtime): self.runtime = runtime
    async def generate(self, ctx):
        self.runtime.check_cancel()
        return await NativeTaskSource(self.runtime.request).tasks(self.runtime.parent_start + ctx.round_index)


class HitchRolloutExecutor:
    stage_id = "gear.dev-grpo.native-hitch:v1"
    def __init__(self, runtime): self.runtime = runtime
    async def execute(self, ctx, tasks):
        self.runtime.check_cancel()
        rollout_id = self.runtime.parent_start + ctx.round_index
        self.runtime.prepare_round(rollout_id, checkpoint=ctx.checkpoint)
        return await self.runtime.hitch.collect(rollout_id, tasks)


class PolicyDatasetBuilder:
    stage_id = "gear.dev-grpo.strict-grpo:v1"
    def __init__(self, runtime): self.runtime = runtime
    async def build(self, ctx, trajectories):
        runtime = self.runtime
        rollout_id = runtime.parent_start + ctx.round_index
        require(trajectories.get("kind") == "raw-grpo-round" and trajectories.get("schemaVersion") == 1
                and trajectories.get("rolloutId") == rollout_id, "raw-round-drift", "raw trajectories belong to another update")
        lease = runtime.ledger.lease(trajectories["lease"]["batchId"])
        require(lease == trajectories["lease"] and lease["state"] == "closed"
                and lease["synchronizedWeightsRef"] == ctx.checkpoint["hfSnapshotRef"],
                "raw-policy-drift", "dataset must retain the original quiescent pre-update policy")
        builder = NativeBuilder(runtime.store, runtime.request)
        groups = [await builder.build([RawTrajectory(**value) for value in group]) for group in trajectories["groups"]]
        batch_ref = seal_batch(runtime.store, groups, runtime.request, lease, trajectories["sourceEvidenceRefs"])
        runtime.ledger.seal(lease["batchId"], batch_ref)
        atomic_json(runtime.job_dir / "batch.json", {"rolloutId": rollout_id, "batchRef": batch_ref})
        return {"schemaVersion": 1, "kind": "grpo-dataset", "rolloutId": rollout_id,
                "batchRef": batch_ref, "batchId": lease["batchId"], "preUpdateHfRef": lease["synchronizedWeightsRef"]}


class SlimeModelUpdater:
    stage_id = "gear.dev-grpo.slime-megatron:v1"
    def __init__(self, runtime): self.runtime = runtime
    def update(self, ctx, dataset):
        return self.runtime.slime.update(self.runtime.parent_start + ctx.round_index, dataset, ctx.checkpoint, ctx.operation_id)


GRPODatasetBuilder = PolicyDatasetBuilder


def build_loop(config, runtime):
    """Native GRPO, GSPO, CISPO and REINFORCE++ use the sealed estimator."""
    require(not is_sft(runtime.request), "online-recipe-required", "use offline_sft stages for supervised data")
    return TrainingLoop(FrozenTaskSource(runtime), HitchRolloutExecutor(runtime),
                        PolicyDatasetBuilder(runtime), SlimeModelUpdater(runtime))
