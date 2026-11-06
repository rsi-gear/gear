"""TB assistant supervision through the same four-stage native controller."""
from gear.training import TrainingLoop
from gear.training.pipelines.offline_sft import DatasetTaskSource, OfflineRolloutExecutor, AssistantDatasetBuilder
from gear.training.pipelines.online_rl import SlimeModelUpdater


def build_loop(config, runtime):
    return TrainingLoop(DatasetTaskSource(runtime), OfflineRolloutExecutor(runtime),
                        AssistantDatasetBuilder(runtime), SlimeModelUpdater(runtime))
