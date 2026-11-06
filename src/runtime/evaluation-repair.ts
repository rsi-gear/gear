import type { Evidence } from '../domain/algorithm-wire.js'
import { canonicalDigest } from '../domain/canonical.js'
import { evaluationRepairPolicy } from '../domain/evaluation.js'
import { GearError } from '../domain/errors.js'
import type { JournalOperation, RunJournal } from '../domain/run.js'

export function unavailableExecution(cell: Evidence): boolean {
  return cell.status === 'environment_failed' || cell.status === 'scoring_failed'
}

/** Recheck a saved retry before submitting: recovery cannot widen its original slot manifest. */
export function validateRepairReservation(journal: RunJournal, operation: JournalOperation): void {
  const request = operation.request,
    repair = request.repair
  if (!repair) return
  const previous = journal.operations.find((item) => item.request.operationId === repair.previousOperationId)
  const failed = previous?.receipt?.evidence.filter(unavailableExecution) ?? []
  const slots = failed.map((cell) => ({ taskId: cell.task_id, repetition: cell.repetition }))
  const expected = previous
    ? { ...previous.request.operation, task_ids: [...new Set(slots.map((slot) => slot.taskId))] }
    : null
  if (
    !previous ||
    previous.status !== 'complete' ||
    !slots.length ||
    repair.rootOperationId !== (previous.request.repair?.rootOperationId ?? previous.request.operationId) ||
    repair.attempt !== (previous.request.repair?.attempt ?? 0) + 1 ||
    repair.attempt > journal.spec.evaluationRepair.maxRetries ||
    request.runId !== journal.id ||
    request.partition !== previous.request.partition ||
    request.repetitions !== previous.request.repetitions ||
    canonicalDigest(request.metrics ?? null) !== canonicalDigest(previous.request.metrics ?? null) ||
    request.evidence.length !== 0 ||
    canonicalDigest(request.operation) !== canonicalDigest(expected) ||
    canonicalDigest(request.slots) !== canonicalDigest(slots) ||
    operation.reservedAttempts !== slots.length ||
    !Number.isSafeInteger(operation.notBefore) ||
    operation.notBefore! < 0 ||
    request.operationId !== canonicalDigest([journal.id, 'evaluation-repair', repair, slots])
  ) {
    throw new GearError(
      'invalid-repair-reservation',
      'Saved repair does not match its frozen source, attempt and slot manifest',
    )
  }
  mergeEvaluationEvidence(journal, operation, failed)
}

/** Reserve only explicit failed executions, never a valid zero or a missing metric on valid output. */
export function reserveRepairs(
  journal: RunJournal,
  remaining: number,
): {
  operations: JournalOperation[]
  changed: boolean
} {
  const policy = evaluationRepairPolicy(journal.spec.evaluationRepair)
  const operations: JournalOperation[] = []
  const superseded = new Set(
    journal.operations.flatMap((item) =>
      item.request.repair ? [item.request.repair.previousOperationId] : [],
    ),
  )
  let changed = false
  for (const previous of journal.operations) {
    if (
      previous.status !== 'complete' ||
      previous.request.operation.kind !== 'evaluate_seed' ||
      previous.repairBlocked ||
      superseded.has(previous.request.operationId)
    )
      continue
    const failed = previous.receipt!.evidence.filter(unavailableExecution)
    if (!failed.length) continue
    const attempt = (previous.request.repair?.attempt ?? 0) + 1
    const blocked =
      policy.maxRetries === 0
        ? 'retries-disabled'
        : attempt > policy.maxRetries
          ? 'attempts-exhausted'
          : failed.length > remaining
            ? 'budget-exhausted'
            : undefined
    if (blocked) {
      previous.repairBlocked = blocked
      changed = true
      continue
    }
    const repair = {
      rootOperationId: previous.request.repair?.rootOperationId ?? previous.request.operationId,
      previousOperationId: previous.request.operationId,
      attempt,
    }
    const slots = failed.map((cell) => ({ taskId: cell.task_id, repetition: cell.repetition }))
    const operation = {
      ...previous.request.operation,
      task_ids: [...new Set(slots.map((slot) => slot.taskId))],
    }
    operations.push({
      request: {
        ...structuredClone(previous.request),
        operation,
        slots,
        repair,
        generation: journal.generation,
        operationId: canonicalDigest([journal.id, 'evaluation-repair', repair, slots]),
      },
      status: 'reserved',
      reservedAttempts: slots.length,
      notBefore: Date.now() + policy.backoffMs[Math.min(attempt - 1, policy.backoffMs.length - 1)]!,
    })
    remaining -= slots.length
  }
  return { operations, changed: changed || operations.length > 0 }
}

/** The latest view may replace an unavailable slot only through its recorded repair chain. */
export function mergeEvaluationEvidence(
  journal: RunJournal,
  operation: JournalOperation,
  cells: Evidence[],
): Evidence[] {
  const request = operation.request
  const destination = request.partition === 'seed' ? journal.seedEvidence : journal.heldOutEvidence
  const next = [...destination]
  const previous = request.repair
    ? journal.operations.find((item) => item.request.operationId === request.repair!.previousOperationId)
    : undefined
  for (const cell of cells) {
    const index = next.findIndex(
      (item) =>
        item.candidate_id === cell.candidate_id &&
        item.task_id === cell.task_id &&
        item.repetition === cell.repetition,
    )
    if (index < 0) {
      if (request.repair)
        throw new GearError('invalid-evidence-repair', 'Repair cannot create an unobserved logical slot')
      next.push(cell)
      continue
    }
    const original = previous?.receipt?.evidence.find(
      (item) => item.task_id === cell.task_id && item.repetition === cell.repetition,
    )
    if (
      !request.repair ||
      previous?.status !== 'complete' ||
      previous.request.partition !== request.partition ||
      previous.request.operation.candidate_id !== request.operation.candidate_id ||
      !original ||
      !unavailableExecution(original) ||
      !unavailableExecution(next[index]!) ||
      canonicalDigest(original) !== canonicalDigest(next[index])
    ) {
      throw new GearError(
        'immutable-evidence-conflict',
        'A repair may only replace its own unavailable execution; valid evidence is immutable',
      )
    }
    next[index] = cell
  }
  return next
}
