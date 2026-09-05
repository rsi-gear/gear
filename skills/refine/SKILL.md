---
name: refine
description: Evolve an agent harness through Gear using measured seed and held-out evaluations. Use when the user asks to refine, evolve, optimize, compare, continue, inspect, publish, or roll back a Gear-managed harness from Codex, Claude Code, DSH, or another Agent Skills-compatible harness.
---

# Refine

Use Gear as the authority for evolution state, candidate workspaces, evaluation,
selection, and promotion. This skill is the Meta Agent entrypoint; the Target
Agent runs separately through the rollout provider configured in Gear.

## Connect

Use the native `refine_request` tool when it is available. It carries the same
protocol as the CLI and binds the current DSH session's client and configured
runtime/skill identity after verifying the packaged skill was loaded; pass only
the method and its ordinary parameters, with no `clientId` or `identity`.
If the bridge reports missing instructions (for example after compaction),
reload `refine` with DSH's native skill tool before retrying. In Code Mode,
finish the skill-loading call before making a separate Refine request.
This does not change or attest the host session's other tools, history, or OS
permissions; those remain the host's responsibility.

Otherwise require all of the following before starting or claiming work:

- the `gear-refine` executable;
- `GEAR_REFINE_SOCKET`, unless the user supplies `--socket`;
- a stable client id for this harness session;
- the exact runtime, skill, model, and sampling identity configured for the
  evolution.

Do not guess an identity or silently change it. Gear seals it into the
evolution spec and rejects a different harness on claim or resume.

Read [references/protocol.md](references/protocol.md) before constructing calls
or handling an active assignment. Before diagnosing evidence or changing a
candidate, also read
[references/target-harness-editing.md](references/target-harness-editing.md).
When the candidate is Gear's DSH carrier, also read
[references/dsh-target-harness.md](references/dsh-target-harness.md) before
choosing an artifact or hook. These references are the complete method
contract, general editing guide, and version-specific DSH authoring guide; do
not infer missing field names or harness APIs from errors.

## Run an evolution

1. Inspect existing status before creating a new evolution when the user's
   wording could mean continue. A plain refine request creates a new evolution;
   continuation must name the evolution explicitly.
2. Call `control.start` or `control.continue`, then poll `control.status` and
   `meta.claim`. Baseline evaluation can finish before an assignment appears.
3. Treat the returned lease id, token, session id, candidate id, and (for CLI
   clients) client id as one inseparable capability. Never reuse them for
   another assignment.
4. Use only the candidate file and `meta.call` methods exposed by Gear. The
   direct candidate methods are exactly `candidate.tree`, `candidate.read`,
   `candidate.write`, `candidate.edit`, and `candidate.remove`. Invoke
   `harness.current`, `harness.read`, `seed_tasks.load`, `trajectory.query`,
   `hitch.status`, `candidate.diff`, `candidate.check`, `candidate.finalize`,
   and `candidate.decline` only as `meta.call` capabilities; they are not
   top-level request methods. Read the active candidate files before selecting
   an edit. Do not discover or modify Gear state, Git metadata, held-out data,
   credentials, or host paths directly.
5. Review the baseline summary. Query `trajectory.query` with `refs` for every
   failed baseline run before proposing a change. It returns a compact
   diagnostic card containing the task, outcome, verifier failure summary,
   and the chronological message transcript without raw chunk noise. The card
   keeps the last 80,000 transcript characters and previews each tool result at
   up to 2,000 characters. Follow `earlierRef` for messages before that window
   and `detailRef` for a complete long result.
   Treat `result_only` as missing verifier logs, not as a complete failure
   explanation. When the card includes a `detailRef`, pass it back to
   `trajectory.query`; pass a returned `nextRef` back as the next `detailRef`,
   or add `find` to search that long content. Keep cited evidence limited to
   references actually returned for the active seed baseline.
6. Connect the observed failure to a harness-controlled cause, then choose the
   narrowest intervention at the point where that cause is observable or
   enforceable. Treat the current tree as a starting state, not a closed list
   of available mechanisms: new files are allowed, but must be connected from
   an existing preset, plugin, skill, or workflow entry. For a failure tied to
   a tool call or result, compare a hook or action verifier with prompt guidance
   before choosing `context`; if `context` is still best, explain why no narrower
   enforceable or on-demand mechanism fits. Do not add guidance for an
   infrastructure failure or behavior the Target Agent already performed
   correctly. Use the routing criteria in the editing guide rather than copying
   a seed-specific remedy into a shared prompt.
7. Inspect `candidate.diff`, remove accidental or task-specific changes, and
   run `candidate.check` before finalizing and require
   `finalizationReadiness.ready: true`. Use `candidate.decline` when the
   evidence does not justify a harness change or the required fix is outside
   the editable substrate.
8. After finalization, stop using that lease and poll status. Claim and complete
   every subsequent candidate or round until the requested batch reaches a
   terminal state.

Do not call `control.publish` or `control.rollback` unless the user explicitly
requests that state change. Automatic per-evolution promotion remains governed
by Gear's sealed promotion policy.

## Failure handling

- Stop using a lease immediately when Gear reports it stale or invalid.
- On a timeout or failed round, inspect status; do not create a replacement
  evolution unless the user asked for a new one.
- Use `control.rerun` only for repairable evaluation slots reported by status.
- If finalize or decline returns `accepted:false, recoverable:true`, execute
  `nextAction`, then `remainingActions`, and retry the same operation with the
  same arguments. The lease remains active until `accepted:true`.
- If it returns `accepted:false, recoverable:false`, report the exact
  `operatorAction` and do not repeat the same tool call. Verifier evidence may
  require an operator/configuration change. `TRAJECTORY_EVIDENCE_UNAVAILABLE`
  means Hitch could not construct bounded analysis for the listed `blockedRuns`;
  Hitch or that stored trajectory must be repaired before rereading the card.
- Never bypass a failed compiler check, evidence requirement, identity check,
  or promotion decision by editing state files.
