import type { RunJournal } from './run.js'
import type { Json } from './algorithm-wire.js'
import { canonicalDigest } from './canonical.js'
import { GearError } from './errors.js'
import { operatorHistory } from './operator-artifacts.js'

export type ResearchKind =
  'conditions' | 'candidate' | 'evidence' | 'operation' | 'decision' | 'operator-call' | 'artifact' | 'event'
export interface ResearchObject {
  version: 1
  kind: ResearchKind
  value: Json
  digest: string
}
export interface ResearchArchive {
  version: 1
  run_id: string
  partition: 'seed'
  objects: Array<{ kind: ResearchKind; digest: string }>
  packs: string[]
  digest: string
}
export interface ResearchPack {
  version: 1
  objects: ResearchObject[]
  digest: string
}

/** Protocol projection only. Rankings and parent distributions are the Python policy's records. */
export function researchArchive(journal: RunJournal): {
  archive: ResearchArchive
  objects: ResearchObject[]
  packs: ResearchPack[]
} {
  const { spec } = journal
  const blind = spec.operatorPolicy?.access?.exposure === 'blind'
  const order = spec.operatorPolicy?.access?.task_order
  const visible = order ? new Set(order.slice(0, (journal.operators?.stream?.index ?? 0) + 1)) : null
  const tasks = new Set(spec.seedTasks.map((task) => task.id)),
    candidates = new Set(journal.candidates.map((candidate) => candidate.id))
  const objects: ResearchObject[] = []
  const add = (kind: ResearchKind, value: unknown): void => {
    const body = { version: 1 as const, kind, value: value as Json }
    objects.push({ ...body, digest: canonicalDigest(body) })
  }
  const validateEvidence = (
    evidence: typeof journal.seedEvidence,
    slots?: Array<{ taskId: string; repetition: number }>,
  ) => {
    if (
      evidence.some(
        (cell) =>
          !tasks.has(cell.task_id) ||
          !candidates.has(cell.candidate_id) ||
          !Number.isSafeInteger(cell.repetition) ||
          cell.repetition < 0 ||
          (slots
            ? !slots.some((slot) => slot.taskId === cell.task_id && slot.repetition === cell.repetition)
            : cell.repetition >= spec.budget.repetitions),
      )
    )
      throw new GearError('research-outside-seed', 'Research evidence must belong to admitted seed slots')
  }
  const objective = spec.objective
    ? {
        ...spec.objective,
        protection: spec.objective.protection.filter((rule) => rule.partition === 'seed'),
        ...(spec.objective.assertion_protection
          ? {
              assertion_protection: spec.objective.assertion_protection.filter(
                (rule) => rule.partition === 'seed',
              ),
            }
          : {}),
      }
    : null
  add('conditions', {
    run_id: journal.id,
    benchmark_digest: spec.benchmarkDigest,
    evaluation_identity: spec.evaluationIdentity ?? spec.providerIdentity,
    algorithm: spec.algorithm,
    algorithm_identity: spec.implementationIdentity,
    config_digest: spec.configDigest,
    budget: spec.budget,
    generation_budget: spec.generationBudget ?? null,
    objective: blind ? null : objective,
    objective_identity: spec.objectiveIdentity ?? null,
    tasks: spec.seedTasks.filter((task) => !visible || visible.has(task.id)),
    repetitions: spec.budget.repetitions,
    anchor: spec.anchor,
    seed: spec.seed,
    lineage: spec.lineage,
    baseline_source_digest: spec.baseline?.sourceDigest ?? null,
  })
  for (const candidate of journal.candidates) add('candidate', candidate)
  validateEvidence(journal.seedEvidence)
  if (!blind) for (const evidence of journal.seedEvidence) add('evidence', evidence)
  for (const entry of journal.operations) {
    if (entry.request.partition !== 'seed') continue
    const { request, receipt } = entry
    if (
      request.operation.task_ids.some((id) => !tasks.has(id)) ||
      request.slots.some((slot) => !tasks.has(slot.taskId))
    )
      throw new GearError('research-outside-seed', 'Research operations must belong to admitted seed tasks')
    if (receipt) validateEvidence(receipt.evidence ?? [], request.operatorSamples ? request.slots : undefined)
    add('operation', {
      operation_id: request.operationId,
      operation: request.operation,
      slots: request.slots,
      status: entry.status,
      reserved_attempts: entry.reservedAttempts,
      receipt: blind ? (receipt ? { physical_attempts: receipt.physicalAttempts } : null) : (receipt ?? null),
      // Rejected metering receipts have not passed seed-slot admission. Preserve
      // their identity here; their original bytes remain in the operator journal.
      generation_violation:
        !blind && entry.generationViolation
          ? {
              reason: entry.generationViolation.reason,
              receipt_digest: canonicalDigest(entry.generationViolation.receipt),
            }
          : null,
      repair: request.repair ?? null,
      projection: request.projection ?? null,
    })
  }
  for (const entry of journal.decisions) {
    for (const record of entry.decision.research ?? [])
      if (
        record.task_ids.some((id) => !tasks.has(id)) ||
        record.candidate_ids.some((id) => !candidates.has(id))
      )
        throw new GearError('research-outside-seed', 'Research records refer outside the seed cohort')
    add('decision', {
      step_id: entry.stepId,
      input_digest: entry.inputDigest,
      decision_digest: canonicalDigest(entry.decision),
      operation_ids: entry.operationIds,
      operations: entry.decision.operations,
      reason: entry.decision.reason,
      records: entry.decision.research ?? [],
      record_authority: 'algorithm-reported',
    })
  }
  if (journal.operators) {
    for (const entry of journal.operators.decisions)
      add('decision', {
        protocol_version: 2,
        step_id: entry.stepId,
        input_digest: entry.inputDigest,
        decision_digest: canonicalDigest(entry.decision),
        call_ids: entry.callIds,
        reason: entry.decision.reason,
        records: entry.decision.records,
        terminal: entry.decision.terminal,
        record_authority: 'algorithm-reported',
      })
    for (const entry of journal.operators.calls)
      add('operator-call', {
        id: entry.id,
        call: entry.call,
        request_digest: entry.requestDigest,
        status: entry.status,
        sample_ids: entry.sampleIds ?? [],
        operation_ids: entry.operationIds,
        result: entry.result ?? null,
        screening: entry.screening ?? null,
      })
    for (const artifact of journal.operators.artifacts) {
      if (artifact.ref.kind === 'history') continue
      add('artifact', { ref: artifact.ref, value: artifact.value, sources: artifact.sources })
    }
    const history = operatorHistory(journal).value as { events: Json[] }
    for (const event of history.events) add('event', event)
  }
  // Pack independent objects to avoid a separate fsync/inode for every trial or
  // decision. Fixed per-kind order preserves old packs as other kinds grow.
  const packs: ResearchPack[] = []
  for (const kind of [
    'conditions',
    'candidate',
    'evidence',
    'operation',
    'decision',
    'operator-call',
    'artifact',
    'event',
  ] as const) {
    let pending: ResearchObject[] = [],
      bytes = 0
    const flush = () => {
      if (!pending.length) return
      const body = { version: 1 as const, objects: pending }
      packs.push({ ...body, digest: canonicalDigest(body) })
      pending = []
      bytes = 0
    }
    for (const object of objects.filter((item) => item.kind === kind)) {
      const size = Buffer.byteLength(JSON.stringify(object))
      if (pending.length && (pending.length === 128 || bytes + size > 4 * 1024 * 1024)) flush()
      pending.push(object)
      bytes += size
    }
    flush()
  }
  const body = {
    version: 1 as const,
    run_id: journal.id,
    partition: 'seed' as const,
    objects: objects.map(({ kind, digest }) => ({ kind, digest })),
    packs: packs.map((pack) => pack.digest),
  }
  return { archive: { ...body, digest: canonicalDigest(body) }, objects, packs }
}
