# Model training · experimental

Gear also coordinates Slime GRPO model updates while freezing the Harness and datasets. This is a separate experiment lifecycle from Harness evolution.

## What is implemented

The TypeScript controller and Python bridge seal inputs, capture exact policy tokens, save complete checkpoints, export immutable HF models, evaluate through Hitch/Harbor and record promotion decisions. The v2 controller separates the control host, Harbor worker and model node.

The documented hardware certification covers a remote single RTX 5090 with Qwen2.5-1.5B and local Gear/Hitch/Harbor Docker, including updates, recovery and inference. Remote Docker/Harbor and dual-GPU configurations were not certified in that record. Its independent evaluation reward was zero; the certification establishes execution/recovery coverage, not model quality improvement.

## Deployment path

1. Read [controller v2](../../training/controller-v2.zh-CN.md) and select the actual host/node topology.
2. Pin the runtime, model, tokenizer, template, verifier and recipe. Apply only the documented patches for that exact runtime.
3. Run deployment preflight and freeze the deployment; import and seal model/dataset inputs.
4. Validate and initialize the experiment, then admit and preflight its work.
5. Repeatedly call `advance` until completed or an explicit blocked/failed state requires action.
6. Inspect immutable model evaluation before explicit publication or rollback.

```text
gear-refine training
```

The bare command displays validation/usage information; it does not start training. Full subcommand arguments and JSON schemas are in the [training guide](../../training/README.zh-CN.md). `advance` is one coordination step, not a background timer; Slime jobs and Hitch evaluations have their own lifecycles.

## Verification scope

CPU bridge/controller tests do not certify GPU execution. A `pending-gpu` runtime lock cannot admit formal training. Use the [recorded single-GPU certification](../../training/certifications/2026-09-10-rtx5090-single-gpu/README.zh-CN.md) to understand which exact identities and recovery checks were exercised. Changed code or runtime requires renewed validation.

## CPU development tests

Use Python 3.12 with the repository's pinned test dependencies; these are separate from a production GPU runtime lock. Run from the Gear repository root:

```bash
python3.12 -m venv python/.venv
. python/.venv/bin/activate
python -m pip install './python[gateway]' -c python/constraints-test.txt
python -m pip install torch -c python/constraints-test.txt --index-url https://download.pytorch.org/whl/cpu
GEAR_TRAINING_TEST_PYTHON="$VIRTUAL_ENV/bin/python" npm run test:training
```

On macOS, omit `--index-url` when installing Torch. CI runs the Python suite in `Training / CPU`.
