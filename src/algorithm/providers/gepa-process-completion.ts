import { FileArtifactStore } from '../artifacts.js'
import { BindingStore } from '../bindings.js'
import type { ArtifactRef, CompletionEnvelope, OperationEnvelope, OperationProvider, ProviderInspection,
  ProviderManifest, ProviderSubmission } from '../contracts.js'
import { ProviderProtocolError, ProviderReconcileError } from '../provider-errors.js'
import { implementationClosureDigest } from '../data/identity.js'
import { FileProviderRecordBackend, type ArtifactCheckpoint, type ProviderRecordBackend } from '../runtime/persistence.js'
import { jsonDigest, type JsonValue } from '../schema.js'
import { assertCell, assertConsistentCells, cellKey, validOutcome, verifyCells } from '../../search/evidence.js'
import { digest, safeId, SearchProtocolError, verifyDigest } from '../../search/contracts.js'
import { budgetFailure, SearchExecutionFailure, searchDeadline } from '../../search/recovery.js'
import type { EvidenceCell, SearchProvider, StageResult } from '../../search/types.js'
import type { SearchJournal } from '../../search/store.js'
import { digestJson } from '../../state/digest.js'
import type { GepaPhysicalEvaluation } from './gepa-repair-evaluation.js'

export type GepaProcessCompletionInput = {
  roundIdentity: { evolutionId: string; roundId: string }
  repairId: string; currentRef: ArtifactRef; cachedRef: ArtifactRef
  evaluationRef?: ArtifactRef; evaluationOperationId?: string
  baseKey: string; cellRef: ArtifactRef; deadlineAt: number
}
export type GepaProcessCompletionOutput = { executionRef: ArtifactRef }
type RecordValue = { schemaVersion: 1; operationId: string; inputDigest: string; implementationDigest: string;
  bindingDigest: string; externalKey: string; stage: 'intent' | 'complete' | 'cancelled-before-start';
  effectStarted: boolean; pendingReason?: string; pendingState?: GepaProcessPendingState['state'];
  pendingHandle?: string; completion?: CompletionEnvelope }
export type GepaProcessPendingState = { state: 'running' | 'unknown' | 'not-started' | 'partially-complete';
  reason: string; handle?: string }
type EvaluationRecord = { externalKey: string; bindingDigest: string; stage: string; completion?: CompletionEnvelope }

/** Completes exactly one original-run projection with its old physical key. */
export class GepaProcessCompletionProvider implements OperationProvider {
  private readonly records: ProviderRecordBackend
  private readonly manifest: ProviderManifest
  private readonly physicalIdentity: string
  private readonly attemptedThisInvocation = new Set<string>()
  private legacyInvocationEnabled = false
  private invocation: { runSignal: AbortSignal; inspectSignal: AbortSignal; dispose(): void } | undefined
  constructor(root: string, readonly artifacts: FileArtifactStore, readonly bindings: BindingStore,
    readonly physical: SearchProvider, records?: ProviderRecordBackend, readonly legacyJournal?: SearchJournal) {
    this.records = records ?? new FileProviderRecordBackend(root)
    this.physicalIdentity = digestJson([physical.integrity, physical.capabilities,
      !!physical.completeProcess, !!physical.inspectProcess])
    const persistenceIdentity = 'identityDigest' in this.records ? this.records.identityDigest : null
    this.manifest = { kind: 'gepa.process-complete', implementationDigest: implementationClosureDigest(
      ['providers/gepa-process-completion'], { physicalIdentity: this.physicalIdentity,
        persistenceIdentity, legacyCache: !!legacyJournal }),
    inputSchema: { type: 'object', required: ['roundIdentity', 'repairId', 'currentRef', 'cachedRef', 'baseKey',
      'cellRef', 'deadlineAt'], properties: {
      roundIdentity: { type: 'object', required: ['evolutionId', 'roundId'], properties: {
        evolutionId: { type: 'string' }, roundId: { type: 'string' } }, additionalProperties: false },
      repairId: { type: 'string' }, currentRef: { type: 'any' }, cachedRef: { type: 'any' },
      evaluationRef: { type: 'any' }, evaluationOperationId: { type: 'string' },
      baseKey: { type: 'string' }, cellRef: { type: 'any' }, deadlineAt: { type: 'integer' },
    }, additionalProperties: false },
    outputSchema: { type: 'object', required: ['executionRef'], properties: { executionRef: { type: 'any' } },
      additionalProperties: false }, meteredDimensions: [], execution: 'external', supportsInspect: true,
    supportsIdempotentReplay: true }
  }
  describe(): ProviderManifest { return structuredClone(this.manifest) }
  beginLegacyInvocation(context?: { callerSignal: AbortSignal; deadlineAt: number }): () => void {
    this.invocation?.dispose()
    this.legacyInvocationEnabled = true
    this.attemptedThisInvocation.clear()
    const timed = context ? searchDeadline(context.callerSignal, context.deadlineAt) : undefined
    const invocation = context && timed ? { runSignal: timed.signal, inspectSignal: context.callerSignal,
      dispose: () => timed.dispose() } : undefined
    this.invocation = invocation
    return () => {
      if (this.invocation === invocation) {
        invocation?.dispose()
        this.invocation = undefined
        this.legacyInvocationEnabled = false
        this.attemptedThisInvocation.clear()
      }
    }
  }
  private physicalSignal(): AbortSignal { return this.invocation?.runSignal ?? new AbortController().signal }
  private inspectionSignal(): AbortSignal {
    const signal = this.invocation?.inspectSignal ?? new AbortController().signal
    signal.throwIfAborted()
    return signal
  }
  private input(envelope: OperationEnvelope): GepaProcessCompletionInput {
    return envelope.input as unknown as GepaProcessCompletionInput
  }
  private async flushArtifacts(): Promise<void> {
    await (this.artifacts as FileArtifactStore & Partial<ArtifactCheckpoint>).flush?.()
  }
  private key(input: GepaProcessCompletionInput, base: EvidenceCell): string {
    return digestJson([input.baseKey, base.digest])
  }
  private async checked(envelope: OperationEnvelope): Promise<{ input: GepaProcessCompletionInput; base: EvidenceCell }> {
    if (envelope.kind !== this.manifest.kind || envelope.implementationDigest !== this.manifest.implementationDigest
      || envelope.inputDigest !== jsonDigest(envelope.input) || envelope.idempotencyKey !== envelope.operationId
      || Object.keys(envelope.limits).length)
      throw new ProviderProtocolError('GEPA process operation identity drift')
    const input = this.input(envelope)
    safeId(input.roundIdentity.roundId); safeId(input.repairId)
    if (!input.roundIdentity.evolutionId || !Number.isSafeInteger(input.deadlineAt) || input.deadlineAt < 0)
      throw new ProviderProtocolError('GEPA process identity or deadline invalid')
    digest(input.baseKey)
    if (input.currentRef.schemaId !== 'gepa.stage-result.v1' || input.cachedRef.schemaId !== 'gepa.cached-cells.v1'
      || input.cellRef.schemaId !== 'gepa.evidence-cell.v1'
      || !!input.evaluationRef !== !!input.evaluationOperationId)
      throw new ProviderProtocolError('GEPA process source schema invalid')
    const current = this.artifacts.getJson(input.currentRef) as unknown as StageResult
    const cached = this.artifacts.getJson(input.cachedRef) as unknown as { schemaVersion: number; cells: EvidenceCell[] }
    const base = this.artifacts.getJson(input.cellRef) as unknown as EvidenceCell
    verifyDigest(current); verifyDigest(base)
    if (cached.schemaVersion !== 1 || !Array.isArray(cached.cells) || !validOutcome(base)
      || input.baseKey !== digestJson([input.roundIdentity.roundId, input.repairId, current.digest]))
      throw new ProviderProtocolError('GEPA process source identity drift')
    const currentMember = current.cells.some(cell => cell.digest === base.digest)
    const cachedMember = cached.cells.some(cell => cell.digest === base.digest)
    if (cachedMember) {
      if (!this.legacyJournal) throw new ProviderProtocolError('GEPA cached process source requires global journal')
      const pointer = await this.legacyJournal.read<{ ref: string }>(`cells/${cellKey(base.identity).slice(7)}`)
      if (pointer?.ref !== base.digest) throw new ProviderProtocolError('GEPA cached process source pointer changed')
      const saved = await this.legacyJournal.object<EvidenceCell>(pointer.ref)
      verifyDigest(saved)
      if (saved.digest !== base.digest) throw new ProviderProtocolError('GEPA cached process source drift')
    }
    let evaluatedMember = false
    if (input.evaluationRef && input.evaluationOperationId) {
      if (input.evaluationRef.schemaId !== 'gepa.physical-evaluation.v1')
        throw new ProviderProtocolError('GEPA process evaluation source schema invalid')
      const record = await this.records.read<EvaluationRecord>('gepa.repair-evaluate', input.evaluationOperationId)
      const output = record?.completion?.outcome
      const ref = output?.kind === 'result' ? (output.value as unknown as { executionRef?: ArtifactRef }).executionRef : undefined
      if (record?.stage !== 'complete' || record.externalKey !== input.baseKey
        || record.bindingDigest !== envelope.bindingSetRef.digest || ref?.digest !== input.evaluationRef.digest)
        throw new ProviderProtocolError('GEPA process evaluation source is not a settled repair')
      const evidence = this.artifacts.getJson(input.evaluationRef) as unknown as GepaPhysicalEvaluation
      if (evidence.schemaVersion !== 1 || !Array.isArray(evidence.cells))
        throw new ProviderProtocolError('GEPA process evaluation evidence malformed')
      evaluatedMember = evidence.cells.some(cell => cell.digest === base.digest)
    }
    if (!currentMember && !cachedMember && !evaluatedMember)
      throw new ProviderProtocolError('GEPA process cell is not part of this repair')
    if (!await verifyCells(this.physical, [{ cell: base, identity: base.identity }]))
      throw new ProviderProtocolError('GEPA process source provenance rejected')
    if (digestJson([this.physical.integrity, this.physical.capabilities,
      !!this.physical.completeProcess, !!this.physical.inspectProcess]) !== this.physicalIdentity
      || !this.physical.completeProcess || !this.physical.capabilities.idempotentExecution)
      throw new ProviderProtocolError('GEPA process provider identity or capability drift')
    this.bindings.read(envelope.bindingSetRef)
    return { input, base }
  }
  async preflight(envelope: OperationEnvelope): Promise<void> { await this.checked(envelope) }
  private async read(envelope: OperationEnvelope, input: GepaProcessCompletionInput, base: EvidenceCell): Promise<RecordValue | undefined> {
    const record = await this.records.read<RecordValue>(this.manifest.kind, envelope.operationId)
    if (record && (record.schemaVersion !== 1 || record.operationId !== envelope.operationId
      || record.inputDigest !== envelope.inputDigest || record.implementationDigest !== envelope.implementationDigest
      || record.bindingDigest !== envelope.bindingSetRef.digest || record.externalKey !== this.key(input, base)
      || !['intent', 'complete', 'cancelled-before-start'].includes(record.stage)
      || typeof record.effectStarted !== 'boolean'
      || record.pendingReason !== undefined && typeof record.pendingReason !== 'string'
      || record.pendingState !== undefined && !['running', 'unknown', 'not-started', 'partially-complete'].includes(record.pendingState)
      || record.pendingHandle !== undefined && typeof record.pendingHandle !== 'string'
      || record.stage === 'complete' && !record.completion))
      throw new ProviderProtocolError('GEPA process record drift')
    return record
  }
  private async inspectPhysical(base: EvidenceCell, key: string) {
    return this.physical.inspectProcess?.(base, key, this.inspectionSignal())
  }
  async inspect(envelope: OperationEnvelope): Promise<ProviderInspection> {
    const { input, base } = await this.checked(envelope)
    const record = await this.read(envelope, input, base)
    if (!record) return { status: 'not-started' }
    if (record.stage === 'cancelled-before-start') return { status: 'cancelled', releaseConfirmed: true }
    if (record.completion) return { status: 'completed', completion: record.completion }
    if (this.legacyInvocationEnabled && this.attemptedThisInvocation.has(envelope.operationId)) return { status: 'running' }
    if (!record.effectStarted) return { status: 'replay-safe' }
    if (this.legacyInvocationEnabled && Date.now() < input.deadlineAt) return { status: 'replay-safe' }
    const observed = await this.inspectPhysical(base, record.externalKey)
    if (observed?.status === 'complete') return { status: 'replay-safe' }
    if (Date.now() < input.deadlineAt) return { status: 'replay-safe' }
    if (observed?.status === 'running') return { status: 'running', handle: observed.handle }
    return { status: 'unknown' }
  }
  /** Read-only compatibility view; the repair facade writes the old journal marker. */
  async legacyPending(envelope: OperationEnvelope): Promise<GepaProcessPendingState | null> {
    const { input, base } = await this.checked(envelope)
    const record = await this.read(envelope, input, base)
    if (!record || record.completion || record.stage === 'cancelled-before-start') return null
    const fallback = record.pendingReason ?? 'deadline reached while external execution was unresolved'
    if (record.pendingState) return { state: record.pendingState, reason: fallback,
      ...(record.pendingHandle ? { handle: record.pendingHandle } : {}) }
    let observed: Awaited<ReturnType<NonNullable<SearchProvider['inspectProcess']>>> | undefined
    try { observed = await this.inspectPhysical(base, record.externalKey) }
    catch (error) {
      if (error instanceof SearchProtocolError) throw new ProviderProtocolError(error.message, { cause: error })
      return { state: 'unknown', reason: error instanceof Error ? error.message : String(error) }
    }
    if (observed?.status === 'complete') return null
    if (observed?.status === 'running') return { state: 'running', handle: observed.handle, reason: fallback }
    if (observed?.status === 'partially-complete') return { state: 'partially-complete',
      reason: 'completed evaluation cells are saved; remaining batches have not started' }
    if (observed?.status === 'not-started') return { state: 'not-started', reason: fallback }
    return { state: 'unknown', reason: observed?.status === 'unknown' ? observed.reason ?? fallback : fallback }
  }
  private async rememberPending(envelope: OperationEnvelope, record: RecordValue,
    reason: string, observed?: Awaited<ReturnType<NonNullable<SearchProvider['inspectProcess']>>>): Promise<ProviderSubmission> {
    const state: GepaProcessPendingState['state'] = observed?.status === 'running' ? 'running'
      : observed?.status === 'partially-complete' ? 'partially-complete'
        : observed?.status === 'not-started' ? 'not-started' : 'unknown'
    const pendingReason = observed?.status === 'unknown' ? observed.reason ?? reason : reason
    try { await this.records.write(this.manifest.kind, envelope.operationId, {
      ...record, pendingReason, pendingState: state,
      ...(observed?.status === 'running' ? { pendingHandle: observed.handle } : {}) }) }
    catch (error) { throw new ProviderReconcileError(error instanceof Error ? error.message : String(error), { cause: error }) }
    return observed?.status === 'running' ? { status: 'running', handle: observed.handle } : { status: 'running' }
  }
  private async complete(envelope: OperationEnvelope, record: RecordValue, base: EvidenceCell,
    value: GepaPhysicalEvaluation): Promise<CompletionEnvelope> {
    if (value.schemaVersion !== 1 || !Array.isArray(value.cells) || value.cells.length > 1)
      throw new ProviderProtocolError('GEPA process completion cardinality invalid')
    for (const cell of value.cells) {
      assertCell(cell, base.identity)
      if (!validOutcome(cell)) throw new ProviderProtocolError('GEPA process completion lost valid outcome')
      assertConsistentCells(base, cell)
      if (!await verifyCells(this.physical, [{ cell, identity: base.identity }]))
        throw new ProviderProtocolError('GEPA process completion provenance rejected')
    }
    try {
      const executionRef = this.artifacts.putJson(value as unknown as JsonValue, 'gepa.physical-evaluation.v1')
      await this.flushArtifacts()
      const completion: CompletionEnvelope = { operationId: envelope.operationId, idempotencyKey: envelope.idempotencyKey,
        inputDigest: envelope.inputDigest, implementationDigest: envelope.implementationDigest,
        outcome: { kind: 'result', value: { executionRef } } }
      await this.records.write(this.manifest.kind, envelope.operationId, { ...record, stage: 'complete', completion })
      return completion
    } catch (error) {
      if (error instanceof ProviderProtocolError) throw error
      throw new ProviderReconcileError(error instanceof Error ? error.message : String(error), { cause: error })
    }
  }
  async submit(envelope: OperationEnvelope): Promise<ProviderSubmission> {
    const { input, base } = await this.checked(envelope)
    const initial: RecordValue = { schemaVersion: 1, operationId: envelope.operationId,
      inputDigest: envelope.inputDigest, implementationDigest: envelope.implementationDigest,
      bindingDigest: envelope.bindingSetRef.digest, externalKey: this.key(input, base), stage: 'intent', effectStarted: false }
    await this.flushArtifacts()
    await this.records.create(this.manifest.kind, envelope.operationId, initial)
    const record = (await this.read(envelope, input, base))!
    if (record.stage === 'cancelled-before-start') throw new ProviderProtocolError('Cancelled GEPA process cannot be submitted')
    if (record.completion) return { status: 'completed', completion: record.completion }
    if (this.legacyInvocationEnabled && this.attemptedThisInvocation.has(envelope.operationId)) return { status: 'running' }
    let observed: Awaited<ReturnType<NonNullable<SearchProvider['inspectProcess']>>> | undefined
    if (record.effectStarted && this.physical.inspectProcess
      && (!this.legacyInvocationEnabled || Date.now() >= input.deadlineAt)) {
      try { observed = await this.inspectPhysical(base, record.externalKey) }
      catch (error) {
        if (error instanceof SearchExecutionFailure) return { status: 'completed', completion: await this.complete(envelope,
          record, base, { schemaVersion: 1, cells: error.cells, failure: error.failure }) }
        if (error instanceof SearchProtocolError) throw new ProviderProtocolError(error.message, { cause: error })
      }
    }
    if (observed?.status === 'complete') return { status: 'completed', completion: await this.complete(envelope,
      record, base, { schemaVersion: 1, cells: observed.result.cells }) }
    if (Date.now() >= input.deadlineAt) {
      if (!record.effectStarted || observed?.status === 'not-started') return { status: 'completed', completion: await this.complete(envelope,
        record, base, { schemaVersion: 1, cells: [], failure: budgetFailure('time') }) }
      if (observed?.status === 'partially-complete') return { status: 'completed', completion: await this.complete(envelope,
        record, base, { schemaVersion: 1, cells: observed.cells, failure: budgetFailure('time') }) }
      return { status: 'running' }
    }
    if (!record.effectStarted) {
      record.effectStarted = true
      await this.records.write(this.manifest.kind, envelope.operationId, record)
    }
    let cell: EvidenceCell
    try {
      if (this.legacyInvocationEnabled) this.attemptedThisInvocation.add(envelope.operationId)
      cell = await this.physical.completeProcess!(base, record.externalKey, this.physicalSignal())
    } catch (error) {
      this.inspectionSignal()
      if (error instanceof SearchExecutionFailure) return { status: 'completed', completion: await this.complete(envelope,
        record, base, { schemaVersion: 1, cells: error.cells, failure: error.failure }) }
      if (error instanceof ProviderProtocolError) throw error
      if (error instanceof SearchProtocolError) throw new ProviderProtocolError(error.message, { cause: error })
      let reason = error instanceof Error ? error.message : String(error)
      let inspected: Awaited<ReturnType<NonNullable<SearchProvider['inspectProcess']>>> | undefined
      try {
        inspected = await this.inspectPhysical(base, record.externalKey)
      } catch (inspectionError) {
        if (inspectionError instanceof SearchExecutionFailure) return { status: 'completed', completion: await this.complete(envelope,
          record, base, { schemaVersion: 1, cells: inspectionError.cells, failure: inspectionError.failure }) }
        if (inspectionError instanceof SearchProtocolError)
          throw new ProviderProtocolError(inspectionError.message, { cause: inspectionError })
        reason = inspectionError instanceof Error ? inspectionError.message : String(inspectionError)
      }
      if (inspected?.status === 'complete') return { status: 'completed', completion: await this.complete(envelope,
        record, base, { schemaVersion: 1, cells: inspected.result.cells }) }
      return this.rememberPending(envelope, record, reason, inspected)
    }
    return { status: 'completed', completion: await this.complete(envelope,
      record, base, { schemaVersion: 1, cells: [cell] }) }
  }
  async cancel(envelope: OperationEnvelope): Promise<ProviderInspection> {
    const { input, base } = await this.checked(envelope)
    const initial: RecordValue = { schemaVersion: 1, operationId: envelope.operationId,
      inputDigest: envelope.inputDigest, implementationDigest: envelope.implementationDigest,
      bindingDigest: envelope.bindingSetRef.digest, externalKey: this.key(input, base),
      stage: 'cancelled-before-start', effectStarted: false }
    await this.flushArtifacts()
    await this.records.create(this.manifest.kind, envelope.operationId, initial)
    const record = (await this.read(envelope, input, base))!
    if (record.stage === 'cancelled-before-start') return { status: 'cancelled', releaseConfirmed: true }
    if (record.completion) return { status: 'completed', completion: record.completion }
    return { status: 'unknown' }
  }
  async collect(envelope: OperationEnvelope): Promise<CompletionEnvelope> {
    const observed = await this.inspect(envelope)
    if (observed.status !== 'completed') throw new Error(`GEPA process result unavailable: ${observed.status}`)
    return observed.completion
  }
}
