"""Deterministic harness search ranked on the seed split only."""

from __future__ import annotations

import copy
from typing import Any

from .world import digest, evaluate_split, harness_id


CANDIDATE_DELTAS: tuple[dict[str, Any], ...] = (
    {"routing": "a"},
    {"routing": "b"},
    {"routing": "balanced"},
    {"prompt_strength": 0.35},
    {"prompt_strength": 0.55},
    {"prompt_strength": 0.75},
    {"tool_bias": -0.35},
    {"tool_bias": 0.0},
    {"tool_bias": 0.35},
    {"routing": "a", "prompt_strength": 0.65, "tool_bias": 0.2},
    {"routing": "b", "prompt_strength": 0.65, "tool_bias": -0.2},
    {"routing": "balanced", "prompt_strength": 0.7, "tool_bias": 0.0},
)


def _apply_delta(harness: dict[str, Any], delta: dict[str, Any]) -> dict[str, Any]:
    candidate = copy.deepcopy(harness)
    candidate.update(delta)
    candidate["version"] = int(harness["version"]) + 1
    candidate["schemaVersion"] = 1
    return candidate


def propose_candidates(harness: dict[str, Any], limit: int) -> list[dict[str, Any]]:
    proposed: list[dict[str, Any]] = []
    seen: set[str] = {harness_id(harness)}
    for delta in CANDIDATE_DELTAS:
        if len(proposed) >= limit:
            break
        candidate = _apply_delta(harness, delta)
        identity = harness_id(candidate)
        if identity in seen:
            continue
        seen.add(identity)
        proposed.append(candidate)
    return proposed


def optimize_harness(
    *,
    checkpoint: dict[str, Any],
    harness: dict[str, Any],
    seed_tasks: list[str],
    candidate_limit: int = 4,
) -> dict[str, Any]:
    """Score seed candidates and promote the best non-regressing harness."""
    baseline = evaluate_split(seed_tasks, checkpoint, harness)
    candidates = propose_candidates(harness, candidate_limit)
    scored: list[dict[str, Any]] = []
    rollouts = baseline["rollouts"]
    for candidate in candidates:
        evaluation = evaluate_split(seed_tasks, checkpoint, candidate)
        rollouts += evaluation["rollouts"]
        scored.append(
            {
                "harness": candidate,
                "harnessId": harness_id(candidate),
                "seed": {
                    "meanReward": evaluation["meanReward"],
                    "meanInteraction": evaluation["meanInteraction"],
                    "datasetDigest": evaluation["datasetDigest"],
                    "trajectoryDigest": evaluation["trajectoryDigest"],
                },
            }
        )
    scored.sort(
        key=lambda row: (
            row["seed"]["meanReward"],
            row["seed"]["meanInteraction"],
            row["harnessId"],
        ),
        reverse=True,
    )
    champion = harness
    champion_seed = {
        "meanReward": baseline["meanReward"],
        "meanInteraction": baseline["meanInteraction"],
        "datasetDigest": baseline["datasetDigest"],
        "trajectoryDigest": baseline["trajectoryDigest"],
    }
    promoted = False
    if scored and scored[0]["seed"]["meanReward"] >= baseline["meanReward"]:
        champion = scored[0]["harness"]
        champion_seed = scored[0]["seed"]
        promoted = harness_id(champion) != harness_id(harness)
    return {
        "harness": copy.deepcopy(champion),
        "beforeId": harness_id(harness),
        "afterId": harness_id(champion),
        "updated": promoted,
        "baselineSeed": {
            "meanReward": baseline["meanReward"],
            "meanInteraction": baseline["meanInteraction"],
            "datasetDigest": baseline["datasetDigest"],
            "trajectoryDigest": baseline["trajectoryDigest"],
        },
        "championSeed": champion_seed,
        "candidates": [
            {
                "harnessId": row["harnessId"],
                "meanReward": row["seed"]["meanReward"],
                "meanInteraction": row["seed"]["meanInteraction"],
            }
            for row in scored
        ],
        "candidateDigest": digest([row["harnessId"] for row in scored]),
        "rollouts": rollouts,
        "updates": 1 if promoted else 0,
    }
