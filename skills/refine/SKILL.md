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
   Translate optimization preferences into `control.start.objective.terms` and
   optional explicit constraints. For example, equal pass/process weights are
   two terms with weight 0.5; cost/token penalties use negative weights and fixed
   scales in their original units. Do not put a different objective only in the
   prompt, invent a metric, infer passes from positive rewards, or alter the
   objective during search. Omission means strict pass rate. Check the returned
   `resolvedObjective`; inspect available raw metrics if admission rejects a term.
3. Treat the returned lease id, token, session id, candidate id, and (for CLI
   clients) client id as one inseparable capability. Never reuse them for
   another assignment.
4. Use only the candidate file and `meta.call` methods exposed by Gear. The
   direct candidate methods are exactly `candidate.tree`, `candidate.read`,
   `candidate.write`, `candidate.edit`, and `candidate.remove`. Invoke
   `harness.current`, `harness.read`, `seed_tasks.load`, `trajectory.query`,
   `experience.query`, `experience.read`, `hitch.status`, `candidate.diff`,
   `candidate.check`, `candidate.finalize`, and `candidate.decline` only as
   `meta.call` capabilities; they are not top-level request methods. Read the
   active candidate files before selecting an edit. Do not discover or modify
   Gear state, Git metadata, held-out data, credentials, or host paths directly.
5. Review the assignment's optional `experienceContext`. It contains the
   actual paired seed result of the direct parent's last edit when available,
   plus only relevant bounded history cards. Treat rationale and expected
   outcome as the earlier proposer's claims; treat task reward changes as
   observations, not causal or statistically significant conclusions. Use
   `experience.query` and `experience.read` for focused history. Historical
   `experienceRef` values never belong in `evidenceRefs` and never satisfy the
   active baseline diagnosis requirement.
6. Review the baseline summary. Also read `baseline.rawMetrics` and
   `baseline.objectiveScore` when present:
   the raw scores, units and contributions explain the frozen objective. A
   successful but expensive task can still warrant an improvement. State which
   measured term the proposal is expected to improve and verify its explicit
   constraints. Never replace a missing metric with zero or change the weights.
   If the assignment contains `workplanDelivery`,
   consume its hypothesis, parent identity, sourced dossier excerpt, scope guards,
   generation budget, and seed-only findings first. Keep modifications within
   `workplan.modificationPaths` (paths relative to the harness root), or explicitly
   disclose the wider effect; a narrow scope does not qualify wider changes for
   promotion. The claimed assignment records `workplan-dossier-consumed`, not
   personal diagnosis of all parent failures. When
   `evidencePolicy.diagnoseEveryFailedRunBeforeProposal` is false, the full-failure
   reading loop below does not apply: read extra seed evidence only when needed,
   and use `candidate.check` to confirm finalization readiness. Do not request or
   use held-out promotion details to plan candidate changes.

   For assignments without a workplan, start with `trajectory.query` without arguments
   on every assignment: it restores validated diagnostics from earlier attempts
   of this candidate and returns their summaries plus current-session detail
   refs. If `diagnosisRecovery.remaining` is positive, repeat that query to
   receive the rest. Use `diagnosisProgress.remainingRunIds` to choose new reads.
   Recovery does not restore candidate edits; inspect the current tree. Changed
   baseline, trajectory, verifier, or sanitization policy requires reading the
   affected evidence again.
   `generationBudget` reports attempt/round deadlines and remaining time. Its
   finalization reserve is advisory time for editing, checking, and sealing; it
   does not extend the deadline. Reconnecting does not reset time. A
   `DIAGNOSIS_BUDGET_AT_RISK` warning means the observed pace may leave too little
   time for the remaining work; do not skip required diagnoses or assume that
   continuing an old evolution adopts new budget settings.
   Query `trajectory.query` with `refs` for every remaining
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
   Start with one diagnostic card and size later reads from its actual output.
   Process the evidence before fetching more; use targeted detail reads instead
   of accumulating transcripts that repeatedly force context compaction.
7. Identify an evidenced harness gap before choosing an intervention. A failed
   task or omitted check alone does not establish that gap. Use relevant
   accessible seed comparisons to test the explanation, including successful
   runs when useful. Choose the smallest supported mechanism from the editing
   guide, with an applicability boundary that transfers beyond the observed
   tasks. New files are allowed but must be wired into the existing load graph.
   Prompt changes, skills, hooks, and workflows need the same causal support;
   do not force any artifact type. An implementation mistake can still expose
   a reusable prevention or detection opportunity; existing guidance alone
   does not show that an effective procedure or check exists. Apply the editing
   guide's diagnosis before either choosing a prompt edit or declining.
   Record the evidence, mechanism choice,
   applicability, and main uncertainty in `rationale`, and an observable
   behavioral prediction in `expectedOutcome`.
8. Inspect `candidate.diff`, remove accidental or task-specific changes, and
   run `candidate.check` before finalizing and require
   `finalizationReadiness.ready: true`. Inspect each runtime stage: loading,
   prompt assembly and Skill reads cover different paths; they do not prove
   that arbitrary tool/hook bodies, routing, compaction or workflows executed.
   Record remaining behavior checks in the proposal. Use `candidate.decline` when the
   evidence does not justify a harness change or the required fix is outside
   the editable substrate.
9. After finalization, stop using that lease and poll status. Claim and complete
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
- For staged-search `searchPendingEvidence`, `control.search-repair` takes
  `evolutionId`, `roundId`, a stable `repairId`, and `evidenceDigest`. It repairs
  original invalid slots and resumes the same round; it is not a request for a
  new candidate or a new experiment. Leave held-out repair to the operator flow,
  and do not feed its results into a candidate lease.
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
