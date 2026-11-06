import type { RunSpec } from '../domain/run.js'
import { GearError } from '../domain/errors.js'
import { canonicalDigest } from '../domain/canonical.js'

function slots(tasks: number, repetitions: number, copies = 1): number {
  const count = BigInt(tasks) * BigInt(repetitions) * BigInt(copies)
  if (count > BigInt(Number.MAX_SAFE_INTEGER))
    throw new GearError('plan-slots-overflow', 'Task repetitions exceed the supported slot range', {
      next_action: 'Reduce repetitions or the task scope before starting a run',
    })
  return Number(count)
}

function taskTimeoutGroups(spec: RunSpec) {
  const groups: Array<{
    partition: 'seed' | 'held_out'
    count: number
    deadlines: NonNullable<RunSpec['taskTimeouts']>[string] | null
  }> = []
  for (const partition of ['seed', 'held_out'] as const) {
    const ids = partition === 'seed' ? spec.seedTasks.map((task) => task.id) : spec.heldOutTaskIds
    const byDigest = new Map<string, (typeof groups)[number]>()
    for (const id of ids) {
      const deadlines = spec.taskTimeouts?.[id] ?? null
      const key = canonicalDigest(deadlines)
      const group = byDigest.get(key)
      if (group) group.count++
      else byDigest.set(key, { partition, count: 1, deadlines })
    }
    groups.push(
      ...[...byDigest]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([, group]) => group),
    )
  }
  return groups
}

/** Operator-only projection. It contains no task instructions, verifier answers or credentials. */
export function runPlan(spec: RunSpec, runId: string | null = null) {
  const seedSlots = slots(spec.seedTasks.length, spec.budget.repetitions)
  const reusable = spec.baseline?.evidence.length ?? 0
  const baselineNew = seedSlots - reusable
  const gateSlots =
    spec.validationMode === 'holdout' ? slots(spec.heldOutTaskIds.length, spec.budget.repetitions, 2) : 0
  const maximum = spec.budget.maxEvaluations
  const body = {
    version: 1 as const,
    state: runId === null ? ('preview' as const) : ('admitted' as const),
    run_id: runId,
    kind: spec.kind,
    benchmark_digest: spec.benchmarkDigest,
    target_digest: spec.anchor.digest,
    evaluation_identity: spec.evaluationIdentity ?? spec.providerIdentity,
    provider_identity: spec.providerIdentity,
    algorithm: spec.algorithm,
    validation_mode: spec.validationMode === 'holdout' ? 'independent-held-out' : 'shared-set-research',
    tasks: { seed: spec.seedTasks.map((task) => task.id), held_out_count: spec.heldOutTaskIds.length },
    repetitions: spec.budget.repetitions,
    baseline: {
      logical_slots: seedSlots,
      reusable_slots: reusable,
      new_physical_trials: baselineNew,
      source: spec.baseline
        ? {
            run_id: spec.baseline.sourceRunId,
            candidate_id: spec.baseline.sourceCandidateId,
            journal_digest: spec.baseline.sourceJournalDigest,
            proof_digest: spec.baseline.sourceDigest,
          }
        : null,
      historical_usage: spec.baseline
        ? {
            scope: 'source-candidate-seed-operations',
            physical_attempts: spec.baseline.historicalPhysicalAttempts,
            usage: spec.baseline.historicalUsage,
          }
        : null,
    },
    final_gate: {
      physical_trials_for_anchor_and_nominee: gateSlots,
      affordable_after_baseline: baselineNew <= maximum && gateSlots <= maximum - baselineNew,
    },
    limits: {
      rounds: spec.budget.rounds,
      new_candidates: spec.budget.maxCandidates,
      physical_trial_attempts: maximum,
      includes: ['baseline', 'candidates', 'final-gate', 'execution-repairs'],
      generation: spec.generationBudget,
      dollar_hard_limit: {
        configured: false,
        supported: spec.providerCapabilities?.hardDollarBudget ?? false,
      },
      timeouts: {
        provider: spec.providerTimeouts ?? null,
        task_declarations: { unit: 'seconds', runtime: 'harbor', groups: taskTimeoutGroups(spec) },
        run_deadline_configured: false,
        note: 'Provider-call deadlines bound waiting, not confirmed termination. Null task fields use runtime defaults; unreported limits are not unlimited.',
      },
    },
    capabilities: spec.providerCapabilities ?? null,
    checks: {
      benchmark: 'passed',
      target_resources: 'passed',
      provider_handshake: 'passed',
      model_access: 'not_checked',
      algorithm_execution: 'not_run',
    },
    ready_for_submission: baselineNew <= maximum,
    warnings: [
      ...(spec.validationMode === 'research' ? ['shared-set-research-no-independent-validation'] : []),
      ...(baselineNew > maximum ? ['baseline-unaffordable'] : []),
      ...(baselineNew <= maximum && gateSlots > maximum - baselineNew
        ? ['final-gate-unaffordable-after-baseline']
        : []),
    ],
    next_action:
      baselineNew > maximum
        ? `Increase budget.max_evaluations to at least ${baselineNew} for the missing baseline slots`
        : runId === null
          ? 'gear refine'
          : `gear resume ${runId}`,
  }
  return { ...body, digest: canonicalDigest(body) }
}
export type RunPlan = ReturnType<typeof runPlan>

export function requireAffordableBaseline(spec: RunSpec): void {
  const plan = runPlan(spec)
  if (!plan.ready_for_submission)
    throw new GearError(
      'budget-baseline-unaffordable',
      `Baseline requires ${plan.baseline.new_physical_trials} new physical trials after verified reuse`,
      { next_action: plan.next_action },
    )
}
