# Read a report

Terminal Hitch failures retain the upstream error in the operation result and the unchanged provider result in private receipt provenance. Already certified scores, including zero, remain valid; requested slots missing from that terminal result have `score: null` and `environment_failed`. Their attempt usage is conservatively charged at the reserved upper bound because execution may have occurred before evidence collection failed. Older exceptional results that omit dataset/candidate/artifact fields may use the matching frozen plan for identity validation; contradictory reported fields and incomplete successful results are still rejected. This does not change old journals or certify trials lacking image evidence.

When Hitch advertises `verifier_evidence: "1"`, Gear freezes an independent verifier observation and checks its run, eval, trial, attempt, task reward and structured components. Python validates component weights/counts and projects failure-code hypotheses. Task `score` stays independent. Process values affect decisions only when explicitly declared in `metrics[].source.path` (for example `verifier.process.score`) and used by an objective or protection rule. Failure codes support investigation, not established root causes.

The report's `verifier` summary distinguishes available, missing, invalid, unsupported, unavailable and not_captured. Process metrics are grouped by name. A task-weighted `value` requires valid process observations for every task/repetition in the scope; `observed_trial_mean` describes only the observed trials. Missing secondary material does not invalidate a valid task score of zero.

`gear experience read RUN_ID REF --snapshot DIGEST --view verifier` pages through frozen observations for the actual parent and candidate. Python `experience_read` / `aexperience_read` accept the same view. Each trial is capped at 16 KiB, 32 components, 16 feedback items and 32 failure codes, with full counts and omission counts. Failed components come first; shortened messages are marked. Private references, raw result and diagnostics remain outside this view, in operator receipts. Read-only source projection can fill declared metrics/assertions without rewriting frozen diagnosis or executing the Target again.

Seed edit experiences use a separate immutable snapshot. `gear experience query RUN_ID --query format` returns at most ten matching cards. Use `--query-json '{"effects":["regressed","mixed"]}'` for structured filters (`task_ids`, `paths`, `semantic_targets`, `effects`). `gear experience read RUN_ID REF --snapshot DIGEST --view task-results` compares the candidate with its actual code parent on the same task/repetition scope; `--view diff` returns verified file changes. Carry the original snapshot and returned cursor into subsequent pages. Missing or invalid observations remain unavailable; valid zeros remain observations. Historical improvements and regressions do not replace promotion gates.

Python exposes `experience_query` / `aexperience_query` and `experience_read` / `aexperience_read`; pass the response's `snapshot_digest` as `snapshot`. Core freezes the snapshot and at most three cards before each Meta diagnosis/generation. Resume reuses that exact input. Native Codex stages the sanitized snapshot and frozen Python query/read code inside its sandbox. It never mounts private journals or the research archive. Snapshots exclude held-out data, gates and raw receipts/provenance; provider artifact locators become digests. Python owns classification, retrieval and automatic card selection.

New snapshots use a version 3 index with immutable record descriptors and content-addressed detail chunks. Query and automatic cards read only index summaries; a detail read opens the selected record, view and page. Shared parent verifier trials are stored once per full observation and run/evaluation/task identity, and unchanged objects are reused across snapshots. Candidate/parent comparisons, scores, card selection and detailed values retain their logical meaning. Capture processes one candidate at a time; it does not assemble all detailed records into one JSON reply.

| Boundary | Limit |
| --- | --- |
| Snapshot index / records | 4 MiB / 4096 |
| Record descriptor | 2 MiB |
| Detail object / individual read item | 256 KiB / 61 KiB |
| Unique files in one authorized snapshot closure | 100,000, including its index |
| Card / automatic context | 2048 bytes / 12 KiB |
| Query or read reply | 64 KiB |

There is no aggregate 12 MiB limit on version 3 evidence. Each item must also fit its page together with the view summary; an oversized indivisible item fails explicitly. Large arrays use chunks, and diff parts preserve UTF-8 characters. Hashes, schema, ownership and admitted seed scope are validated. File sizes are checked before bounded reads; symbolic links, hardlinks and special files are rejected. Dependencies are published durably before the immutable index becomes visible. Interrupted publication can be retried without changing committed observations.

Native Codex receives exactly the authorized index/object closure and frozen Python sources. Staging and export verify every dependency; ordinary queries do not open unrelated detail files. Export's version 3 `experience-snapshots.json` lists `latest_snapshot_digest` and `snapshot_digests`; `experience/<digest>.json` and `experience/objects/<digest>.json` contain the final snapshot, all Meta-reserved snapshots and their shared object union. It does not reconstruct an aggregate detailed JSON snapshot. The `trajectory` view still lists only sources authorized by the selected record. Missing capture is `not_captured`; failed capture is `unavailable`.

Historical version 2 monolithic files retain their 12 MiB file bound, original record digests, `experience:` refs and snapshot-bound cursors; reads do not migrate or rewrite them. New version 3 snapshot digests identify the index, while record refs still identify the complete logical version 2 record. A cursor remains bound to its original snapshot, record and view (or query). Updating the frozen Python sources changes implementation identities: this format update does not automatically resume an old frozen run. Use its matching runtime; no journal or historical evidence is silently migrated.

When Hitch advertises `trajectory_events_page: "1"`, Gear captures the canonical digest with the accepted seed receipt and binds each source to its original execution, candidate and task/repetition slot:

```sh
gear experience read RUN_ID EXPERIENCE_REF --snapshot SNAPSHOT_DIGEST --view trajectory
gear experience trajectory RUN_ID EXPERIENCE_REF SOURCE_REF --snapshot SNAPSHOT_DIGEST --query-json '{"limit":20,"types":["tool/call","tool/result"]}'
```

The query accepts `limit` (1–50), `types`, `seq_start`, `seq_end`, `field` and `cursor`. Field reads require one exact sequence. Pass `next_cursor` inside a query with the same filters. Python exposes `experience_trajectory` / `aexperience_trajectory`, with required `snapshot`. Pages bind the snapshot, source digest and filters. Missing, changed or unauthorized sources fail without rerunning evaluation. Large fields use bounded provider excerpts; sequences belong to the canonical session only. `child_sessions: not-included` makes no claim about child activity.

Native Codex uses a separate read-only socket for each operation, restricted to that snapshot's sources. Its sandbox cannot read the Hitch root or invoke project control methods. Export adds `trajectory-sources.json` with operator-visible source bindings and reader identity, without copying full logs. Reused baselines retain the original run and candidate identities.

`gear experience read RUN_ID REF --snapshot DIGEST --view modification-use` pages through changed-resource observations for candidate trials. Python sync/async `experience_read` accepts the same view. Cards contain status counts and `task-results` contains per-task summaries. The four statuses are `observed` (exact content read or injected), `attempted-failure` (a matching read failed), `not-observed` (a supported Skill was absent from complete listed sources), and `unknown` (insufficient evidence). Missing logs, unsupported code execution, mismatched content and removed files never establish absence.

DSH/Hitch pins the native manifest digest at receipt capture. An independent Python reader verifies each listed main/child file's bytes, digest, session identity and parent relationship, rejecting symbolic links, hardlinks and special files. `gear.algorithms.modification_use` owns matching and classification; `gear.observations.hitch` owns file access. Coverage is only `listed-files-complete`, not a claim about unlisted sources. Canonical pages alone cannot establish this coverage. Pi and providers without supported native sources remain `unknown`.

Uncached observations share a budget of 1024 source reads and 1 GiB of native logs per snapshot. Each source permits 16 files, 32 MiB per file, 64 MiB total and 8 MiB of retained matching inputs. Candidate resource content has a separate 8 MiB limit per candidate. Limits produce partial or unavailable coverage, never proof of absence. Complete verified observations are cached by candidate, changes, sources and implementation identity, surviving removal of the original logs. Partial/unavailable sources are retried in later snapshots; frozen snapshots stay unchanged.

Examples are limited to four actions per resource and sixteen per trial, with full matched-action counts and explicit omitted counts. They retain source digests, relative paths, session identities and event sequences; call IDs become digests. Raw logs and resource bodies are not copied. Each page includes `summary.conditioned_results`, using valid paired trials only, preserving valid zeros and excluding missing scores. These summaries describe associations, not causation. Matching an unchanged Skill body after a metadata-only edit does not prove execution of changed instructions.

```sh
gear report RUN_ID --json
```

Start with `status`, `initial`, `retained`, `nominee` and `gate`. Reports include
seed/held-out scores, observed and required slots, and completeness for the
initial and retained versions. Compare only complete, shared scopes; a high
local score is not a full-benchmark improvement.

| Field | Meaning |
| --- | --- |
| `coverage.valid` | Valid scored slots |
| `coverage.valid_zero` | Valid zeros, included in valid |
| `coverage.invalid` | Slots without a valid score |
| `coverage.scoring_failed` | Scorer failures |
| `coverage.environment_failed` | Environment or execution infrastructure failures |
| `coverage.physical_attempts` | Settled actual executions |
| `coverage.reserved_attempts` | Reservations held by unfinished operations |
| `evaluation_repairs` | Repair attempts, usage, original/previous operation references, due times and exhausted retry/budget reasons |
| `evidence_projections` | Read-only metric completion attempts, source references, requested channels, due times and blocked reasons |
| `changes` | Verified initial-to-retained and initial-to-nominee resource differences, with candidate digests and file patches |
| `usage` | Provider usage; null or missing does not mean zero |
| `plan` | Refine's frozen admission scope, baseline reuse and applicable limits; not a live remaining-budget view |
| `baseline_reuse` | Source, proof digest, slots and historical usage; excluded from current usage and physical budget |
| `research` | Verified independent seed archive, digest and object counts; read with `gear archive RUN_ID` |

`validation_mode: shared-set-research` means there was no independent validation.
A `needs_recovery` report preserves the failure and next command; repair the
cause before resuming the original run.

`gear export RUN_ID` exports the retained target, manifest and the same report,
including resource differences.
Verify exported resources and identities; a demonstration run does not establish
generalization.

`gear archive RUN_ID --json` reads the research archive. Python provides `project.archive(run_id)` and `await project.aarchive(run_id)`. The immutable content-addressed `archive` lists `objects` containing seed conditions, every candidate, current seed evidence, original seed receipts and algorithm traces. Local specialists remain even without promotion. Held-out evidence, final gate and champion outcomes stay in the operator report.

The matching Python implementation generates `projection`: candidate completeness, metrics and task leaders within each explicit task/weight/repetition scope. There is no combined ranking across scopes. Opaque custom scopes without weights retain their records and report projection unavailable; missing observations never become zeros. `task_leaders` is descriptive. `parent_selections` and `rankings` preserve algorithm-reported historical records, not a newly drawn final GEPA parent distribution. `generations` identifies the parent actually requested for each generation.

Metering-violation receipts have not passed evidence admission. The archive keeps their rejection reason and receipt digest; original rejected bytes stay in the operator journal, without exposing unadmitted evidence as seed research.

Interactive projections expand at most 10,000 scoped candidate × task × repetition slots and respect the Python reply-size limit. Oversized or failed projections explicitly return `projection.status: unavailable` with a reason; the complete raw archive remains available without truncating evidence or changing denominators.

Archive objects and snapshots are published before the journal commit; unreferenced interrupted snapshots do not change the committed run. Objects retain individual digests but share packs to avoid syncing thousands of tiny files. Missing or damaged records make `research.status` unavailable while report accounting stays readable. Resume refuses new execution, and export refuses damaged records. Explicit cancellation can still stop submitted work through status-only writes, without overwriting damaged archives or changing experiment facts. Export includes the same `research-archive.json` as the archive command. After a projector implementation change, the raw archive remains readable and the projection explicitly reports `projection-identity-mismatch`.

Reused baselines also export `baseline-source.json`: source run/journal digests,
execution conditions, original seed receipts and selected observations. Resume
and export verify this frozen proof even if the original history was removed.
`historical_usage.scope: source-candidate-seed-operations` covers all seed operations
for the source candidate, including repairs and read-only projections; it is not
a prorated cost of the selected slots. Valid zeros can be reused. Held-out evidence
never becomes an optimization baseline.

`changes.retained` compares against the run's initial target. `changes.nominee` also shows a rejected proposal; it is null before nomination. Each changed file lists its path, added/removed/modified status, before/after digests and executable flags. UTF-8 text includes a unified `patch`; mode-only changes have `patch_status: unchanged`. Binary/invalid UTF-8 and files over 64 KiB retain metadata with an explicit omission reason. Text display is bounded to 128 KiB per comparison and 2,000 line edits per file; `omitted_patches` counts omitted content, not absent files. Exported target contents remain complete.

The report verifies frozen resources and candidate identities without contacting a model provider. If resources are damaged, `changes.status: unavailable` explains the failure while scores and accounting stay readable; export refuses unverifiable resources. These operator report bytes are never added to algorithm or Meta inputs.

Each score scope contains raw `metrics`, `objective.contributions`, `objective.constraintResults` and per-task `protection` outcomes. Declared independent assertions add per-task/repetition `assertions` detail and `assertion_protection` outcomes; a perfect task score can still violate an independent assertion. `scores.nominee` includes rejected candidates so a protection failure is visible even when the aggregate improved. Missing/invalid observations never shrink the fixed denominator. Scoring implementation identity is sealed; reading or resuming an old run requires its matching runtime.

Coverage uses the current view of each logical slot after repair; original receipts remain in the journal and physical usage includes every execution attempt. Read-only projections can fill missing metrics without adding physical usage. `completed` means execution has ended, not that every slot or metric is valid. Check `coverage.invalid`, `evaluation_repairs.blocked`, `evidence_projections.blocked` and score completeness. Repair policy is frozen: changed configuration requires a new run, and resume cannot increase its original retry/projection allowance or budget.

`gear cancel RUN_ID` records a cancellation request, then attempts to confirm that work has stopped. The CLI returns `cancellation: confirmed` only after confirmation. Background controllers return `requested` immediately and continue stopping work. A worker still holding the run lock can also leave the response as `requested`; inspect the report or retry cancellation. The run is `cancelled` only after providers confirm stopped work or a durable fence against starting it. `cancellation-unconfirmed` keeps the run in `needs_recovery`; resume retries cancellation without submitting new work. Unsettled reservations and unknown usage remain visible rather than being reset to zero.

Admission saves a private cancellation connection snapshot with mode `0600` and binds its digest into the run. Cancellation recovery uses the original connection, request and implementation identity. It does not reload profiles, validate Target/benchmark/algorithm files, prepare dependencies or start an algorithm. Hitch sends a terminal pause for the original subject; Codex verifies its durable cancellation marker and worker termination. Missing or mismatched snapshots and unconfirmed termination never count as success. The snapshot excludes `passEnv` values and is not included in Meta context or exports; it is not a shareable experiment artifact.
