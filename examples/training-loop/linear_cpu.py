"""Four ordinary Python classes fit y=3x on CPU, with durable round recovery.

Install Gear Python, then:
    python examples/training-loop/linear_cpu.py --workspace /tmp/gear-linear --rounds 12
Repeat the same command to replay completed artifacts. Changing settings or code version requires
a new workspace; resume uses the same configuration. No agent,
GPU, framework, external weights or third-party numeric package is required.
"""
import argparse
import json
from gear_training import TrainingLoop, TrainingConfig


class TaskSource:
    def generate(self, ctx):
        return [{"x": x, "target": ctx.config.parameters["target_weight"] * x} for x in [-2.0, -1.0, 1.0, 2.0]]


class RolloutExecutor:
    def execute(self, ctx, tasks):
        return [{**task, "prediction": ctx.checkpoint["weight"] * task["x"]} for task in tasks]


class DatasetBuilder:
    def build(self, ctx, trajectories):
        return {"samples": trajectories, "loss": sum((row["prediction"] - row["target"]) ** 2 for row in trajectories) / len(trajectories)}


class ModelUpdater:
    stage_id = "linear-gradient-descent:v1"
    def update(self, ctx, dataset):
        gradient = sum(2 * (row["prediction"] - row["target"]) * row["x"] for row in dataset["samples"]) / len(dataset["samples"])
        # The JSON checkpoint is the complete model state. There is no external
        # write; re-evaluating this operation from the same checkpoint is safe.
        return {"weight": ctx.checkpoint["weight"] - ctx.config.parameters["learning_rate"] * gradient,
                "steps": ctx.checkpoint["steps"] + 1}


def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--workspace", required=True)
    parser.add_argument("--rounds", type=int, default=12); parser.add_argument("--learning-rate", type=float, default=0.1)
    args = parser.parse_args()
    result = TrainingLoop(TaskSource(), RolloutExecutor(), DatasetBuilder(), ModelUpdater()).run(
        TrainingConfig(args.workspace, args.rounds, initial_checkpoint={"weight": 0.0, "steps": 0},
                       parameters={"learning_rate": args.learning_rate, "target_weight": 3.0}))
    print(json.dumps({"checkpoint": result.checkpoint, "initial_loss": result.history[0]["dataset"]["loss"],
                      "final_loss": result.history[-1]["dataset"]["loss"], "rounds_completed": result.rounds_completed}))


if __name__ == "__main__": main()
