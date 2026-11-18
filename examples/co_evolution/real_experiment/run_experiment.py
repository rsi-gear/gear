#!/usr/bin/env python3
"""Run real model/harness co-evolution arms on Apple Silicon via MLX.

This answers rsi-gear/gear#93 under matched generation + LoRA-iter budgets.
It is not Gear's Slime/CUDA training path (unavailable without NVIDIA GPU).
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path
from typing import Any

_EXAMPLES = Path(__file__).resolve().parents[2]
if str(_EXAMPLES) not in sys.path:
    sys.path.insert(0, str(_EXAMPLES))

from co_evolution.real_experiment.runtime import (
    AgentRuntime,
    collect_successes,
    evaluate_tasks,
    initial_harness,
    optimize_harness,
    train_lora,
    write_sft_dataset,
)
from co_evolution.real_experiment.tasks import load_task_bank, save_task_bank

SETTINGS = ("fixed_baseline", "model_only", "harness_only", "co_evolution")


def stability(values: list[float]) -> dict[str, Any]:
    if not values:
        return {"count": 0, "mean": 0.0, "stdev": 0.0, "min": 0.0, "max": 0.0, "regressions": []}
    regressions = []
    for index in range(1, len(values)):
        if values[index] < values[index - 1] - 1e-12:
            regressions.append({"round": index, "previous": values[index - 1], "current": values[index]})
    return {
        "count": len(values),
        "mean": statistics.fmean(values),
        "stdev": statistics.pstdev(values),
        "min": min(values),
        "max": max(values),
        "regressions": regressions,
    }


def run_setting(
    *,
    setting: str,
    workspace: Path,
    rounds: int,
    lora_iters: int,
    candidate_limit: int,
    order: str,
    model_id: str,
) -> dict[str, Any]:
    bank = load_task_bank(workspace.parent / "tasks.json")
    train_tasks = bank["train"]
    seed_tasks = bank["seed"]
    held_tasks = bank["held_out"]

    setting_dir = workspace / setting / order
    setting_dir.mkdir(parents=True, exist_ok=True)
    runtime = AgentRuntime(model_id=model_id)
    runtime.load()
    harness = initial_harness()
    adapter_path: Path | None = None
    history: list[dict[str, Any]] = []
    t0 = time.time()

    for round_index in range(rounds):
        round_dir = setting_dir / f"round-{round_index:03d}"
        round_dir.mkdir(parents=True, exist_ok=True)
        model_updated = False
        harness_updated = False
        train_acc = None
        seed_info = None
        lora_info = None

        def do_model() -> None:
            nonlocal adapter_path, model_updated, train_acc, lora_info
            if setting in {"fixed_baseline", "harness_only"}:
                return
            train_eval = evaluate_tasks(runtime, train_tasks, harness)
            train_acc = train_eval["accuracy"]
            (round_dir / "train_eval.json").write_text(
                json.dumps(train_eval, indent=2) + "\n", encoding="utf-8"
            )
            successes = collect_successes(train_eval, train_tasks)
            # If nothing succeeded, distill grader targets as teacher traces
            # so model-only/co-evolution still get a learning signal.
            if not successes:
                successes = [
                    {
                        "user": task["user"],
                        "assistant": (
                            f'<answer>{task["target"]}</answer>'
                            if task["family"] in {"math_tag", "entity_tag"}
                            else json.dumps(
                                {"label": task["target"]}
                                if task["family"] == "sentiment_json"
                                else {"tool": task["target"]}
                            )
                        ),
                        "taskId": task["id"],
                    }
                    for task in train_tasks
                ]
            else:
                # Mix in gold targets for missed tasks to stabilize tiny-model SFT.
                have = {row["taskId"] for row in successes}
                for task in train_tasks:
                    if task["id"] in have:
                        continue
                    if task["family"] in {"math_tag", "entity_tag"}:
                        assistant = f'<answer>{task["target"]}</answer>'
                    elif task["family"] == "sentiment_json":
                        assistant = json.dumps({"label": task["target"]})
                    else:
                        assistant = json.dumps({"tool": task["target"]})
                    successes.append(
                        {"user": task["user"], "assistant": assistant, "taskId": task["id"]}
                    )
            data_dir = round_dir / "sft"
            write_sft_dataset(successes, harness, data_dir)
            next_adapter = round_dir / "adapter"
            lora_info = train_lora(
                runtime=runtime,
                data_dir=data_dir,
                adapter_path=next_adapter,
                iters=lora_iters,
            )
            if lora_info["ok"]:
                adapter_path = next_adapter
                runtime.set_adapter(adapter_path)
                model_updated = True
            else:
                # Reload previous generative weights after failed train attempt.
                runtime.set_adapter(adapter_path)
            (round_dir / "lora.json").write_text(json.dumps(lora_info, indent=2) + "\n", encoding="utf-8")

        def do_harness() -> None:
            nonlocal harness, harness_updated, seed_info
            if setting in {"fixed_baseline", "model_only"}:
                return
            result = optimize_harness(
                runtime,
                seed_tasks,
                harness,
                candidate_limit=candidate_limit,
            )
            harness = result["harness"]
            harness_updated = result["updated"]
            seed_info = {
                "baselineAccuracy": result["baseline"]["accuracy"],
                "championAccuracy": result["championSeed"]["accuracy"],
                "candidates": result["candidates"],
                "updated": result["updated"],
                "rollouts": result["rollouts"],
            }
            (round_dir / "harness_search.json").write_text(
                json.dumps(result, indent=2) + "\n", encoding="utf-8"
            )

        if order == "model_then_harness":
            do_model()
            do_harness()
        else:
            do_harness()
            do_model()

        held = evaluate_tasks(runtime, held_tasks, harness)
        (round_dir / "held_eval.json").write_text(json.dumps(held, indent=2) + "\n", encoding="utf-8")
        row = {
            "round": round_index,
            "setting": setting,
            "order": order,
            "heldOutAccuracy": held["accuracy"],
            "heldOutCorrect": held["correct"],
            "heldOutTotal": held["total"],
            "trainAccuracy": train_acc,
            "seed": seed_info,
            "modelUpdated": model_updated,
            "harnessUpdated": harness_updated,
            "adapterPath": str(adapter_path) if adapter_path else None,
            "harnessId": harness["id"],
            "harnessVersion": harness.get("version", 0),
            "generationCalls": runtime.generation_calls,
            "trainIters": runtime.train_iters,
            "lora": {"ok": None if lora_info is None else lora_info["ok"], "iters": lora_iters if lora_info else 0},
        }
        history.append(row)
        (round_dir / "summary.json").write_text(json.dumps(row, indent=2) + "\n", encoding="utf-8")

    runtime.unload()
    held_curve = [row["heldOutAccuracy"] for row in history]
    result = {
        "setting": setting,
        "order": order,
        "rounds": rounds,
        "loraItersPerRound": lora_iters,
        "finalHeldOutAccuracy": held_curve[-1] if held_curve else None,
        "bestHeldOutAccuracy": max(held_curve) if held_curve else None,
        "stability": stability(held_curve),
        "generationCalls": history[-1]["generationCalls"] if history else 0,
        "trainIters": history[-1]["trainIters"] if history else 0,
        "elapsedSeconds": round(time.time() - t0, 2),
        "history": history,
        "finalHarness": harness,
        "finalAdapter": str(adapter_path) if adapter_path else None,
    }
    (setting_dir / "result.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result


def run_all(
    *,
    workspace: Path,
    rounds: int,
    lora_iters: int,
    candidate_limit: int,
    model_id: str,
    orders: list[str],
) -> dict[str, Any]:
    workspace = Path(workspace).resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    save_task_bank(workspace / "tasks.json")
    results: dict[str, Any] = {}
    for order in orders:
        for setting in SETTINGS:
            key = f"{setting}__{order}"
            print(f"[run] {key}", flush=True)
            results[key] = run_setting(
                setting=setting,
                workspace=workspace,
                rounds=rounds,
                lora_iters=lora_iters,
                candidate_limit=candidate_limit,
                order=order,
                model_id=model_id,
            )
            print(
                f"[done] {key} held={results[key]['finalHeldOutAccuracy']:.3f} "
                f"gens={results[key]['generationCalls']} iters={results[key]['trainIters']}",
                flush=True,
            )

    # Primary comparison uses model_then_harness order.
    primary_order = orders[0]
    primary = {
        setting: results[f"{setting}__{primary_order}"]
        for setting in SETTINGS
        if f"{setting}__{primary_order}" in results
    }
    ranking = sorted(
        (
            {
                "setting": setting,
                "heldOut": payload["finalHeldOutAccuracy"],
                "bestHeldOut": payload["bestHeldOutAccuracy"],
                "generationCalls": payload["generationCalls"],
                "trainIters": payload["trainIters"],
            }
            for setting, payload in primary.items()
        ),
        key=lambda row: (row["heldOut"], row["bestHeldOut"]),
        reverse=True,
    )
    comparison = {
        "schemaVersion": 1,
        "issue": "https://github.com/rsi-gear/gear/issues/93",
        "disclaimer": (
            "Real local MLX LoRA + prompt-harness experiment on Apple M1. "
            "Not Gear Slime/CUDA/Harbor. Not Terminal-Bench official score."
        ),
        "model": model_id,
        "rounds": rounds,
        "loraItersPerRound": lora_iters,
        "candidateLimit": candidate_limit,
        "primaryOrder": primary_order,
        "ranking": ranking,
        "primary": {
            setting: {
                "finalHeldOutAccuracy": payload["finalHeldOutAccuracy"],
                "bestHeldOutAccuracy": payload["bestHeldOutAccuracy"],
                "stability": payload["stability"],
                "generationCalls": payload["generationCalls"],
                "trainIters": payload["trainIters"],
                "elapsedSeconds": payload["elapsedSeconds"],
            }
            for setting, payload in primary.items()
        },
        "all": {
            key: {
                "finalHeldOutAccuracy": payload["finalHeldOutAccuracy"],
                "bestHeldOutAccuracy": payload["bestHeldOutAccuracy"],
                "stability": payload["stability"],
                "generationCalls": payload["generationCalls"],
                "trainIters": payload["trainIters"],
                "elapsedSeconds": payload["elapsedSeconds"],
            }
            for key, payload in results.items()
        },
    }
    (workspace / "comparison.json").write_text(json.dumps(comparison, indent=2) + "\n", encoding="utf-8")
    return comparison


def write_findings(comparison: dict[str, Any], path: Path) -> None:
    primary = comparison["primary"]
    ranking = comparison["ranking"]
    winner = ranking[0]["setting"] if ranking else "unknown"
    lines = [
        "# Findings: model + harness co-evolution (#93)",
        "",
        f"- Issue: {comparison['issue']}",
        f"- Model: `{comparison['model']}`",
        f"- Rounds: {comparison['rounds']}; LoRA iters/round: {comparison['loraItersPerRound']}",
        f"- Primary update order: `{comparison['primaryOrder']}`",
        f"- Scope note: {comparison['disclaimer']}",
        "",
        "## Held-out accuracy (primary order)",
        "",
        "| Setting | Final held-out | Best held-out | Generations | LoRA iters |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    for setting in SETTINGS:
        row = primary[setting]
        lines.append(
            f"| {setting} | {row['finalHeldOutAccuracy']:.3f} | {row['bestHeldOutAccuracy']:.3f} | "
            f"{row['generationCalls']} | {row['trainIters']} |"
        )
    lines.extend(
        [
            "",
            "## Answer to #93",
            "",
        ]
    )
    co = primary["co_evolution"]["finalHeldOutAccuracy"]
    model_only = primary["model_only"]["finalHeldOutAccuracy"]
    harness_only = primary["harness_only"]["finalHeldOutAccuracy"]
    baseline = primary["fixed_baseline"]["finalHeldOutAccuracy"]
    if winner == "co_evolution" and co >= max(model_only, harness_only, baseline) - 1e-12:
        verdict = (
            "Under this local MLX setup with matched rounds, **co-evolution beat or tied "
            "independent optimization** on held-out accuracy. Model and harness updates "
            "were complementary rather than strongly interfering."
        )
    elif co > baseline and (co < model_only or co < harness_only):
        verdict = (
            "Co-evolution beat the fixed baseline but **did not beat the best single-component "
            f"arm** (winner: `{winner}`). Updates partially interfered or wasted budget versus "
            "focusing resources on the stronger component."
        )
    else:
        verdict = (
            f"Best setting was `{winner}`. Co-evolution did not dominate; inspect per-round "
            "curves for interference versus under-training."
        )
    lines.extend(
        [
            verdict,
            "",
            "### Evidence notes",
            "",
            f"- Baseline held-out: {baseline:.3f}",
            f"- Model-only held-out: {model_only:.3f}",
            f"- Harness-only held-out: {harness_only:.3f}",
            f"- Co-evolution held-out: {co:.3f}",
            f"- Co-evolution regressions across rounds: {len(primary['co_evolution']['stability']['regressions'])}",
            "",
            "### Limits",
            "",
            "- Apple M1 8GB; tiny 0.5B 4-bit model; prompt harness only (not full tool/workflow evolution).",
            "- Teacher-mixed SFT uses gold targets when rollouts fail, so model updates are partly supervised.",
            "- Does not replace a Gear+Hitch+Slime GPU certification run on Terminal-Bench.",
            "",
        ]
    )
    # Order ablation summary if present.
    order_rows = [
        (key, value)
        for key, value in comparison["all"].items()
        if key.startswith("co_evolution__")
    ]
    if len(order_rows) > 1:
        lines.extend(["## Co-evolution order ablation", ""])
        for key, value in order_rows:
            lines.append(
                f"- `{key}`: final={value['finalHeldOutAccuracy']:.3f}, "
                f"best={value['bestHeldOutAccuracy']:.3f}"
            )
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", default=".local/co-evolution/real")
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--lora-iters", type=int, default=30)
    parser.add_argument("--candidate-limit", type=int, default=3)
    parser.add_argument("--model", default="mlx-community/Qwen2.5-0.5B-Instruct-4bit")
    parser.add_argument(
        "--orders",
        nargs="+",
        default=["model_then_harness", "harness_then_model"],
        choices=["model_then_harness", "harness_then_model"],
    )
    args = parser.parse_args(argv)
    comparison = run_all(
        workspace=Path(args.workspace),
        rounds=args.rounds,
        lora_iters=args.lora_iters,
        candidate_limit=args.candidate_limit,
        model_id=args.model,
        orders=list(args.orders),
    )
    findings = Path(args.workspace) / "FINDINGS.md"
    write_findings(comparison, findings)
    print(json.dumps({"ranking": comparison["ranking"], "findings": str(findings)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
