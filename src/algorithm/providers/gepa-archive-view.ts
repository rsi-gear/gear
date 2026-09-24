import { FileArtifactStore } from '../artifacts.js'
import type { ArtifactRef, CompletionEnvelope, OperationEnvelope, OperationProvider, ProviderInspection,
  ProviderManifest, ProviderSubmission } from '../contracts.js'
import { implementationClosureDigest } from '../data/identity.js'
import { ProviderReconcileError } from '../provider-errors.js'
import { FileProviderRecordBackend, type ArtifactCheckpoint, type ProviderRecordBackend } from '../runtime/persistence.js'
import { jsonDigest } from '../schema.js'
import { digestJson } from '../../state/digest.js'
import { safeId, seal, verifyDigest } from '../../search/contracts.js'
import { validateSearchSchema } from '../../search/schema.js'
import type { SearchJournal } from '../../search/store.js'
import type { ResearchArchive } from '../../search/types.js'

export type GepaArchiveViewInput = { roundId: string; baseArchiveRef: ArtifactRef;
  parentArchiveRef: ArtifactRef; completionRefs: string[]; publishParentView: boolean }
type RecordValue = { schemaVersion: 1; operationId: string; inputDigest: string; implementationDigest: string;
  stage: 'intent' | 'complete' | 'cancelled-before-start'; completion?: CompletionEnvelope }

/** Checkpoints the old archive-base/completion selection before parent sampling. */
export class GepaArchiveViewProvider implements OperationProvider {
  private readonly records: ProviderRecordBackend
  private readonly manifest: ProviderManifest
  constructor(root: string, readonly artifacts: FileArtifactStore, readonly journal: SearchJournal,
    records?: ProviderRecordBackend) {
    this.records = records ?? new FileProviderRecordBackend(root)
    this.manifest = { kind: 'gepa.archive-view',
      implementationDigest: implementationClosureDigest(['providers/gepa-archive-view'], {
        recordBackend: ('identityDigest' in this.records ? this.records.identityDigest : null) ?? null }),
      inputSchema: { type: 'object', required: ['roundId', 'baseArchiveRef', 'parentArchiveRef',
        'completionRefs', 'publishParentView'], properties: { roundId: { type: 'string' },
        baseArchiveRef: { type: 'any' }, parentArchiveRef: { type: 'any' },
        completionRefs: { type: 'array', items: { type: 'string' } }, publishParentView: { type: 'boolean' } },
      additionalProperties: false }, outputSchema: { type: 'object', required: ['parentArchiveRef'],
        properties: { parentArchiveRef: { type: 'any' } }, additionalProperties: false },
      meteredDimensions: [], execution: 'trusted-local', supportsInspect: true,
      supportsIdempotentReplay: true }
  }
  describe(): ProviderManifest { return structuredClone(this.manifest) }
  private input(envelope: OperationEnvelope): { value: GepaArchiveViewInput; base: ResearchArchive; parent: ResearchArchive } {
    if (envelope.kind !== this.manifest.kind || envelope.implementationDigest !== this.manifest.implementationDigest
      || envelope.inputDigest !== jsonDigest(envelope.input) || envelope.operationId !== envelope.idempotencyKey
      || Object.keys(envelope.limits).length) throw new Error('GEPA archive view identity drift')
    const value = envelope.input as unknown as GepaArchiveViewInput
    safeId(value.roundId)
    if (value.baseArchiveRef.schemaId !== 'gepa.research-archive.v1'
      || value.parentArchiveRef.schemaId !== 'gepa.research-archive.v1'
      || !Array.isArray(value.completionRefs) || value.completionRefs.some(ref => !/^sha256:[a-f0-9]{64}$/u.test(ref))
      || typeof value.publishParentView !== 'boolean') throw new Error('GEPA archive view input invalid')
    const base = this.artifacts.getJson(value.baseArchiveRef) as unknown as ResearchArchive
    const parent = this.artifacts.getJson(value.parentArchiveRef) as unknown as ResearchArchive
    verifyDigest(base); verifyDigest(parent)
    validateSearchSchema('ResearchArchive', base); validateSearchSchema('ResearchArchive', parent)
    if (!value.publishParentView && parent.digest !== base.digest)
      throw new Error('GEPA unchanged archive view has a different digest')
    return { value, base, parent }
  }
  async preflight(envelope: OperationEnvelope): Promise<void> { this.input(envelope) }
  private async read(envelope: OperationEnvelope): Promise<RecordValue | null> {
    const value = await this.records.read<RecordValue>(this.manifest.kind, envelope.operationId)
    if (value && (value.schemaVersion !== 1 || value.operationId !== envelope.operationId
      || value.inputDigest !== envelope.inputDigest || value.implementationDigest !== envelope.implementationDigest
      || !['intent', 'complete', 'cancelled-before-start'].includes(value.stage)))
      throw new Error('GEPA archive view record drift')
    return value ?? null
  }
  private async create(envelope: OperationEnvelope, stage: RecordValue['stage']): Promise<RecordValue> {
    const value: RecordValue = { schemaVersion: 1, operationId: envelope.operationId,
      inputDigest: envelope.inputDigest, implementationDigest: envelope.implementationDigest, stage }
    await (this.artifacts as FileArtifactStore & Partial<ArtifactCheckpoint>).flush?.()
    await this.records.create(this.manifest.kind, envelope.operationId, value)
    return (await this.read(envelope))!
  }
  private completion(envelope: OperationEnvelope, parentArchiveRef: ArtifactRef): CompletionEnvelope {
    return { operationId: envelope.operationId, idempotencyKey: envelope.idempotencyKey,
      inputDigest: envelope.inputDigest, implementationDigest: envelope.implementationDigest,
      outcome: { kind: 'result', value: { parentArchiveRef } } }
  }
  private async published(value: GepaArchiveViewInput, base: ResearchArchive,
    parent: ResearchArchive): Promise<boolean> {
    const basePointer = await this.journal.read<{ ref: string }>(`rounds/${value.roundId}/archive-base`)
    if (!basePointer) return false
    const frozenBase = await this.journal.object<{ archiveDigest: string; digest: string }>(basePointer.ref)
    if (frozenBase.archiveDigest !== base.digest) throw new Error('GEPA archive-base pointer changed')
    const completionsPointer = await this.journal.read<{ ref: string }>(`rounds/${value.roundId}/completions`)
    if (!completionsPointer) return false
    const completions = await this.journal.object<{ refs: string[]; digest: string }>(completionsPointer.ref)
    if (digestJson(completions.refs) !== digestJson(value.completionRefs))
      throw new Error('GEPA frozen completion queue changed')
    if (!value.publishParentView) return true
    const parentPointer = await this.journal.read<{ ref: string }>(`rounds/${value.roundId}/parent-archive`)
    if (!parentPointer) return false
    const frozenParent = await this.journal.object<ResearchArchive>(parentPointer.ref)
    if (frozenParent.digest !== parent.digest) throw new Error('GEPA parent archive view changed')
    return true
  }
  async inspect(envelope: OperationEnvelope): Promise<ProviderInspection> {
    const { value, base, parent } = this.input(envelope)
    const record = await this.read(envelope)
    if (!record) return { status: 'not-started' }
    if (record.stage === 'cancelled-before-start') return { status: 'cancelled', releaseConfirmed: true }
    if (record.completion) return { status: 'completed', completion: record.completion }
    await this.published(value, base, parent)
    return { status: 'replay-safe' }
  }
  async submit(envelope: OperationEnvelope): Promise<ProviderSubmission> {
    const { value, base, parent } = this.input(envelope)
    const record = await this.create(envelope, 'intent')
    if (record.stage === 'cancelled-before-start') throw new Error('Cancelled archive view cannot publish')
    if (record.completion) return { status: 'completed', completion: record.completion }
    try {
      const frozenBase = await this.journal.freeze(value.roundId, 'archive-base',
        () => seal({ archiveDigest: base.digest }))
      if (frozenBase.archiveDigest !== base.digest) throw new Error('GEPA archive-base drift')
      const completions = await this.journal.freeze(value.roundId, 'completions',
        () => seal({ refs: value.completionRefs }))
      if (digestJson(completions.refs) !== digestJson(value.completionRefs))
        throw new Error('GEPA completion queue drift')
      if (value.publishParentView) {
        const frozenParent = await this.journal.freeze(value.roundId, 'parent-archive', () => parent)
        if (frozenParent.digest !== parent.digest) throw new Error('GEPA parent archive drift')
      }
      const completion = this.completion(envelope, value.parentArchiveRef)
      await this.records.write(this.manifest.kind, envelope.operationId, { ...record, stage: 'complete', completion })
      return { status: 'completed', completion }
    } catch (error) { throw new ProviderReconcileError('GEPA archive view publication uncertain', { cause: error }) }
  }
  async cancel(envelope: OperationEnvelope): Promise<ProviderInspection> {
    this.input(envelope)
    const record = await this.create(envelope, 'cancelled-before-start')
    return record.stage === 'cancelled-before-start' ? { status: 'cancelled', releaseConfirmed: true }
      : { status: 'unknown' }
  }
  async collect(envelope: OperationEnvelope): Promise<CompletionEnvelope> {
    const result = await this.inspect(envelope)
    if (result.status !== 'completed') throw new Error('GEPA archive view is not complete')
    return result.completion
  }
}
