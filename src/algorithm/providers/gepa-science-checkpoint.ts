import { FileArtifactStore } from '../artifacts.js'
import type { ArtifactRef, CompletionEnvelope, OperationEnvelope, OperationProvider, ProviderInspection,
  ProviderManifest, ProviderSubmission } from '../contracts.js'
import { implementationClosureDigest } from '../data/identity.js'
import { ProviderReconcileError } from '../provider-errors.js'
import { FileProviderRecordBackend, type ArtifactCheckpoint, type ProviderRecordBackend } from '../runtime/persistence.js'
import { canonicalJson, jsonDigest, type JsonValue } from '../schema.js'
import { digestJson } from '../../state/digest.js'
import { safeId, seal, verifyDigest } from '../../search/contracts.js'
import { validateSearchSchema } from '../../search/schema.js'
import type { SearchJournal } from '../../search/store.js'
import type { EvaluationStageDecision, SearchProgress, StageResult } from '../../search/types.js'

type Stage = 'parents' | 'scope-preparation' | 'planning' | 'local' | 'nomination'
type Consumer = 'scope-preparation' | 'workplans' | 'local-decision' | 'nomination'
const names: Record<Stage, string[]> = {
  parents: ['parents'], 'scope-preparation': ['scope-preparation'], planning: ['planning'],
  local: ['local', 'expansion', 'local-stage-decisions'], nomination: ['nomination'],
}
const consumer: Partial<Record<Stage, Consumer>> = {
  'scope-preparation': 'scope-preparation', planning: 'workplans', local: 'local-decision',
  nomination: 'nomination',
}
export type GepaScienceCheckpointInput = { roundId: string; stage: Stage;
  objects: Array<{ name: string; ref: ArtifactRef }>;
  supportRefs: ArtifactRef[];
  consumptions: Array<{ resultRef: ArtifactRef; consumerDigest: string }> }
type Prepared = { input: GepaScienceCheckpointInput; objects: Array<{ name: string; value: { digest: string } }>;
  supports: Array<{ digest: string }>; decisions: EvaluationStageDecision[];
  consumptions: Array<{ name: string; value: { digest: string } }> }
type RecordValue = { schemaVersion: 1; operationId: string; inputDigest: string; implementationDigest: string;
  bindingDigest: string; stage: 'intent' | 'complete' | 'cancelled-before-start'; completion?: CompletionEnvelope }

/** Publishes a reducer's sealed science decision at the same boundary as the old journal. */
export class GepaScienceCheckpointProvider implements OperationProvider {
  private readonly records: ProviderRecordBackend
  private readonly manifest: ProviderManifest
  constructor(root: string, readonly artifacts: FileArtifactStore, readonly journal: SearchJournal,
    records?: ProviderRecordBackend) {
    this.records = records ?? new FileProviderRecordBackend(root)
    this.manifest = { kind: 'gepa.science-checkpoint',
      implementationDigest: implementationClosureDigest(['providers/gepa-science-checkpoint'], {
        recordBackend: ('identityDigest' in this.records ? this.records.identityDigest : null) ?? null }),
      inputSchema: { type: 'object', required: ['roundId', 'stage', 'objects', 'supportRefs', 'consumptions'], properties: {
        roundId: { type: 'string' }, stage: { type: 'string', enum: Object.keys(names) },
        objects: { type: 'array', items: { type: 'any' } },
        supportRefs: { type: 'array', items: { type: 'any' } },
        consumptions: { type: 'array', items: { type: 'any' } },
      }, additionalProperties: false },
      outputSchema: { type: 'object', required: ['stage'], properties: {
        stage: { type: 'string' },
      }, additionalProperties: false },
      meteredDimensions: [], execution: 'trusted-local', supportsInspect: true,
      supportsIdempotentReplay: true }
  }
  describe(): ProviderManifest { return structuredClone(this.manifest) }
  private prepare(envelope: OperationEnvelope): Prepared {
    if (envelope.kind !== this.manifest.kind || envelope.implementationDigest !== this.manifest.implementationDigest
      || envelope.inputDigest !== jsonDigest(envelope.input) || envelope.operationId !== envelope.idempotencyKey
      || Object.keys(envelope.limits).length) throw new Error('GEPA science checkpoint identity drift')
    return this.prepareInput(envelope.input as unknown as GepaScienceCheckpointInput)
  }
  private prepareInput(input: GepaScienceCheckpointInput): Prepared {
    safeId(input.roundId)
    if (!(input.stage in names) || !Array.isArray(input.objects) || !Array.isArray(input.supportRefs)
      || !Array.isArray(input.consumptions)
      || digestJson(input.objects.map(row => row.name)) !== digestJson(names[input.stage]))
      throw new Error('GEPA science checkpoint stage objects invalid')
    const objects = input.objects.map(row => {
      if (row.ref?.schemaId !== 'gepa.legacy-journal-object.v1')
        throw new Error('GEPA science checkpoint object schema invalid')
      const value = this.artifacts.getJson(row.ref) as unknown as { digest: string }
      verifyDigest(value)
      return { name: row.name, value }
    })
    const decisions = input.stage === 'local'
      ? objects.find(row => row.name === 'local-stage-decisions')?.value
      : input.stage === 'nomination' ? objects.find(row => row.name === 'nomination')?.value : undefined
    if (decisions && (!('decisions' in decisions) || !Array.isArray(decisions.decisions)))
      throw new Error('GEPA science checkpoint decisions invalid')
    const stageDecisions = decisions ? decisions.decisions as EvaluationStageDecision[] : []
    for (const decision of stageDecisions) {
      validateSearchSchema('EvaluationStageDecision', decision)
      verifyDigest(decision)
    }
    const expectedSupports = stageDecisions.map(row => row.supportDigest)
    const supports = input.supportRefs.map(ref => {
      if (ref?.schemaId !== 'gepa.legacy-journal-object.v1')
        throw new Error('GEPA science checkpoint support schema invalid')
      const value = this.artifacts.getJson(ref) as unknown as { digest: string }
      verifyDigest(value)
      return value
    })
    if (expectedSupports.some(digest => typeof digest !== 'string')
      || digestJson(supports.map(row => row.digest)) !== digestJson(expectedSupports))
      throw new Error('GEPA science checkpoint support decisions drift')
    const expectedConsumer = consumer[input.stage]
    if (!expectedConsumer && input.consumptions.length)
      throw new Error('GEPA science checkpoint cannot consume evidence at this stage')
    const owning = objects.find(row => row.name === (input.stage === 'scope-preparation' ? 'scope-preparation'
      : input.stage === 'planning' ? 'planning' : input.stage === 'local' ? 'local' : 'nomination'))?.value.digest
    const consumptions = input.consumptions.map(row => {
      if (row.resultRef?.schemaId !== 'gepa.stage-result.v1' || row.consumerDigest !== owning)
        throw new Error('GEPA science checkpoint consumption owner invalid')
      const result = this.artifacts.getJson(row.resultRef) as unknown as StageResult
      verifyDigest(result)
      const value = seal({ stagePlanDigest: result.stagePlanDigest, snapshotDigest: result.snapshotDigest,
        resultDigest: result.digest, consumer: expectedConsumer!, consumerDigest: row.consumerDigest })
      return { name: `consumed-${digestJson([result.stagePlanDigest, result.snapshotDigest]).slice(7)}`, value }
    })
    if (new Set(consumptions.map(row => row.name)).size !== consumptions.length)
      throw new Error('GEPA science checkpoint duplicate consumption')
    return { input, objects, supports, decisions: stageDecisions, consumptions }
  }
  async preflight(envelope: OperationEnvelope): Promise<void> { this.prepare(envelope) }
  private async read(envelope: OperationEnvelope): Promise<RecordValue | null> {
    const record = await this.records.read<RecordValue>(this.manifest.kind, envelope.operationId)
    if (record && (record.schemaVersion !== 1 || record.operationId !== envelope.operationId
      || record.inputDigest !== envelope.inputDigest || record.implementationDigest !== envelope.implementationDigest
      || record.bindingDigest !== envelope.bindingSetRef.digest
      || !['intent', 'complete', 'cancelled-before-start'].includes(record.stage)))
      throw new Error('GEPA science checkpoint record drift')
    return record ?? null
  }
  private async create(envelope: OperationEnvelope, stage: RecordValue['stage']): Promise<RecordValue> {
    await (this.artifacts as FileArtifactStore & Partial<ArtifactCheckpoint>).flush?.()
    const value: RecordValue = { schemaVersion: 1, operationId: envelope.operationId,
      inputDigest: envelope.inputDigest, implementationDigest: envelope.implementationDigest,
      bindingDigest: envelope.bindingSetRef.digest, stage }
    const { record } = await this.records.create(this.manifest.kind, envelope.operationId, value)
    return record
  }
  private async published(prepared: Prepared): Promise<boolean> {
    for (const support of prepared.supports) {
      const saved = await this.journal.object<{ digest: string }>(support.digest)
      if (digestJson(saved) !== digestJson(support)) throw new Error('GEPA science checkpoint support drift')
    }
    for (const row of [...prepared.objects, ...prepared.consumptions]) {
      const pointer = await this.journal.read<{ ref: string }>(`rounds/${prepared.input.roundId}/${row.name}`)
      if (!pointer) return false
      if (pointer.ref !== row.value.digest) throw new Error('GEPA science checkpoint pointer drift')
      const saved = await this.journal.object<{ digest: string }>(pointer.ref)
      if (digestJson(saved) !== digestJson(row.value)) throw new Error('GEPA science checkpoint object drift')
    }
    if (prepared.decisions.length) {
      const progress = await this.journal.read<SearchProgress>(`rounds/${prepared.input.roundId}/progress`)
      if (!progress) return false
      for (const decision of prepared.decisions) {
        const row = progress.decisions.find(item => item.stagePlanDigest === decision.stagePlanDigest
          && item.candidateId === decision.candidateId)
        // The phase pointer is frozen before the decision object and progress
        // row are published. Resume that window instead of treating it as drift.
        if (!row) return false
        if (row.digest !== decision.digest) throw new Error('GEPA science decision progress drift')
        const saved = await this.journal.object<EvaluationStageDecision>(decision.digest)
        if (canonicalJson(saved as unknown as JsonValue) !== canonicalJson(decision as unknown as JsonValue))
          throw new Error('GEPA science decision object drift')
      }
    }
    return true
  }
  async inspect(envelope: OperationEnvelope): Promise<ProviderInspection> {
    const prepared = this.prepare(envelope), record = await this.read(envelope)
    if (!record) return { status: 'not-started' }
    if (record.stage === 'cancelled-before-start') return { status: 'cancelled', releaseConfirmed: true }
    if (record.stage === 'complete') {
      if (!await this.published(prepared)) throw new Error('Completed GEPA science checkpoint is missing')
      return { status: 'completed', completion: record.completion! }
    }
    return { status: 'replay-safe' }
  }
  async submit(envelope: OperationEnvelope): Promise<ProviderSubmission> {
    const prepared = this.prepare(envelope)
    let record: RecordValue
    try {
      record = await this.create(envelope, 'intent')
    } catch (error) { throw new ProviderReconcileError('GEPA science checkpoint intent persistence failed', { cause: error }) }
    if (record.stage === 'cancelled-before-start') throw new Error('Cancelled GEPA science checkpoint cannot publish')
    try {
      if (record.stage === 'complete') return { status: 'completed', completion: record.completion! }
      await this.publishPrepared(prepared)
      const completion: CompletionEnvelope = { operationId: envelope.operationId,
        idempotencyKey: envelope.idempotencyKey, inputDigest: envelope.inputDigest,
        implementationDigest: envelope.implementationDigest,
        outcome: { kind: 'result', value: { stage: prepared.input.stage } as JsonValue } }
      await this.records.write(this.manifest.kind, envelope.operationId, { ...record, stage: 'complete', completion })
      return { status: 'completed', completion }
    } catch (error) { throw new ProviderReconcileError('GEPA science checkpoint publication failed', { cause: error }) }
  }
  /** Idempotent old-journal projection for a durably committed Campaign decision. */
  async project(input: GepaScienceCheckpointInput): Promise<void> {
    const prepared = this.prepareInput(input)
    const first = prepared.objects[0]!
    if (await this.journal.read(`rounds/${input.roundId}/${first.name}`)
      && await this.published(prepared)) return
    await this.publishPrepared(prepared)
    if (!await this.published(prepared)) throw new Error('GEPA science checkpoint projection unresolved')
  }
  private async publishPrepared(prepared: Prepared): Promise<void> {
    // The old journal makes the immutable decision and support objects readable first,
    // marks evidence consumed next, and only then exposes the phase pointer.
    for (const value of [...prepared.objects.map(row => row.value), ...prepared.supports])
      if (await this.journal.put(value) !== value.digest)
        throw new Error('GEPA science checkpoint object address drift')
    for (const row of prepared.consumptions) {
      const saved = await this.journal.freeze(prepared.input.roundId, row.name, () => row.value)
      if (digestJson(saved) !== digestJson(row.value))
        throw new Error('GEPA science checkpoint frozen value drift')
    }
    for (const row of prepared.objects) {
      const saved = await this.journal.freeze(prepared.input.roundId, row.name, () => row.value)
      if (digestJson(saved) !== digestJson(row.value))
        throw new Error('GEPA science checkpoint frozen value drift')
    }
    if (prepared.decisions.length) {
      const key = `rounds/${prepared.input.roundId}/progress`
      const progress = await this.journal.read<SearchProgress>(key)
      if (!progress) throw new Error('GEPA stage progress is unavailable')
      for (const decision of prepared.decisions) await this.journal.put(decision)
      const byKey = new Map([...progress.decisions, ...prepared.decisions].map(decision =>
        [`${decision.stagePlanDigest}/${decision.candidateId}`, decision]))
      const next = { ...progress, decisions: [...byKey.values()] }
      if (canonicalJson(next as unknown as JsonValue) !== canonicalJson(progress as unknown as JsonValue))
        await this.journal.write(key, next)
    }
  }
  async cancel(envelope: OperationEnvelope): Promise<ProviderInspection> {
    this.prepare(envelope)
    const record = await this.create(envelope, 'cancelled-before-start')
    if (record.stage === 'cancelled-before-start') return { status: 'cancelled', releaseConfirmed: true }
    return this.inspect(envelope)
  }
  async collect(envelope: OperationEnvelope): Promise<CompletionEnvelope> {
    const result = await this.inspect(envelope)
    if (result.status !== 'completed') throw new Error('GEPA science checkpoint has not completed')
    return result.completion
  }
}
