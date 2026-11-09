"""Model generation, LoRA training, and harness search for the real experiment."""

from __future__ import annotations

import gc
import json
import shutil
from pathlib import Path
from typing import Any

from .tasks import BASE_HARNESS, HARNESS_CANDIDATES, make_grader

DEFAULT_MODEL = "mlx-community/Qwen2.5-0.5B-Instruct-4bit"


def _clear_mlx() -> None:
    gc.collect()
    try:
        import mlx.core as mx

        mx.clear_cache()
    except Exception:
        pass


class AgentRuntime:
    def __init__(self, model_id: str = DEFAULT_MODEL, adapter_path: Path | None = None) -> None:
        self.model_id = model_id
        self.adapter_path = Path(adapter_path) if adapter_path else None
        self.model = None
        self.tokenizer = None
        self.generation_calls = 0
        self.train_iters = 0

    def load(self) -> None:
        from mlx_lm import load

        self.unload()
        kwargs = {}
        if self.adapter_path and self.adapter_path.exists():
            kwargs["adapter_path"] = str(self.adapter_path)
        self.model, self.tokenizer = load(self.model_id, **kwargs)

    def unload(self) -> None:
        self.model = None
        self.tokenizer = None
        _clear_mlx()

    def set_adapter(self, adapter_path: Path | None) -> None:
        self.adapter_path = Path(adapter_path) if adapter_path else None
        self.load()

    def generate(self, system: str, user: str, max_tokens: int = 96) -> str:
        from mlx_lm import generate

        if self.model is None or self.tokenizer is None:
            self.load()
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]
        prompt = self.tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
        )
        text = generate(
            self.model,
            self.tokenizer,
            prompt=prompt,
            max_tokens=max_tokens,
            verbose=False,
        )
        self.generation_calls += 1
        return text if isinstance(text, str) else str(text)


def evaluate_tasks(
    runtime: AgentRuntime,
    tasks: list[dict[str, Any]],
    harness: dict[str, Any],
    max_tokens: int = 96,
) -> dict[str, Any]:
    rows = []
    correct = 0
    for task in tasks:
        output = runtime.generate(harness["system"], task["user"], max_tokens=max_tokens)
        ok = make_grader(task["grader"])(output)
        correct += int(ok)
        rows.append(
            {
                "taskId": task["id"],
                "family": task["family"],
                "ok": ok,
                "target": task.get("target"),
                "output": output,
            }
        )
    n = len(tasks) or 1
    return {
        "accuracy": correct / n,
        "correct": correct,
        "total": len(tasks),
        "rollouts": len(tasks),
        "rows": rows,
    }


def write_sft_dataset(success_rows: list[dict[str, Any]], harness: dict[str, Any], out_dir: Path) -> int:
    """Write mlx-lm chat JSONL from successful trajectories."""
    out_dir = Path(out_dir)
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    train_path = out_dir / "train.jsonl"
    valid_path = out_dir / "valid.jsonl"
    records = []
    for row in success_rows:
        records.append(
            {
                "messages": [
                    {"role": "system", "content": harness["system"]},
                    {"role": "user", "content": row["user"]},
                    {"role": "assistant", "content": row["assistant"]},
                ]
            }
        )
    if not records:
        # mlx-lm needs at least one example; write a harmless noop that matches format.
        records.append(
            {
                "messages": [
                    {"role": "system", "content": harness["system"]},
                    {"role": "user", "content": "Return <answer>0</answer>."},
                    {"role": "assistant", "content": "<answer>0</answer>"},
                ]
            }
        )
    # Tiny valid split: duplicate first record.
    with train_path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record) + "\n")
    with valid_path.open("w", encoding="utf-8") as handle:
        handle.write(json.dumps(records[0]) + "\n")
    return len(records)


def train_lora(
    *,
    runtime: AgentRuntime,
    data_dir: Path,
    adapter_path: Path,
    iters: int,
    learning_rate: float = 1e-4,
    num_layers: int = 4,
    max_seq_length: int = 512,
) -> dict[str, Any]:
    """Run mlx_lm LoRA training. Unloads the generative model first to free RAM."""
    import subprocess
    import sys

    runtime.unload()
    adapter_path = Path(adapter_path)
    adapter_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        sys.executable,
        "-m",
        "mlx_lm",
        "lora",
        "--model",
        runtime.model_id,
        "--train",
        "--data",
        str(data_dir),
        "--adapter-path",
        str(adapter_path),
        "--batch-size",
        "1",
        "--iters",
        str(iters),
        "--learning-rate",
        str(learning_rate),
        "--num-layers",
        str(num_layers),
        "--max-seq-length",
        str(max_seq_length),
        "--mask-prompt",
        "--grad-checkpoint",
        "--save-every",
        str(max(iters, 1)),
        "--steps-per-eval",
        str(max(iters, 1)),
        "--val-batches",
        "1",
        "--seed",
        "0",
    ]
    if runtime.adapter_path and runtime.adapter_path.exists():
        # Continue from previous adapter weights when present.
        resume = runtime.adapter_path / "adapters.safetensors"
        if resume.exists():
            cmd.extend(["--resume-adapter-file", str(resume)])
    proc = subprocess.run(cmd, capture_output=True, text=True)
    runtime.train_iters += iters
    ok = proc.returncode == 0 and (adapter_path / "adapters.safetensors").exists()
    return {
        "ok": ok,
        "returncode": proc.returncode,
        "iters": iters,
        "adapterPath": str(adapter_path),
        "stdoutTail": proc.stdout[-2000:],
        "stderrTail": proc.stderr[-2000:],
    }


def collect_successes(
    eval_result: dict[str, Any],
    tasks: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    by_id = {task["id"]: task for task in tasks}
    successes = []
    for row in eval_result["rows"]:
        if not row["ok"]:
            continue
        task = by_id[row["taskId"]]
        successes.append(
            {
                "user": task["user"],
                "assistant": row["output"],
                "taskId": task["id"],
            }
        )
    return successes


def optimize_harness(
    runtime: AgentRuntime,
    seed_tasks: list[dict[str, Any]],
    current: dict[str, Any],
    candidate_limit: int = 3,
) -> dict[str, Any]:
    baseline = evaluate_tasks(runtime, seed_tasks, current)
    scored = []
    for spec in HARNESS_CANDIDATES[:candidate_limit]:
        candidate = {
            "id": spec["id"],
            "version": int(current.get("version", 0)) + 1,
            "system": spec["system"],
        }
        result = evaluate_tasks(runtime, seed_tasks, candidate)
        scored.append({"harness": candidate, "seed": result})
    scored.sort(key=lambda row: (row["seed"]["accuracy"], row["harness"]["id"]), reverse=True)
    best = current
    best_seed = baseline
    updated = False
    if scored and scored[0]["seed"]["accuracy"] >= baseline["accuracy"]:
        best = scored[0]["harness"]
        best_seed = scored[0]["seed"]
        updated = best["system"] != current["system"]
    return {
        "harness": best,
        "updated": updated,
        "baseline": baseline,
        "championSeed": best_seed,
        "candidates": [
            {
                "id": row["harness"]["id"],
                "accuracy": row["seed"]["accuracy"],
                "correct": row["seed"]["correct"],
            }
            for row in scored
        ],
        "rollouts": baseline["rollouts"] + sum(row["seed"]["rollouts"] for row in scored),
    }


def initial_harness() -> dict[str, Any]:
    return dict(BASE_HARNESS)
