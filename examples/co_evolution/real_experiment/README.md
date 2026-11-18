# Real MLX co-evolution experiment (#93)

Runs four settings on Apple Silicon with a real local LM:

- `fixed_baseline`
- `model_only` (MLX LoRA)
- `harness_only` (system-prompt search)
- `co_evolution`

Requires `mlx-lm`. Does **not** require NVIDIA GPU, Hitch, or Harbor.

```sh
. python/.venv/bin/activate
python -m pip install -U mlx-lm
PYTHONPATH=examples python -m co_evolution.real_experiment.run_experiment \
  --workspace .local/co-evolution/real \
  --rounds 3 --lora-iters 25
```

Results and the issue answer land in `.local/co-evolution/real/FINDINGS.md`.
