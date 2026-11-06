import type { RunJournal } from '../domain/run.js'
import { pythonObjective } from '../adapters/python/objective.js'
import { GearError } from '../domain/errors.js'
import { aggregateUsage } from '../domain/usage.js'
import { generationLedger } from '../runtime/generation-budget.js'
import { runPlan } from './run-plan.js'
export function runReport(journal: RunJournal) {
  if (journal.spec.objective && journal.spec.objectiveIdentity !== pythonObjective.identity)
    throw new GearError(
      'objective-identity-mismatch',
      'Frozen objective implementation changed; use the matching runtime',
    )
  const cells = [...journal.seedEvidence, ...journal.heldOutEvidence]
  const coverage = {
    logical_slots: cells.length,
    valid: cells.filter((cell) => cell.score !== null).length,
    valid_zero: cells.filter((cell) => cell.score === 0).length,
    invalid: cells.filter((cell) => cell.score === null).length,
    scoring_failed: cells.filter((cell) => cell.status === 'scoring_failed').length,
    environment_failed: cells.filter((cell) => cell.status === 'environment_failed').length,
    physical_attempts: journal.physicalAttempts,
    reserved_attempts: journal.operations
      .filter((operation) => operation.status !== 'complete')
      .reduce((sum, operation) => sum + operation.reservedAttempts, 0),
  }
  const score = (candidate: string, partition: 'seed' | 'held_out') => {
    const tasks =
      partition === 'seed' ? journal.spec.seedTasks.map((task) => task.id) : journal.spec.heldOutTaskIds
    const source = partition === 'seed' ? journal.seedEvidence : journal.heldOutEvidence
    return pythonObjective.project({
      evidence: source,
      task_ids: tasks,
      repetitions: journal.spec.budget.repetitions,
      candidate_id: candidate,
      anchor_id: journal.spec.anchor.id,
      partition,
      objective: journal.spec.objective ?? null,
    })
  }

  const usage = aggregateUsage(journal.operations)
  const generationViolation = journal.operations.some((operation) => operation.generationViolation)
  return {
    run_id: journal.id,
    status: journal.status,
    ...(journal.failure ? { error: journal.failure } : {}),
    validation_mode:
      journal.spec.validationMode === 'research' ? 'shared-set-research' : 'independent-held-out',
    warning: journal.spec.validationMode === 'research' ? '同集优化，未做独立验证' : null,
    initial: journal.spec.anchor.id,
    retained: journal.championId,
    nominee: journal.nomineeId,
    gate: journal.gate,
    lineage: journal.spec.lineage,
    ...(journal.spec.kind === 'refine' ? { plan: runPlan(journal.spec, journal.id) } : {}),
    baseline_reuse: journal.spec.baseline
      ? {
          source_run_id: journal.spec.baseline.sourceRunId,
          source_candidate_id: journal.spec.baseline.sourceCandidateId,
          proof_digest: journal.spec.baseline.sourceDigest,
          slots: journal.spec.baseline.evidence.map((cell) => ({
            task_id: cell.task_id,
            repetition: cell.repetition,
          })),
          historical_usage: {
            scope: 'source-candidate-seed-operations',
            physical_attempts: journal.spec.baseline.historicalPhysicalAttempts,
            usage: journal.spec.baseline.historicalUsage,
          },
          new_physical_attempts: 0,
        }
      : null,
    scores: {
      initial: {
        seed: score(journal.spec.anchor.id, 'seed'),
        held_out: score(journal.spec.anchor.id, 'held_out'),
      },
      retained: { seed: score(journal.championId, 'seed'), held_out: score(journal.championId, 'held_out') },
      nominee: journal.nomineeId
        ? { seed: score(journal.nomineeId, 'seed'), held_out: score(journal.nomineeId, 'held_out') }
        : null,
    },
    usage,
    generation_budget: {
      ...generationLedger(journal),
      violations: journal.operations
        .filter((operation) => operation.generationViolation)
        .map((operation) => ({
          operation_id: operation.request.operationId,
          reason: operation.generationViolation!.reason,
          usage: operation.generationViolation!.receipt.usage,
        })),
    },
    coverage,
    evidence_projections: {
      attempts: journal.operations.filter((operation) => operation.request.projection).length,
      operations: journal.operations
        .filter((operation) => operation.request.projection)
        .map((operation) => ({
          operation_id: operation.request.operationId,
          source_operation_id: operation.request.projection!.sourceOperationId,
          root_operation_id: operation.request.projection!.rootOperationId,
          attempt: operation.request.projection!.attempt,
          partition: operation.request.partition,
          missing: operation.request.projection!.missing,
          status: operation.status,
          not_before: operation.notBefore,
        })),
      blocked: journal.operations
        .filter((operation) => operation.projectionBlocked)
        .map((operation) => ({
          operation_id: operation.request.operationId,
          reason: operation.projectionBlocked,
        })),
    },
    evaluation_repairs: {
      attempts: journal.operations.filter((operation) => operation.request.repair).length,
      physical_attempts: journal.operations
        .filter((operation) => operation.request.repair)
        .reduce((sum, operation) => sum + (operation.receipt?.physicalAttempts ?? 0), 0),
      operations: journal.operations
        .filter((operation) => operation.request.repair)
        .map((operation) => ({
          operation_id: operation.request.operationId,
          root_operation_id: operation.request.repair!.rootOperationId,
          previous_operation_id: operation.request.repair!.previousOperationId,
          attempt: operation.request.repair!.attempt,
          partition: operation.request.partition,
          slots: operation.request.slots,
          status: operation.status,
          not_before: operation.notBefore,
        })),
      blocked: journal.operations
        .filter((operation) => operation.repairBlocked)
        .map((operation) => ({
          operation_id: operation.request.operationId,
          reason: operation.repairBlocked,
        })),
    },
    next_action: generationViolation
      ? journal.status === 'cancelled'
        ? 'Inspect provider metering before starting a new run with gear refine'
        : `gear cancel ${journal.id}; inspect provider metering before starting a new run`
      : journal.status === 'needs_recovery'
        ? `gear resume ${journal.id}`
        : journal.status === 'completed'
          ? `gear export ${journal.id}`
          : journal.status === 'cancelled'
            ? 'gear refine'
            : `gear report ${journal.id}`,
  }
}
