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

The tracked runtime manifest still pins `agent-hitch@0.2.7`. That pinned release
does not provide task-start credentials. Until
the Hitch change is published, build the reviewed Hitch checkout that advertises
`host-task-credential-helper-v1` and install that checkout into the ignored lab
runtime before running a Codex target evaluation:

```sh
npm --prefix /absolute/path/to/agent-hitch ci
npm --prefix /absolute/path/to/agent-hitch run build
pnpm --dir .evolve-lab/runtime add /absolute/path/to/agent-hitch
```

`node examples/dsh-codex-luna/evolve.mjs doctor` verifies the capability. Do
not infer support from an unreleased version number.

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

## Sign in once on the host

```sh
node examples/dsh-codex-luna/evolve.mjs codex-status
node examples/dsh-codex-luna/evolve.mjs codex-device-login
```

The login is stored in the isolated DSH home. `gear-hitch-codex` configures a
trusted host helper for direct target evaluations. Hitch calls that helper when
each Target is ready to start and requests enough remaining validity for that
task. Each target container gets a short-lived access-only envelope, never the
rotating refresh token. A container writes a non-refreshable credential to its
disposable DSH home, so a new task does not require another device login and
cannot invalidate the host login.

Daemon submission is intentionally unsupported: keep `hitch.controlPlane.mode`
set to `direct`. The wrapper verifies Hitch's
`host-task-credential-helper-v1` capability and the host login before launch,
then keeps the access value out of the eval-wide environment. Hitch refreshes
later tasks through the same locked host credential store and rejects an
account change during one wrapper process. For a long-lived experiment, set
`GEAR_TARGET_CODEX_EXPECTED_ACCOUNT_ID` from the trusted host provisioning
record so separately launched evaluations and reruns use the same account; a
new wrapper process without that explicit constraint adopts the account that is
logged in at its own preflight. The target has no usable refresh token and
cannot rotate or overwrite the host login. The example uses one native Hitch
eval with three attempts per task and concurrency 12. Infrastructure retries
remain explicitly disabled; invalid logical slots are repaired with the normal
Hitch rerun path.

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
- `GEAR_TARGET_CODEX_AUTH_FILE` / `GEAR_TARGET_CODEX_ENV` /
  `GEAR_TARGET_CODEX_EXPECTED_ACCOUNT_ID`
- `GEAR_HITCH_EXECUTABLE` / `GEAR_HITCH_CODEX_EXECUTABLE`
- `GEAR_DSH_CODEX_MODULE` / `DSH_CODEX_SEARCH_MODE`
- `GEAR_LAB_ROOT`, dataset paths, state paths, task budget, and concurrency

Set `GEAR_TARGET_PROVIDER=deepseek-official` and provide
`DEEPSEEK_API_KEY` only when the explicit DeepSeek fallback is desired.
