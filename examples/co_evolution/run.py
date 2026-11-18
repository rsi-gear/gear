#!/usr/bin/env python3
"""CPU-deterministic model/harness co-evolution scaffold for issue #93.

Synthetic results only. Does not claim Terminal-Bench or AutomationBench gains.

Run from the repository root:
  PYTHONPATH=examples python -m co_evolution.run --workspace .local/co-evolution/smoke --rounds 6
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path
from typing import Any

_EXAMPLES_ROOT = Path(__file__).resolve().parents[1]
if str(_EXAMPLES_ROOT) not in sys.path:
    sys.path.insert(0, str(_EXAMPLES_ROOT))

from co_evolution.harness_backend import optimize_harness
from co_evolution.ledger import JointLedger
from co_evolution.model_backend import update_model
from co_evolution.world import (
    INITIAL_HARNESS,
    INITIAL_MODEL,
    digest,
    evaluate_split,
    harness_id,
    load_split,
    model_id,
    stability_summary,
)

SETTINGS = ("fixed_baseline", "model_only", "harness_only", "co_evolution")
ORDERS = ("model_then_harness", "harness_then_model")
FREQUENCIES = ("every_round", "model_every_2", "harness_every_2")


def should_update_model(round_index: int, setting: str, frequency: str) -> bool:
    if setting in {"fixed_baseline", "harness_only"}:
        return False
    if frequency == "model_every_2":
        return round_index % 2 == 0
    return True


def should_update_harness(round_index: int, setting: str, frequency: str) -> bool:
    if setting in {"fixed_baseline", "model_only"}:
        return False
    if frequency == "harness_every_2":
        return round_index % 2 == 0
    return True


def budget_plan(rounds: int, train_n: int, seed_n: int, held_n: int, candidate_limit: int) -> int:
    """Worst-case rollouts+updates for co_evolution with every_round updates."""
    per_round = (
        train_n
        + 1
        + seed_n * (1 + candidate_limit)
        + 1
        + held_n
    )
    return rounds * per_round


def run_setting(
    *,
    workspace: Path,
    setting: str,
    rounds: int,
    budget: int,
    order: str,
    frequency: str,
    candidate_limit: int,
    learning_rate: float,
) -> dict[str, Any]:
    split = load_split()
    train_tasks = split["train"]
    seed_tasks = split["seed"]
    held_tasks = split["held_out"]
    train_digest = digest({"tasks": train_tasks})
    seed_digest = digest({"tasks": seed_tasks})
    held_digest = digest({"tasks": held_tasks})

    setting_dir = workspace / setting / f"{order}__{frequency}"
    setting_dir.mkdir(parents=True, exist_ok=True)
    ledger = JointLedger(setting_dir / "ledger.jsonl")
    history: list[dict[str, Any]] = []

    checkpoint = copy.deepcopy(INITIAL_MODEL)
    harness = copy.deepcopy(INITIAL_HARNESS)
    spent = 0

    for round_index in range(rounds):
        if spent >= budget:
            break
        round_dir = setting_dir / f"round-{round_index:03d}"
        round_dir.mkdir(parents=True, exist_ok=True)

        model_meta: dict[str, Any] = {
            "updated": False,
            "beforeId": model_id(checkpoint),
            "afterId": model_id(checkpoint),
            "rollouts": 0,
            "updates": 0,
        }
        harness_meta: dict[str, Any] = {
            "updated": False,
            "beforeId": harness_id(harness),
            "afterId": harness_id(harness),
            "rollouts": 0,
            "updates": 0,
            "championSeed": None,
            "baselineSeed": None,
            "candidates": [],
        }

        do_model = should_update_model(round_index, setting, frequency)
        do_harness = should_update_harness(round_index, setting, frequency)

        def maybe_model() -> None:
            nonlocal checkpoint, spent, model_meta
            if not do_model:
                return
            needed = len(train_tasks) + 1 + len(held_tasks)
            if spent + needed > budget:
                return
            result = update_model(
                workspace=round_dir / "model-loop",
                checkpoint=checkpoint,
                harness=harness,
                train_tasks=train_tasks,
                train_digest=train_digest,
                learning_rate=learning_rate,
            )
            checkpoint = result["checkpoint"]
            spent += result["rollouts"] + result["updates"]
            model_meta = {
                "updated": result["updated"],
                "beforeId": result["beforeId"],
                "afterId": result["afterId"],
                "rollouts": result["rollouts"],
                "updates": result["updates"],
            }

        def maybe_harness() -> None:
            nonlocal harness, spent, harness_meta
            if not do_harness:
                return
            needed = len(seed_tasks) * (1 + candidate_limit) + 1 + len(held_tasks)
            if spent + needed > budget:
                return
            result = optimize_harness(
                checkpoint=checkpoint,
                harness=harness,
                seed_tasks=seed_tasks,
                candidate_limit=candidate_limit,
            )
            harness = result["harness"]
            spent += result["rollouts"] + (1 if result["updated"] else 0)
            harness_meta = {
                "updated": result["updated"],
                "beforeId": result["beforeId"],
                "afterId": result["afterId"],
                "rollouts": result["rollouts"],
                "updates": result["updates"],
                "championSeed": result["championSeed"],
                "baselineSeed": result["baselineSeed"],
                "candidates": result["candidates"],
            }

        if order == "model_then_harness":
            maybe_model()
            maybe_harness()
        else:
            maybe_harness()
            maybe_model()

        if spent + len(held_tasks) > budget:
            break
        held = evaluate_split(held_tasks, checkpoint, harness)
        spent += held["rollouts"]

        row: dict[str, Any] = {
            "round": round_index,
            "setting": setting,
            "order": order,
            "frequency": frequency,
            "modelId": model_id(checkpoint),
            "harnessId": harness_id(harness),
            "modelCheckpoint": copy.deepcopy(checkpoint),
            "harnessVersion": copy.deepcopy(harness),
            "trainDigest": train_digest,
            "seedDigest": seed_digest,
            "heldOutDigest": held_digest,
            "trainTrajectoryDigest": None,
            "seed": harness_meta.get("championSeed"),
            "heldOut": {
                "meanReward": held["meanReward"],
                "meanInteraction": held["meanInteraction"],
                "trajectoryDigest": held["trajectoryDigest"],
                "datasetDigest": held["datasetDigest"],
            },
            "updates": {
                "model": model_meta["updated"],
                "harness": harness_meta["updated"],
            },
            "modelMeta": model_meta,
            "harnessMeta": {
                "updated": harness_meta["updated"],
                "beforeId": harness_meta["beforeId"],
                "afterId": harness_meta["afterId"],
                "rollouts": harness_meta["rollouts"],
                "updates": harness_meta["updates"],
                "candidates": harness_meta["candidates"],
            },
            "budget": {
                "limit": budget,
                "spent": spent,
                "remaining": budget - spent,
            },
        }
        if model_meta["updated"] or model_meta["rollouts"]:
            train_eval = evaluate_split(train_tasks, checkpoint, harness)
            row["trainTrajectoryDigest"] = train_eval["trajectoryDigest"]
            row["trainMeanReward"] = train_eval["meanReward"]

        ledger.append(row)
        history.append(row)
        (round_dir / "state.json").write_text(
            json.dumps(row, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

    summary = {
        "schemaVersion": 1,
        "setting": setting,
        "order": order,
        "frequency": frequency,
        "roundsRequested": rounds,
        "roundsCompleted": len(history),
        "budget": {"limit": budget, "spent": spent, "remaining": budget - spent},
        "final": history[-1] if history else None,
        "stability": stability_summary(history),
        "ledgerSummary": str(ledger.write_summary(setting_dir / "summary.json")),
    }
    (setting_dir / "result.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return summary


def run_comparison(
    *,
    workspace: Path,
    rounds: int,
    budget: int | None,
    order: str,
    frequency: str,
    candidate_limit: int,
    learning_rate: float,
    settings: list[str] | None = None,
) -> dict[str, Any]:
    workspace = Path(workspace).resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    split = load_split()
    if budget is None:
        budget = budget_plan(
            rounds,
            len(split["train"]),
            len(split["seed"]),
            len(split["held_out"]),
            candidate_limit,
        )
    selected = list(settings or SETTINGS)
    results = {}
    for setting in selected:
        results[setting] = run_setting(
            workspace=workspace,
            setting=setting,
            rounds=rounds,
            budget=budget,
            order=order,
            frequency=frequency,
            candidate_limit=candidate_limit,
            learning_rate=learning_rate,
        )
    comparison = {
        "schemaVersion": 1,
        "kind": "synthetic-co-evolution-comparison",
        "disclaimer": (
            "Synthetic CPU dry-run for rsi-gear/gear#93 scaffolding. "
            "Not a real harness/model quality claim."
        ),
        "workspace": str(workspace),
        "budget": budget,
        "rounds": rounds,
        "order": order,
        "frequency": frequency,
        "settings": {
            name: {
                "heldOutFinal": (
                    payload["final"]["heldOut"]["meanReward"] if payload["final"] else None
                ),
                "interactionFinal": (
                    payload["final"]["heldOut"]["meanInteraction"] if payload["final"] else None
                ),
                "spent": payload["budget"]["spent"],
                "stability": payload["stability"],
            }
            for name, payload in results.items()
        },
        "results": results,
    }
    (workspace / "comparison.json").write_text(
        json.dumps(comparison, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return comparison


def run_ablations(
    *,
    workspace: Path,
    rounds: int,
    budget: int | None,
    candidate_limit: int,
    learning_rate: float,
) -> dict[str, Any]:
    workspace = Path(workspace).resolve()
    ablation_root = workspace / "ablations"
    ablation_root.mkdir(parents=True, exist_ok=True)
    matrix = []
    for order in ORDERS:
        for frequency in FREQUENCIES:
            label = f"{order}__{frequency}"
            result = run_comparison(
                workspace=ablation_root / label,
                rounds=rounds,
                budget=budget,
                order=order,
                frequency=frequency,
                candidate_limit=candidate_limit,
                learning_rate=learning_rate,
                settings=["co_evolution"],
            )
            co = result["settings"]["co_evolution"]
            matrix.append(
                {
                    "order": order,
                    "frequency": frequency,
                    "heldOutFinal": co["heldOutFinal"],
                    "interactionFinal": co["interactionFinal"],
                    "spent": co["spent"],
                    "stability": co["stability"],
                }
            )
    payload = {
        "schemaVersion": 1,
        "kind": "synthetic-co-evolution-ablations",
        "disclaimer": "Synthetic ablations only.",
        "matrix": matrix,
    }
    (ablation_root / "ablation-summary.json").write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return payload


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", required=True, help="Output directory under .local/ preferred")
    parser.add_argument("--rounds", type=int, default=6)
    parser.add_argument(
        "--budget",
        type=int,
        default=None,
        help="Shared rollout+update budget; default equals co_evolution worst-case",
    )
    parser.add_argument("--order", choices=ORDERS, default="model_then_harness")
    parser.add_argument("--frequency", choices=FREQUENCIES, default="every_round")
    parser.add_argument("--candidate-limit", type=int, default=4)
    parser.add_argument("--learning-rate", type=float, default=0.18)
    parser.add_argument(
        "--settings",
        nargs="+",
        choices=SETTINGS,
        default=list(SETTINGS),
    )
    parser.add_argument(
        "--ablations",
        action="store_true",
        help="Also run order/frequency ablations for co_evolution",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    comparison = run_comparison(
        workspace=Path(args.workspace),
        rounds=args.rounds,
        budget=args.budget,
        order=args.order,
        frequency=args.frequency,
        candidate_limit=args.candidate_limit,
        learning_rate=args.learning_rate,
        settings=args.settings,
    )
    output: dict[str, Any] = {"comparison": comparison}
    if args.ablations:
        output["ablations"] = run_ablations(
            workspace=Path(args.workspace),
            rounds=args.rounds,
            budget=args.budget,
            candidate_limit=args.candidate_limit,
            learning_rate=args.learning_rate,
        )
    print(
        json.dumps(
            {
                "workspace": comparison["workspace"],
                "budget": comparison["budget"],
                "settings": comparison["settings"],
                "ablations": output.get("ablations", {}).get("matrix") if args.ablations else None,
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
