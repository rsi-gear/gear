# Gear

**Adapt your agent to any task.**

[![GitHub release](https://img.shields.io/github/v/release/rsi-gear/gear)](https://github.com/rsi-gear/gear/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-Join_chat-5865F2?logo=discord&logoColor=white)](https://discord.gg/cZ4NBbHDk)

[English](README.md) | [简体中文](README.zh-CN.md) · [User guide](https://rsigear.xyz/docs/gear) · [Examples](https://rsigear.xyz/docs/gear/examples/evolution-search)

Gear is an open-source algorithm framework that helps AI agents work on real tasks across different software environments and learn from what goes right or wrong. We aim to use that experience to improve their instructions and tools, and turn it into training data that makes the models themselves better.

## A smaller model that can compete with the best

On AutomationBench's 100 public Marketing tasks, Gear improved **GPT 5.6 Luna max to a process score of 88.88%, above Codex + GPT 6 Astra max's 84.08%**, and its task pass rate reached 53%.

![Harness and GEPA evolution from original DSH: GPT 5.6 Luna max reaches an 88.88% process score and 53% task pass rate, compared with 84.08% and 57% for Codex + GPT 6 Astra max.](docs/guide/assets/marketing-evolution-overview.png)

### Tasks we have validated

Our compute budget is limited, so we are starting with the task set below and reporting its results before and after optimization.

| Validated task set | Model + harness combination | Metric | Before | After | Δ |
| --- | --- | --- | --- | --- | --- |
| AutomationBench / Marketing  | GPT 5.6 Luna medium + DSH | Task pass rate / process score |  27% / 75.37% |  40% / 83.87% |**+13% / +8.50%** |

These public tasks also guided optimization. Starred points in the chart come from a separate official private test set. [Scoring and sources](docs/guide/en/results.md) · [Full experiment](docs/guide/en/example-algorithm.md).

## Quick start

Gear is an optimization library you can call as a **Skill** from Codex, Claude Code, DSH, or another compatible agent. Use an existing benchmark, or bring your own tasks in [Harbor format](docs/guide/en/datasets.md).

**Let your agent install Gear.** Copy this prompt into the agent you use:

```text
Follow https://rsigear.xyz/docs/gear/quickstart to install Gear in my environment.
Install rsi-gear@latest and agent-hitch@latest with npm and check the required dependencies.
Add Gear's complete Refine Skill to my current agent and configure its connection to Gear.
Use my actual task paths, target harness and model settings; ask me for any missing information.
Verify that the Skill can connect to Gear, then report the result and how to start my first optimization.
```

To install manually, start with Gear and [Hitch](https://github.com/rsi-gear/agent-hitch), which runs the tests. This example uses DSH as the agent doing the tasks:

```bash
npm install --global rsi-gear@latest agent-hitch@latest @deepseek-ai/dsh@latest
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
- **Outer loop: improve the worker.** The Meta agent reads the results and failed attempts, proposes changes or creates new seed tasks (practice tasks), and tests which versions work better.

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
