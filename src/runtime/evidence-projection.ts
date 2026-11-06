import type { Evidence } from '../domain/algorithm-wire.js'
import { canonicalDigest } from '../domain/canonical.js'
import { GearError } from '../domain/errors.js'
import type { JournalOperation, RunJournal } from '../domain/run.js'
import type { OperationProvider, OperationRequest, OperationReceipt } from '../ports/operations.js'

const key = (partition: string, cell: Evidence) =>
  JSON.stringify([partition, cell.candidate_id, cell.task_id, cell.repetition])
function missingMetrics(journal: RunJournal, partition: 'seed' | 'held_out', cell: Evidence): string[] {
  const objective = journal.spec.objective
  if (!objective || !['valid', 'task_failed'].includes(cell.status)) return []
  return [
    ...new Set([
      ...objective.definition.terms.filter((term) => term.weight !== 0).map((term) => term.metric),
      ...objective.definition.constraints.map((rule) => rule.metric),
      ...objective.protection
        .filter((rule) => rule.partition === partition && rule.task_id === cell.task_id)
        .map((rule) => rule.metric),
    ]),
  ]
    .filter((id) => cell.raw_metrics?.[id]?.status !== 'available')
    .sort()
}

function missingAssertions(journal: RunJournal, partition: 'seed' | 'held_out', cell: Evidence): string[] {
  if (!['valid', 'task_failed'].includes(cell.status)) return []
  return [
    ...new Set(
      (journal.spec.objective?.assertion_protection ?? [])
        .filter((rule) => rule.partition === partition && rule.task_id === cell.task_id)
        .map((rule) => rule.assertion_id),
    ),
  ]
    .filter(
      (id) =>
        !['passed', 'failed', 'excluded'].includes(
          cell.assertions?.find((value) => value.id === id)?.status ?? 'missing',
        ),
    )
    .sort()
}
function projectionAssertions(journal: RunJournal, partition: 'seed' | 'held_out', cell: Evidence): string[] {
  return missingAssertions(journal, partition, cell).filter(
    (id) => cell.assertions?.find((value) => value.id === id)?.status !== 'unsupported',
  )
}

/** Choose the latest exact source for each unresolved slot, including unchanged projection receipts. */
export function reserveProjections(
  journal: RunJournal,
  provider: OperationProvider,
): { operations: JournalOperation[]; changed: boolean } {
  const operations: JournalOperation[] = [],
    visited = new Set<string>()
  let changed = false
  for (const source of [...journal.operations].reverse()) {
    if (source.status !== 'complete' || source.request.operation.kind !== 'evaluate_seed') continue
    const destination = source.request.partition === 'seed' ? journal.seedEvidence : journal.heldOutEvidence
    const eligible = source.receipt!.evidence.filter((cell) => {
      const id = key(source.request.partition, cell)
      if (
        visited.has(id) ||
        !destination.some(
          (value) =>
            key(source.request.partition, value) === id && canonicalDigest(value) === canonicalDigest(cell),
        )
      )
        return false
      visited.add(id)
      return (
        missingMetrics(journal, source.request.partition, cell).length > 0 ||
        missingAssertions(journal, source.request.partition, cell).length > 0
      )
    })
    if (!eligible.length || source.projectionBlocked) continue
    const missing = eligible
      .map((cell) => ({
        taskId: cell.task_id,
        repetition: cell.repetition,
        assertions: projectionAssertions(journal, source.request.partition, cell),
        metrics: missingMetrics(journal, source.request.partition, cell).filter(
          (id) => cell.raw_metrics?.[id]?.status !== 'unsupported',
        ),
      }))
      .filter((slot) => slot.metrics.length || slot.assertions.length)
    const attempt = (source.request.projection?.attempt ?? 0) + 1
    const policy = journal.spec.evaluationRepair
    const blocked =
      !provider.capabilities.evidenceProjection || !provider.completeEvidence
        ? 'provider-unsupported'
        : !policy.maxProjections
          ? 'projections-disabled'
          : !missing.length
            ? eligible.some((cell) => missingAssertions(journal, source.request.partition, cell).length)
              ? 'assertion-unsupported'
              : 'metric-unsupported'
            : attempt > policy.maxProjections
              ? 'attempts-exhausted'
              : undefined
    if (blocked) {
      source.projectionBlocked = blocked
      changed = true
      continue
    }
    const rootOperationId = source.request.projection?.rootOperationId ?? source.request.operationId
    const root = journal.operations.find((item) => item.request.operationId === rootOperationId)!
    const projection = {
      rootOperationId,
      rootRequestDigest: canonicalDigest(root.request),
      rootProvenanceDigest: canonicalDigest(root.receipt!.provenance),
      sourceOperationId: source.request.operationId,
      sourceReceiptDigest: canonicalDigest(source.receipt),
      attempt,
      missing,
    }
    const slots = missing.map(({ taskId, repetition }) => ({ taskId, repetition }))
    const { repair: _repair, projection: _projection, ...original } = structuredClone(source.request)
    operations.push({
      request: {
        ...original,
        generation: journal.generation,
        projection,
        slots,
        operation: { ...original.operation, task_ids: [...new Set(slots.map((slot) => slot.taskId))] },
        evidence: structuredClone(
          eligible.filter((cell) =>
            slots.some((slot) => slot.taskId === cell.task_id && slot.repetition === cell.repetition),
          ),
        ),
        operationId: canonicalDigest([journal.id, 'evidence-projection', projection, slots]),
      },
      reservedAttempts: 0,
      status: 'reserved',
      notBefore: Date.now() + policy.backoffMs[Math.min(attempt - 1, policy.backoffMs.length - 1)]!,
    })
  }
  return { operations, changed: changed || operations.length > 0 }
}

export function validateProjectionReservation(journal: RunJournal, operation: JournalOperation): void {
  const request = operation.request,
    projection = request.projection
  if (!projection) return
  const source = journal.operations.find((item) => item.request.operationId === projection.sourceOperationId)
  const root = journal.operations.find((item) => item.request.operationId === projection.rootOperationId)
  const slots = projection.missing.map(({ taskId, repetition }) => ({ taskId, repetition }))
  const sourceCells =
    source?.receipt?.evidence.filter((cell) =>
      slots.some((slot) => slot.taskId === cell.task_id && slot.repetition === cell.repetition),
    ) ?? []
  const expected = source
    ? { ...source.request.operation, task_ids: [...new Set(slots.map((slot) => slot.taskId))] }
    : null
  if (
    !source ||
    source.status !== 'complete' ||
    !root ||
    root.status !== 'complete' ||
    root.request.projection ||
    request.repair ||
    request.runId !== journal.id ||
    request.operation.kind !== 'evaluate_seed' ||
    request.partition !== source.request.partition ||
    request.repetitions !== source.request.repetitions ||
    projection.rootOperationId !==
      (source.request.projection?.rootOperationId ?? source.request.operationId) ||
    projection.rootRequestDigest !== canonicalDigest(root.request) ||
    projection.rootProvenanceDigest !== canonicalDigest(root.receipt!.provenance) ||
    projection.sourceReceiptDigest !== canonicalDigest(source.receipt) ||
    projection.attempt !== (source.request.projection?.attempt ?? 0) + 1 ||
    projection.attempt > journal.spec.evaluationRepair.maxProjections ||
    !slots.length ||
    sourceCells.length !== slots.length ||
    operation.reservedAttempts !== 0 ||
    !Number.isSafeInteger(operation.notBefore) ||
    operation.notBefore! < 0 ||
    canonicalDigest(request.operation) !== canonicalDigest(expected) ||
    canonicalDigest(request.slots) !== canonicalDigest(slots) ||
    canonicalDigest(request.metrics ?? null) !== canonicalDigest(root.request.metrics ?? null) ||
    canonicalDigest(request.assertions ?? null) !== canonicalDigest(root.request.assertions ?? null) ||
    canonicalDigest(request.evidence) !== canonicalDigest(sourceCells) ||
    projection.missing.some((slot) => {
      const cell = sourceCells.find(
        (value) => value.task_id === slot.taskId && value.repetition === slot.repetition,
      )
      return (
        !cell ||
        canonicalDigest(slot.assertions ?? []) !==
          canonicalDigest(projectionAssertions(journal, request.partition, cell)) ||
        canonicalDigest(slot.metrics) !==
          canonicalDigest(
            missingMetrics(journal, request.partition, cell).filter(
              (id) => cell.raw_metrics?.[id]?.status !== 'unsupported',
            ),
          )
      )
    }) ||
    request.operationId !== canonicalDigest([journal.id, 'evidence-projection', projection, slots])
  ) {
    throw new GearError(
      'invalid-projection-reservation',
      'Saved projection changed its source evidence, frozen contracts or missing channels',
    )
  }
  mergeProjectedEvidence(journal, request, request.evidence)
}

export function validateProjectionReceipt(request: OperationRequest, receipt: OperationReceipt): void {
  if (!request.projection) return
  if (
    receipt.physicalAttempts !== 0 ||
    receipt.usage.model_requests !== 0 ||
    Object.values(receipt.usage).some((value) => value !== 0)
  )
    throw new GearError(
      'projection-execution-forbidden',
      'Original-artifact projection cannot execute targets or issue model requests',
    )
  for (const cell of receipt.evidence) {
    const original = request.evidence.find(
      (value) => value.task_id === cell.task_id && value.repetition === cell.repetition,
    )
    if (!original) throw new GearError('invalid-projection-slot', 'Projection returned an unrequested slot')
    const { raw_metrics: before, assertions: beforeAssertions, ...originalOutcome } = original
    const { raw_metrics: after, assertions: afterAssertions, ...outcome } = cell
    const metrics = request.projection.missing.find(
      (slot) => slot.taskId === cell.task_id && slot.repetition === cell.repetition,
    )!.metrics
    const assertions =
      request.projection.missing.find(
        (slot) => slot.taskId === cell.task_id && slot.repetition === cell.repetition,
      )!.assertions ?? []
    if (
      (beforeAssertions ?? []).some((value) => !afterAssertions?.some((item) => item.id === value.id)) ||
      (afterAssertions ?? []).some(
        (value) =>
          !assertions.includes(value.id) &&
          canonicalDigest(value) !==
            canonicalDigest(beforeAssertions?.find((item) => item.id === value.id) ?? null),
      ) ||
      canonicalDigest(originalOutcome) !== canonicalDigest(outcome) ||
      Object.keys(before ?? {}).some((id) => !Object.hasOwn(after ?? {}, id)) ||
      Object.entries(after ?? {}).some(
        ([id, metric]) =>
          !metrics.includes(id) && canonicalDigest(metric) !== canonicalDigest(before?.[id] ?? null),
      )
    )
      throw new GearError(
        'immutable-projection-evidence',
        'Projection may only fill requested unavailable channels; outcomes and existing channels are immutable',
      )
  }
}

export function mergeProjectedEvidence(
  journal: RunJournal,
  request: OperationRequest,
  cells: Evidence[],
): Evidence[] {
  const destination = request.partition === 'seed' ? journal.seedEvidence : journal.heldOutEvidence
  const next = [...destination]
  for (const cell of cells) {
    const original = request.evidence.find(
      (value) => key(request.partition, value) === key(request.partition, cell),
    )
    const index = next.findIndex((value) => key(request.partition, value) === key(request.partition, cell))
    if (!original || index < 0 || canonicalDigest(next[index]) !== canonicalDigest(original))
      throw new GearError(
        'projection-source-changed',
        'Projection cannot replace a different or already updated source observation',
      )
    next[index] = cell
  }
  return next
}
