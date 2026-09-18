"""Bounded native Slime update diagnostic; synthetic rewards, not compatibility evidence.

Run with the pinned Slime plus Gear export patch on PYTHONPATH, and an external
timeout. The output directory must belong only to this diagnostic invocation.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def rendered_prompt(tokenizer):
    prompt = tokenizer.apply_chat_template([{"role": "user", "content": "Output only one invented spaceship name, without a preamble or explanation."}],
                                           tokenize=False, add_generation_prompt=True)
    assert isinstance(prompt, str) and prompt
    return prompt


def generate_rollout(args, rollout_id, data_source, evaluation=False):
    """Exercise upstream native generation and conversion with diagnostic rewards."""
    assert not evaluation
    from slime.rollout.base_types import RolloutFnTrainOutput
    from slime.rollout.sglang_rollout import GenerateState, generate
    from slime.utils.async_utils import run
    from slime.utils.types import Sample

    async def generate_group():
        state = GenerateState(args)
        samples = [Sample(group_index=rollout_id, index=rollout_id * 2 + i,
                          rollout_id=rollout_id * 2 + i,
                          prompt=rendered_prompt(state.tokenizer)) for i in range(2)]
        results = await asyncio.gather(*(generate(args, sample, {
            **state.sampling_params, "sampling_seed": 1234 + i,
        }) for i, sample in enumerate(samples)))
        generation_calls = 2
        # Identical responses with opposite synthetic rewards cancel the gradient.
        # A bounded diagnostic-only retry avoids spending a full training step on
        # that pair. This conditional selection is not on-policy compatibility evidence.
        for retry in range(3):
            if results[0].tokens != results[1].tokens:
                break
            replacement = Sample(group_index=rollout_id, index=rollout_id * 2 + 1,
                                 rollout_id=rollout_id * 2 + 1, prompt=rendered_prompt(state.tokenizer))
            results[1] = await generate(args, replacement, {**state.sampling_params, "sampling_seed": 1236 + retry})
            generation_calls += 1
        assert results[0].tokens != results[1].tokens, "refuse a diagnostic pair whose gradients cancel exactly"
        evidence = []
        for i, sample in enumerate(results):
            assert 0 < sample.response_length <= 8
            assert len(sample.rollout_log_probs) == sample.response_length
            assert all(math.isfinite(value) for value in sample.rollout_log_probs)
            assert len(sample.tokens) > sample.response_length
            sample.reward = float(i)  # Diagnostic gradient signal; never task/verifier evidence.
            evidence.append({"index": sample.index, "tokens": sample.tokens,
                             "response_length": sample.response_length,
                             "rollout_log_probs": sample.rollout_log_probs,
                             "synthetic_reward": sample.reward, "group_generation_calls": generation_calls})
        Path(os.environ["GEAR_ACTOR_DIAGNOSTIC_OUTPUT"], f"rollout-{rollout_id}.json").write_text(json.dumps(evidence, indent=2))
        return results

    return RolloutFnTrainOutput(samples=run(generate_group()))


def prepared_args(options):
    from gear_training.driver import build_argv
    from gear_training.placement import validate_resource_args
    from gear_training.recipes.agent_grpo import validate_layout
    from slime.utils.arguments import parse_args

    source = json.loads(Path(options.input).read_text())
    request = source["request"]
    assert request["trainer"]["placement"] == "colocated" and len(request["trainingDevices"]) == 1
    assert request["trainer"]["updatesPerCandidate"] == 1
    assert request["trainer"]["rolloutBatchSize"] == 1 and request["trainer"]["globalBatchSize"] == 2
    assert request["rollout"]["groupSize"] == 2 and request["rollout"]["sampling"]["maxNewTokens"] == 8
    paths = {"load": options.model, "reference": options.model, "hf": options.model,
             "save": str(options.output / "checkpoint"), "export": str(options.output / "export")}
    argv = build_argv(request, source["hyperparameters"], paths, 0)
    # The native runtime can be diagnosed before complete task/receipt attestation
    # exists. This callback substitution must never be a production job/probe.
    argv[argv.index("--rollout-function-path") + 1] = "slime_actor_smoke.generate_rollout"
    argv.extend(["--lr-decay-style", "constant", "--attention-backend", options.attention_backend, "--sglang-attention-backend", "triton",
                 "--sglang-sampling-backend", "pytorch", "--sglang-mem-fraction-static", "0.25",
                 "--sglang-context-length", "256", "--sglang-max-total-tokens", "512",
                 "--sglang-max-running-requests", "2", "--sglang-disable-cuda-graph",
                 "--sglang-disable-radix-cache", "--seed", "1234"])
    sys.argv = ["gear-slime-actor-diagnostic", *argv]
    args = parse_args()
    validate_resource_args(args, request, argv)
    validate_layout(args, request)
    assert not args.no_save_optim and not args.no_save_rng and not args.async_save
    (options.output / "prepared-argv.json").write_text(json.dumps({"argv": argv, "request": request}, indent=2))
    return args


def changed_tensor(model, exported):
    """Read one tensor at a time on CPU; prove the HF export is not the parent."""
    from safetensors import safe_open
    import torch

    parent_files = {}
    for file in sorted(Path(model).glob("*.safetensors")):
        with safe_open(file, framework="pt", device="cpu") as reader:
            parent_files.update({key: file for key in reader.keys()})
    assert parent_files, "parent has no safetensors"
    for file in sorted(exported.glob("*.safetensors")):
        with safe_open(file, framework="pt", device="cpu") as reader:
            for key in sorted(reader.keys()):
                # Keep diagnostic CPU memory bounded; no embedding copies needed.
                if ".layers." not in key:
                    continue
                with safe_open(parent_files[key], framework="pt", device="cpu") as parent:
                    before, after = parent.get_tensor(key), reader.get_tensor(key)
                assert before.shape == after.shape and before.dtype == after.dtype
                assert torch.isfinite(after).all().item()
                count = torch.count_nonzero(before != after).item()
                if count:
                    return {"name": key, "changed_elements": count,
                            "max_abs_delta": (before.float() - after.float()).abs().max().item()}
    raise AssertionError("exported actor weights did not change")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--input", required=True, help="slime_argument_smoke argument-input.json")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--attention-backend", choices=("flash", "unfused"), default="flash",
                        help="Explicit training backend; unsupported kernels fail without fallback")
    parser.add_argument("--minimum-host-memory-gib", type=float, default=64)
    parser.add_argument("--minimum-available-memory-gib", type=float, default=48)
    options = parser.parse_args()
    options.output = options.output.resolve()
    options.output.mkdir(parents=True, exist_ok=True)
    ray_directory = Path("/tmp") / ("gear-actor-" + hashlib.sha256(str(options.output).encode()).hexdigest()[:10])
    assert len(str(ray_directory / "session_2026-09-08_12-34-56_123456_99999/sockets/plasma_store").encode()) <= 107
    assert not (options.output / "summary.json").exists(), "refuse to reuse a completed diagnostic directory"
    import psutil
    memory = psutil.virtual_memory()
    observed_memory = {"total_bytes": memory.total, "available_bytes": memory.available,
                       "minimum_total_gib": options.minimum_host_memory_gib,
                       "minimum_available_gib": options.minimum_available_memory_gib}
    assert options.minimum_host_memory_gib > 0 and options.minimum_available_memory_gib > 0
    (options.output / "host-memory.json").write_text(json.dumps(observed_memory, indent=2))
    assert memory.total >= options.minimum_host_memory_gib * 1024 ** 3, "insufficient host RAM for this native offload diagnostic"
    assert memory.available >= options.minimum_available_memory_gib * 1024 ** 3, "insufficient available RAM for this native offload diagnostic"
    os.environ["GEAR_ACTOR_DIAGNOSTIC_OUTPUT"] = str(options.output)
    args = prepared_args(options)
    if options.prepare_only:
        from slime.rollout.sglang_rollout import GenerateState, _prepare_prompt_ids
        from slime.utils.types import Sample
        from slime.backends.megatron_utils.actor import MegatronTrainRayActor
        from slime.ray.actor_group import RayTrainGroup
        from slime.ray.rollout import RolloutManager
        assert hasattr(MegatronTrainRayActor, "export_hf") and hasattr(RayTrainGroup, "export_hf")
        state = GenerateState(args)
        tokens = _prepare_prompt_ids(Sample(prompt=rendered_prompt(state.tokenizer)),
                                     state.tokenizer, state.processor)
        assert tokens and all(type(token) is int for token in tokens)
        print(json.dumps({"kind": "gear-slime-actor-diagnostic", "validated": False, "status": "prepared"}), flush=True)
        return

    import ray
    from gear_training.placement import TrainingMemoryCycle
    from slime.ray.placement_group import create_placement_groups, create_rollout_manager, create_training_models
    from slime.utils.logging_utils import configure_logger, init_tracking, finish_tracking

    start = time.monotonic()
    summary = {"kind": "gear-slime-actor-diagnostic", "validated": False,
               "synthetic_rewards": True, "status": "running", "phases": []}
    manager = None

    def record(phase, **details):
        snapshot = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                                  capture_output=True, text=True, timeout=10, check=True).stdout.strip()
        event = {"phase": phase, "elapsed_seconds": round(time.monotonic() - start, 3),
                 "gpu_memory_mib": snapshot, **details}
        summary["phases"].append(event)
        (options.output / "progress.json").write_text(json.dumps(summary, indent=2))
        print(json.dumps(event), flush=True)

    def terminate(signum, frame):
        raise SystemExit(f"diagnostic received signal {signum}")

    signal.signal(signal.SIGTERM, terminate)
    try:
        record("starting")
        assert not ray_directory.exists(), "refuse to reuse another private Ray session"
        summary["ray_directory"] = str(ray_directory)
        ray.init(address="local", num_gpus=1, num_cpus=8, object_store_memory=512 * 1024 ** 2,
                 include_dashboard=False, _temp_dir=str(ray_directory),
                 runtime_env={"env_vars": {"PYTHONPATH": os.environ.get("PYTHONPATH", ""),
                                          "GEAR_ACTOR_DIAGNOSTIC_OUTPUT": str(options.output)}})
        configure_logger()
        init_tracking(args)
        pgs = create_placement_groups(args)
        manager, _ = create_rollout_manager(args, pgs["rollout"])
        record("rollout-created")
        actor, _ = create_training_models(args, pgs, manager)
        assert hasattr(actor, "export_hf"), "pinned Gear HF export patch is required"
        memory = TrainingMemoryCycle(args, ray, actor, manager)
        record("actor-created")
        memory.prepare_rollout()
        engines, *_ = ray.get(manager.get_updatable_engines_and_lock.remote())
        versions_before = ray.get([engine.get_weight_version.remote() for engine in engines])
        data = ray.get(manager.generate.remote(0))
        record("generated", weight_versions=versions_before)
        memory.finish_rollout(lambda: None)  # generate returned synchronously; no external task calls.
        memory.train_and_save(0, data)
        record("trained-and-saved")
        tracker = options.output / "checkpoint/latest_checkpointed_iteration.txt"
        # Slime labels this checkpoint with zero-based rollout_id, not step count.
        assert tracker.read_text().strip() == "0", "synchronous checkpoint does not match rollout 0"
        memory.export_hf(str(options.output / "export"))
        delta = changed_tensor(options.model, options.output / "export")
        record("exported", changed_tensor=delta)
        memory.prepare_rollout()
        versions_after = ray.get([engine.get_weight_version.remote() for engine in engines])
        assert versions_after != versions_before, "weight transfer version did not advance"
        ray.get(manager.generate.remote(1))
        memory.finish_rollout(lambda: None)
        record("updated-policy-generated", weight_versions=versions_after)
        summary["status"] = "passed"
        summary["checkpoint_files"] = [{"path": str(p.relative_to(options.output / "checkpoint")), "bytes": p.stat().st_size}
                                       for p in sorted((options.output / "checkpoint").rglob("*")) if p.is_file()]
    except BaseException as error:
        summary.update(status="failed", error=f"{type(error).__name__}: {error}")
        raise
    finally:
        try:
            if manager is not None:
                try:
                    ray.get(manager.dispose.remote(), timeout=10)
                except Exception as error:
                    summary["dispose_error"] = str(error)
        finally:
            ray.shutdown()
            finish_tracking(args)
            summary["elapsed_seconds"] = round(time.monotonic() - start, 3)
            summary["script_sha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
            (options.output / "summary.json").write_text(json.dumps(summary, indent=2))
            print(json.dumps({k: v for k, v in summary.items() if k not in ("phases", "checkpoint_files")}), flush=True)


if __name__ == "__main__":
    main()
