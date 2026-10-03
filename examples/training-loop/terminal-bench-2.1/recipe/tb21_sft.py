"""TB assistant supervision through the same four-stage native controller."""
from gear_training import TrainingLoop
from gear_training.offline_sft import DatasetTaskSource, OfflineRolloutExecutor, AssistantDatasetBuilder
from gear_training.online_rl import SlimeModelUpdater


def build_loop(config, runtime):
    return TrainingLoop(DatasetTaskSource(runtime), OfflineRolloutExecutor(runtime),
                        AssistantDatasetBuilder(runtime), SlimeModelUpdater(runtime))
