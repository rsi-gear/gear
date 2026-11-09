"""Synthetic tasks where model skill and harness policy interact.

Scores are deterministic. Held-out tasks never appear in train or seed lists.
Results are for scaffolding #93 only — not real benchmark claims.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

FIXTURES = Path(__file__).resolve().parent / "fixtures"
SPLIT_PATH = FIXTURES / "split.json"

# Latent task families: preferred skill axis + whether mismatch is punished.
TASK_SPECS: dict[str, dict[str, Any]] = {
    "train_align_a": {"axis": "a", "mode": "reinforce", "difficulty": 0.2},
    "train_align_b": {"axis": "b", "mode": "reinforce", "difficulty": 0.2},
    "train_mixed": {"axis": "balanced", "mode": "reinforce", "difficulty": 0.35},
    "train_conflict": {"axis": "a", "mode": "interfere", "difficulty": 0.45},
    "seed_align_a": {"axis": "a", "mode": "reinforce", "difficulty": 0.25},
    "seed_align_b": {"axis": "b", "mode": "reinforce", "difficulty": 0.25},
    "seed_mixed": {"axis": "balanced", "mode": "reinforce", "difficulty": 0.4},
    "seed_conflict": {"axis": "b", "mode": "interfere", "difficulty": 0.5},
    "held_align_a": {"axis": "a", "mode": "reinforce", "difficulty": 0.3},
    "held_align_b": {"axis": "b", "mode": "reinforce", "difficulty": 0.3},
    "held_mixed": {"axis": "balanced", "mode": "reinforce", "difficulty": 0.45},
    "held_conflict": {"axis": "a", "mode": "interfere", "difficulty": 0.55},
    "held_transfer": {"axis": "balanced", "mode": "interfere", "difficulty": 0.6},
}

INITIAL_MODEL: dict[str, Any] = {
    "schemaVersion": 1,
    "skills": {"a": 0.15, "b": 0.15},
    "steps": 0,
}

INITIAL_HARNESS: dict[str, Any] = {
    "schemaVersion": 1,
    "routing": "balanced",
    "prompt_strength": 0.2,
    "tool_bias": 0.0,
    "version": 0,
}


def load_split(path: Path | None = None) -> dict[str, list[str]]:
    payload = json.loads((path or SPLIT_PATH).read_text(encoding="utf-8"))
    train = list(payload["train"])
    seed = list(payload["seed"])
    held_out = list(payload["held_out"])
    overlap = set(train) & set(seed) | set(train) & set(held_out) | set(seed) & set(held_out)
    if overlap:
        raise ValueError(f"split isolation violated: {sorted(overlap)}")
    for task_id in train + seed + held_out:
        if task_id not in TASK_SPECS:
            raise KeyError(f"unknown task id in split: {task_id}")
    return {"train": train, "seed": seed, "held_out": held_out}


def digest(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def model_id(checkpoint: dict[str, Any]) -> str:
    return digest({"kind": "model", "checkpoint": checkpoint})


def harness_id(harness: dict[str, Any]) -> str:
    return digest({"kind": "harness", "harness": harness})


def _clip(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def _model_axis_score(checkpoint: dict[str, Any], axis: str) -> float:
    skills = checkpoint["skills"]
    if axis == "a":
        return _clip(float(skills["a"]))
    if axis == "b":
        return _clip(float(skills["b"]))
    return _clip(0.5 * (float(skills["a"]) + float(skills["b"])))


def _harness_axis_score(harness: dict[str, Any], axis: str) -> float:
    routing = harness["routing"]
    strength = float(harness["prompt_strength"])
    bias = float(harness["tool_bias"])
    if axis == "a":
        route = 1.0 if routing == "a" else 0.55 if routing == "balanced" else 0.15
        return _clip(0.55 * route + 0.3 * strength + 0.15 * (0.5 + bias))
    if axis == "b":
        route = 1.0 if routing == "b" else 0.55 if routing == "balanced" else 0.15
        return _clip(0.55 * route + 0.3 * strength + 0.15 * (0.5 - bias))
    route = 1.0 if routing == "balanced" else 0.35
    return _clip(0.5 * route + 0.35 * strength + 0.15 * (1.0 - abs(bias)))


def score_task(
    task_id: str,
    checkpoint: dict[str, Any],
    harness: dict[str, Any],
) -> dict[str, Any]:
    spec = TASK_SPECS[task_id]
    axis = spec["axis"]
    mode = spec["mode"]
    difficulty = float(spec["difficulty"])
    model_score = _model_axis_score(checkpoint, axis)
    harness_score = _harness_axis_score(harness, axis)
    alignment = 1.0 - abs(model_score - harness_score)
    if mode == "reinforce":
        interaction = 0.35 * alignment * min(model_score, harness_score)
    else:
        # Mismatch between strong model and wrong harness (or vice versa) hurts.
        interaction = -0.4 * (1.0 - alignment) * max(model_score, harness_score)
    raw = 0.35 * model_score + 0.35 * harness_score + interaction - 0.25 * difficulty
    reward = _clip(raw)
    return {
        "taskId": task_id,
        "axis": axis,
        "mode": mode,
        "modelScore": model_score,
        "harnessScore": harness_score,
        "alignment": alignment,
        "interaction": interaction,
        "reward": reward,
        "modelId": model_id(checkpoint),
        "harnessId": harness_id(harness),
    }


def evaluate_split(
    task_ids: list[str],
    checkpoint: dict[str, Any],
    harness: dict[str, Any],
) -> dict[str, Any]:
    trajectories = [score_task(task_id, checkpoint, harness) for task_id in task_ids]
    rewards = [row["reward"] for row in trajectories]
    interactions = [row["interaction"] for row in trajectories]
    mean_reward = sum(rewards) / len(rewards)
    mean_interaction = sum(interactions) / len(interactions)
    return {
        "taskIds": list(task_ids),
        "trajectories": trajectories,
        "meanReward": mean_reward,
        "meanInteraction": mean_interaction,
        "trajectoryDigest": digest(trajectories),
        "datasetDigest": digest({"tasks": task_ids}),
        "rollouts": len(trajectories),
    }


def regression_flags(history: list[dict[str, Any]], epsilon: float = 1e-9) -> list[dict[str, Any]]:
    flags: list[dict[str, Any]] = []
    for index in range(1, len(history)):
        prev = history[index - 1]["heldOut"]["meanReward"]
        curr = history[index]["heldOut"]["meanReward"]
        if curr + epsilon < prev:
            flags.append(
                {
                    "round": history[index]["round"],
                    "previous": prev,
                    "current": curr,
                    "delta": curr - prev,
                }
            )
    return flags


def stability_summary(history: list[dict[str, Any]]) -> dict[str, Any]:
    rewards = [row["heldOut"]["meanReward"] for row in history]
    if not rewards:
        return {"count": 0, "mean": 0.0, "stdev": 0.0, "min": 0.0, "max": 0.0}
    mean = sum(rewards) / len(rewards)
    variance = sum((value - mean) ** 2 for value in rewards) / len(rewards)
    return {
        "count": len(rewards),
        "mean": mean,
        "stdev": variance**0.5,
        "min": min(rewards),
        "max": max(rewards),
        "regressions": regression_flags(history),
    }
