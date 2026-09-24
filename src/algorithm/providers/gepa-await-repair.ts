import type { CompletionEnvelope, OperationEnvelope, OperationProvider, ProviderInspection,
  ProviderManifest, ProviderSubmission } from '../contracts.js'
import { implementationClosureDigest } from '../data/identity.js'
import { jsonDigest } from '../schema.js'
import { digestJson } from '../../state/digest.js'
import { FileProviderRecordBackend, type ProviderRecordBackend } from '../runtime/persistence.js'
import { verifyDigest } from '../../search/contracts.js'
import { validateSearchSchema } from '../../search/schema.js'
import type { SearchJournal } from '../../search/store.js'
import type { Snapshot, StageEvaluationPlan, StageResult } from '../../search/types.js'

export type GepaAwaitRepairInput = { roundId: string; plan: StageEvaluationPlan;
  snapshots: [Snapshot, Snapshot]; originalResultRefs: [string, string]; currentResultDigests: [string, string] }
type RecordValue = { schemaVersion: 1; operationId: string; inputDigest: string;
  implementationDigest: string; stage: 'started' | 'cancelled-before-start' }

/** A read-only repair fence. The physical repair is an auxiliary operation in the same Campaign. */
export class GepaAwaitRepairProvider implements OperationProvider {
  private readonly records: ProviderRecordBackend
  private readonly manifest: ProviderManifest
  constructor(readonly journal: SearchJournal, root: string, records?: ProviderRecordBackend) {
    this.records = records ?? new FileProviderRecordBackend(root)
    this.manifest = { kind: 'gepa.await-repair',
    implementationDigest: implementationClosureDigest(['providers/gepa-await-repair'], {
      recordBackend: ('identityDigest' in this.records ? this.records.identityDigest : null) ?? null }),
    inputSchema: { type: 'object', required: ['roundId', 'plan', 'snapshots', 'originalResultRefs', 'currentResultDigests'],
      properties: { roundId: { type: 'string' }, plan: { type: 'any' },
        snapshots: { type: 'array', items: { type: 'any' } },
        originalResultRefs: { type: 'array', items: { type: 'string' } },
        currentResultDigests: { type: 'array', items: { type: 'string' } } }, additionalProperties: false },
    outputSchema: { type: 'object', required: ['revisions'], properties: {
      revisions: { type: 'array', items: { type: 'any' } } }, additionalProperties: false },
    meteredDimensions: [], execution: 'trusted-local', supportsInspect: true }
  }
  describe(): ProviderManifest { return structuredClone(this.manifest) }
  private async record(envelope: OperationEnvelope): Promise<RecordValue | null> {
    const value = await this.records.read<RecordValue>(this.manifest.kind, envelope.operationId)
    if (value && (value.schemaVersion !== 1 || value.operationId !== envelope.operationId
      || value.inputDigest !== envelope.inputDigest || value.implementationDigest !== envelope.implementationDigest
      || !['started', 'cancelled-before-start'].includes(value.stage)))
      throw new Error('GEPA repair fence record drift')
    return value ?? null
  }
  private async create(envelope: OperationEnvelope, stage: RecordValue['stage']): Promise<RecordValue> {
    const value: RecordValue = { schemaVersion: 1, operationId: envelope.operationId,
      inputDigest: envelope.inputDigest, implementationDigest: envelope.implementationDigest, stage }
    await this.records.create(this.manifest.kind, envelope.operationId, value)
    return (await this.record(envelope))!
  }
  private async revision(ref: string, originalRef: string, plan: StageEvaluationPlan,
    snapshot: Snapshot): Promise<StageResult> {
    const result = await this.journal.object<StageResult>(ref)
    verifyDigest(result); validateSearchSchema('StageResult', result)
    if (result.digest !== ref || result.stagePlanDigest !== plan.digest
      || result.snapshotDigest !== snapshot.digest || !result.settled)
      throw new Error('GEPA repair revision changed its plan or snapshot')
    let previousRef = result.digest === originalRef ? originalRef : result.supersedesEvidenceDigest
    const visited = new Set([result.digest])
    while (previousRef !== originalRef) {
      if (!previousRef || visited.has(previousRef)) throw new Error('GEPA repair revision chain is broken')
      visited.add(previousRef)
      const previous = await this.journal.object<StageResult>(previousRef)
      verifyDigest(previous); validateSearchSchema('StageResult', previous)
      if (previous.digest !== previousRef || previous.stagePlanDigest !== plan.digest
        || previous.snapshotDigest !== snapshot.digest || !previous.settled)
        throw new Error('GEPA repair revision chain changed its plan or snapshot')
      previousRef = previous.supersedesEvidenceDigest
    }
    return result
  }
  private async input(envelope: OperationEnvelope): Promise<GepaAwaitRepairInput> {
    if (envelope.kind !== this.manifest.kind || envelope.implementationDigest !== this.manifest.implementationDigest
      || envelope.inputDigest !== jsonDigest(envelope.input) || envelope.operationId !== envelope.idempotencyKey
      || Object.keys(envelope.limits).length) throw new Error('GEPA repair fence identity changed')
    const input = envelope.input as unknown as GepaAwaitRepairInput
    if (!input || typeof input.roundId !== 'string' || !input.roundId
      || !Array.isArray(input.snapshots) || input.snapshots.length !== 2
      || !Array.isArray(input.originalResultRefs) || input.originalResultRefs.length !== 2
      || !Array.isArray(input.currentResultDigests) || input.currentResultDigests.length !== 2)
      throw new Error('GEPA repair fence input invalid')
    verifyDigest(input.plan)
    if (input.plan.stage !== 'held-out' || input.plan.partition !== 'held-out')
      throw new Error('GEPA repair fence requires a held-out plan')
    for (let index = 0; index < 2; index++) {
      const snapshot = input.snapshots[index]!, original = input.originalResultRefs[index]!
      verifyDigest(snapshot)
      await this.revision(original, original, input.plan, snapshot)
      await this.revision(input.currentResultDigests[index]!, original, input.plan, snapshot)
    }
    return input
  }
  async preflight(envelope: OperationEnvelope): Promise<void> { await this.input(envelope) }
  private async completion(envelope: OperationEnvelope, input: GepaAwaitRepairInput): Promise<CompletionEnvelope | null> {
    const pending = await this.journal.read<{ planDigest: string; resultRefs: string[] }>(`rounds/${input.roundId}/pending-evidence`)
    if (!pending) return null
    if (pending.planDigest !== input.plan.digest
      || jsonDigest(pending.resultRefs) !== jsonDigest(input.currentResultDigests))
      throw new Error('GEPA pending evidence fence changed')
    const active = await this.journal.read<{ id: string }>(`rounds/${input.roundId}/active-repair`)
    if (active && !await this.journal.read(`rounds/${input.roundId}/repair-result-${digestJson(active.id).slice(7)}`))
      return null
    const revisions: Array<{ originalRef: string; result: StageResult }> = []
    let changed = false
    for (let index = 0; index < 2; index++) {
      const originalRef = input.originalResultRefs[index]!, snapshot = input.snapshots[index]!
      const pointer = await this.journal.read<{ ref: string }>(`rounds/${input.roundId}/repair-${originalRef.slice(7)}`)
      const ref = pointer?.ref ?? originalRef
      const result = await this.revision(ref, originalRef, input.plan, snapshot)
      if (result.digest !== input.currentResultDigests[index]) changed = true
      revisions.push({ originalRef, result })
    }
    return changed ? { operationId: envelope.operationId, idempotencyKey: envelope.idempotencyKey,
      inputDigest: envelope.inputDigest, implementationDigest: envelope.implementationDigest,
      outcome: { kind: 'result', value: { revisions } as unknown as import('../schema.js').JsonValue } } : null
  }
  async inspect(envelope: OperationEnvelope): Promise<ProviderInspection> {
    const input = await this.input(envelope)
    const record = await this.record(envelope)
    if (record?.stage === 'cancelled-before-start') return { status: 'cancelled', releaseConfirmed: true }
    if (!record) return { status: 'not-started' }
    const complete = await this.completion(envelope, input)
    if (complete) return { status: 'completed', completion: complete }
    return await this.journal.read(`rounds/${input.roundId}/pending-evidence`)
      ? { status: 'running' } : { status: 'not-started' }
  }
  async submit(envelope: OperationEnvelope): Promise<ProviderSubmission> {
    const input = await this.input(envelope)
    const record = await this.create(envelope, 'started')
    if (record.stage === 'cancelled-before-start')
      throw new Error('Cancelled GEPA repair fence cannot publish pending evidence')
    const key = `rounds/${input.roundId}/pending-evidence`
    const value = { planDigest: input.plan.digest, resultRefs: input.currentResultDigests }
    const previous = await this.journal.read<typeof value>(key)
    if (previous && previous.planDigest !== input.plan.digest)
      throw new Error('GEPA pending evidence plan changed')
    if (!previous || jsonDigest(previous) !== jsonDigest(value)) await this.journal.write(key, value)
    const complete = await this.completion(envelope, input)
    return complete ? { status: 'completed', completion: complete } : { status: 'running' }
  }
  async cancel(envelope: OperationEnvelope): Promise<ProviderInspection> {
    await this.input(envelope)
    const record = await this.create(envelope, 'cancelled-before-start')
    return record.stage === 'cancelled-before-start'
      ? { status: 'cancelled', releaseConfirmed: true } : { status: 'unknown' }
  }
  async collect(envelope: OperationEnvelope): Promise<CompletionEnvelope> {
    const observed = await this.inspect(envelope)
    if (observed.status !== 'completed') throw new Error('GEPA repair evidence is unresolved')
    return observed.completion
  }
}
