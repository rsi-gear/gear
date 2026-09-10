"""Capture an actual Slime training forward on saved diagnostic token facts.

Replays synthetic-reward samples; does not generate, save a model, or certify a
runtime. Run only in an owned directory with an external GPU time limit.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import sys
import time


def reject_generation(*args, **kwargs):
    raise RuntimeError("this diagnostic must only replay the saved samples")


def replay_argv(record, model, output):
    source = record["argv"]
    assert all(isinstance(value, str) for value in source)
    replacements = {"--load": str(model), "--ref-load": str(model), "--hf-checkpoint": str(model),
                    "--rollout-function-path": "slime_logprob_replay.reject_generation"}
    result = []
    index = 0
    while index < len(source):
        flag = source[index]
        assert flag.startswith("--"), flag
        has_value = index + 1 < len(source) and not source[index + 1].startswith("--")
        if not (flag.startswith("--sglang-") or flag in ("--save", "--save-interval")):
            result.append(flag)
            if has_value:
                result.append(replacements.get(flag, source[index + 1]))
        index += 2 if has_value else 1
    assert set(replacements).issubset(result)
    assert "--load-debug-rollout-data" not in result and "--save-debug-train-data" not in result
    result.extend(["--load-debug-rollout-data", str(output / "replay.pt"),
                   "--save-debug-train-data", str(output / "train-{rollout_id}.pt")])
    return result


def validate_facts(samples):
    assert len(samples) == 2
    assert [row["index"] for row in samples] == [0, 1]
    for index, row in enumerate(samples):
        tokens, count, probs = row["tokens"], row["response_length"], row["rollout_log_probs"]
        assert 0 < count <= 8 and count < len(tokens) <= 256
        assert all(type(token) is int and 0 <= token < 151936 for token in tokens)
        assert len(probs) == count and all(math.isfinite(value) for value in probs)
        assert row["synthetic_reward"] == float(index)


def capture_report(path, original):
    import torch
    # Only load this diagnostic's own small dump. No arbitrary pickled classes.
    assert path.stat().st_size <= 1024 ** 2
    dump = torch.load(path, map_location="cpu", weights_only=True)
    assert dump["format_version"] == 2 and dump["rollout_id"] == 0
    assert len(dump["samples"]) == len(original)
    rows = []
    for position, (sample, fact) in enumerate(zip(dump["samples"], original, strict=True)):
        assert sample["rollout_position"] == position and sample["sample_index"] == fact["index"]
        assert sample["tokens"].tolist() == fact["tokens"]
        assert sample["response_lengths"] == fact["response_length"]
        mask = sample["loss_masks"].tolist()
        assert mask == [1] * fact["response_length"]
        actor = sample["log_probs"].float().tolist()
        native = sample["rollout_log_probs"].float().tolist()
        assert native == fact["rollout_log_probs"]
        assert len(actor) == len(native) and all(math.isfinite(value) for value in actor)
        differences = [a - b for a, b in zip(actor, native, strict=True)]
        rows.append({"index": position, "tokens": fact["tokens"], "responseLength": fact["response_length"],
                     "lossMask": mask, "actorLogprobs": actor, "nativeLogprobs": native,
                     "actorMinusNative": differences,
                     "meanAbsoluteDifference": sum(map(abs, differences)) / len(differences)})
    return {"samples": rows, "sampleMeanAbsoluteDifference": sum(row["meanAbsoluteDifference"] for row in rows) / len(rows)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--record", type=Path, required=True)
    parser.add_argument("--rollout", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--prepare-only", action="store_true")
    options = parser.parse_args()
    output = options.output.resolve()
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    facts = json.loads(options.rollout.read_text())
    validate_facts(facts)
    record = json.loads(options.record.read_text())
    argv = replay_argv(record, options.model.resolve(), output)
    import torch
    from slime.utils.types import Sample
    samples = [Sample(index=i, rollout_id=i, group_index=0, tokens=row["tokens"],
                      response_length=row["response_length"], rollout_log_probs=row["rollout_log_probs"],
                      reward=row["synthetic_reward"], status=Sample.Status.COMPLETED,
                      loss_mask=[1] * row["response_length"]).to_dict() for i, row in enumerate(facts)]
    torch.save({"samples": samples}, output / "replay.pt")
    sys.argv = ["slime-logprob-replay", *argv]
    from slime.utils.arguments import parse_args
    args = parse_args()
    assert args.debug_train_only and args.use_rollout_logprobs and args.bf16
    assert args.tensor_model_parallel_size == args.pipeline_model_parallel_size == args.context_parallel_size == 1
    assert args.num_steps_per_rollout == args.num_rollout == 1 and args.global_batch_size == 2
    assert args.attention_dropout == args.hidden_dropout == 0
    assert args.rollout_temperature == args.rollout_top_p == 1 and args.rollout_top_k == -1
    assert args.save is None and args.save_debug_train_data is not None
    assert not args.ci_test and args.ci_train_rollout_logprob_abs_diff_threshold == 0.1
    selected = ["bf16", "attention_backend", "attention_softmax_in_fp32", "fp32_residual_connection",
                "apply_rope_fusion", "disable_bf16_reduced_precision_matmul", "use_rollout_logprobs",
                "debug_train_only", "kl_coef", "lr", "offload_train", "offload_rollout"]
    (output / "prepared.json").write_text(json.dumps({"argv": argv, "parsed": {key: getattr(args, key) for key in selected},
                                                      "sourceArgv": record["argv"], "validated": False}, indent=2, default=str))
    if options.prepare_only:
        print(json.dumps({"status": "prepared", "validated": False}), flush=True)
        return

    import psutil
    import ray
    from slime.ray.placement_group import create_placement_groups, create_rollout_manager, create_training_models
    from slime.utils.logging_utils import init_tracking, finish_tracking
    memory = psutil.virtual_memory()
    assert memory.total >= 64 * 1024 ** 3 and memory.available >= 48 * 1024 ** 3
    ray_root = "/tmp/gear-lp-" + hashlib.sha256(str(output).encode()).hexdigest()[:10]
    assert not Path(ray_root).exists()
    start = time.monotonic()
    report = {"kind": "slime-training-logprob-replay", "validated": False,
              "syntheticRewards": True, "freshNativeGeneration": False, "checkpointOrExport": False,
              "status": "running", "rayDirectory": ray_root}
    def terminate(signum, frame):
        raise SystemExit(f"received signal {signum}")
    signal.signal(signal.SIGTERM, terminate)
    manager = None
    try:
        ray.init(address="local", num_gpus=1, num_cpus=8, include_dashboard=False,
                 object_store_memory=512 * 1024 ** 2, _temp_dir=ray_root,
                 runtime_env={"env_vars": {"PYTHONPATH": os.environ["PYTHONPATH"]}})
        init_tracking(args)
        groups = create_placement_groups(args)
        manager, _ = create_rollout_manager(args, groups["rollout"])
        actor, _ = create_training_models(args, groups, manager)
        print(json.dumps({"phase": "actor-ready", "elapsedSeconds": time.monotonic() - start}), flush=True)
        data = ray.get(manager.generate.remote(0))
        ray.get(actor.async_train(0, data))
        report.update(capture_report(output / "train-0.pt", facts))
        report["status"] = "captured"
    except BaseException as error:
        report.update(status="failed", error=f"{type(error).__name__}: {error}")
        raise
    finally:
        try:
            if manager is not None:
                ray.get(manager.dispose.remote(), timeout=10)
        finally:
            ray.shutdown()
            finish_tracking(args)
            report["elapsedSeconds"] = time.monotonic() - start
            (output / "capture.json").write_text(json.dumps(report, indent=2))
            print(json.dumps({key: value for key, value in report.items() if key != "samples"}), flush=True)


if __name__ == "__main__":
    main()
