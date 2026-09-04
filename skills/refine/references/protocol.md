# Gear Refine Skill Protocol

This is the complete structured protocol used by a Refine Meta Agent. The
Target Harness editing and reasoning guide is in
[target-harness-editing.md](target-harness-editing.md). Gear DSH candidates also
require the version-specific
[dsh-target-harness.md](dsh-target-harness.md) authoring guide.

## Transport and request form

The client sends one request at a time:

```text
gear-refine [--socket <path>] request <method> '<json-params>'
```

Set `GEAR_REFINE_SOCKET` when `--socket` is omitted. Standard output is one JSON
value. A nonzero exit means the request failed; treat its message as a protocol
error, not as permission to inspect host state.

Keep `leaseToken` secret. Do not print it in commentary, reports, logs, diffs,
prompts, or candidate files. It is sent only in requests for its assignment.

## Control methods

Control methods do not use a lease.

### `control.start`

Starts one new evolution. A plain refine request uses this method even if older
evolutions exist.

```json
{
  "seedTaskRef": "optional configured seed dataset override",
  "rounds": 1,
  "taskBudgetMs": 3600000,
  "focus": ["context"],
  "from": "initial",
  "name": "optional human-readable name"
}
```

All fields are optional. `focus` must be an array containing any of `context`,
`pre_action`, `routing`, `post_action`, `action_verifier`, `skill`, `tool`,
`workflow`, or `compaction`. `from` is `initial`, `published`, or an exact
40-character Git commit. The response contains `evolutionId`, `batchId`,
`roundId`, and `status: "queued"`.

### `control.continue`

Continues an existing evolution without changing its sealed datasets, models,
budgets, toolchain, sandbox, or promotion policy.

```json
{
  "evolutionId": "required",
  "rounds": 1,
  "focus": ["routing", "tool"]
}
```

Only `evolutionId` is required.

### `control.status`

List evolutions:

```json
{}
```

Inspect an evolution or one exact round:

```json
{
  "evolutionId": "required for detail",
  "roundId": "optional"
}
```

Round statuses are `queued`, `baseline-running`, `preparing-candidate`,
`candidate-editing`, `building-candidate`, `candidate-seed-running`,
`selection-running`, `held-out-running`, `repairing-evaluation`, `promoting`,
`accepted`, `rejected`, `rejected-for-substrate`, or `failed`. Only the last
four are terminal.

The public status can include `seedSummary`, `seedBaseline`, `seedCandidate`, a
terminal `decision`, a public failure string, and `repairableEvaluations`.
Held-out task identity and reward are intentionally not returned.

### `control.rerun`

Repairs a failed evaluation only after status advertises a repairable
evaluation. It is not a general retry mechanism.

```json
{
  "evolutionId": "required",
  "roundId": "required",
  "evalId": "required repairable Hitch evaluation",
  "selector": {"mode": "invalid"}
}
```

Or select all invalid/missing logical slots for named tasks:

```json
{
  "evolutionId": "required",
  "roundId": "required",
  "evalId": "required",
  "selector": {"mode": "tasks", "taskNames": ["task-a", "task-b"]}
}
```

### `control.publish`

```json
{"evolutionId":"required","ref":"optional exact accepted commit"}
```

Publishes an accepted champion as the workspace default. Invoke only when the
user explicitly requests publication.

### `control.rollback`

```json
{"evolutionId":"required","ref":"required exact previously accepted commit"}
```

Rolls one evolution back to an accepted commit. Invoke only when the user
explicitly requests rollback.

## Claiming a Meta assignment

Poll `meta.claim` after starting/continuing and while baseline evaluation is
running:

```json
{
  "clientId": "stable-id-for-this-Meta-harness-session",
  "evolutionId": "optional evolution filter",
  "identity": {
    "runtime": {
      "type": "codex-or-claude-code-or-dsh",
      "version": "exact version",
      "integrity": "sha256:<runtime artifact digest>"
    },
    "preset": {
      "id": "refine",
      "digest": "sha256:<configured skill digest>"
    },
    "model": {
      "provider": "exact provider",
      "model": "exact model"
    },
    "sampling": {
      "temperature": 0
    }
  }
}
```

New Gear configurations omit `maxTokens` so Gear does not impose an additional
per-turn output cap. A legacy evolution that sealed `maxTokens` must still send
that exact value. Omit optional `temperature` only when it is also absent from
the sealed Gear configuration. When no sampling fields are configured, still
send `"sampling": {}`. Identity equality is exact. Do not guess values or
silently substitute another runtime/model.

`{"pending":false}` means the baseline is still running or no matching
assignment is currently available. Continue polling the same evolution. A
successful response includes:

- `leaseId` and secret `leaseToken`;
- `evolutionId`, `roundId`, `candidateId`, `sessionId`, and `workspaceId`;
- `parentHarnessRef` and `parentHarnessDigest`;
- `baseline` with `evalId`, score summary, and seed trials/run ids;
- `evidencePolicy`, optional `advisoryFocus`, and batch position.

Treat all returned assignment identifiers as one inseparable capability. Use a
stable `clientId` for the Meta harness session; never transfer or reuse a lease
for another candidate, round, or client.

## Lease request envelope

Every candidate method and `meta.call` includes:

```json
{
  "clientId": "same client id used to claim",
  "leaseId": "claimed lease id",
  "leaseToken": "secret claimed token"
}
```

Examples below show method-specific fields in addition to this envelope.

## Candidate file methods

Request routing is strict:

- send `candidate.tree`, `candidate.read`, `candidate.write`, `candidate.edit`,
  and `candidate.remove` directly as the request method;
- send every capability documented under **Meta capabilities** through request
  method `meta.call`, placing its name in `params.capability` and its payload in
  `params.arguments`.

In particular, `candidate.diff`, `candidate.check`, `candidate.finalize`, and
`candidate.decline` are capability names, not top-level request methods. A call
such as `gear-refine request candidate.diff ...` is invalid.

All paths are logical paths below `/candidate/harness`. Relative paths such as
`plugins/policy.js` are preferred. Absolute host paths are unavailable.

Only `preset/`, `plugins/`, `prompts/`, `skills/`, and `workflows/` are editable.
`manifest.json`, package manifests, lockfiles, `.git`, symlinks, hardlinks, and
other substrate are protected.

### `candidate.tree`

```json
{"path":"optional relative directory or file; defaults to ."}
```

Returns `root` and bounded `entries` containing logical path, type, byte size,
and a digest when the file is small enough to observe.

### `candidate.read`

```json
{"path":"plugins/policy.js"}
```

Returns `path`, UTF-8 `text`, `bytes`, and an observation `digest`. Use that
digest for the next mutation of this file.

### `candidate.write`

Create a file only if absent:

```json
{
  "path":"prompts/new.md",
  "text":"new text\n",
  "expectedDigest":null
}
```

Replace a file only if it still matches a previous observation:

```json
{
  "path":"prompts/existing.md",
  "text":"replacement text\n",
  "expectedDigest":"sha256:<digest from candidate.read>"
}
```

### `candidate.edit`

```json
{
  "path":"plugins/policy.js",
  "oldString":"unique exact text",
  "newString":"replacement text",
  "expectedDigest":"sha256:<digest from candidate.read>",
  "replaceAll":false
}
```

`oldString` must be nonempty. Without `replaceAll: true`, it must occur exactly
once. The response returns the new digest and replacement count.

### `candidate.remove`

```json
{
  "path":"prompts/obsolete.md",
  "expectedDigest":"sha256:<digest from candidate.read>"
}
```

Only a regular owned file can be removed. Remove live references before the
file itself.

## Meta capabilities

Call any capability through `meta.call`:

```json
{
  "clientId":"...",
  "leaseId":"...",
  "leaseToken":"...",
  "capability":"trajectory.query",
  "arguments":{}
}
```

### `harness.current`

Arguments: `{}`.

Returns the exact parent `ref`, manifest `digest`, and manifest. The manifest
lists every parent harness artifact available to `harness.read`.

### `harness.read`

```json
{
  "ref":"exact parentHarnessRef",
  "path":"plugins/policy.js",
  "offset":0,
  "limit":131072
}
```

`ref` and `path` are required. Only files indexed by the current parent
manifest can be read. `offset` defaults to zero; `limit` is bounded by server
configuration. The response includes `text`, `bytes`, `digest`, `offset`, and
`eof`. This reads the immutable parent, not the candidate copy.

### `seed_tasks.load`

```json
{"partition":"seed"}
```

`partition` is optional but, when supplied, must be `seed`. The response contains
the configured public seed projection or `available:false` when no typed
projection is configured. Held-out tasks are never available.

### `trajectory.query`

List failed seed runs and diagnosis progress for the active round:

```json
{}
```

Read compact diagnostic cards for up to five recorded runs:

```json
{"refs":["run_<recorded seed run id>"]}
```

The card contains task/outcome data, a verifier summary, and every chronological
message that fits in the final 80,000-character transcript window. It does not
select or rank semantic steps. Each tool result is previewed at no more than
2,000 characters. Internal sequence numbers, canonical digests, field paths,
byte ranges, context epochs, and raw events are not exposed. Long values contain
an opaque `detailRef`; messages before the transcript window use `earlierRef`:

```json
{"detailRef":"detail_<opaque>"}
```

The response contains a bounded text page and, when more remains, an opaque
`nextRef`. Continue by passing `nextRef` as `detailRef`. Search long content
without loading every page by supplying `find`:

```json
{"detailRef":"detail_<opaque>","find":"AssertionError"}
```

Search is a locator and does not satisfy a card's required verifier-detail
read. For a `[required verifier details: ...]` reference, read the ordinary
pages through the final page before finalization.

If a detail response says `complete:false` without a `nextRef`, Hitch supplied
only an incomplete source excerpt; Gear does not invent a continuation. Treat
that run as blocked until the retained source evidence is repaired or extended.

Only `refs`, `detailRef`, and `find` are accepted. Sensitive values and held-out
references are redacted. Gear keeps source location, integrity, and paging data
internally and binds the diagnosis receipt to the exact visible card plus any
required verifier-detail pages.

If bounded analysis cannot be produced, the card query returns
`batchAccepted:false`, `recoverable:false`,
`code:"TRAJECTORY_EVIDENCE_UNAVAILABLE"`, exact `blockedRuns` with stable Hitch
codes, and an `operatorAction`. Do not retry the same query. Report those fields;
an operator must update/fix Hitch or repair the stored trajectory, then the
card must be read again before finalization.

Query a card for every failed baseline run before finalizing or declining.

### `hitch.status`

```json
{"roundId":"required active round id"}
```

Returns the public active-round status plus authoritative seed baseline detail.
It is restricted to the assignment's active round. It does not expose held-out
identity or reward.

### `candidate.diff`

```json
{"maxBytes":1048576}
```

All arguments are optional. Returns an authoritative summary and patch against
the exact parent. The patch can be truncated by the requested/server limit;
the summary and patch digest remain authoritative.

### `candidate.check`

```json
{"check":"compiler"}
```

`check` is optional; the only accepted value is `compiler`. Runs Gear's fixed
workspace validation/compiler and returns the backward-compatible `ok:true`
and summary plus separate `compiler` and `finalizationReadiness` objects. It
does not run the seed or held-out benchmark. Do not finalize while readiness is
false; execute its typed `nextActions` first.

### `candidate.finalize`

```json
{
  "rationale":"evidence-based causal explanation",
  "evidenceRefs":["eval_<baseline>","run_<failed seed run>"],
  "expectedOutcome":"measurable Target Agent behavior expected to change",
  "semanticTargets":["action_verifier"]
}
```

`rationale`, nonempty `evidenceRefs`, and `expectedOutcome` are required.
`semanticTargets` is optional and uses the same values as `focus`. Cite only
current baseline refs that were actually returned and observed. Before this
call, inspect the baseline, query every failed run's diagnostic card, inspect the
diff, and pass `candidate.check` with readiness true. `accepted:true` seals and
submits the candidate and concludes the lease; it does not mean the candidate
passed evaluation.

If evidence prerequisites remain, the response is not an exception-shaped
string. It returns `accepted:false`, `recoverable:true`, a stable `code`,
task-labelled `readiness.missing`, directly callable `nextAction` and
`remainingActions`, and `retry.reusePreviousArguments:true`. The lease and
candidate workspace remain active. Execute the actions and retry.

If strict verifier evidence is unavailable, Gear instead returns
`accepted:false`, `recoverable:false`, `code:"VERIFIER_EVIDENCE_UNAVAILABLE"`,
and an exact `operatorAction`. Do not loop on the same call. An operator must
upgrade Hitch or explicitly enable the temporary
`hitch.allowUnavailableVerifierDiagnosis=true` compatibility mode, then the
affected diagnostic cards must be read again.

If bounded trajectory analysis previously failed, Gear returns the analogous
non-recoverable `TRAJECTORY_EVIDENCE_UNAVAILABLE` response with
`readiness.trajectoryBlockedRuns` and `operatorAction.runIds`. This is distinct
from an unread run: repeating the suggested card query cannot fix it. Repair
Hitch/the recorded evidence first, reread the affected cards, then retry the
same finalization arguments.

### `candidate.decline`

```json
{
  "rationale":"why the observed evidence does not justify a valid harness change",
  "evidenceRefs":["eval_<baseline>","run_<observed seed run>"]
}
```

Use when evidence is insufficient or no allowed/generalizable harness edit is
justified. Every failed baseline run must still be diagnosed. It concludes the
lease without a candidate diff only when the response is `accepted:true`; a
recoverable rejection follows the same action protocol as finalize.

## Complete assignment sequence

For each candidate assignment:

1. Poll `control.status` and `meta.claim` until a matching lease is returned.
2. Record the assignment and baseline; call `harness.current`, `candidate.tree`,
   `seed_tasks.load`, and `hitch.status`.
3. Query a diagnostic card for every failed baseline run, following only the
   opaque `detailRef` values needed for focused drill-down.
4. Follow [target-harness-editing.md](target-harness-editing.md) to select and
   apply an evidence-based edit, or decide to decline. For Gear's DSH carrier,
   first follow [dsh-target-harness.md](dsh-target-harness.md) to map the
   semantic target to a real DSH artifact, registration, and hook.
5. For an edit, use `meta.call` with capabilities `candidate.diff`,
   `candidate.check`, require readiness true, then `candidate.finalize`. For no justified edit, use
   `meta.call` with capability `candidate.decline`.
6. If finalize/decline returns a recoverable response, execute all actions and
   retry with the same arguments. Stop using the lease only after
   `accepted:true`. Poll `control.status` through candidate seed,
   selection, held-out, and promotion states.
7. Claim every subsequent candidate/round in the requested batch. Finish only
   at `accepted`, `rejected`, `rejected-for-substrate`, or `failed` for the last
   requested round.

Do not call publish, rollback, rerun, start another evolution, or access host
state as a substitute for completing this sequence.

## Error handling

- `pending:false`: wait and claim again; do not start a replacement evolution.
- Invalid/stale lease: stop using it and inspect control status.
- Identity mismatch: use the configured exact identity; do not weaken or change
  the evolution identity.
- Observation mismatch: re-read the candidate file and reassess the edit.
- Compiler failure: repair the candidate within allowed roots or decline when
  no valid repair is possible.
- `TRAJECTORY_EVIDENCE_UNAVAILABLE`: stop repeated card/finalization calls and
  report `blockedRuns`/`operatorAction`; resume only after the prerequisite is repaired.
- Failed round with `repairableEvaluations`: use `control.rerun` only for the
  advertised evolution, round, evaluation, and logical slots.
- Nonterminal status: continue polling the same round.
