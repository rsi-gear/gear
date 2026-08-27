# Gear

[![GitHub release](https://img.shields.io/github/v/release/rsi-gear/gear)](https://github.com/rsi-gear/gear/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-Join_chat-5865F2?logo=discord&logoColor=white)](https://discord.gg/cZ4NBbHDk)

Gear is an extensible experiment control plane for evolving agent harnesses. It
generates candidate harness revisions, evaluates them under paired conditions,
selects a research population, and promotes at most one deployment champion.

> **Status:** pre-alpha. Gear is ready for local research and integration work,
> but its state format and extension APIs may change between releases.

## Quick start

Gear runs as a [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/DeepSeek-Harness)
plugin. It requires Node.js 22.19+ (or 24+), DSH `0.1.0-rc.8`, Git, Python 3
with IPython, Docker, and an installed Hitch CLI. Linux control-plane hosts also
need Bubblewrap, `socat`, and ripgrep.

### 1. Install Hitch

[Hitch](https://github.com/rsi-gear/agent-hitch) is Gear's required rollout and
evidence backend. It installs and manages Harbor for containerized evaluations.

```bash
npm install --global 'agent-hitch@>=0.2.5'
hitch eval setup harbor
hitch eval doctor --json
```

### 2. Build and install Gear

Until the package is published, install Gear from a source checkout:

```bash
git clone https://github.com/rsi-gear/gear.git
cd gear
npm ci
npm pack
dsh plugin --profile web add ./dsh-plugin-refine-0.1.0.tgz
```

The bundled plugin row is disabled by default. Complete the one-time Meta Agent,
target repository, dataset, and profile configuration in the
[installation guide](docs/plugin-installation-and-usage.md), then verify and
start the profile:

```bash
dsh --profile web --dump-config
dsh --profile web --no-open
```

Run one refinement round from a DSH session:

```text
/refine --rounds 1 --focus context,routing
/refine status
```

### Optional: install Rear

[Rear](https://github.com/rsi-gear/rear) is a read-only web workbench for Gear
experiments and Hitch trajectories. Gear does not require it for refinement,
selection, or promotion.

```bash
git clone https://github.com/rsi-gear/rear.git
cd rear
npm ci
npm pack
dsh plugin --profile web add ./dsh-plugin-rear-0.1.0.tgz
```

Enable Rear's dormant plugin row and point `gear.root` and `hitch.root` at the
same state directories used by Gear and Hitch.

## Using `/refine`

Start a new isolated evolution with:

```text
/refine [seed-task-ref] [--rounds N] [--budget MILLISECONDS] [--focus FOCUS] [--from SOURCE] [--name NAME]
/refine rerun <evolution-id> <round-id> --eval <eval-id> (--invalid | --task TASK...)
```

| Argument | Description |
| --- | --- |
| `seed-task-ref` | Optional seed dataset override; otherwise the configured dataset is used |
| `--rounds N` | Number of complete refinement rounds to run serially |
| `--budget MILLISECONDS` | Per-trial timeout for the new evolution; defaults to 3600000 (60 minutes) |
| `--focus FOCUS` | Advisory focus for the Meta Agent; repeat the option or use comma-separated values |
| `--from SOURCE` | Start from `initial`, `published`, or an exact Git commit |
| `--name NAME` | Human-readable name for the new evolution |

Supported focus values are `context`, `pre_action`, `routing`, `post_action`,
`action_verifier`, `skill`, `tool`, `workflow`, and `compaction`. The legacy
`--target` option is an alias for a single `--focus` value.

Manage an evolution with:

| Command | Purpose |
| --- | --- |
| `/refine continue <evolution-id> [--rounds N] [--focus FOCUS]` | Continue with the same spec, Meta history, and champion |
| `/refine status [evolution-id [round-id]]` | List evolutions or inspect one evolution or round |
| `/refine rerun <evolution-id> <round-id> --eval <eval-id> (--invalid \| --task TASK...)` | Repair invalid/missing logical trial slots in a failed Hitch evaluation |
| `/refine publish <evolution-id> [exact-ref]` | Publish an accepted champion as the workspace default |
| `/refine rollback <evolution-id> <exact-ref>` | Return an evolution to a previously accepted commit |

A plain `/refine` always creates a new evolution. `continue` accepts only
`--rounds` and `--focus`; datasets, models, budgets, sandboxes, and promotion
policy remain sealed by the original experiment spec. See the
[installation and usage guide](docs/plugin-installation-and-usage.md#8-使用-refine)
for command output, lifecycle states, and operational details.

Gear requires agent-hitch 0.2.5 or newer and checks the CLI version at startup.
For multi-attempt evaluations, `--task TASK` repairs every invalid or missing
`(task, attempt)` slot for that task while preserving already-valid slots.

## How it works

A Gear round is an evolutionary search step over exact, Git-addressed harness
versions:

```text
Task sampling
  -> Candidate generation
  -> Paired baseline/candidate rollouts
  -> Judging
  -> Survivor and finalist selection
  -> Held-out promotion gate
  -> Population update + optional champion update
```

The research population and deployment champion are separate. Multiple
candidates may survive into the next generation, while only one finalist can
pass the promotion gate and replace the current champion.

Every evolution seals its datasets, Meta Agent preset, models, sampling,
budgets, toolchain, sandbox, component implementations, and component
configuration in an immutable `EvolutionSpec`. Continuing an evolution
revalidates those identities instead of reading new global defaults.

## Pluggable algorithm components

Gear exposes six algorithm extension points through `ctx.evolutionComponents`.
Developer plugins can register alternative implementations without replacing
the experiment state machine.

| Component | Algorithmic responsibility | Built-in implementation |
| --- | --- | --- |
| `CandidateGenerator` | Allocate parents and propose candidate harnesses | Forked DSH Meta Agent proposals |
| `TaskSampler` | Resolve seed and held-out tasks into evaluation conditions | Dataset sampler |
| `RolloutProvider` | Execute exact harness versions and collect evidence | Hitch CLI |
| `Judge` | Convert rollout evidence into comparable metrics | Task reward and success rate |
| `CandidateSelector` | Choose survivors and one promotion finalist | Highest quality |
| `PromotionPolicy` | Decide whether the finalist replaces the champion | Paired seed/held-out gate |

The Meta Agent's model, prompt, skills, tools, workflows, and documents are also
replaceable through a DSH preset. The resolved preset is part of the experiment
identity, so changing it creates a different evolution rather than silently
altering an existing one.

Algorithm plugins cannot bypass Gear's reproducibility and safety core:

- exact Git commit and manifest verification;
- candidate workspace containment and fixed toolchain boundaries;
- held-out data isolation;
- baseline/candidate condition parity and auditable evidence;
- atomic population and champion compare-and-swap updates;
- terminal cleanup and recovery rules.

See the [component abstraction design](docs/research-evolution-component-abstraction-plan.md)
and the public interfaces in [`src/evolution/components.ts`](src/evolution/components.ts)
for the extension contract.

## Roadmap

Expand and evolve seed tasks, then use the resulting trajectories and
evaluation feedback to drive continuous model capability evolution.

## Documentation

- [Vision and architecture](docs/vision.md)
- [Installation and usage](docs/plugin-installation-and-usage.md)
- [Gear and Hitch integration](docs/hitch-dsh-integration.md)
- [Local evolution lab runbook](docs/evolve-lab-runbook.md)

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run pack:check
```

Focused issues and pull requests are welcome at
[rsi-gear/gear](https://github.com/rsi-gear/gear). Because Gear is pre-alpha,
please describe the experiment or compatibility contract that a change is
intended to preserve.

## License

[MIT](LICENSE)
