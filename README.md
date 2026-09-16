# Gear

**Adapt your agent to any task.**

[![GitHub release](https://img.shields.io/github/v/release/rsi-gear/gear)](https://github.com/rsi-gear/gear/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-Join_chat-5865F2?logo=discord&logoColor=white)](https://discord.gg/cZ4NBbHDk)

[English](README.md) | [简体中文](README.zh-CN.md) · [User guide](https://rsigear.xyz/docs/gear) · [Examples](https://rsigear.xyz/docs/gear/examples/evolution-search)

Give Gear tasks with checkable results. It tests an AI agent, looks at what went wrong, and improves its instructions, tools, and workflow so it can do those tasks better.

## A smaller model that can compete with the best

On **AutomationBench's 100 public Marketing tasks**, Gear helped **GPT 5.6 Luna complete 53 tasks**, close to **Codex + GPT 6 Astra max's 57**. A smaller model came within four completed tasks of a frontier model.

![Example 2: Gear improves GPT 5.6 Luna from 27 tasks passed at medium effort to 40 at medium and 53 at max. Codex with GPT 6 Astra max passes 57; the Gear-evolved harness with Astra max passes 61.](docs/guide/assets/marketing-staged-search.svg)

| Agent setup | Model and reasoning effort | Tasks passed / 100 |
| --- | --- | ---: |
| Original DSH | GPT 5.6 Luna medium | 27 |
| DSH improved by Gear | GPT 5.6 Luna medium | 40 |
| DSH improved by Gear | GPT 5.6 Luna max | **53** |
| Codex | GPT 6 Astra max | **57** |
| DSH improved by Gear | GPT 6 Astra max | **61** |

Gear raised Luna from 27 to 40 at the same reasoning effort. Giving the improved agent more time to reason (`max`) brought it to 53. The same improved instructions and tools also worked with Astra max, reaching 61.

A task passes only when every scored requirement is met. These public tasks also guided optimization; starred results in the chart use a separate official private test set. [Scoring and sources](docs/guide/en/results.md).

See [Example 2](docs/guide/en/example-algorithm.md) for the search algorithm, changes, and runnable code.

## How it works

A model needs instructions, tools, and a way to use them. Together, these are its **harness**. Gear improves this harness through a simple loop:

1. **Try the tasks.** Measure what the agent can already do.
2. **Study the mistakes.** A second agent reads the failed attempts and suggests improvements.
3. **Make a change.** Update instructions, tools, skills, or the steps used to finish a task.
4. **Test again.** Compare the results, keep useful changes, and repeat.

You choose the tasks and the number of rounds. Gear keeps the versions and results so you can see what changed and use the final harness.

Gear is an optimization library you can call as a **Skill** from Codex, Claude Code, DSH, or another compatible agent. Use an existing benchmark, or bring your own tasks in [Harbor format](docs/guide/en/datasets.md).

## Quick start

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
