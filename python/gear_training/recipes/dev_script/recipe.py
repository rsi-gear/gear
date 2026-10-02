"""Default Gear dev recipe, loaded through the same factory contract as custom scripts."""
from gear_training import TrainingLoop
from gear_training.dev_grpo import FrozenTaskSource, HitchRolloutExecutor, GRPODatasetBuilder, SlimeModelUpdater


def build_loop(config, runtime):
    return TrainingLoop(
        FrozenTaskSource(runtime),
        HitchRolloutExecutor(runtime),
        GRPODatasetBuilder(runtime),
        SlimeModelUpdater(runtime),
    )
