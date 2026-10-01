"""Run Gear's original dev workflow through the real four-stage recipe.

    python examples/training-loop/dev_grpo.py --spec dev-spec.json --config controller.json

The four stage implementations and build_loop live in gear_training.dev_grpo;
that same recipe is executed by the model worker. This entry starts/follows its
controller, preserving placement checks, evaluation and checkpoint recovery.
"""
from gear_training.dev_launcher import main

if __name__ == "__main__":
    raise SystemExit(main())
