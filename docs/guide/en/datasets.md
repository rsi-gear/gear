# Tasks and evaluations

Prepare the task set before starting an evolution. Gear freezes dataset content and evaluation settings so a later round cannot silently change the experiment.

## Small first, then full evaluation

Use a Harbor-compatible dataset with task instructions, environment and verifier. First run one known task and inspect its verifier output. A working model request alone does not validate task setup or scoring.

For AutomationBench, use Hitch's version-matched benchmark-package import tooling; do not pass the raw upstream Python repository as a Harbor dataset. Follow [Hitch benchmark packages](https://github.com/rsi-gear/agent-hitch/blob/main/docs/benchmark-packages.md) and check the help of the installed importer. Preserve the upstream revision, importer/runtime identity, task IDs and generated dataset digest. The historical 100-task export is not shipped in the Harness download.

## Import one Marketing task

This pins the Hitch adapter and upstream revision used in the experiment. Start Docker and run from the Gear repository root. Import builds an image and installs dependencies, but makes no model calls. The output directory must not already exist.

```bash
git clone https://github.com/rsi-gear/agent-hitch.git ../hitch-marketing-guide
git -C ../hitch-marketing-guide checkout 67c527b9321e37755c77ee50545af4b9524ec731
node ../hitch-marketing-guide/benchmark-packages/automationbench/import.mjs \
  --source https://github.com/zapier/AutomationBench.git \
  --ref 4a8e1061254004d9dac807054eed33fad7d1ff14 \
  --task marketing.social_engagement_response \
  --out "$PWD/.evolve-lab/marketing-guide/one-task"
```

Use the generated directory as `GEAR_SMOKE_DATASET` in Quick start. The full 100-task case requires explicit task selection and its export manifest; a one-task run is not a full benchmark score. See the [pinned adapter instructions](https://github.com/rsi-gear/agent-hitch/blob/67c527b9321e37755c77ee50545af4b9524ec731/benchmark-packages/automationbench/README.md).

## Split evidence by purpose

| Set | Consumer | Purpose |
| --- | --- | --- |
| Seed/dev | Meta and search | Diagnose failures and select modifications. |
| Held-out | Promotion control plane | Test the finalist under conditions not exposed to Meta. |
| Public research set | Explicit research experiment | Study iteration on a known task set; report that it participated in optimization. |

Use disjoint directories and keep related task families separated where relevant. Do not relabel a second evaluation on the same tasks as an independent test. Both Marketing cases intentionally used all 100 public tasks for research; they demonstrate same-set improvement.

## Record evaluation conditions

Pin the model and effort, Harness revision, task versions, scoring rule, repetitions, timeouts and runtime. Concurrency affects resource use, while model and sampling affect results. Gear and Hitch must agree on the effective execution policy.

```yaml
seedTaskRef: /absolute/datasets/seed
heldOutRef: /absolute/datasets/held-out
taskBudgetMs: 3600000
hitch:
  attempts: 1
  maxConcurrent: 4
  setupTimeoutMs: 1200000
```

Changing a sealed setting requires a new evolution. `continue` does not reload global dataset, model or budget defaults.

## Reuse and repair

Reuse is valid only when evidence identities and logical `(task, attempt)` slots match. Keep valid zero-score tasks. Repair missing or infrastructure-invalid slots through `rerun`; preserve original failures and valid evidence. Count physical executions separately from final scored tasks. See [results](results.md) and [operations](evolutions.md).
