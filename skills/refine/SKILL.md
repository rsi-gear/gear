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

Read [references/protocol.md](references/protocol.md) before constructing calls
or handling an active assignment. Before diagnosing evidence or changing a
candidate, also read
[references/target-harness-editing.md](references/target-harness-editing.md).
These references are the complete method contract and Target Harness editing
guide; do not infer missing field names from errors.

## Run an evolution

1. Inspect existing status before creating a new evolution when the user's
   wording could mean continue. A plain refine request creates a new evolution;
   continuation must name the evolution explicitly.
2. Call `control.start` or `control.continue`, then poll `control.status` and
   `meta.claim`. Baseline evaluation can finish before an assignment appears.
3. Treat the returned lease id, token, client id, session id, and candidate id
   as one inseparable capability. Never reuse them for another assignment.
4. Use only the candidate file and `meta.call` methods exposed by Gear. Start
   with `harness.current`, `candidate.tree`, and `seed_tasks.load`; read the
   active candidate files before selecting an edit. Do not discover or modify
   Gear state, Git metadata, held-out data, credentials, or host paths directly.
5. Review the baseline summary. Query `trajectory.query` with `refs` for every
   failed baseline run before proposing a change. Use `nextOffset` for bounded
   pagination and stop once the causal evidence is sufficient. Keep cited
   evidence limited to references actually returned for the active seed
   baseline.
6. Connect the observed failure to a harness-controlled cause, select the
   affected semantic target, and make the smallest coherent change. New files
   must be connected from an existing preset, plugin, skill, or workflow entry;
   unreferenced files do not change Target Agent behavior.
7. Inspect `candidate.diff`, remove accidental or task-specific changes, and
   run `candidate.check` before finalizing. Use `candidate.decline` when the
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
- Never bypass a failed compiler check, evidence requirement, identity check,
  or promotion decision by editing state files.
