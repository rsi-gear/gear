# Gear

[![GitHub release](https://img.shields.io/github/v/release/rsi-gear/gear)](https://github.com/rsi-gear/gear/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-Join_chat-5865F2?logo=discord&logoColor=white)](https://discord.gg/cZ4NBbHDk)

[English](README.md) | [简体中文](README.zh-CN.md) · [User guide](https://rsigear.xyz/docs/gear) · [Examples](https://rsigear.xyz/docs/gear/examples/marketing-harness)

**Evolve agent harnesses with verifiable evaluation feedback.**

Gear uses a Meta agent to turn task trajectories into Harness changes, evaluates exact Git versions under paired conditions, and records which candidates to retain or promote. Improve prompts, skills, tools and workflows while preserving the evidence behind each decision.

```text
Seed tasks → Baseline evidence → Harness changes → Paired evaluations → Selection
```

> **Pre-alpha.** Gear 0.1.0 supports local research and integration. State formats and extension APIs may change. Install the npm package as `gear@latest`.

## Why Gear?

- **Improve from experience.** Meta diagnoses actual failures and proposes a reusable mechanism.
- **Measure each change.** Compare exact candidates and baselines; retain useful research records and an accepted champion.
- **Experiment with algorithms.** Compose generation, sampling, judging, assessment, selection and promotion components.
- **Keep the result.** Export a versioned Harness with its manifest, diff and evaluation provenance.

Gear manages search and promotion. [Hitch](https://github.com/rsi-gear/agent-hitch) runs evaluations and records evidence. [Rear](https://github.com/rsi-gear/rear) is an optional read-only workbench.

## Two worked examples

### 1. Evolve a harness for Marketing

Five rounds on the 100-task AutomationBench public Marketing research set improved **Luna medium from 27% to 36%** strict task pass rate. The final retained Harness separately scored **50% at max effort**.

![Five-round Harness evolution with candidate and champion scores; separate max evaluation and private-set leaderboard reference.](docs/guide/assets/marketing-harness-evolution.svg)

Read the [case study](docs/guide/en/example-harness.md) for the input instructions, final retained Meta change, rejected candidates, and [runnable Harness source](examples/automationbench-marketing/README.md).

### 2. Customize your evolve algorithm

Starting from that champion, three rounds of shared failure diagnosis and **4 → 2 → 1 staged evaluation** reached **40% at medium**. The resulting Harness scored **53% at max** in a separate evaluation.

The [algorithm example](docs/guide/en/example-algorithm.md) explains individuals, parent selection, Meta mutations, fitness, research archives and promotion. It includes a runnable selector component and the exact configuration and final Harness from the measured staged implementation. This mutation-based variant does not implement crossover; all observed candidates in the three-round case shared the same parent.

Both cases optimized on the public research set, with no independent held-out validation. The official leaderboard uses a different private set; its reference score is not evidence of official SOTA. [Metrics, sources and comparison rules](docs/guide/en/results.md).

## Quick start

Install Gear and Hitch. This example uses DSH for rollouts:

```bash
npm install --global gear@latest agent-hitch@latest @deepseek-ai/dsh@latest
hitch eval setup harbor
```

Add the bundled [Refine Skill](skills/refine/SKILL.md) to Codex, Claude Code, DSH or another compatible agent. Follow the [Quick start](docs/guide/en/quickstart.md) to connect Gear, prepare your Harness and benchmark, and configure the Meta and rollout agents independently. Then load Refine through the host's Skill interface or `/refine` where supported, or ask in natural language:

```text
Use the Refine Skill to optimize the Marketing domain of AutomationBench.
Use Codex + Astra as the Meta agent and DSH + Luna for rollouts.
Run one round of optimization.
```

Meta proposes Harness changes; the rollout agent executes benchmark tasks. [Meta connections](docs/guide/en/meta-agents.md) covers standalone and native DSH integration. Model weight optimization uses a separate [experimental training workflow](docs/guide/en/training.md).

## How it works

An evolution seals its datasets, model/sampling settings, component implementations and budgets. Candidates are exact Git commits with verified manifests. The default search generates from the accepted champion, evaluates seed evidence, selects survivors and a finalist, and applies the configured promotion gate. Research retention, evolution promotion and workspace publication are separate decisions.

Meta and Target are independent. The built-in Target builder currently uses DSH; additional Target types need a builder and rollout integration. Algorithm components operate within Gear's version, containment, evidence parity, held-out isolation and atomic state-update contracts. [Configuration](docs/guide/en/configuration.md) · [Operations](docs/guide/en/evolutions.md) · [Component interfaces](src/evolution/components.ts).

## Experimental model training

`gear-refine training` coordinates Slime GRPO updates, exact-token capture, complete checkpoints and immutable model evaluation. Its lifecycle is separate from Harness evolution. Start with the [training overview](docs/guide/en/training.md) for deployment and certification scope; the recorded GPU validation does not establish model-quality improvement.

The longer-term direction includes evolving tasks and models alongside Harnesses. See the [vision](docs/vision.md).

## Documentation and development

- [User guide](docs/guide/en/index.md): setup, tasks, operation, results and troubleshooting.
- [Harness example](examples/automationbench-marketing/README.md) and [algorithm example](examples/evolution-search/README.md).
- [DSH integration lab](examples/dsh-codex-luna/README.md) and [detailed installation](docs/plugin-installation-and-usage.md).
- [Training contracts and GPU certification](docs/training/README.zh-CN.md).

```bash
npm run typecheck
npm test
npm run build
npm run pack:check
node --test examples/evolution-search/selection.test.mjs
```

Charts are generated from [versioned data](docs/guide/assets/marketing-results.json) with `python scripts/render-guide-charts.py` (matplotlib 3.7+). Guide source lives in `docs/guide`; gear-pages imports a checksummed snapshot. The [authoring notes](docs/guide/README.md) describe updates and validation. Training CPU test setup is in the [training guide](docs/guide/en/training.md).

## Community and license

Discuss experiments and contribute focused issues or pull requests at [rsi-gear/gear](https://github.com/rsi-gear/gear) and [Discord](https://discord.gg/cZ4NBbHDk). Describe the experiment or compatibility contract your change preserves.

[MIT](LICENSE).
