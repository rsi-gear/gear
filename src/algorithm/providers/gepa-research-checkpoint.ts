import { join } from 'node:path'
import { FileArtifactStore } from '../artifacts.js'
import type { ArtifactRef, CompletionEnvelope, OperationEnvelope, OperationProvider, ProviderInspection,
  ProviderManifest, ProviderSubmission } from '../contracts.js'
import { canonicalJson, jsonDigest, type JsonValue } from '../schema.js'
import { implementationClosureDigest } from '../data/identity.js'
import { CampaignStore } from '../runtime/store.js'
import { FileProviderRecordBackend, type ProviderRecordBackend } from '../runtime/persistence.js'
import { digestJson } from '../../state/digest.js'
import { digest, safeId, verifyDigest } from '../../search/contracts.js'
import { validateSearchSchema } from '../../search/schema.js'
import type { SearchJournal } from '../../search/store.js'
import type { ResearchArchive, ResearchFinding, SearchProgress } from '../../search/types.js'

export type GepaResearchCheckpointInput = {
  roundId: string
  /** A verified failed bootstrap records progress but does not install seed research. */
  publishResearch?: false
  archiveRef: ArtifactRef
  findings: Array<{ snapshotDigest: string; findingRef: ArtifactRef }>
  progressRef: ArtifactRef
  regressionRef?: ArtifactRef
}
export type GepaResearchCheckpointOutput = { archiveRef: ArtifactRef; checkpointRef: ArtifactRef }
type Frozen = { input: GepaResearchCheckpointInput; archive: ResearchArchive; findings: ResearchFinding[];
  progress: SearchProgress; regression: { proposals: Array<{ digest: string }> } | null }
type RecordValue = { schemaVersion: 1; operationId: string; inputDigest: string; implementationDigest: string;
  bindingDigest: string; stage: 'intent' | 'complete' | 'cancelled-before-start'; completion?: CompletionEnvelope }

/** Publishes only already sealed seed research. Every journal write is idempotent under the original round key. */
export class GepaResearchCheckpointProvider implements OperationProvider {
  private readonly records: ProviderRecordBackend
  private readonly writer: CampaignStore<JsonValue>
  private readonly manifest: ProviderManifest

  constructor(root: string, readonly artifacts: FileArtifactStore, readonly journal: SearchJournal,
    records?: ProviderRecordBackend) {
    this.records = records ?? new FileProviderRecordBackend(root,
      { 'gepa.research-checkpoint': 'gepa-research-checkpoint' })
    this.writer = new CampaignStore<JsonValue>(join(root, 'gepa-research-checkpoint-writer'))
    this.manifest = { kind: 'gepa.research-checkpoint',
      implementationDigest: implementationClosureDigest(['providers/gepa-research-checkpoint'], {
        recordBackend: ('identityDigest' in this.records ? this.records.identityDigest : null) ?? null }),
      inputSchema: { type: 'object', required: ['roundId', 'archiveRef', 'findings', 'progressRef'], properties: {
        roundId: { type: 'string' }, publishResearch: { type: 'boolean', enum: [false] },
        archiveRef: { type: 'any' }, findings: { type: 'array', items: { type: 'any' } },
        progressRef: { type: 'any' }, regressionRef: { type: 'any' },
      }, additionalProperties: false },
      outputSchema: { type: 'object', required: ['archiveRef', 'checkpointRef'], properties: {
        archiveRef: { type: 'any' }, checkpointRef: { type: 'any' },
      }, additionalProperties: false },
      meteredDimensions: [], execution: 'trusted-local', supportsInspect: true, supportsIdempotentReplay: true }
  }

  describe(): ProviderManifest { return structuredClone(this.manifest) }
  private freeze(envelope: OperationEnvelope): Frozen {
    if (envelope.kind !== this.manifest.kind || envelope.implementationDigest !== this.manifest.implementationDigest
      || envelope.inputDigest !== jsonDigest(envelope.input) || envelope.idempotencyKey !== envelope.operationId
      || Object.keys(envelope.limits).length) throw new Error('GEPA research checkpoint identity drift')
    const input = envelope.input as unknown as GepaResearchCheckpointInput
    safeId(input.roundId)
    if (input.archiveRef.schemaId !== 'gepa.research-archive.v1'
      || input.progressRef.schemaId !== 'gepa.seed-progress.v1'
      || (input.regressionRef && input.regressionRef.schemaId !== 'gepa.regression-proposals.v1')
      || !Array.isArray(input.findings)) throw new Error('GEPA research checkpoint artifact schema invalid')
    const archive = this.artifacts.getJson(input.archiveRef) as unknown as ResearchArchive
    verifyDigest(archive); validateSearchSchema('ResearchArchive', archive)
    const progress = this.artifacts.getJson(input.progressRef) as unknown as SearchProgress
    if (!progress || progress.phase !== (input.publishResearch === false ? 'bootstrap' : 'seed-research-complete')
      || !Array.isArray(progress.evaluations)
      || progress.evaluations.some(row => (row as { stage: string }).stage === 'held-out') || !Array.isArray(progress.decisions))
      throw new Error('GEPA seed progress invalid')
    if (input.publishResearch === false && (input.findings.length || input.regressionRef))
      throw new Error('Failed bootstrap cannot publish seed findings or regression')
    const findings = input.findings.map(({ snapshotDigest, findingRef }) => {
      digest(snapshotDigest)
      if (findingRef.schemaId !== 'gepa.research-finding.v1') throw new Error('GEPA finding schema invalid')
      const finding = this.artifacts.getJson(findingRef) as unknown as ResearchFinding
      verifyDigest(finding)
      if (!archive.snapshots.some(snapshot => snapshot.digest === snapshotDigest
        && snapshot.candidateId === finding.candidateId)) throw new Error('GEPA finding snapshot mismatch')
      return finding
    })
    if (new Set(input.findings.map(row => row.snapshotDigest)).size !== input.findings.length)
      throw new Error('GEPA duplicate finding snapshot')
    const regression = input.regressionRef
      ? this.artifacts.getJson(input.regressionRef) as unknown as { proposals: Array<{ digest: string }> } : null
    if (regression && (!Array.isArray(regression.proposals)
      || regression.proposals.some(proposal => !/^sha256:[a-f0-9]{64}$/u.test(proposal.digest))))
      throw new Error('GEPA regression proposals invalid')
    return { input, archive, findings, progress, regression }
  }
  async preflight(envelope: OperationEnvelope): Promise<void> { this.freeze(envelope) }
  private async read(envelope: OperationEnvelope): Promise<RecordValue | null> {
    const record = await this.records.read<RecordValue>(this.manifest.kind, envelope.operationId)
    if (!record) return null
    if (!record || record.schemaVersion !== 1 || !['intent', 'complete', 'cancelled-before-start'].includes(record.stage)
      || record.operationId !== envelope.operationId || record.inputDigest !== envelope.inputDigest
      || record.implementationDigest !== envelope.implementationDigest || record.bindingDigest !== envelope.bindingSetRef.digest)
      throw new Error('GEPA research checkpoint record drift')
    return record
  }
  private async create(envelope: OperationEnvelope, stage: RecordValue['stage']): Promise<RecordValue> {
    const value: RecordValue = { schemaVersion: 1, operationId: envelope.operationId,
      inputDigest: envelope.inputDigest, implementationDigest: envelope.implementationDigest,
      bindingDigest: envelope.bindingSetRef.digest, stage }
    const { record } = await this.records.create(this.manifest.kind, envelope.operationId, value)
    return record
  }
  private checkpointRef(frozen: Frozen): ArtifactRef {
    return this.artifacts.putJson({ schemaVersion: 1, roundId: frozen.input.roundId,
      publishResearch: frozen.input.publishResearch !== false,
      archiveDigest: frozen.archive.digest, findings: frozen.input.findings,
      progressDigest: jsonDigest(frozen.progress), regressionDigest: frozen.input.regressionRef?.digest ?? null },
    'gepa.research-checkpoint.v1')
  }
  private completion(envelope: OperationEnvelope, frozen: Frozen): CompletionEnvelope {
    return { operationId: envelope.operationId, idempotencyKey: envelope.idempotencyKey,
      inputDigest: envelope.inputDigest, implementationDigest: envelope.implementationDigest,
      outcome: { kind: 'result', value: { archiveRef: frozen.input.archiveRef,
        checkpointRef: this.checkpointRef(frozen) } as unknown as JsonValue } }
  }
  private async published(frozen: Frozen): Promise<boolean> {
    const saved = await this.journal.read<{ ref: string }>(`rounds/${frozen.input.roundId}/research`)
    if (frozen.input.publishResearch === false) {
      if (saved) throw new Error('Failed bootstrap installed seed research')
    } else {
      if (!saved) return false
      if (saved.ref !== frozen.archive.digest) throw new Error('GEPA research pointer conflict')
      const old = await this.journal.object<ResearchArchive>(saved.ref)
      if (digestJson(old) !== digestJson(frozen.archive)) throw new Error('GEPA research archive drift')
    }
    for (const [index, row] of frozen.input.findings.entries()) {
      const pointer = await this.journal.read<{ refs: string[] }>(`findings/${row.snapshotDigest.slice(7)}`)
      if (!pointer) return false
      if (canonicalJson(pointer) !== canonicalJson({ refs: [frozen.findings[index]!.digest] }))
        throw new Error('GEPA finding pointer conflict')
    }
    if (frozen.regression) {
      const savedRegression = await this.journal.read('regression/proposals')
      if (!savedRegression) return false
      if (canonicalJson(savedRegression as JsonValue) !== canonicalJson(frozen.regression as unknown as JsonValue))
        throw new Error('GEPA regression pointer conflict')
    }
    const progress = await this.journal.read<SearchProgress>(`rounds/${frozen.input.roundId}/progress`)
    if (!progress) return false
    if (canonicalJson(progress as unknown as JsonValue) !== canonicalJson(frozen.progress as unknown as JsonValue))
      throw new Error('GEPA seed progress drift')
    return true
  }
  private async publish(frozen: Frozen): Promise<void> {
    const existing = await this.journal.read<{ ref: string }>(`rounds/${frozen.input.roundId}/research`)
    if (existing && (frozen.input.publishResearch === false || existing.ref !== frozen.archive.digest))
      throw new Error('GEPA research pointer conflict')
    await this.journal.put(frozen.archive)
    if (!existing && frozen.input.publishResearch !== false)
      await this.journal.write(`rounds/${frozen.input.roundId}/research`, { ref: frozen.archive.digest })
    for (const [index, row] of frozen.input.findings.entries()) {
      const finding = frozen.findings[index]!
      await this.journal.put(finding)
      const key = `findings/${row.snapshotDigest.slice(7)}`
      const old = await this.journal.read<{ refs: string[] }>(key)
      if (old && canonicalJson(old) !== canonicalJson({ refs: [finding.digest] }))
        throw new Error('GEPA finding pointer conflict')
      if (!old) await this.journal.write(key, { refs: [finding.digest] })
    }
    if (frozen.regression) {
      const old = await this.journal.read('regression/proposals')
      if (old && canonicalJson(old as JsonValue) !== canonicalJson(frozen.regression as unknown as JsonValue))
        throw new Error('GEPA regression pointer conflict')
      if (!old) await this.journal.write('regression/proposals', frozen.regression)
    }
    const progressKey = `rounds/${frozen.input.roundId}/progress`
    const oldProgress = await this.journal.read<SearchProgress>(progressKey)
    if (!oldProgress || canonicalJson(oldProgress as unknown as JsonValue) !== canonicalJson(frozen.progress as unknown as JsonValue))
      await this.journal.write(progressKey, frozen.progress)
  }
  async inspect(envelope: OperationEnvelope): Promise<ProviderInspection> {
    const frozen = this.freeze(envelope), record = await this.read(envelope)
    if (!record) return { status: 'not-started' }
    if (record.stage === 'cancelled-before-start') return { status: 'cancelled', releaseConfirmed: true }
    if (record.stage === 'complete') {
      if (!await this.published(frozen)) throw new Error('GEPA completed research checkpoint missing')
      return { status: 'completed', completion: record.completion! }
    }
    return { status: 'replay-safe' }
  }
  async submit(envelope: OperationEnvelope): Promise<ProviderSubmission> {
    const frozen = this.freeze(envelope)
    return this.writer.withWriter(async () => {
      const record = await this.create(envelope, 'intent')
      if (record.stage === 'cancelled-before-start') throw new Error('Cancelled GEPA research checkpoint cannot submit')
      if (record.stage === 'complete') {
        if (!await this.published(frozen)) throw new Error('GEPA completed research checkpoint missing')
        return { status: 'completed', completion: record.completion! }
      }
      await this.publish(frozen)
      if (!await this.published(frozen)) throw new Error('GEPA research checkpoint unresolved')
      const completion = this.completion(envelope, frozen)
      await this.records.write(this.manifest.kind, envelope.operationId, { ...record, stage: 'complete', completion })
      return { status: 'completed', completion }
    })
  }
  async cancel(envelope: OperationEnvelope): Promise<ProviderInspection> {
    this.freeze(envelope)
    const record = await this.create(envelope, 'cancelled-before-start')
    if (record.stage === 'cancelled-before-start') return { status: 'cancelled', releaseConfirmed: true }
    return this.inspect(envelope)
  }
  async collect(envelope: OperationEnvelope): Promise<CompletionEnvelope> {
    const observed = await this.inspect(envelope)
    if (observed.status !== 'completed') throw new Error('GEPA research checkpoint is not complete')
    return observed.completion
  }
}
