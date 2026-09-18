"""Check the bridge argv against the pinned Slime parser without starting Ray."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--slime", required=True)
    parser.add_argument("--output", required=True)
    options = parser.parse_args()
    output = Path(options.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    from gear_training.driver import build_argv
    from gear_training.placement import validate_resource_args
    from gear_training.recipes.agent_grpo import validate_layout
    model_args = subprocess.run(["bash", "-c", 'source "$1"; printf "%s\\0" "${MODEL_ARGS[@]}"', "_",
                                 str(Path(options.slime) / "scripts/models/qwen2.5-1.5B.sh")],
                                check=True, capture_output=True).stdout.decode().strip("\0").split("\0")
    model_config = json.loads((Path(options.model) / "config.json").read_text())
    # The upstream 1.5B base-model recipe has a different RoPE base from Instruct.
    rotary_base = float(model_config["rope_theta"])
    assert rotary_base > 0 and rotary_base.is_integer()
    model_args[model_args.index("--rotary-base") + 1] = str(int(rotary_base))
    request = {"schemaVersion": 1, "trainingDevices": ["probe-device"],
               "trainer": {"placement": "colocated", "dataParallelSize": 1, "updatesPerCandidate": 1,
                           "rolloutBatchSize": 1, "globalBatchSize": 2},
               "rollout": {"groupSize": 2, "sampling": {"temperature": 1, "topP": 1, "topK": -1,
                                                        "repetitionPenalty": 1, "maxNewTokens": 8}}}
    hyperparameters = {"schemaVersion": 1, "slimeArgs": [*model_args, "--lr", "0.000001", "--kl-coef", "0.001",
                       "--eps-clip", "0.2", "--num-steps-per-rollout", "1", "--bf16",
                       "--tensor-model-parallel-size", "1", "--pipeline-model-parallel-size", "1",
                       "--context-parallel-size", "1", "--seq-length", "256", "--max-position-embeddings", "256",
                       "--micro-batch-size", "1", "--attention-dropout", "0", "--hidden-dropout", "0"]}
    paths = {"load": options.model, "reference": options.model, "hf": options.model,
             "save": str(output.parent / "checkpoint"), "export": str(output.parent / "export")}
    argv = build_argv(request, hyperparameters, paths, 0)
    (output.parent / "argument-input.json").write_text(json.dumps({"request": request, "hyperparameters": hyperparameters, "argv": argv}, indent=2))
    sys.argv = ["gear-slime-argument-probe", *argv]
    from slime.utils.arguments import parse_args
    args = parse_args()
    validate_resource_args(args, request, argv)
    validate_layout(args, request)
    assert not args.no_save_optim and not args.no_save_rng and not args.async_save
    output.write_text(json.dumps({"kind": "gear-slime-argument-diagnostic", "validated": False, "status": "passed",
                                 "colocate": args.colocate, "offload_train": args.offload_train,
                                 "offload_rollout": args.offload_rollout, "actor_gpus": args.actor_num_gpus_per_node,
                                 "rollout_gpus": args.rollout_num_gpus}, indent=2))
    print(output.read_text())


if __name__ == "__main__":
    main()
