# Synthetic model + harness co-evolution scaffold

[English](README.md)

CPU-only dry-run for [rsi-gear/gear#93](https://github.com/rsi-gear/gear/issues/93).

This example defines an iterative loop that joins trajectory collection, model
updates, harness search, and held-out evaluation. It tracks model checkpoints,
harness versions, training/seed digests, and evaluation results in one ledger.
It compares four settings under a shared budget and supports order/frequency
ablations.

**These results are synthetic.** They do not measure Terminal-Bench,
AutomationBench, or any real model quality gain. Real GPU training and Refine
harness evolution remain separate Gear lifecycles.

## Setup

From the Gear repository root (Node + editable Python package already installed):

```sh
npm ci
npm run typecheck
npm run build
python3 -m venv python/.venv
. python/.venv/bin/activate
python -m pip install -e './python'
```

## Run the four settings

```sh
PYTHONPATH=examples python -m co_evolution.run \
  --workspace .local/co-evolution/smoke \
  --rounds 6 \
  --ablations
```

Artifacts land under `.local/co-evolution/` (gitignored). Each setting writes:

- `ledger.jsonl` — joint identities per round
- `summary.json` — compact table
- `result.json` — final score + stability
- `comparison.json` — cross-setting summary
- `ablations/ablation-summary.json` — order/frequency matrix

## Settings

| Setting | Model updates | Harness updates |
| --- | --- | --- |
| `fixed_baseline` | no | no |
| `model_only` | yes | frozen baseline harness |
| `harness_only` | frozen baseline model | yes |
| `co_evolution` | yes | yes |

Shared budget counts rollouts and update slots. Default budget equals the
co-evolution worst case so comparisons stay resource-comparable.

## Tests

```sh
PYTHONPATH=examples python -m unittest co_evolution.test_co_evolution -v
```

## Design notes

- `train` / `seed` / `held_out` task ids are disjoint (`fixtures/split.json`).
- Model updates use Gear's public `TrainingLoop` on the train split only.
- Harness search proposes deterministic candidates and ranks them on seed only.
- Held-out evaluation never feeds training or harness promotion.
- Interaction terms in `world.py` make reinforcement vs interference observable.

## Real experiment (MLX)

For a real local LM run that answers [#93](https://github.com/rsi-gear/gear/issues/93) on Apple Silicon, see [`real_experiment/README.md`](real_experiment/README.md). Artifacts and findings stay under `.local/co-evolution/real/`.
