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
private ToolFs bundle. The build follows the public CLI/SDK/Skill/training and
Codex runner entrypoints and produces `lib/`; generated output should not be
committed. Retired execution modules are excluded from that build and the npm
package. Platform dependencies and a runnable agent setup are
documented in [installation and usage](docs/plugin-installation-and-usage.md).

## Code structure and readability

Keep behavior in the module that owns it:

| Area | Responsibility |
| --- | --- |
| `src/domain/`, `src/ports/` | Shared contracts, identities and implementation-independent interfaces |
| `src/runtime/` | Durable decisions, operation admission, budgets, recovery and final gate |
| `src/application/` | Project use cases shared by CLI, Python SDK and Skill |
| `src/adapters/` | Harness/provider integration, storage, Python workers and isolation |
| `src/cli/`, `src/skill/`, `skills/refine/` | Command projection, bundled Skill resources and operator instructions |
| `python/gear/algorithms/` | Public Python contracts and the six replaceable modules in each algorithm |
| `python/gear/benchmark/`, `python/gear/refine/` | Author-data compilation/import, verifiers and worker protocol |
| `src/training/`, `python/gear/training/` | Training coordination, contracts, runtime, storage and optional backends |

Retired search, RefineService and Meta implementations and their regression
fixtures have been removed. Git history preserves the old implementation.
Tests exercise current production modules; do not restore a parallel legacy
assembly to support new tests.

Keep CLI handlers focused on argument parsing and output. Use the public entry
points in `package.json` for external consumers. Algorithms use public
`gear.algorithms` Python contracts; start with the
[algorithm authoring guide](docs/search-algorithm-authoring.zh-CN.md) and
[examples](examples/algorithms/). GEPA and RandomSearch both expose parents,
sampling, proposal, ranking, stopping and algorithm modules.

Follow nearby TypeScript style: two-space indentation, single quotes, no
semicolons, and `.js` suffixes for local ESM imports. Use descriptive names and
explicit types for substantial contracts. Split large operations by
responsibility, reuse rules that share an owner, and keep formatting changes
focused. Run `npm run lint`, `npm run format:check`, `npm run check:boundaries`
and `npm run check:contracts` for the new architecture. Python uses Ruff and
mypy as configured in `python/pyproject.toml`.

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

Gear uses Vitest on TypeScript source. Its global setup builds the production
entrypoints once so subprocess tests also execute current code:

```sh
npm test -- tests/unit/project-controller.spec.ts
```

Use the checks that cover the changed surface:

| Change | Validation |
| --- | --- |
| Python algorithm contracts and policies | Python tests and `python -m gear algorithm test` |
| Public project API; Python algorithm authoring uses the project package journey | `npm run test:api:package` |
| Package contents, exports, or dependencies | `npm run build` followed by `npm pack --dry-run --ignore-scripts` |
| Sandbox, algorithm workers or Meta execution | `npm run test:sandbox:platform` with the [platform dependencies](docs/plugin-installation-and-usage.md) installed |
| Training controller or Python bridge | `npm run test:training` after the [CPU training test setup](docs/guide/en/training.md#cpu-development-tests) |
| CI selection or npm release rules | `node --test .github/scripts/*.test.mjs` |

For changes to Gear's Hitch contract, run the current provider tests:

```sh
npm test -- tests/unit/project-hitch.spec.ts tests/unit/hitch-preparation.spec.ts
```

For real daemon checks, build the companion Hitch with the capabilities listed
in the [configuration guide](docs/guide/en/configuration.md), then run
`GEAR_TEST_HITCH=/absolute/path/to/hitch GEAR_TEST_HITCH_BINDING=1 node scripts/check-hitch-environment.mjs`.
Report skipped checks and which tests used real processes or services. Add regression tests for observable
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
experiment results. Do not commit experiment documents to Git: this includes
ad hoc experiment plans, progress diaries, run logs, local acceptance reports,
and one-off validation summaries, even when written as Markdown under `docs/`.
Keep them outside the checkout or in an ignored local directory; summarize
relevant results in the PR description and link external artifacts when needed.
Commit maintained user/developer documentation, durable design decisions,
reusable test instructions, and small automated fixtures with clear provenance.
Do not copy a local experiment report into the documentation tree as a substitute
for updating those maintained documents.

For diagram changes, commit only the SVG assets in
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
