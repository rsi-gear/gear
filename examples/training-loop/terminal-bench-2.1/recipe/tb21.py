"""Terminal-Bench tasks use the same four stages as the native GRPO workflow."""
from gear_training import TrainingLoop
from gear_training.online_rl import (
    FrozenTaskSource, HitchRolloutExecutor, PolicyDatasetBuilder, SlimeModelUpdater,
)


def build_loop(config, runtime):
    return TrainingLoop(
        FrozenTaskSource(runtime),
        HitchRolloutExecutor(runtime),
        PolicyDatasetBuilder(runtime),
        SlimeModelUpdater(runtime),
    )
