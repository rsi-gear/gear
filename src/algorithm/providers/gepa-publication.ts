import { join } from 'node:path'
import { FileArtifactStore, assertDigest } from '../artifacts.js'
import type { ArtifactRef, CompletionEnvelope, OperationEnvelope, OperationProvider, ProviderInspection,
  ProviderManifest, ProviderSubmission } from '../contracts.js'
import { canonicalJson, jsonDigest, type JsonValue } from '../schema.js'
import { implementationClosureDigest } from '../data/identity.js'
import { CampaignStore } from '../runtime/store.js'
import { FileProviderRecordBackend, type ArtifactCheckpoint, type ProviderRecordBackend } from '../runtime/persistence.js'
import { ProviderProtocolError, ProviderReconcileError } from '../provider-errors.js'
import { digestJson } from '../../state/digest.js'
import { digest, safeId, seal, validateSnapshot, verifyDigest } from '../../search/contracts.js'
import { validateSearchSchema } from '../../search/schema.js'
import type { SearchJournal } from '../../search/store.js'
import type { Snapshot, ResearchArchive } from '../../search/types.js'
import type { SearchExecutionHooks } from '../../search/runtime.js'
import type { SearchRoundOutcome } from '../../search/outcomes.js'

export type GepaBootstrapPublication = {
  schemaVersion: 1; kind: 'bootstrap-archive'; roundId: string; archiveDigest: string
}
export type GepaPublicationInput = {
  roundId: string
  /** False records a terminal bootstrap failure without installing its incomplete research archive. */
  publishArchive?: false
  expectedArchiveDigest: string | null
  nextArchiveRef: ArtifactRef
  expectedChampionRevisionDigest: string
  nextChampion?: Snapshot
  outcomeRef: ArtifactRef
}
export type GepaPublicationOutput = { outcomeRef: ArtifactRef; publicationReceiptRef: ArtifactRef }
export type GepaPublicationReceipt = {
  schemaVersion: 1; kind: 'gepa-publication'; roundId: string
  archiveCommitted: boolean
  expectedArchiveDigest: string | null; nextArchiveDigest: string
  expectedChampionRevisionDigest: string; nextChampionDigest: string | null
  outcomeRef: ArtifactRef
}
type PublicationStore = SearchJournal
type PublicationHooks = Pick<SearchExecutionHooks, 'commitChampion'>
type RecordValue = {
  schemaVersion: 1; operationId: string; inputDigest: string; implementationDigest: string
  bindingDigest: string; idempotencyKey: string; stage: 'intent' | 'complete' | 'cancelled-before-start'
  publicationReceiptRef?: ArtifactRef; completion?: CompletionEnvelope
}

/** Publishes one frozen archive CAS. No old SearchJournal budget reservation is made. */
export class GepaPublicationProvider implements OperationProvider {
  private readonly records: ProviderRecordBackend
  private readonly writer: CampaignStore<JsonValue>
  private readonly manifest: ProviderManifest
  private readonly beforePublication: (() => Promise<void>) | undefined

  constructor(root: string, readonly artifacts: FileArtifactStore, readonly publication: PublicationStore,
    readonly hooks: PublicationHooks, options: { hookIdentityDigest?: string; records?: ProviderRecordBackend;
      beforePublication?: () => Promise<void>; publicationBarrierIdentityDigest?: string } = {}) {
    this.records = options.records ?? new FileProviderRecordBackend(root, { 'gepa.publish': 'gepa-publication' })
    this.beforePublication = options.beforePublication
    this.writer = new CampaignStore<JsonValue>(join(root, 'gepa-publication-writer'))
    if (options.hookIdentityDigest !== undefined) assertDigest(options.hookIdentityDigest)
    if (options.publicationBarrierIdentityDigest !== undefined) assertDigest(options.publicationBarrierIdentityDigest)
    if (!!options.beforePublication !== !!options.publicationBarrierIdentityDigest)
      throw new Error('GEPA publication barrier requires a frozen identity')
    const persistenceIdentity = 'identityDigest' in this.records ? this.records.identityDigest : null
    this.manifest = {
      kind: 'gepa.publish',
      implementationDigest: implementationClosureDigest(['providers/gepa-publication'], {
        hookIdentityDigest: options.hookIdentityDigest ?? null,
        hookSourceDigest: digestJson(String(hooks.commitChampion)),
        persistenceIdentity, publicationBarrierIdentityDigest: options.publicationBarrierIdentityDigest ?? null,
      }),
      inputSchema: { type: 'object', required: ['roundId', 'expectedArchiveDigest', 'nextArchiveRef',
        'expectedChampionRevisionDigest', 'outcomeRef'], properties: {
        roundId: { type: 'string' }, publishArchive: { type: 'boolean', enum: [false] },
        expectedArchiveDigest: { type: 'any' }, nextArchiveRef: { type: 'any' },
        expectedChampionRevisionDigest: { type: 'string' }, nextChampion: { type: 'any' }, outcomeRef: { type: 'any' },
      }, additionalProperties: false },
      outputSchema: { type: 'object', required: ['outcomeRef', 'publicationReceiptRef'], properties: {
        outcomeRef: { type: 'any' }, publicationReceiptRef: { type: 'any' },
      }, additionalProperties: false },
      meteredDimensions: [], execution: 'external', supportsInspect: true, supportsIdempotentReplay: true,
    }
  }

  describe(): ProviderManifest { return structuredClone(this.manifest) }
  private async flushArtifacts(): Promise<void> {
    await (this.artifacts as FileArtifactStore & Partial<ArtifactCheckpoint>).flush?.()
  }
  private input(envelope: OperationEnvelope): GepaPublicationInput {
    return envelope.input as unknown as GepaPublicationInput
  }
  private validated(envelope: OperationEnvelope): { input: GepaPublicationInput; next: ResearchArchive;
    terminal: SearchRoundOutcome | null } {
    if (envelope.kind !== this.manifest.kind || envelope.implementationDigest !== this.manifest.implementationDigest
      || envelope.inputDigest !== jsonDigest(envelope.input) || envelope.idempotencyKey !== envelope.operationId)
      throw new Error('GEPA publication operation identity drift')
    if (Object.keys(envelope.limits).length) throw new Error('GEPA publication cannot reserve measured resources')
    const input = this.input(envelope)
    safeId(input.roundId)
    if (input.publishArchive !== undefined && input.publishArchive !== false)
      throw new Error('GEPA publication mode invalid')
    if (input.publishArchive === false && input.nextChampion)
      throw new Error('Terminal-only GEPA publication cannot change champion')
    if (input.expectedArchiveDigest !== null) digest(input.expectedArchiveDigest)
    digest(input.expectedChampionRevisionDigest)
    if (input.nextArchiveRef.schemaId !== 'gepa.research-archive.v1')
      throw new Error('GEPA publication requires a sealed research archive')
    const next = this.artifacts.getJson(input.nextArchiveRef) as unknown as ResearchArchive
    verifyDigest(next)
    validateSearchSchema('ResearchArchive', next)
    const outcome = this.artifacts.getJson(input.outcomeRef)
    let terminal: SearchRoundOutcome | null = null
    if (input.outcomeRef.schemaId === 'gepa.bootstrap-publication.v1') {
      const bootstrap = outcome as unknown as GepaBootstrapPublication
      if (!bootstrap || bootstrap.schemaVersion !== 1 || bootstrap.kind !== 'bootstrap-archive'
        || bootstrap.roundId !== input.roundId || bootstrap.archiveDigest !== next.digest
        || Object.keys(bootstrap).sort().join(',') !== 'archiveDigest,kind,roundId,schemaVersion'
        || input.nextChampion || input.publishArchive === false)
        throw new Error('GEPA bootstrap publication checkpoint mismatch')
    } else if (input.outcomeRef.schemaId === 'gepa.round-outcome.v1') {
      validateSearchSchema('SearchRoundOutcome', outcome)
      terminal = outcome as unknown as SearchRoundOutcome
      verifyDigest(terminal)
      if (terminal.roundId !== input.roundId || terminal.archiveDigest !== next.digest
        || terminal.championChanged !== !!input.nextChampion)
        throw new Error('GEPA publication outcome mismatch')
      if (input.publishArchive === false && (input.expectedArchiveDigest !== null
        || !terminal.reasonCodes.includes('bootstrap-execution-unavailable')))
        throw new Error('GEPA terminal-only publication requires failed bootstrap')
    } else throw new Error('GEPA publication outcome schema unsupported')
    if (input.nextChampion) {
      validateSnapshot(input.nextChampion)
      if (terminal?.nomineeId !== input.nextChampion.candidateId
        || !next.snapshots.some(snapshot => snapshot.digest === input.nextChampion!.digest))
        throw new Error('GEPA champion is not the archived nominee')
    }
    return { input, next, terminal }
  }
  async preflight(envelope: OperationEnvelope): Promise<void> { this.validated(envelope) }

  private async read(envelope: OperationEnvelope): Promise<RecordValue | null> {
    const record = await this.records.read<RecordValue>(envelope.kind, envelope.operationId)
    if (!record) return null
    if (!record || record.schemaVersion !== 1 || !['intent', 'complete', 'cancelled-before-start'].includes(record.stage)
      || record.operationId !== envelope.operationId || record.inputDigest !== envelope.inputDigest
      || record.implementationDigest !== envelope.implementationDigest
      || record.bindingDigest !== envelope.bindingSetRef.digest || record.idempotencyKey !== envelope.idempotencyKey)
      throw new Error('GEPA publication record drift')
    if (record.stage === 'complete' && !record.completion) throw new Error('GEPA publication completion missing')
    return record
  }
  private receiptValue(input: GepaPublicationInput, next: ResearchArchive): GepaPublicationReceipt {
    return { schemaVersion: 1, kind: 'gepa-publication', roundId: input.roundId,
      archiveCommitted: input.publishArchive !== false,
      expectedArchiveDigest: input.expectedArchiveDigest, nextArchiveDigest: next.digest,
      expectedChampionRevisionDigest: input.expectedChampionRevisionDigest,
      nextChampionDigest: input.nextChampion?.digest ?? null, outcomeRef: input.outcomeRef }
  }
  private receipt(input: GepaPublicationInput, next: ResearchArchive): ArtifactRef {
    return this.artifacts.putJson(this.receiptValue(input, next) as unknown as JsonValue, 'gepa.publication-receipt.v1')
  }
  private async freezeLegacyPrepublication(input: GepaPublicationInput, next: ResearchArchive,
    terminal: SearchRoundOutcome | null): Promise<void> {
    if (await this.publication.put(next) !== next.digest
      || canonicalJson(await this.publication.object<ResearchArchive>(next.digest) as unknown as JsonValue)
        !== canonicalJson(next as unknown as JsonValue))
      throw new ProviderProtocolError('GEPA next archive object drift')
    if (!terminal) {
      const [result] = next.results
      if (next.results.length !== 1 || !result
        || next.plans.filter(plan => plan.digest === result.stagePlanDigest && plan.stage === 'baseline-probe').length !== 1
        || next.snapshots.filter(snapshot => snapshot.digest === result.snapshotDigest).length !== 1)
        throw new ProviderProtocolError('GEPA bootstrap archive has no unique verified baseline result')
      verifyDigest(result)
      const name = `consumed-${digestJson([result.stagePlanDigest, result.snapshotDigest]).slice(7)}`
      const expected = seal({ stagePlanDigest: result.stagePlanDigest, snapshotDigest: result.snapshotDigest,
        resultDigest: result.digest, consumer: 'bootstrap-archive' as const, consumerDigest: next.digest })
      const frozen = await this.publication.freeze(input.roundId, name, () => expected)
      verifyDigest(frozen)
      if (canonicalJson(frozen as unknown as JsonValue) !== canonicalJson(expected as unknown as JsonValue))
        throw new ProviderProtocolError('GEPA bootstrap evidence consumption drift')
      return
    }
    if (input.publishArchive === false || input.expectedArchiveDigest === null) return
    const expected = seal({ expectedArchiveDigest: input.expectedArchiveDigest, nextArchiveDigest: next.digest,
      expectedChampionRevisionDigest: input.expectedChampionRevisionDigest,
      ...(input.nextChampion ? { nextChampion: input.nextChampion } : {}), outcome: terminal })
    const frozen = await this.publication.freeze(input.roundId, 'commit', () => expected)
    verifyDigest(frozen)
    if (canonicalJson(frozen as unknown as JsonValue) !== canonicalJson(expected as unknown as JsonValue))
      throw new ProviderProtocolError('GEPA commit intent drift')
  }
  private verifyReceipt(record: RecordValue, input: GepaPublicationInput, next: ResearchArchive): void {
    if (!record.publicationReceiptRef || record.publicationReceiptRef.schemaId !== 'gepa.publication-receipt.v1'
      || canonicalJson(this.artifacts.getJson(record.publicationReceiptRef))
        !== canonicalJson(this.receiptValue(input, next) as unknown as JsonValue))
      throw new Error('GEPA publication receipt drift')
  }
  private async checkedRecord(envelope: OperationEnvelope, input: GepaPublicationInput, next: ResearchArchive): Promise<RecordValue | null> {
    const record = await this.read(envelope)
    if (!record) return null
    if (record.stage !== 'cancelled-before-start') this.verifyReceipt(record, input, next)
    if (record.completion && canonicalJson(record.completion) !== canonicalJson(this.completion(envelope, record)))
      throw new Error('GEPA publication completion drift')
    return record
  }
  private completion(envelope: OperationEnvelope, record: RecordValue): CompletionEnvelope {
    if (!record.publicationReceiptRef) throw new Error('GEPA publication receipt missing')
    const output: GepaPublicationOutput = { outcomeRef: this.input(envelope).outcomeRef,
      publicationReceiptRef: record.publicationReceiptRef }
    return { operationId: envelope.operationId, idempotencyKey: envelope.idempotencyKey,
      inputDigest: envelope.inputDigest, implementationDigest: envelope.implementationDigest,
      outcome: { kind: 'result', value: output as unknown as JsonValue } }
  }
  private async create(envelope: OperationEnvelope, stage: RecordValue['stage'], receiptRef?: ArtifactRef): Promise<RecordValue> {
    const initial: RecordValue = { schemaVersion: 1, operationId: envelope.operationId,
      inputDigest: envelope.inputDigest, implementationDigest: envelope.implementationDigest,
      bindingDigest: envelope.bindingSetRef.digest, idempotencyKey: envelope.idempotencyKey, stage,
      ...(receiptRef ? { publicationReceiptRef: receiptRef } : {}) }
    await this.flushArtifacts()
    await this.records.create(envelope.kind, envelope.operationId, initial)
    return (await this.read(envelope))!
  }
  private async archiveState(input: GepaPublicationInput, next: ResearchArchive): Promise<'expected' | 'published'> {
    const current = await this.publication.archive()
    if (current?.digest === next.digest) return 'published'
    if ((current?.digest ?? null) === input.expectedArchiveDigest) return 'expected'
    throw new ProviderProtocolError('archive CAS conflict')
  }
  private pointerKey(input: GepaPublicationInput, terminal: SearchRoundOutcome | null): string {
    return `rounds/${input.roundId}/${terminal ? 'terminal' : 'bootstrap-publication'}`
  }
  private pointerValue(input: GepaPublicationInput, next: ResearchArchive, terminal: SearchRoundOutcome | null) {
    return terminal ?? seal({ kind: 'bootstrap-archive-publication', roundId: input.roundId,
      archiveDigest: next.digest, outcomeArtifactDigest: input.outcomeRef.digest })
  }
  private async pointerPublished(input: GepaPublicationInput, next: ResearchArchive,
    terminal: SearchRoundOutcome | null): Promise<boolean> {
    const key = this.pointerKey(input, terminal)
    const pointer = await this.publication.read<{ ref: string }>(key)
    if (!pointer) return false
    const expected = this.pointerValue(input, next, terminal)
    if (pointer.ref !== expected.digest) throw new Error('GEPA publication pointer conflict')
    const saved = await this.publication.object<typeof expected>(pointer.ref)
    if (digestJson(saved) !== digestJson(expected)) throw new Error('GEPA publication pointer drift')
    if (input.publishArchive === false) await this.publication.object<ResearchArchive>(next.digest)
    if (terminal) {
      const active = await this.publication.read<{ roundId: string | null }>('active-round')
      if (active?.roundId === input.roundId) return false
    }
    return true
  }
  private async writePointer(input: GepaPublicationInput, next: ResearchArchive,
    terminal: SearchRoundOutcome | null): Promise<void> {
    const value = this.pointerValue(input, next, terminal)
    const key = this.pointerKey(input, terminal)
    const previous = await this.publication.read<{ ref: string }>(key)
    if (previous && previous.ref !== value.digest) throw new Error('GEPA publication pointer conflict')
    await this.publication.put(value)
    if (!previous) await this.publication.write(key, { ref: value.digest })
    if (terminal) {
      const active = await this.publication.read<{ roundId: string | null }>('active-round')
      if (active?.roundId === input.roundId) await this.publication.write('active-round', { roundId: null })
    }
  }

  async inspect(envelope: OperationEnvelope): Promise<ProviderInspection> {
    const { input, next, terminal } = this.validated(envelope)
    const record = await this.checkedRecord(envelope, input, next)
    if (!record) return { status: 'not-started' }
    if (record.stage === 'cancelled-before-start') return { status: 'cancelled', releaseConfirmed: true }
    if (record.stage === 'complete') {
      if (!await this.pointerPublished(input, next, terminal)) throw new Error('GEPA completed publication pointer missing')
      return { status: 'completed', completion: record.completion! }
    }
    if (input.publishArchive === false) {
      if (await this.publication.archive()) throw new Error('failed bootstrap cannot overwrite parent archive')
      return await this.pointerPublished(input, next, terminal)
        ? { status: 'completed', completion: this.completion(envelope, record) } : { status: 'replay-safe' }
    }
    const state = await this.archiveState(input, next)
    if (state === 'expected') return { status: 'replay-safe' }
    // The archive pointer itself proves a lost CAS response. No new effect is
    // initiated from inspect; a missing compatibility pointer is replayed by submit.
    if (!input.nextChampion) return await this.pointerPublished(input, next, terminal)
      ? { status: 'completed', completion: this.completion(envelope, record) } : { status: 'replay-safe' }
    // A terminal pointer is written only after the full champion CAS. Without
    // it, the old hook's exact expected/next/round tuple is safe to reconcile.
    return await this.pointerPublished(input, next, terminal)
      ? { status: 'completed', completion: this.completion(envelope, record) } : { status: 'replay-safe' }
  }

  async submit(envelope: OperationEnvelope): Promise<ProviderSubmission> {
    const { input, next, terminal } = this.validated(envelope)
    const receiptRef = this.receipt(input, next)
    return this.writer.withWriter<ProviderSubmission>(async () => {
      const record = await this.create(envelope, 'intent', receiptRef)
      if (record.stage === 'cancelled-before-start') throw new Error('Cancelled GEPA publication cannot be submitted')
      this.verifyReceipt(record, input, next)
      if (record.stage === 'complete') {
        if (!await this.pointerPublished(input, next, terminal)) throw new Error('GEPA completed publication pointer missing')
        if (canonicalJson(record.completion) !== canonicalJson(this.completion(envelope, record)))
          throw new Error('GEPA publication completion drift')
        return { status: 'completed', completion: record.completion! }
      }
      await this.beforePublication?.()
      await this.freezeLegacyPrepublication(input, next, terminal)
      if (input.publishArchive !== false) {
        if (await this.archiveState(input, next) === 'expected') {
          try { await this.publication.casArchive(input.expectedArchiveDigest ?? undefined, next) }
          catch (error) {
            if (error instanceof Error && error.message.includes('archive CAS conflict'))
              throw new ProviderProtocolError(error.message, { cause: error })
            throw error
          }
        }
        if (await this.archiveState(input, next) !== 'published') throw new Error('GEPA archive publication unresolved')
      } else {
        if (await this.publication.archive()) throw new Error('failed bootstrap cannot overwrite parent archive')
        // An unsuccessful bootstrap is terminal evidence, not an installed parent.
        // Its immutable research object remains readable by the legacy outcome.
        await this.publication.put(next)
      }
      if (input.nextChampion) {
        try { await this.hooks.commitChampion(input.expectedChampionRevisionDigest, input.nextChampion, input.roundId) }
        catch (error) {
          if (error instanceof Error && error.message.includes('champion revision CAS conflict'))
            throw new ProviderProtocolError(error.message, { cause: error })
          throw error
        }
      }
      await this.writePointer(input, next, terminal)
      if (!await this.pointerPublished(input, next, terminal)) throw new Error('GEPA publication pointer unresolved')
      const completion = this.completion(envelope, record)
      await this.flushArtifacts()
      await this.records.write(envelope.kind, envelope.operationId, { ...record, stage: 'complete', completion })
      return { status: 'completed', completion }
    }).catch(error => {
      if (error instanceof ProviderProtocolError) throw error
      throw new ProviderReconcileError(error instanceof Error ? error.message : String(error), { cause: error })
    })
  }

  async cancel(envelope: OperationEnvelope): Promise<ProviderInspection> {
    const { input, next, terminal } = this.validated(envelope)
    return this.writer.withWriter(async () => {
      const record = await this.create(envelope, 'cancelled-before-start')
      if (record.stage === 'cancelled-before-start') return { status: 'cancelled', releaseConfirmed: true }
      this.verifyReceipt(record, input, next)
      if (record.stage === 'complete') {
        if (!await this.pointerPublished(input, next, terminal)) throw new Error('GEPA completed publication pointer missing')
        return { status: 'completed', completion: record.completion! }
      }
      // A published archive is only the first part of champion promotion.
      // Cancellation cannot assert a terminal outcome before that CAS settles.
      if (input.nextChampion) return { status: 'unknown' }
      if (input.publishArchive !== false && await this.archiveState(input, next) === 'published') {
        await this.beforePublication?.()
        await this.freezeLegacyPrepublication(input, next, terminal)
        await this.writePointer(input, next, terminal)
        const completion = this.completion(envelope, record)
        await this.flushArtifacts()
        await this.records.write(envelope.kind, envelope.operationId, { ...record, stage: 'complete', completion })
        return { status: 'completed', completion }
      }
      if (await this.pointerPublished(input, next, terminal))
        return { status: 'completed', completion: this.completion(envelope, record) }
      await this.records.write(envelope.kind, envelope.operationId, { ...record, stage: 'cancelled-before-start' })
      return { status: 'cancelled', releaseConfirmed: true }
    })
  }
  async collect(envelope: OperationEnvelope): Promise<CompletionEnvelope> {
    const inspected = await this.inspect(envelope)
    if (inspected.status !== 'completed') throw new Error(`GEPA publication unavailable: ${inspected.status}`)
    return inspected.completion
  }
}
