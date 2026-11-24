"""One native solver job after fresh question construction and task admission.

trainer.scriptConfig must contain curriculumRef and challengerRequestRef.
See docs/training/diagevo.zh-CN.md for the required upstream evidence.
"""

from gear.training.pipelines.diagevo_solver import build_loop

__all__ = ["build_loop"]
