"""Public four-stage training API. Backend and command-line dependencies are lazy imports."""

# The public CPU-friendly loop has no optional agent/GPU dependencies.
from gear.training.contracts import (
    DatasetBuilder,
    ModelUpdater,
    RolloutExecutor,
    TaskSource,
    TrainingConfig,
    TrainingContext,
    TrainingResult,
)
from gear.training.loop import TrainingLoop

SLIME_COMMIT = "41014d1f29e201137fdffce737bb8bac65bc5219"
CONTRACT_VERSION = 1

__all__ = [
    "TrainingLoop",
    "TrainingConfig",
    "TrainingContext",
    "TrainingResult",
    "TaskSource",
    "RolloutExecutor",
    "DatasetBuilder",
    "ModelUpdater",
    "SLIME_COMMIT",
    "CONTRACT_VERSION",
]
