# DSH + Codex Luna evolution lab

This example packages the complete path used by the local Gear validation:

```text
DSH Meta (openai-codex/gpt-5.6-luna)
  -> Gear
  -> gear-hitch-codex
  -> Hitch / disposable Harbor container
  -> DSH target (openai-codex/gpt-5.6-luna)
```

It contains configuration and source only. OAuth credentials, task data,
runtime dependencies, state, and generated target Git commits remain under the
ignored `.evolve-lab/` directory.

## Install the isolated runtime and profile

From the Gear repository root:

```sh
mkdir -p .evolve-lab/runtime
cp examples/dsh-codex-luna/runtime.package.json .evolve-lab/runtime/package.json
cp examples/dsh-codex-luna/runtime.pnpm-workspace.yaml .evolve-lab/runtime/pnpm-workspace.yaml
pnpm --dir .evolve-lab/runtime install
```

Build Gear, then let DSH create the isolated profile and its runtime links:

```sh
npm ci
npm run build
export DSH_HOME="$PWD/.evolve-lab/dsh-home"
.evolve-lab/runtime/node_modules/.bin/dsh plugin --profile web add "$PWD"
.evolve-lab/runtime/node_modules/.bin/dsh plugin --profile web add dsh-codex@0.2.6
cp examples/dsh-codex-luna/profile.patch.yml .evolve-lab/dsh-home/profiles/web/cordis.patch.yml
```

The profile links `dsh-plugin-refine` to this checkout. The commands pin DSH
`0.1.1-rc.2` and `dsh-codex` `0.2.6`; the isolated runtime supplies the
compatible `pi-ai` `0.84.4` to the profile through DSH's runtime links.

## Create the target carrier

The target must be a separate Git repository because Hitch identifies and
builds an exact commit. Bootstrap it from the tracked, credential-free source:

```sh
node examples/dsh-codex-luna/bootstrap-target.mjs
```

This installs the carrier dependencies, creates the substrate and initial
champion commits, computes the harness manifest, and writes the generated refs
to `.evolve-lab/target.json`.

## Candidate runtime checks

The profile now uses `assets/dsh-runtime-check.mjs` through the existing fixed
compiler interface. `evolve.mjs` supplies its absolute path as
`GEAR_RUNTIME_CHECK_EXECUTABLE`; when starting the profile directly, set that
variable yourself. `compiler.runtimeRoot` points at the installed target
carrier, including its existing `pnpm-lock.yaml` and dependencies. Checks never
install packages or use Gear's rc.8 development runtime.

Carrier `0.0.1` configures DSH's existing `skill-filesystem` provider with
`<repositoryRoot>/harness/skills`. Adding an ordinary Skill requires only
`harness/skills/<name>/SKILL.md` and its supporting resources. Do not add a
candidate loader or preset row. The native provider retains its default roots;
the locked base row has no other explicit config to preserve. If customizing
the fixed patch, retain any deployment-specific config fields because a DSH
patch replaces the entire `config` object.

The snapshot links to the installed Target's `node_modules`, preserving pnpm's
direct/transitive visibility. DSH's recursive profile fallback remains private
to the profile. The checker rejects mismatched dependency declarations,
workspace policy, or an existing candidate lockfile that differs from the
installed runtime's lockfile.

The checker loads the actual rc.2 headless composition and target loader with
the automatic task runner, startup parser, HMR and telemetry disabled. It uses
a temporary copy with a matching candidate manifest, verifies Skill discovery
and native reads through a real Agent session whose cwd is the disposable task
workspace, and disposes the runtime. It does not call a model or Hitch.
Keep `metaSandbox.mode: required` for candidate execution; no Meta shell or
credentials are needed. Fixed toolchains outside system directories can declare
additional absolute `compiler.readPaths` for their shared libraries.

Existing releases do not acquire this checker by upgrading source alone: update
their compiler command, args, `reportProtocol: gear-runtime-check-v1`, and
`runtimeRoot` before creating the next evolution. `/usr/bin/true` without a
report protocol remains compatible but explicitly returns runtime `not_checked`;
with the protocol enabled it fails because it produces no runtime report.

Re-bootstrap the Target when adopting carrier `0.0.1`: the fixed patch changes
the substrate commit, manifest identity, and packaged artifact. Record those
new identities and reassess baseline comparability; do not rewrite old commits
or evidence to reuse an earlier experiment identity.

Run the full Target integration matrix without a model or benchmark:

```sh
GEAR_TEST_DSH_RUNTIME_ROOT="$PWD/.evolve-lab/target-dsh" \
GEAR_TEST_RUNTIME_SANDBOX=required \
npx vitest run tests/integration/dsh-runtime-check.spec.ts
```

The matrix also archives a finalized candidate, relocates its installed pnpm
tree, and launches `apps/cli/lib/bin.js` from a separate task directory. A
test-only observer calls the native Skill tool with a real Agent; the task
runner and telemetry are disabled and network/model calls are forbidden. This
exercises the actual carrier entry point independently of Gear's snapshot and
checker. A production Harbor smoke trial and model Skill-selection evaluation
remain separate rollout checks before expanding to a full benchmark batch.

## Sign in once on the host

```sh
node examples/dsh-codex-luna/evolve.mjs codex-status
node examples/dsh-codex-luna/evolve.mjs codex-device-login
```

The login is stored in the isolated DSH home. `gear-hitch-codex` refreshes it
only on the host before a direct target evaluation. Each target container gets
a short-lived access-only envelope, never the rotating refresh token. A
container writes a non-refreshable credential to its disposable DSH home, so a
new task does not require another device login and cannot invalidate the host
login.

Daemon submission is intentionally unsupported: keep `hitch.controlPlane.mode`
set to `direct`. Containers in one eval share an access snapshot, so split a
long multi-wave dataset into direct evals. The wrapper preflights enough access
lifetime for the declared setup and task budgets plus dsh-codex's five-minute
refresh window. The target has no usable refresh token: if preparation outlives
that estimate, dsh-codex fails its refresh rather than rotating or overwriting
the host credential. The issuer-enforced access-token expiry is the final
boundary; the wrapper deliberately does not enumerate or kill detached PIDs.
The access-only path permits one attempt and zero infrastructure retries. Keep
both task and setup timeouts positive; Hitch's zero setup timeout is unlimited
and is rejected by the wrapper.

## Check and run

```sh
node examples/dsh-codex-luna/evolve.mjs dump
node examples/dsh-codex-luna/evolve.mjs doctor
node examples/dsh-codex-luna/evolve.mjs prepare
node examples/dsh-codex-luna/evolve.mjs target-eval /absolute/path/to/one-task-dataset
node examples/dsh-codex-luna/evolve.mjs web
```

Meta and target default independently to Luna with Medium reasoning effort.
`metaSampling.reasoningEffort` controls Meta requests. The target's fixed
`target-harness-loader` sets `reasoningEffort: medium` in each disposable DSH
home before the headless runner reads its model selection, while preserving
Hitch's provider and model. This configuration lives outside the mutable
`harness/` tree and survives candidate iterations; subscription settings and
credentials remain in the run's own home.

All relevant choices are
configuration:

- `GEAR_META_PROVIDER` / `GEAR_META_MODEL`
- `GEAR_TARGET_PROVIDER` / `GEAR_TARGET_MODEL`
- `GEAR_TARGET_CODEX_AUTH_FILE` / `GEAR_TARGET_CODEX_ENV`
- `GEAR_HITCH_EXECUTABLE` / `GEAR_HITCH_CODEX_EXECUTABLE`
- `GEAR_DSH_CODEX_MODULE` / `DSH_CODEX_SEARCH_MODE`
- `GEAR_LAB_ROOT`, dataset paths, state paths, task budget, and concurrency

Set `GEAR_TARGET_PROVIDER=deepseek-official` and provide
`DEEPSEEK_API_KEY` only when the explicit DeepSeek fallback is desired.
