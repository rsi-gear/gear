# Terminal-Bench 2.0 evolve lab

The local lab lives at `/Users/zgq/Desktop/projs/gear/.evolve-lab` and is
ignored by Git. It is intentionally isolated from the user's normal DSH and
Hitch state.

## Pinned components

- DSH: `@deepseek-ai/dsh@0.1.0-rc.8`
- Gear: the locally packed `dsh-plugin-refine@0.1.0`
- Hitch: local `feat/run-centered-trajectory-storage-spec@dee3176c0e0dc1d8e81fdb7bf154012c1c6b64ec`, package version `0.2.0`
- Harbor: managed `0.21.0`
- target substrate commit: `4ddad53c1f858e02ae69167ac0d2adcbb9d53f80`
- initial champion commit: `2f1a76d3774e30e667b9895c8e9be831b3553639`
- seed: Terminal-Bench 2.0 `terminal-bench/regex-log`
- held-out: Terminal-Bench 2.0 `terminal-bench/log-summary-date-ranges`

The two task directories are disjoint local Harbor datasets. A round performs
four trials: seed baseline, seed candidate, held-out baseline, and held-out
candidate.

The target repository is a small carrier Git repository whose lockfile pins
the public rc.8 DSH package. Its fixed headless launcher verifies
`harness/manifest.json`, verifies every declared artifact, mounts
`harness/preset/agent.cordis.yml`, and only then makes the headless runner
eligible to start. Hitch uses its unmodified `deepseek` adapter and records the
carrier's exact commit.

The Terminal-Bench images are Linux/amd64. On Apple Silicon, Docker Desktop
must be able to run amd64 containers. This lab was validated with Docker
Desktop's classic image store because the legacy Terminal-Bench images did not
start reliably through the containerd image store. The local derived images
`gear-evolve/regex-log-node22:20251031` and
`gear-evolve/log-summary-date-ranges-node22:20251031` add Node `22.19.0`, pnpm
`11.7.0`, curl, Git, and CA certificates. Preinstalling those tools keeps Hitch
setup out of the task-time network path; it does not change either task or its
verifier.

## Run

First start Docker Desktop. Then run:

```sh
cd /Users/zgq/Desktop/projs/gear
.evolve-lab/bin/evolve.mjs doctor
```

Continue only when the JSON says `"ready": true`. Start the isolated DSH
control plane:

```sh
.evolve-lab/bin/evolve.mjs web
```

Open `http://127.0.0.1:3080`, enter an already persisted ordinary session, and
submit:

```text
/refine --rounds 1 --budget 900000 --target context
```

The command returns a round id. Inspect it with:

```text
/refine status <round-id>
```

DSH Web `0.1.0-rc.8` has a blank-session presentation edge: a slash command
entered directly on the empty “New session” draft is executed and durably logs
its `command/done`, but the UI can remain on the blank draft instead of showing
the command card. Send one ordinary prompt to persist the session first, or
select an existing ordinary session before using `/refine`. This does not affect
round admission; check `rounds/` or run `/refine status` from an existing
session if a command was already submitted from the blank draft.

Round state is under `.evolve-lab/state/refine`; Hitch evidence and prepared
artifacts are under `.evolve-lab/hitch-home`. The target repository must remain
clean before starting a round.

The meta IPython helper runs inside the required OS sandbox. Its actual cwd is
a per-session directory below `.evolve-lab/state/refine/meta-notebooks`, and it
cannot directly read the surrounding lab, DSH session logs, target repository,
Hitch state, held-out dataset, credentials, or host environment. Champion and
trajectory data must cross the typed Host Bridge. On macOS this requires the
built-in `sandbox-exec`; on Linux install Bubblewrap, `socat`, and ripgrep.

The launcher reads `DEEPSEEK_API_KEY` from the existing
`/Users/zgq/.dsh/.credentials.yaml` without copying it into the lab and passes
it to the DSH/Hitch child process. Credential values are not written to the
repository or printed by the launcher.

## Useful checks

```sh
.evolve-lab/bin/evolve.mjs dump
.evolve-lab/bin/evolve.mjs prepare
git -C .evolve-lab/target-dsh status --short
```

`dump` verifies the final DSH composition without starting a server. `prepare`
forces Hitch to resolve and build the exact initial champion; its output must
report `observed_version: 0.1.0-rc.8`.

## Run-centered trajectory status

Round `18fbc12e-6854-45b9-bd40-c7683fe4804c` first proved that the feat build
exports a complete provider-native DSH trajectory from Docker (about 6.3 MB,
including tool calls/results, usage and original event timing), while exposing
a Harbor display-name versus locked task-identity mismatch. Hitch `23ff627`
fixed that comparison by using the locked Harbor task identity. Hitch
`dee3176` subsequently preserved the original timeout classification when
trajectory finalization runs after a timed-out agent, instead of masking it as
`trajectory_recording_failed`. The pinned build above includes both fixes and
publishes valid trajectories to the authoritative run store for
`hitch trajectory inspect <run-id> --json`.

## Validated full round

Round `57b0560a-4d2c-4568-bd20-a4e97f0c8eb3` completed on 2026-08-21 with
all four rewards equal to `1`:

- seed baseline: `eval_09e7fd23135748d6bc9f7b0ad90c7150`
- seed candidate: `eval_d8aaa9e4bf0c48479134607d6c47f56a`
- held-out baseline: `eval_697fdab4111e4150aad5c26e00618af2`
- held-out candidate: `eval_b21b42999ff8478e94c2e12e39579468`

The meta agent patched `harness/plugins/policy.js`, Gear built candidate
`97ec58877315b26ab79c341a07fa806ac1643db5`, both seed and held-out parity
checks passed, and the promotion gate atomically accepted that commit as the
new champion with manifest digest
`sha256:6b2e1ddc7adc9db0d57c0a0fae95917cc4a23657dd00be144cfc255ae881412f`.
