# Gear user guide

Gear is an algorithm library for agent optimization that you can invoke through a Skill. Provide an existing benchmark or define your own in Harbor format, and Gear can automatically optimize both the agent's Harness and its model using evaluation feedback.

## Choose a path

- [Quick start](quickstart.md): install `rsi-gear@latest`, connect the Refine Skill to Codex, Claude Code or another agent, and request an optimization in natural language.
- [Example 1: evolve a harness for Marketing](example-harness.md): five rounds, the initial prompt, the retained change, and a 27% → 36% strict pass rate at fixed Luna medium.
- [Example 2: customize your evolve algorithm](example-algorithm.md): seven editable algorithm modules, an elitist selector, and the measured 4 → 2 → 1 staged-search experiment.
- [Model training](training.md): the experimental Slime training path, its deployment requirements and validation boundary.

## What you can evolve

| Part | What Gear can improve |
| --- | --- |
| Prompts and policies | System prompts, behavioral rules and task instructions. |
| Tools and hooks | Tool definitions, implementations and hooks around agent actions. |
| Skills and workflows | Reusable procedures, helpers and how the agent discovers and uses them. |
| Context management | Context assembly, injection and compaction through the Harness's extension points. |
| Harness composition | Which plugins and providers are enabled and how they are configured. |
| Model weights · experimental | Slime GRPO training with a fixed Harness and datasets. |

Start with [Harness evolution](example-harness.md), learn how to [prepare an editable Target](target-harness.md), or explore [model training](training.md).

## Algorithm components you can customize

| Component | What you can change |
| --- | --- |
| Candidate generation | Candidate slots and allocation across available parents. |
| Task sampling | Task selection, evaluation scopes and repetitions. |
| Rollout backend | How candidate versions execute and produce evaluation evidence. |
| Fitness scoring | Metrics calculated from evaluation evidence. |
| Candidate assessment | Ranking criteria and optional verifier reasoning. |
| Survivor selection | Which candidates to retain, including elitism, diversity and tie-breaking. |
| Champion promotion | Acceptance thresholds and paired evaluation checks for replacing the champion. |

Compose these components to define your search algorithm. [Example 2](example-algorithm.md) shows the extension interfaces, an elitist selector and a staged evaluation design.

## Support and version

This guide accompanies Gear 0.1.0, packaged as `rsi-gear`. Gear is pre-alpha. The standalone Meta connection is Harness-neutral; the built-in Target builder is currently DSH-oriented. Supporting a Harness in Hitch does not automatically add a Gear Target builder.

The staged-search case used the implementation pinned in its [source record](example-algorithm.md#implementation-and-version). Its configuration is not advertised as a switch supported by every 0.1.0 checkout. Historical Marketing scores use a public research set that also supplied optimization evidence; they are not independent held-out results.

## Next steps

Learn to [connect Meta](meta-agents.md), [prepare a Target](target-harness.md), [prepare tasks](datasets.md), [manage an evolution](evolutions.md), and [interpret results](results.md). Use [configuration](configuration.md) and [troubleshooting](troubleshooting.md) when setting up your own experiment.
