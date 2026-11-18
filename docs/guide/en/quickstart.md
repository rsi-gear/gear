# Quick start

This page uses the Gear 0.2.4 `gear` CLI. Use compatible Node (22.x from
22.19, or 24+), and Python 3.10+; development and CPU tests use Python 3.12.
Linux algorithm isolation also requires bubblewrap, socat and ripgrep; macOS
uses the system sandbox. Hitch/Harbor tasks need their runtime and Docker.

## Install the current checkout

```sh
npm ci
npm pack
npm install --global ./rsi-gear-0.2.4.tgz
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install ./python
gear setup --python python3.12
gear doctor
```

Run these commands at the Gear source root. The activated `.venv` runs the Python SDK examples below; `gear setup` manages the execution worker environment. Build both packages from the same source. Codex Meta requires Hitch capabilities `isolated_agent_run: "1"` and `generation_budget: "1"`; `gear doctor` checks them. See [Meta integration](meta-agents.md).

`setup` verifies a fresh Python environment before selecting it; a failed install leaves the previous environment selected.
In an interactive terminal it also guides Target/Meta profile creation or selection; use `--json` for unattended setup.
Use `gear setup --hitch --target dsh --python python3.12 --json` to download the pinned harness, Harbor and Docker image and start the Hitch daemon.
Choose `--target pi` for Pi. Install Hitch, Docker and platform sandbox tools first. Setup makes no model calls.

## Create and check a benchmark

```sh
gear init my-benchmark --target dsh
cd my-benchmark
gear benchmark check
gear benchmark preview sum-01
gear algorithm test gepa
```

Select `--target pi` for Pi or `--template files` for file artifacts. Replace
the demonstration tasks in `tasks.csv` and `benchmark.yaml`. These checks and
offline algorithm tests make no model calls. `benchmark.preview` is an author
tool; do not pass its private expected answers to Meta.

## Configure execution and try one task

Create profiles using models available to you. The Target credential variable must match its provider:

```sh
gear profile create default-target --kind hitch --adapter dsh --model YOUR_TARGET_MODEL --pass-env OPENAI_API_KEY
gear profile create default-meta --kind codex --model YOUR_META_MODEL
gear profile use default-target --role target
gear profile use default-meta --role meta
gear doctor
```

Hitch profile creation pins the locally prepared image by registry digest. Codex uses `CODEX_API_KEY` by default;
use `--auth-home /path/to/codex-home` for an existing file-based login. Commands accept credential references, never key values.
See [configuration](configuration.md). Doctor reports dependencies, capabilities and local credential sources separately.
`ready_for_seed_smoke` means prerequisites for an attempted smoke test; `model_access: not_checked` remains explicit until an actual run.

```sh
gear evaluate --split seed --limit 1
gear report
```

Each evaluation returns a run ID. Reports distinguish valid zero scores, scorer
failures, environment failures and physical attempts. The small demonstration
benchmark checks the workflow; it does not establish optimization quality.

## Choose and run an algorithm

Save and run this Python example from the project directory. First set Meta request/token limits and the target evaluation budget in `gear.yaml` using [configuration](configuration.md#generation-and-diagnosis-budgets), then choose one [algorithm](algorithms.md):

```python
from gear import Project
from gear.algorithms import OPRO

project = Project.open(".")
recipe = OPRO(prompt_path="prompts/system.md")
print(project.plan_refine(algorithm=recipe, rounds=2))
run = project.refine(algorithm=recipe, rounds=2)
print(run.id)
print(run.report.summary)
```

For Pi, use `OPRO(prompt_path="AGENTS.md")`. Other recipes reuse the project configuration; Harness2 additionally needs [explicit task order and blind access](algorithms.md#harness2). In notebooks use `await project.aplan_refine(...)` and `await project.arefine(...)`.

Planning checks task scope, repetitions, budgets and verified baseline reuse without creating a run or making model calls. Admission rechecks inputs; a preview is not a reservation. A smoke test covers only its matching seed slot. `rounds=2` is a limit, and insufficient budget can stop a run earlier; inspect actual progress in the [report](results.md).

The CLI uses the algorithm configured in the project: `gear refine --rounds 2 --dry-run` previews it and `gear refine --rounds 2` executes it. Both entrypoints call the same project service.

See [run management](evolutions.md) for recovery and export. The ordinary CLI
needs no manually managed server; [Skill integration](meta-agents.md) provides
the natural-language entrypoint.
