# Gear Refine Skill Protocol

The client sends one request at a time:

```text
gear-refine request <method> '<json-params>'
```

Set `GEAR_REFINE_SOCKET` or add `--socket <path>` before `request`. Output is a
single JSON value. A nonzero exit means the request failed.

## Control methods

- `control.start`: accepts optional `seedTaskRef`, `rounds`, `taskBudgetMs`,
  `focus`, `from`, and `name`.
- `control.continue`: requires `evolutionId`; accepts optional `rounds` and
  `focus`.
- `control.status`: omit `evolutionId` to list evolutions; otherwise accepts an
  optional `roundId`.
- `control.rerun`: requires `evolutionId`, `roundId`, `evalId`, and `selector`.
  The selector is `{"mode":"invalid"}` or
  `{"mode":"tasks","taskNames":[...]}`.
- `control.publish`: requires `evolutionId`; optional `ref`. Invoke only on an
  explicit user request.
- `control.rollback`: requires `evolutionId` and exact accepted `ref`. Invoke
  only on an explicit user request.

## Claim an assignment

Call `meta.claim` with:

```json
{
  "clientId": "stable-id-for-this-harness-session",
  "evolutionId": "optional-evolution-filter",
  "identity": {
    "runtime": {"type": "codex-or-claude-or-dsh", "version": "...", "integrity": "sha256:..."},
    "preset": {"id": "refine", "digest": "sha256:..."},
    "model": {"provider": "...", "model": "..."},
    "sampling": {}
  }
}
```

The identity must exactly match Gear's configuration, including optional
`maxTokens` and `temperature`. `{ "pending": false }` means baseline work is
still running or there is currently no assignment. A successful claim returns
the assignment and a secret `leaseToken`.

Every candidate or Meta capability request must include `clientId`, `leaseId`,
and `leaseToken`.

## Candidate files

- `candidate.tree`: optional `path`; returns the bounded editable tree.
- `candidate.read`: requires `path`; returns text and its SHA-256 observation.
- `candidate.write`: requires `path`, `text`, and `expectedDigest`. Use `null`
  only to create a path that must not already exist.
- `candidate.edit`: requires `path`, `oldString`, `newString`, and the
  `expectedDigest` returned by `candidate.read`; optional `replaceAll`.
- `candidate.remove`: requires `path` and `expectedDigest`.

Paths are relative to `/candidate/harness`. Only the editable preset, plugin,
prompt, skill, and workflow roots are available. Observation digests prevent a
stale Meta Agent from overwriting newer content.

## Meta capabilities

Call `meta.call` with an additional `capability` and `arguments` object.
Available capabilities are:

- `harness.current`, `harness.read`, `seed_tasks.load`;
- `trajectory.query`, `hitch.status`;
- `candidate.diff`, `candidate.check`;
- `candidate.finalize`, `candidate.decline`.

Before `candidate.finalize`, call `trajectory.query` for each failed baseline
run, inspect the diff, and run the compiler check. Finalization arguments are
`rationale`, `evidenceRefs`, and `expectedOutcome`. Decline arguments are
`rationale` and `evidenceRefs`.
