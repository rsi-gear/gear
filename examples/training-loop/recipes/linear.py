"""A controller-loaded CPU recipe: four ordinary classes, no backend requirements."""
from gear_training import TrainingLoop


class TaskSource:
    def generate(self, ctx):
        target = ctx.config.parameters["target_weight"]
        return [{"x": x, "target": target * x} for x in [-2.0, -1.0, 1.0, 2.0]]


class RolloutExecutor:
    def execute(self, ctx, tasks):
        return [{**task, "prediction": ctx.checkpoint["weight"] * task["x"]} for task in tasks]


class DatasetBuilder:
    def build(self, ctx, trajectories):
        return {"samples": trajectories, "loss": sum((row["prediction"] - row["target"]) ** 2 for row in trajectories) / len(trajectories)}


class ModelUpdater:
    def update(self, ctx, dataset):
        gradient = sum(2 * (row["prediction"] - row["target"]) * row["x"] for row in dataset["samples"]) / len(dataset["samples"])
        return {"weight": ctx.checkpoint["weight"] - ctx.config.parameters["learning_rate"] * gradient,
                "steps": ctx.checkpoint["steps"] + 1}


def build_loop(config, runtime):
    return TrainingLoop(TaskSource(), RolloutExecutor(), DatasetBuilder(), ModelUpdater())
