"""CPU model updates using Gear TrainingLoop contracts on the train split only."""

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

from gear.training import TrainingConfig, TrainingLoop

from .world import evaluate_split, model_id


def _clip(value: float) -> float:
    return max(0.0, min(1.0, value))


class TrainTaskSource:
    stage_id = "co-evolution-train-source:v1"

    def generate(self, ctx):
        return [{"taskId": task_id} for task_id in ctx.config.parameters["trainTasks"]]


class TrainRolloutExecutor:
    stage_id = "co-evolution-train-rollout:v1"

    def execute(self, ctx, tasks):
        harness = ctx.config.parameters["harness"]
        result = evaluate_split(
            [row["taskId"] for row in tasks],
            ctx.checkpoint,
            harness,
        )
        return result["trajectories"]


class TrainDatasetBuilder:
    stage_id = "co-evolution-train-dataset:v1"

    def build(self, ctx, trajectories):
        return {
            "samples": trajectories,
            "meanReward": sum(row["reward"] for row in trajectories) / len(trajectories),
            "datasetDigest": ctx.config.parameters["trainDigest"],
        }


class TrainModelUpdater:
    stage_id = "co-evolution-train-updater:v1"

    def update(self, ctx, dataset):
        learning_rate = float(ctx.config.parameters["learningRate"])
        skills = {
            "a": float(ctx.checkpoint["skills"]["a"]),
            "b": float(ctx.checkpoint["skills"]["b"]),
        }
        # Push skill weights toward axes that underperformed relative to difficulty-free target.
        for row in dataset["samples"]:
            axis = row["axis"]
            error = 1.0 - float(row["reward"])
            if axis == "a":
                skills["a"] = _clip(skills["a"] + learning_rate * error)
            elif axis == "b":
                skills["b"] = _clip(skills["b"] + learning_rate * error)
            else:
                skills["a"] = _clip(skills["a"] + 0.5 * learning_rate * error)
                skills["b"] = _clip(skills["b"] + 0.5 * learning_rate * error)
            # Mild interference signal: conflict tasks also nudge the opposite axis down.
            if row["mode"] == "interfere":
                opposite = "b" if axis == "a" else "a" if axis == "b" else None
                if opposite is not None:
                    skills[opposite] = _clip(skills[opposite] - 0.25 * learning_rate * error)
        return {
            "schemaVersion": 1,
            "skills": skills,
            "steps": int(ctx.checkpoint["steps"]) + 1,
        }


def update_model(
    *,
    workspace: Path,
    checkpoint: dict[str, Any],
    harness: dict[str, Any],
    train_tasks: list[str],
    train_digest: str,
    learning_rate: float = 0.18,
) -> dict[str, Any]:
    """Run one durable TrainingLoop round and return the next checkpoint plus metadata."""
    workspace = Path(workspace)
    workspace.mkdir(parents=True, exist_ok=True)
    before = model_id(checkpoint)
    loop = TrainingLoop(
        TrainTaskSource(),
        TrainRolloutExecutor(),
        TrainDatasetBuilder(),
        TrainModelUpdater(),
    )
    result = loop.run(
        TrainingConfig(
            workspace,
            1,
            initial_checkpoint=copy.deepcopy(checkpoint),
            parameters={
                "trainTasks": list(train_tasks),
                "trainDigest": train_digest,
                "harness": copy.deepcopy(harness),
                "learningRate": learning_rate,
            },
        )
    )
    next_checkpoint = copy.deepcopy(result.checkpoint)
    return {
        "checkpoint": next_checkpoint,
        "beforeId": before,
        "afterId": model_id(next_checkpoint),
        "updated": before != model_id(next_checkpoint),
        "history": result.history,
        "rollouts": len(train_tasks),
        "updates": 1,
    }
