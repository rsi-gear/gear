# Candidate runtime validation gap reproduction

Verified against `dev` / `origin/dev` at `3cf26a8a36c386efbe14df2a6d1b5e1bfc433872` on 2026-09-07.

Local verification used Node `26.5.1`, Vitest `4.1.11` and the installed Gear development dependencies (DSH Skill packages `0.1.0-rc.8`).

From the repository root, with the repository's development dependencies installed:

```sh
node node_modules/vitest/vitest.mjs run --config repros/candidate-runtime-validation/vitest.config.ts
```

Observed: **4 tests passed**. These tests characterize a defect; their success means the gap was reproduced, not that runtime loading succeeded.

Each test uses the real `RefineCapabilities`, `HarnessBuilder`, Git candidate workspace and `/usr/bin/true` subprocess. Only unrelated active-round orchestration state is stubbed. No model, evaluator or benchmark runs. Temporary repositories and worktrees are removed in `finally`.

| Candidate | Current `candidate.check` result |
| --- | --- |
| Documented Skill and loader | `ok: true`, no runtime coverage |
| Loader throws during `apply()` | `ok: true`, no runtime coverage |
| Loader imports a nonexistent allowed-prefix dependency | `ok: true`, no runtime coverage |
| Loader points at `../missing-skills/` | `ok: true`, no runtime coverage |

The tests also verify that `check: "runtime"` is rejected and the candidate still has its parent's manifest after checking. They do not boot DSH and do not claim to reproduce the private experimental Skill.

Control checks:

```sh
node node_modules/vitest/vitest.mjs run tests/unit/harness-builder.spec.ts tests/composition/target-skill-loader.spec.ts tests/unit/dsh-codex-luna-example.spec.ts
```

Observed: **45 tests passed**. The existing composition test uses Gear's DSH `0.1.0-rc.8` development dependencies and a small service composition; it is not a Target `0.1.1-rc.2` carrier smoke check.

The reproduction is intentionally outside the normal test suite. When implementing the fix, replace its current-behavior assertions with the proposed coverage semantics and transfer the invalid candidates to runtime integration tests.

See [the investigation and implementation proposal](../../docs/candidate-runtime-validation-gap-and-plan.zh-CN.md).
