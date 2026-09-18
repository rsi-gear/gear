# Contributing to Gear

Contributions to algorithms, integrations, tests, documentation, and reproducible
experiments are welcome. For a substantial feature or contract change, open an
issue first to agree on scope. Bug reports should include the Gear and Hitch
versions, Node version, OS, steps to reproduce, and expected and actual behavior.
Remove credentials and private task data from examples and logs.

## Development setup

Use Git, npm, and a Node.js version supported by [package.json](package.json):
22.19 or later within the 22.x line, or 24+. The
[CI workflow](.github/workflows/ci.yml) defines the tested versions and platforms.
Python 3.12 is used in CI for the Python bridge; real notebook tests also need
IPython. Docker, Harbor, model credentials, and GPUs are needed only for checks
that exercise those integrations.

```sh
git clone https://github.com/rsi-gear/gear.git
cd gear
git switch dev
npm ci
npm run typecheck
npm run build
```

Create a topic branch from `dev` for normal development PRs. Keep
`package-lock.json` in sync when dependencies change. `npm ci` prepares Gear's
private ToolFs bundle, and the build produces `lib/`; neither generated output
should be committed. Platform dependencies and a runnable agent setup are
documented in [installation and usage](docs/plugin-installation-and-usage.md).

## Code structure and readability

Keep behavior in the module that owns it:

| Area | Responsibility |
| --- | --- |
| `src/skill/`, `skills/refine/` | Skill control plane, agent-facing contracts, and bundled instructions |
| `src/refine/` | Refinement lifecycle and round orchestration |
| `src/evolution/`, `src/search/` | Algorithm components, search policies, and candidate comparison |
| `src/harness/`, `src/candidate/` | Harness construction and isolated candidate workspaces |
| `src/evaluator/` | Evaluation adapters, execution evidence, and Hitch integration |
| `src/state/`, `src/experience/` | Durable records, identities, and reusable task experience |
| `src/training/`, `python/gear_training/` | Model-training coordination and the Slime bridge |

Keep CLI handlers focused on argument parsing and output. Use the public entry
points in `package.json` for external consumers. Algorithm extensions should use
the existing component contracts; start with the
[algorithm authoring guide](docs/search-algorithm-authoring.zh-CN.md) and the
[external policy example](examples/parent-policy/README.md).

Follow nearby TypeScript style: two-space indentation, single quotes, no
semicolons, and `.js` suffixes for local ESM imports. Use descriptive names and
explicit types for substantial contracts. Split large operations by
responsibility, reuse rules that share an owner, and keep formatting changes
focused. The core package has no repository-wide formatter or lint command.

Explain invariants and non-obvious decisions in comments, especially ownership,
persistence, cancellation, and evidence reuse. Avoid comments that narrate the
implementation or record development progress.

## Contracts, state, and evaluation evidence

Treat CLI flags, JSON responses, Skill protocols, package exports, component
identities, and persisted records as interfaces. Preserve them during refactors;
describe intentional changes and migration behavior in the PR. Validate external
values at boundaries, updating runtime validation, types, and callers together.

Preserve immutable harness and model identities, dataset digests, and evaluation
conditions when reusing evidence. Do not rewrite historical results to make a
retry succeed. For lifecycle changes, cover interrupted writes, duplicate
requests, stale workers, cancellation, and resource cleanup. An expired timeout
alone does not establish that an external task has stopped.

Keep the Meta agent's evidence permissions and the separation between seed,
training, and held-out data intact. Changes to scoring, selection, or promotion
must explain how comparisons remain valid, including missing or failed
evaluations. Model training currently has a separate experiment lifecycle from
harness evolution; document the capability actually exercised by a change.

## Tests and validation

For code changes, run type checking, the build, and tests relevant to the affected
behavior. Before requesting review of a broad runtime change, run the full suite
with the dependencies for its integration checks installed:

```sh
npm run typecheck
npm run build
npm test
```

Gear uses Vitest on TypeScript source, so focused tests do not require a prior
build unless they exercise packaged output:

```sh
npm test -- tests/unit/refine-service.spec.ts
```

Use the checks that cover the changed surface:

| Change | Validation |
| --- | --- |
| Search policies or algorithm contracts | `npm run test:search` |
| Public search API or external algorithm extensions | `npm run test:search:package` |
| Package contents, exports, or dependencies | `npm run build` followed by `npm pack --dry-run --ignore-scripts` |
| Sandbox or notebook execution | `npm run test:sandbox:platform` with the [platform dependencies](docs/plugin-installation-and-usage.md) installed |
| Training controller or Python bridge | `npm run test:training` after the [CPU training test setup](docs/guide/en/training.md#cpu-development-tests) |
| CI selection or npm release rules | `node --test .github/scripts/*.test.mjs` |

For changes to Gear's Hitch contract, reproduce the pinned Hitch checkout and
build from [CI](.github/workflows/ci.yml), then run:

```sh
HITCH_CONTRACT_ROOT=/absolute/path/to/agent-hitch \
  npm test -- tests/integration/hitch-rerun-contract.spec.ts
```

That suite skips when `HITCH_CONTRACT_ROOT` is absent. Report skipped checks and
which tests used real processes or services. Add regression tests for observable
failures and changed contracts, using isolated temporary directories and the
fixtures in `tests/helpers/` and `tests/fixtures/`. Clean up processes, ports,
and files; avoid real credentials, personal state, and fixed-sleep assumptions.

CI selects jobs using [changed-path rules](.github/scripts/ci-changes.mjs).
Development pushes keep the quick checks; relevant `main` pushes and PRs, and
manual CI runs, include the full regression suite. Platform, Python training,
and Hitch contract checks have separate jobs. CPU tests do not establish GPU
support; training or hardware changes need the applicable environment and
evidence from the [training guide](docs/training/README.zh-CN.md).

Documentation-only edits need accurate examples and working links. Check the
commands and paths you change; a prose edit does not require unrelated runtime
or hardware tests.

## Documentation, experiments, and dependencies

Follow the [documentation authoring guide](docs/guide/README.md). Update both
READMEs or both language versions of a guide when a shared user-facing behavior
changes. Keep current setup instructions separate from design proposals and
dated experiment records. For diagram changes, commit only the SVG assets in
`docs/guide/assets/` and inspect their rendering and animation in a browser.
Keep diagram authoring projects and rendered video files outside version control.

When reporting benchmark improvements, include the dataset and split, harness
and model versions, reasoning effort, evaluation budget, metric definitions,
and reproducible evidence. Distinguish tasks used during optimization from
independent held-out evaluation. Preserve historical results and link new
evidence instead of silently replacing old measurements.

A new dependency needs a concrete reason and consideration of licensing,
supported platforms, package size, and maintenance. Verify public APIs and
runtime assets from a packed package without relying on the source checkout.
Do not commit `lib/`, generated private ToolFs assets, local evolution state,
credentials, unrelated drafts, or large experiment artifacts. Use small fixtures
with clear provenance.

## Pull requests and releases

Keep a PR focused on one outcome and target `dev` for normal contributions.
Separate behavior changes from broad moves or formatting. Use concise commit
subjects such as `fix: ...`, `feat: ...`, or `docs: ...` and remove temporary
debugging work before review.

Lead the PR description with the problem and resulting behavior. Include:

- Scope, a linked issue if applicable, and important design tradeoffs.
- Compatibility, persistent-state, or evidence-reuse changes.
- Exact validation commands and results, including skipped checks.
- Remaining limitations that affect users or merge readiness.

Review the entire diff for unrelated changes, stale documentation, unnecessary
exports, and accidental secrets. Resolve applicable CI failures and review
feedback before merging.

Release changes follow the [npm release process](docs/npm-release.md).
A merge to `main` triggers publication after its CI succeeds, using the version
in `package.json`; an already published version is skipped. Coordinate version
bumps with maintainers and update both package manifests. The workflow does not
require a manually created GitHub Release.
