# Gear

**Adapt your agent to any task.**

[![GitHub release](https://img.shields.io/github/v/release/rsi-gear/gear)](https://github.com/rsi-gear/gear/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-Join_chat-5865F2?logo=discord&logoColor=white)](https://discord.gg/cZ4NBbHDk)

[English](README.md) | [简体中文](README.zh-CN.md) · [User guide](https://rsigear.xyz/docs/gear) · [Examples](https://rsigear.xyz/docs/gear/examples/evolution-search)

Give Gear tasks with checkable results. It tests an AI agent, looks at what went wrong, and improves its instructions, tools, and workflow so it can do those tasks better.

## A smaller model that can compete with the best

On **AutomationBench's 100 public Marketing tasks**, Gear improved **GPT 5.6 Luna max to a process score of 88.88%, above Codex + GPT 6 Astra max's 84.08%**. Its **task pass rate reached 53%, close to Astra's 57%**. The smaller model met more of the scoring requirements on average and came close on fully completed tasks.

![Example 2: the Gear-evolved harness with GPT 5.6 Luna max scores 88.88% on process and passes 53% of tasks, compared with 84.08% and 57% for Codex + GPT 6 Astra max.](docs/guide/assets/marketing-staged-search.svg)

## Tasks we have validated

Our compute budget is limited, so we are starting with the task set below. We report results before and after optimization, alongside a leading-model (SOTA) reference.

| Validated task set | Metric | Before · medium | After · medium → max | SOTA model reference |
| --- | --- | ---: | ---: | ---: |
| AutomationBench / Marketing · 100 tasks | Task pass rate | 27% | **40% → 53%** | 57% |
| AutomationBench / Marketing · 100 tasks | Process score | 75.37% | **83.87% → 88.88%** | 84.08% |

The before/after agent uses DSH + GPT 5.6 Luna; the reference uses Codex + GPT 6 Astra max on the same 100 public tasks. **Medium → medium shows the harness improvement; max uses a higher reasoning budget.** Process score measures the share of scoring requirements met; a task passes only when all its scored requirements are met.

These public tasks also guided optimization. The reference column uses our Codex + Astra measurement on this public set; starred points in the chart come from a separate official private test set. [Scoring and sources](docs/guide/en/results.md) · [Full experiment](docs/guide/en/example-algorithm.md).

## Quick start

Gear is an optimization library you can call as a **Skill** from Codex, Claude Code, DSH, or another compatible agent. Use an existing benchmark, or bring your own tasks in [Harbor format](docs/guide/en/datasets.md).

Install Gear and [Hitch](https://github.com/rsi-gear/agent-hitch), which runs the tests. This example uses DSH as the agent doing the tasks:

```bash
npm install --global gear@latest agent-hitch@latest @deepseek-ai/dsh@latest
hitch eval setup harbor
```

Follow the [setup guide](docs/guide/en/quickstart.md) to add the bundled [Refine Skill](skills/refine/SKILL.md) to your agent and connect your benchmark. Then use `/refine` where supported, or ask in plain language:

```text
Use the Refine Skill to improve performance on AutomationBench's Marketing tasks.
Use Codex + Astra to propose improvements and DSH + Luna to run the tasks.
Run one round of optimization.
```

The agent proposing changes is called the **Meta agent**. It can use a different model from the agent doing the tasks.

## Algorithm design: learning how to improve

Gear follows a **meta-learning** design: one loop does the tasks, and another learns how to improve the agent doing them.

- **Inner loop: do the work.** The task agent uses its current model, instructions, and tools to attempt the tasks.
- **Outer loop: improve the worker.** The Meta agent reads the results and failed attempts, proposes changes, and tests which versions work better.

The instructions, tools, and workflow around a model are called its **harness**. Gear's design aims to **evolve the model and harness together**: improve how the agent works through harness changes, and improve the model's ability through training, using task results to guide both. Harness evolution works today. Model training has an experimental path; the complete joint loop is still in progress.

### What can evolve?

Within the parts of the agent you allow Gear to edit:

| Component | What can change | Status |
| --- | --- | --- |
| Prompts and policies | Task instructions, system prompts, and rules for taking action. | Supported |
| Tools and hooks | Tool code and checks before or after a tool runs. | Supported |
| Skills and workflows | Reusable procedures, helper scripts, and the order of steps. | Supported |
| Context management | What information the agent sees and how it summarizes long histories. | Supported |
| Harness composition | Which plugins and providers the agent uses and how they are configured. | Supported |
| Model weights | Train the model itself using feedback from tasks. | Experimental; full iteration loop incomplete |

You can also customize the **optimization algorithm**: how it proposes changes, selects tasks, runs and scores attempts, compares candidates, and decides which version to keep. [Example 2](docs/guide/en/example-algorithm.md) shows these modules through a GEPA-based search.

Gear saves each version and its results, so you can inspect the changes and use the final harness.

## Explore the examples

- [Evolve a harness for Marketing](docs/guide/en/example-harness.md): follow five rounds of changes, from the initial prompt to the final harness.
- [Customize your evolve algorithm](docs/guide/en/example-algorithm.md): change how Gear proposes improvements, chooses tasks to test, and keeps the best versions. The Marketing experiment uses a GEPA variant that tests several ideas, then spends more evaluation effort on the promising ones.

## Build with us

Start with the [user guide](docs/guide/en/index.md), browse the [example code](examples/evolution-search/README.md), or join [Discord](https://discord.gg/cZ4NBbHDk).

For local development:

```bash
npm ci
npm run typecheck
npm run build
npm test
```

[Documentation authoring](docs/guide/README.md) · [GitHub issues](https://github.com/rsi-gear/gear/issues) · [MIT license](LICENSE)

## Roadmap

Gear can improve harnesses today. Two parts of the bigger learning loop are still in progress:

- [ ] **Improve the model itself.** Use task results to train the model, test the new version, and repeat. An [experimental training path](docs/guide/en/training.md) exists; the full model-iteration loop is not yet complete.
- [ ] **Turn failures into new practice tasks.** Build focused starting tasks, or *seed tasks*, from the tasks an agent fails. Feed them into the next round so the agent can work on its weak spots. This automatic task-generation loop is not yet complete.
