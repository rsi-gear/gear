# Project operation protocol

The native `refine_request` tool accepts `method`, `params`, and optional
`request_id`. The JSON-line socket transport accepts `{id, method, params}` and
returns `{id, result}` or `{id, error}`. CLI and Python Project use the same service.

| Method | Parameters | Result |
| --- | --- | --- |
| `benchmark.import` | `{source, template?, mode?, resource_root?}` | Preview frozen CSV/JSONL or native Harbor data and deterministic family/input splits |
| `benchmark.apply` | `{plan_id}` | Apply the reviewed plan if project config and destination still match |
| `benchmark.check` | `{}` | Frozen data digest, task count, splits and check results |
| `benchmark.preview` | `{"task_id":"..."}` | Author task and private scorer preview |
| `benchmark.probe` | `{task_id?, scorer?, image?}` | Build/start a seed Docker environment; explicitly run deterministic verifier fixtures; save a probe report, zero model calls |
| `environment.doctor` | `{}` | Local dependencies, capabilities and credential-source checks; zero model calls |
| `environment.setup` | `{python?, hitch?, adapter?, hitchExecutable?, hitchRoot?, image?, targetProfile?, metaProfile?}` | Install the managed worker and explicitly requested execution dependencies |
| `project.init` | `{directory, adapter?, template?, targetProfile?, metaProfile?}` | Create a project using selected profiles |
| `profile.list` | `{}` | Profile inventory and default selection |
| `profile.create` | `{name, options}` | Create native Hitch/Codex settings; explicit model, credential references only |
| `profile.import` | `{name, profile}` | Validate and save process/native settings without overwriting a name |
| `profile.select` | `{name, role, scope?}` | Select target/meta for project or default scope |
| `config.explain` | `{}` | Effective values and their sources |
| `algorithm.test` | Optional `entrypoint` | Offline contract-test result |
| `run.evaluate` | `split`: `seed` or `held_out`; optional positive `limit` | Durable `run_id`, followed by background execution |
| `run.plan` | Same parameters as `run.refine` | Scope, verified baseline reuse, applicable limits and warnings; no run admission or execution |
| `run.refine` | Optional positive `rounds`; SDK algorithm descriptions may also carry `algorithm`, `sources`, `dependencies` | Durable `run_id` and frozen `plan`, followed by background execution |
| `run.report` | Optional `run_id` (latest by default) | Persisted report, coverage, gate, usage, error and next action |
| `run.archive` | `run_id` | Verified seed-only archive and Python scope projections; preserves candidates independently of promotion |
| `experience.query` | `run_id`, optional `snapshot_digest`, `query`, `parent_id`, `limit` (1–10), `cursor` | Bounded seed edit-outcome cards; query fields: query, task_ids, paths, semantic_targets, effects |
| `experience.read` | `run_id`, `ref`, optional `snapshot_digest`, `view`, `limit` (1–50), `cursor` | Card, task-results, diff, modification-use, verifier, or trajectory source refs; missing capture stays explicit |
| `experience.trajectory` | `run_id`, `snapshot_digest`, `ref`, `source_ref`, optional `query` | Bounded historical seed canonical events; query: limit (1–50), types, seq_start, seq_end, field, cursor |
| `run.resume` | `run_id` | Resume saved execution in the background |
| `run.cancel` | `run_id` | Durable cancellation request |
| `run.export` | `run_id` | Verified immutable export directory |

Do not pass client identities, model settings, lease IDs, credentials, or private
filesystem paths as operation parameters. Unknown parameters are rejected.

Experience outcomes compare a candidate against its actual code parent on the
same seed task/repetition scope. Invalid or missing observations stay unavailable.
Reuse snapshot_digest and cursor together for stable pagination. Classification,
retrieval and automatic card selection run in Python. Before each Meta operation,
core binds the sanitized immutable snapshot and at most three cards to its durable
request. The native Codex runner stages only that snapshot with a frozen local
query/read program; it has no access to this operator socket or private journals.
Snapshots contain no held-out/gate or raw provider receipts. Version 3 snapshots
use a 4 MiB index (4096 records), separate 2 MiB record descriptors and 256 KiB
detail objects; one authorized closure permits 100,000 unique files. Shared parent
verifier observations retain full content and run/evaluation/task ownership while
being stored once. Query/cards read only summaries; read opens only the selected
record/view/page. Individual items are at most 61 KiB and must also fit the view
summary; cards remain 2048 bytes, automatic context 12 KiB and replies 64 KiB.
There is no aggregate 12 MiB evidence limit. Bounds fail explicitly, with no silent
evidence truncation. Dependencies publish before the immutable index; staging
copies and verifies only its exact authorized object closure.

Export's version 3 experience-snapshots.json lists latest_snapshot_digest and
snapshot_digests; experience/<digest>.json indexes and experience/objects/<digest>.json
contain all required shared objects, without reconstructing a detailed monolith.
Historical v2 files retain their original digests, refs/cursors and 12 MiB file
bound. Version 3 index digests are new snapshot identities; experience refs still
name complete logical records. Frozen source implementation identities remain
enforced: this update does not auto-resume or silently migrate old runs.

Trajectory refs are opaque capabilities bound to an accepted seed trial; never pass
provider run IDs or paths. Native Hitch pins the canonical digest at receipt capture.
Reuse the snapshot, ref, source_ref and filters with each returned next_cursor.
Exact field reads require equal seq_start/seq_end. Large content uses provider
excerpts; child_sessions is explicitly not-included. Missing or changed sources fail
without evaluation. Native Codex exposes only this read method on a separate
per-operation socket, not the operator socket. Export includes private source
bindings and reader identity in trajectory-sources.json, without copying full logs.

The modification-use view returns sanitized per-trial observations, also summarized
in cards and task-results. Statuses are observed, attempted-failure, not-observed,
and unknown. Python verifies pinned DSH native main/child sources and exact candidate
content before matching reads/injections. Absence requires complete listed sources
and a supported Skill; missing or unsupported sources stay unknown. Limits apply
across the snapshot (1024 source reads / 1 GiB), with bounded per-source inputs and
action examples. Complete verified observations are reusable; partial/unavailable
sources may be retried in a new snapshot. Old snapshots remain immutable. Actions
contain source identities and sequences, not raw logs or resource bodies. These
observations and their paired score summaries (summary.conditioned_results on every
page, within the same byte limit) never establish causation or prove
execution of changed instructions after a metadata-only edit.

The verifier view contains frozen parent/candidate process observations and public
feedback. Each trial is bounded to 16 KiB, 32 components, 16 feedback items and 32
failure codes, with full counts and explicit omission/truncation fields. Private
references, raw verifier results and diagnostics stay in operator receipts. Python
validates component consistency and projects failure-code hypotheses. Missing,
invalid, unsupported and unavailable sources never become zero scores. Process
channels affect ranking or promotion only through explicitly declared objective
metrics/protection rules. Read-only metric/assertion completion does not rewrite
the original diagnosis or run a Target again.

For a create-run call, `request_id` is its admission key. Use a fresh ID for a new
intent and the same ID after a lost reply. A conflicting method or parameter set
returns `admission-conflict`. Completed requests return their original report;
failed execution remains `needs_recovery` until `run.resume` is requested.
Normal CLI `evaluate`, `refine`, and `resume` wait for their report. Socket and
native Skill calls return after admission so the operator can inspect or cancel.

`run.plan` is a preview, not a reservation. Inputs are rechecked when the run is
admitted. Ordinary CLI refine prints that admitted plan before execution;
`--json` keeps a single JSON response with `plan` in its report. Use
`gear refine --dry-run --json` or Python `Project.plan_refine()` /
`await Project.aplan_refine()` to inspect without starting work. Plans show seed
task IDs and the held-out count, never private task content. Model access remains
`not_checked`; the algorithm has not run during preview.

Verified completed seed receipts may supply matching baseline slots. The plan
identifies the source and missing slots; the report separates `baseline_reuse`
historical usage from current `usage`. Valid zeros remain valid. The frozen
source proof is verified on resume/export, without rereading mutable history.

Reports distinguish `ready`, `running`, `needs_recovery`, `cancelled`, and
`completed`. Completion alone does not mean improvement: inspect `gate`,
`retained`, score coverage, and `validation_mode`. Do not zero-fill invalid slots.

The operator may preview author data. The managed algorithm and Meta execute with
seed-only projections; do not copy held-out previews or gate details into their
inputs. They do not use this operator socket as an evidence-reading capability.

Benchmark probes may build/download environment dependencies. They are authoring
checks, not experiment runs or baselines. Inspect `environment`, `scorer`,
`fixtures`, and `cleanup_required`; a native environment passing does not imply
its verifier has declared self-test fixtures. Probe reports are saved separately
under `.gear/probes/` and do not change run budgets or promotion state.
