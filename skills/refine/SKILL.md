---
name: refine
description: Evolve an agent harness through Gear using measured seed and held-out evaluations. Use when the user asks to refine, evolve, optimize, compare, continue, inspect, publish, or roll back a Gear-managed harness from Codex, Claude Code, DSH, or another Agent Skills-compatible harness.
---

# Refine

Use Gear as the authority for evolution state, candidate workspaces, evaluation,
selection, and promotion. This skill is the Meta Agent entrypoint; the Target
Agent runs separately through the rollout provider configured in Gear.

## Connect

Require all of the following before starting or claiming work:

- the `gear-refine` executable;
- `GEAR_REFINE_SOCKET`, unless the user supplies `--socket`;
- a stable client id for this harness session;
- the exact runtime, skill, model, and sampling identity configured for the
  evolution.

Do not guess an identity or silently change it. Gear seals it into the
evolution spec and rejects a different harness on claim or resume.

Read [references/protocol.md](references/protocol.md) when constructing calls or
handling an active assignment.

## Run an evolution

1. Inspect existing status before creating a new evolution when the user's
   wording could mean continue. A plain refine request creates a new evolution;
   continuation must name the evolution explicitly.
2. Call `control.start` or `control.continue`, then poll `control.status` and
   `meta.claim`. Baseline evaluation can finish before an assignment appears.
3. Treat the returned lease id, token, client id, session id, and candidate id
   as one inseparable capability. Never reuse them for another assignment.
4. Use only the candidate file and `meta.call` methods exposed by Gear. Do not
   discover or modify Gear state, Git metadata, held-out data, or host paths
   directly.
5. Review the baseline summary. Query the trajectory for every failed baseline
   run before proposing a change. Keep cited evidence limited to references
   actually returned for the active seed baseline.
6. Make the smallest coherent harness change, inspect `candidate.diff`, and run
   `candidate.check` before finalizing. Use `candidate.decline` when evidence
   does not justify a change.
7. After finalization, poll status. Claim and complete every subsequent
   candidate or round until the requested batch reaches a terminal state.

Do not call `control.publish` or `control.rollback` unless the user explicitly
requests that state change. Automatic per-evolution promotion remains governed
by Gear's sealed promotion policy.

## Failure handling

- Stop using a lease immediately when Gear reports it stale or invalid.
- On a timeout or failed round, inspect status; do not create a replacement
  evolution unless the user asked for a new one.
- Use `control.rerun` only for repairable evaluation slots reported by status.
- Never bypass a failed compiler check, evidence requirement, identity check,
  or promotion decision by editing state files.
