"""A native recipe; reuse any built-in stage or replace it with your own Python class."""
from gear.training import TrainingLoop
from gear.training.pipelines.online_rl import FrozenTaskSource, HitchRolloutExecutor, PolicyDatasetBuilder, SlimeModelUpdater


def build_loop(config, runtime):
    return TrainingLoop(
        FrozenTaskSource(runtime),
        HitchRolloutExecutor(runtime),
        PolicyDatasetBuilder(runtime),
        SlimeModelUpdater(runtime),
    )
