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

Gear uses the packaged `refine` Agent Skill as its primary Meta entrypoint for
Codex, Claude Code, DSH, and other Agent Skills-compatible harnesses. The DSH
plugin publishes that same skill through DSH's native skill catalog; its older
direct-session adapter remains available only as an explicit compatibility
mode. The Meta harness and the Target harness are independent; Hitch starts the
configured Target harness for isolated rollouts.

Gear requires Node.js 22.19+ (or 24+), Git, Docker, and an installed Hitch CLI.
The DSH plugin deployment supports DSH `0.1.0-rc.8` and `0.1.1-rc.2`. Python,
IPython, Bubblewrap, `socat`, and ripgrep are required only by the configured
compiler, verifier, or DSH Meta sandbox features that use them.

### 1. Install Hitch

[Hitch](https://github.com/rsi-gear/agent-hitch) is Gear's required rollout and
evidence backend. It installs and manages Harbor for containerized evaluations.

```bash
npm install --global 'agent-hitch@>=0.2.5'
hitch eval setup harbor
hitch eval doctor --json
```

Gear uses Hitch's direct eval CLI by default. To share one bounded scheduler
with other Hitch work, install agent-hitch 0.2.6 or newer, start a daemon for
the configured Hitch root, and select daemon mode:

```bash
hitch --root /absolute/path/to/hitch-state daemon start --max-concurrent 4
```

```yaml
hitch:
  root: /absolute/path/to/hitch-state
  controlPlane:
    mode: daemon
```

Daemon mode uses durable, idempotent `eval submit`, `eval watch`, `eval cancel`,
and daemon rerun operations. Gear verifies the frozen Hitch execution policy
before accepting evidence. Keep `mode: direct` when no daemon owns that root.

### 2. Build Gear

Until the package is published, install Gear from a source checkout:

```bash
git clone https://github.com/rsi-gear/gear.git
cd gear
npm ci
npm pack
npm install --global ./dsh-plugin-refine-0.1.0.tgz
```

### 3. Choose the Meta entrypoint

For Codex, Claude Code, or another external harness, configure skill mode and
start the standalone control plane:

```bash
gear-refine serve --config /absolute/path/to/gear-refine.json
```

Install or link the packaged [`refine` skill](skills/refine/SKILL.md) into the
Meta harness and point `GEAR_REFINE_SOCKET` at the socket reported by the
server. The skill creates or continues evolutions, claims candidate leases, and
uses Gear's restricted evidence and candidate APIs. See the
[standalone and skill guide](docs/harness-agnostic-refine-skill.md).

For DSH, install the package as a plugin:

```bash
dsh plugin --profile web add ./dsh-plugin-refine-0.1.0.tgz
dsh --profile web --dump-config
dsh --profile web --no-open
```

The bundled plugin row is disabled by default. Complete its one-time setup in
the [DSH installation guide](docs/plugin-installation-and-usage.md). Skill mode
is the default: the plugin publishes the bundled skill and `refine_request`
bridge, and DSH's native `/refine` gesture loads it into the current agent:

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

## Using refine

The `refine` skill calls the structured Gear protocol. In DSH skill mode,
`/refine` is a native skill invocation; in explicit legacy mode, the same text
is handled by Gear's compatibility command.

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

Gear checks the Hitch CLI version at startup. Direct mode requires agent-hitch
0.2.5 or newer; daemon mode requires 0.2.6 or newer and a running daemon. For
multi-attempt evaluations, `--task TASK` repairs every invalid or missing
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
seed-selected candidates remain in the research population, but every new
round creates its candidate workspaces from the current champion. A candidate
that was not promoted cannot become the next round's code parent or require a
new parent baseline, including when its evaluation is partial. Only one finalist
can pass the promotion gate and replace the champion.

Each new round records its champion parent and forks Meta from that champion's
checkpoint, or the initial Meta root for the initial champion. Research records
remain available in history; they do not replace the current champion's code or
baseline. Recovery of an already admitted round retains that round's sealed
parent and checkpoint.

Every evolution seals its datasets, Meta Agent preset, models, sampling,
budgets, toolchain, sandbox, component implementations, and component
configuration in an immutable `EvolutionSpec`. Continuing an evolution
revalidates those identities instead of reading new global defaults.

## Pluggable algorithm components

New evolutions can explicitly select `failure-cluster-gepa-v1` for shared failure
diagnosis, scoped specialist archives, proportional task sampling, and staged
multisignal promotion. It requires a provider that certifies task subsets and
cell reuse; the built-in legacy Hitch adapter fails admission until that contract
is supplied. Existing evolutions retain their sealed strategy. See the
[implementation and provider guide](docs/candidate-promotion-implementation.zh-CN.md).

Gear exposes six algorithm extension points through `ctx.evolutionComponents`.
Developer plugins can register alternative implementations without replacing
the experiment state machine.

| Component | Algorithmic responsibility | Built-in implementation |
| --- | --- | --- |
| `CandidateGenerator` | Allocate parents and propose candidate harnesses | Forked Meta Agent proposals |
| `TaskSampler` | Resolve seed and held-out tasks into evaluation conditions | Dataset sampler |
| `RolloutProvider` | Execute exact harness versions and collect evidence | Hitch CLI |
| `Judge` | Convert rollout evidence into comparable metrics | Task reward and success rate |
| `CandidateSelector` | Choose survivors and one promotion finalist | Highest quality |
| `PromotionPolicy` | Decide whether the finalist replaces the champion | Paired seed/held-out gate |

The Meta Agent runtime, model, skill/preset, sampling, and content digests are
part of the experiment identity. Skill mode seals the configured harness and
skill-bundle identity, including references and invocation metadata; the DSH
plugin derives these from its runtime and packaged skill. Its native bridge
also verifies the loaded skill and current model settings, but does not attest
or restrict the rest of the host session's tools, history, or OS permissions.
Legacy Native DSH mode instead resolves identity from a configured DSH preset.
Changing either creates a different evolution rather than silently altering an
existing one. Bundles sealed with the old `SKILL.md`-only digest require a new
evolution after upgrading; Gear does not rewrite existing experiment identities.

Native DSH Meta can opt into fresh-session context handoff:

```yaml
metaAdapter:
  kind: dsh
metaContextOffloading:
  mode: proactive
  contextWindow: 128000 # actual capacity of your configured model, not its output limit
```

Omit `contextWindow` only when the adapter supplies capacity metadata, or select
`mode: overflow-only` explicitly. Offloading is disabled when this configuration
is absent and is never retroactively enabled for an existing evolution. Defaults
trigger at 80% pressure, target a bootstrap below 50%, and cap summaries at 4k
tokens (scaled down for smaller windows). The Meta preset must not also mount an
independent DSH compaction plugin. Session persistence is required.

An attempt keeps its worktree, evidence receipts, deadline and aggregate request
and token budgets across handoffs. Without an explicit `metaModel.maxTokens`,
offloading limits each conversation response to its sealed `reserveTokens`.
Notebook kernels are recreated. Journals, immutable handoff bundles and bounded
tool-output artifacts live under the evolution's `meta-context/` directory;
Meta reads them only through owner-scoped `meta_context_read` references.
See the [implementation and recovery details](docs/dsh-meta-context-offloading-spec.zh-CN.md#13-v1-实现与使用).

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

## Model training

Gear also provides an experimental Slime GRPO training path through
`gear-refine training` and the `dsh-plugin-refine/training` API. It freezes the
harness and datasets, records exact policy tokens, saves a checkpoint after
each update, and evaluates immutable model exports before promotion.

Start with the [training guide](docs/training/README.zh-CN.md) and
[controller and model-node configuration](docs/training/controller-v2.zh-CN.md)
(Chinese). GPU execution requires a pinned, validated runtime and a compatible
Hitch checkout; the guides describe the supported scope and certification process.

## Documentation

- [Vision and architecture](docs/vision.md)
- [Harness-neutral Refine Skill and standalone control plane](docs/harness-agnostic-refine-skill.md)
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

For the training bridge's CPU tests, use Python 3.12 and the pinned test
dependencies. These versions are separate from a production GPU runtime lock:

```bash
python3.12 -m venv python/.venv
. python/.venv/bin/activate
python -m pip install './python[gateway]' -c python/constraints-test.txt
python -m pip install torch -c python/constraints-test.txt --index-url https://download.pytorch.org/whl/cpu
GEAR_TRAINING_TEST_PYTHON="$VIRTUAL_ENV/bin/python" npm run test:training
```

On macOS, omit `--index-url` when installing Torch. These tests cover the CPU
bridge and controller contracts; real GPU certification uses the probes
described in the training guide. CI runs the Python suite in `Training / CPU`.

Focused issues and pull requests are welcome at
[rsi-gear/gear](https://github.com/rsi-gear/gear). Because Gear is pre-alpha,
please describe the experiment or compatibility contract that a change is
intended to preserve.

## License

[MIT](LICENSE)
