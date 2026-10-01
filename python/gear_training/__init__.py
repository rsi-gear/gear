"""Gear's process-isolated Slime bridge. CUDA dependencies are lazy imports."""

SLIME_COMMIT = "41014d1f29e201137fdffce737bb8bac65bc5219"
CONTRACT_VERSION = 1

# The public CPU-friendly loop has no optional agent/GPU dependencies.
from .loop import (TrainingLoop, TrainingConfig, TrainingContext, TrainingResult,
                   TaskSource, RolloutExecutor, DatasetBuilder, ModelUpdater)

__all__ = ["TrainingLoop", "TrainingConfig", "TrainingContext", "TrainingResult",
           "TaskSource", "RolloutExecutor", "DatasetBuilder", "ModelUpdater", "SLIME_COMMIT", "CONTRACT_VERSION"]
