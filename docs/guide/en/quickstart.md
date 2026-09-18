# Quick start

Use Gear's Refine Skill from Codex, Claude Code, DSH, or another agent that can load Skills and call Gear. Describe the benchmark, Meta agent, rollout agent and number of rounds in natural language to start optimizing.

## Let your agent install Gear

Copy this prompt into your agent to have it handle setup:

```text
Follow https://rsigear.xyz/docs/gear/quickstart to install Gear in my environment.
Install rsi-gear@latest and agent-hitch@latest with npm and check the required dependencies.
Add Gear's complete Refine Skill to my current agent and configure its connection to Gear.
Use my actual task paths, target harness and model settings; ask me for any missing information.
Verify that the Skill can connect to Gear, then report the result and how to start my first optimization.
```

The steps below cover manual installation and the first optimization.

## 1. Install Gear

Use Node.js 22.19+ or 24+ and Git. Install Gear and Hitch; this example also installs DSH as the rollout agent:

```bash
npm install --global rsi-gear@latest agent-hitch@latest @deepseek-ai/dsh@latest
hitch eval setup harbor
```

Docker must be running for Harbor tasks. See [platform setup](../../plugin-installation-and-usage.md) for Python/IPython and sandbox dependencies. The Gear package includes the `gear-refine` CLI and the complete Refine Skill.

## 2. Connect the Skill to your agent

Find the installed Skill bundle:

```bash
GEAR_REFINE_SKILL="$(npm root -g)/rsi-gear/skills/refine"
gear-refine skill-identity --path "$GEAR_REFINE_SKILL"
```

Add that entire directory to your agent's Skill catalog using its supported installation method, including the references. Codex, Claude Code and other compatible hosts connect to Gear's standalone control plane. Follow [Connect your Meta agent](meta-agents.md) to configure and start it:

```bash
gear-refine serve --config /absolute/path/to/gear-refine.json
```

Keep the server running. Set the returned `socketPath` as `GEAR_REFINE_SOCKET` in the environment of the agent using the Skill.

For the first run, prepare the [Target Harness](target-harness.md), [benchmark tasks](datasets.md), and the [standalone configuration](../../harness-agnostic-refine-skill.md). You can ask your agent to help set these up using your actual repository, dataset paths and installed runtime identities. Authenticate the Meta and rollout models separately.

Meta and rollout are independent choices. For the example below:

| Role | Runtime and model | Responsibility |
| --- | --- | --- |
| Meta agent | Codex + Astra | Read failure evidence and improve the Harness through the Refine Skill. |
| Rollout agent | DSH + Luna | Execute benchmark tasks with each candidate Harness. |

Use Codex with Astra for this Meta session and match the Gear configuration to its actual model and sampling settings. DSH provides the Target runtime in this example. If you also choose DSH as your Meta host, its [native Skill integration](meta-agents.md#dsh-native-skill) is another connection option.

## 3. Ask your agent to optimize

Load the Refine Skill through your agent's Skill interface or `/refine` where supported. You can also request it in natural language:

```text
Use the Refine Skill to optimize the Marketing domain of AutomationBench.
Use Codex + Astra as the Meta agent and DSH + Luna for rollouts.
Run one round of optimization.
```

The request defines the benchmark scope, two agent configurations and round count. It uses the Harness and benchmark paths prepared above. Gear evaluates the baseline, gives Meta the permitted failure evidence, checks and evaluates candidate changes, and records which Harness to retain.

```text
Show the results of this evolution and the retained Harness changes.
Continue evolution EVOLUTION_ID for two more rounds with the same settings.
```

Use the returned evolution ID when continuing. [Manage evolutions](evolutions.md) explains status, repair and publication.

Next, follow [Example 1: evolve a harness for Marketing](example-harness.md) or [Example 2: customize your evolve algorithm](example-algorithm.md). For model weight optimization, see the separate [experimental training workflow](training.md).
