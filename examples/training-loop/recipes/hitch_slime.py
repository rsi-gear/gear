"""A native recipe; reuse any built-in stage or replace it with your own Python class."""
from gear_training import TrainingLoop
from gear_training.dev_grpo import FrozenTaskSource, HitchRolloutExecutor, GRPODatasetBuilder, SlimeModelUpdater


def build_loop(config, runtime):
    return TrainingLoop(
        FrozenTaskSource(runtime),
        HitchRolloutExecutor(runtime),
        GRPODatasetBuilder(runtime),
        SlimeModelUpdater(runtime),
    )
