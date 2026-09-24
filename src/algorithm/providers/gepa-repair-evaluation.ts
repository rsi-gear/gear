import { FileArtifactStore } from '../artifacts.js'
import { BindingStore } from '../bindings.js'
import type { ArtifactRef, CompletionEnvelope, OperationEnvelope, OperationProvider, ProviderInspection,
  ProviderManifest, ProviderSubmission, UsageReceipt } from '../contracts.js'
import { ProviderProtocolError, ProviderReconcileError } from '../provider-errors.js'
import { implementationClosureDigest } from '../data/identity.js'
import { FileProviderRecordBackend, type ArtifactCheckpoint, type ProviderRecordBackend } from '../runtime/persistence.js'
import { jsonDigest, type JsonValue } from '../schema.js'
import { assertCell, assertConsistentCells, cellKey, plannedCells, validOutcome, verifyCells } from '../../search/evidence.js'
import { budgetFailure, SearchExecutionFailure, searchDeadline } from '../../search/recovery.js'
import { safeId, SearchProtocolError, verifyDigest, validateSnapshot } from '../../search/contracts.js'
import type { CellIdentity, EvidenceCell, SearchProvider, SearchStageFailure, Snapshot,
  StageEvaluationPlan, StageResult, TaskUniverse } from '../../search/types.js'
import { digestJson } from '../../state/digest.js'

export type GepaRepairEvaluationInput = {
  roundIdentity: { evolutionId: string; roundId: string }
  repairId: string
  originalRef: ArtifactRef
  currentRef: ArtifactRef
  cachedRef: ArtifactRef
  plan: StageEvaluationPlan
  snapshot: Snapshot
  universe: TaskUniverse
  missing: CellIdentity[]
  deadlineAt: number
}
export type GepaPhysicalEvaluation = { schemaVersion: 1; cells: EvidenceCell[]; failure?: SearchStageFailure }
export type GepaRepairEvaluationOutput = { executionRef: ArtifactRef }

type RecordValue = { schemaVersion: 1; operationId: string; inputDigest: string; implementationDigest: string;
  bindingDigest: string; externalKey: string; stage: 'started' | 'complete' | 'cancelled-before-start';
  effectStarted: boolean; pendingReason?: string; pendingState?: GepaRepairPendingState['state'];
  pendingHandle?: string; completion?: CompletionEnvelope }
export type GepaRepairPendingState = { state: 'running' | 'unknown' | 'not-started' | 'partially-complete';
  reason: string; handle?: string }

/** One repairId, one original physical key, and one frozen subset of missing cells. */
export class GepaRepairEvaluationProvider implements OperationProvider {
  private readonly manifest: ProviderManifest
  private readonly records: ProviderRecordBackend
  private readonly physicalIdentity: string
  private readonly attemptedThisInvocation = new Set<string>()
  private legacyInvocationEnabled = false
  private invocation: { runSignal: AbortSignal; inspectSignal: AbortSignal; dispose(): void } | undefined
  constructor(root: string, readonly artifacts: FileArtifactStore, readonly bindings: BindingStore,
    readonly physical: SearchProvider, records?: ProviderRecordBackend) {
    this.records = records ?? new FileProviderRecordBackend(root)
    this.physicalIdentity = digestJson([physical.integrity, physical.capabilities])
    const persistenceIdentity = 'identityDigest' in this.records ? this.records.identityDigest : null
    this.manifest = { kind: 'gepa.repair-evaluate', implementationDigest: implementationClosureDigest(
      ['providers/gepa-repair-evaluation'], { physicalIdentity: this.physicalIdentity, persistenceIdentity }),
    inputSchema: { type: 'object', required: ['roundIdentity', 'repairId', 'originalRef', 'currentRef',
      'cachedRef', 'plan', 'snapshot', 'universe', 'missing', 'deadlineAt'], properties: {
      roundIdentity: { type: 'object', required: ['evolutionId', 'roundId'], properties: {
        evolutionId: { type: 'string' }, roundId: { type: 'string' } }, additionalProperties: false },
      repairId: { type: 'string' }, originalRef: { type: 'any' }, currentRef: { type: 'any' }, cachedRef: { type: 'any' },
      plan: { type: 'any' }, snapshot: { type: 'any' }, universe: { type: 'any' },
      missing: { type: 'array', items: { type: 'any' } }, deadlineAt: { type: 'integer' },
    }, additionalProperties: false },
    outputSchema: { type: 'object', required: ['executionRef'], properties: { executionRef: { type: 'any' } },
      additionalProperties: false }, meteredDimensions: ['rolloutCells', 'repairCells'], hardLimitDimensions: [],
    execution: 'external', supportsInspect: true, supportsIdempotentReplay: true }
  }
  describe(): ProviderManifest { return structuredClone(this.manifest) }
  /** Reset only for a new explicit public repair call, never between auxiliary kernel ticks. */
  beginLegacyInvocation(context?: { callerSignal: AbortSignal; deadlineAt: number }): () => void {
    this.invocation?.dispose()
    this.attemptedThisInvocation.clear()
    this.legacyInvocationEnabled = true
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
  private input(envelope: OperationEnvelope): GepaRepairEvaluationInput {
    return envelope.input as unknown as GepaRepairEvaluationInput
  }
  private key(input: GepaRepairEvaluationInput, current: StageResult): string {
    return digestJson([input.roundIdentity.roundId, input.repairId, current.digest])
  }
  private async flushArtifacts(): Promise<void> {
    await (this.artifacts as FileArtifactStore & Partial<ArtifactCheckpoint>).flush?.()
  }
  private async read(envelope: OperationEnvelope): Promise<RecordValue | undefined> {
    const record = await this.records.read<RecordValue>(this.manifest.kind, envelope.operationId)
    if (record && (record.schemaVersion !== 1 || record.operationId !== envelope.operationId
      || record.inputDigest !== envelope.inputDigest || record.implementationDigest !== envelope.implementationDigest
      || record.bindingDigest !== envelope.bindingSetRef.digest
      || record.externalKey !== this.key(this.input(envelope), this.current(envelope))
      || !['started', 'complete', 'cancelled-before-start'].includes(record.stage)
      || typeof record.effectStarted !== 'boolean'
      || record.pendingReason !== undefined && typeof record.pendingReason !== 'string'
      || record.pendingState !== undefined && !['running', 'unknown', 'not-started', 'partially-complete'].includes(record.pendingState)
      || record.pendingHandle !== undefined && typeof record.pendingHandle !== 'string'
      || record.stage === 'complete' && !record.completion)) throw new ProviderProtocolError('GEPA repair record drift')
    return record
  }
  private original(envelope: OperationEnvelope): StageResult {
    const ref = this.input(envelope).originalRef
    if (ref.schemaId !== 'gepa.stage-result.v1') throw new ProviderProtocolError('GEPA original repair evidence schema mismatch')
    const value = this.artifacts.getJson(ref) as unknown as StageResult
    verifyDigest(value)
    return value
  }
  private current(envelope: OperationEnvelope): StageResult {
    const ref = this.input(envelope).currentRef
    if (ref.schemaId !== 'gepa.stage-result.v1') throw new ProviderProtocolError('GEPA current repair evidence schema mismatch')
    const value = this.artifacts.getJson(ref) as unknown as StageResult
    verifyDigest(value)
    return value
  }
  private async checked(envelope: OperationEnvelope): Promise<{ input: GepaRepairEvaluationInput; current: StageResult }> {
    if (envelope.kind !== this.manifest.kind || envelope.implementationDigest !== this.manifest.implementationDigest
      || envelope.inputDigest !== jsonDigest(envelope.input) || envelope.idempotencyKey !== envelope.operationId)
      throw new ProviderProtocolError('GEPA repair operation identity drift')
    const input = this.input(envelope)
    safeId(input.roundIdentity.roundId); safeId(input.repairId)
    if (typeof input.roundIdentity.evolutionId !== 'string' || !input.roundIdentity.evolutionId
      || !Number.isSafeInteger(input.deadlineAt) || input.deadlineAt < 0)
      throw new ProviderProtocolError('GEPA repair identity or deadline invalid')
    for (const value of [input.plan, input.universe]) verifyDigest(value)
    validateSnapshot(input.snapshot)
    const original = this.original(envelope), current = this.current(envelope)
    if (original.stagePlanDigest !== input.plan.digest || current.stagePlanDigest !== input.plan.digest
      || original.snapshotDigest !== input.snapshot.digest || current.snapshotDigest !== input.snapshot.digest
      || input.plan.universeDigest !== input.universe.digest || input.plan.partition !== input.universe.partition
      || !input.plan.participantIds.includes(input.snapshot.candidateId))
      throw new ProviderProtocolError('GEPA repair stage binding mismatch')
    const harnessRef = this.bindings.read(envelope.bindingSetRef).slots.harness
    const harness = harnessRef ? this.artifacts.getJson(harnessRef) as Record<string, unknown> : undefined
    if (harness?.commitOid !== input.snapshot.commit || harness.manifestDigest !== input.snapshot.manifestDigest)
      throw new ProviderProtocolError('GEPA repair harness binding mismatch')
    const expected = plannedCells(input.universe, input.plan, input.snapshot)
    const byKey = new Map(expected.map(identity => [cellKey(identity), identity]))
    const cachedRecord = this.artifacts.getJson(input.cachedRef) as unknown as { schemaVersion: number; cells: EvidenceCell[] }
    if (input.cachedRef.schemaId !== 'gepa.cached-cells.v1' || cachedRecord.schemaVersion !== 1
      || !Array.isArray(cachedRecord.cells)) throw new ProviderProtocolError('GEPA repair cached evidence schema mismatch')
    const seen = new Set<string>()
    for (const cell of [...original.cells, ...current.cells, ...cachedRecord.cells]) {
      const key = cellKey(cell.identity), identity = byKey.get(key)
      if (!identity) throw new ProviderProtocolError('GEPA repair contains unplanned evidence')
      assertCell(cell, identity)
      if (current.cells.includes(cell) || cachedRecord.cells.includes(cell)) {
        if (seen.has(`${key}:${cell.digest}`)) throw new ProviderProtocolError('GEPA duplicate current/cached evidence')
        seen.add(`${key}:${cell.digest}`)
      }
    }
    const originalByKey = new Map(original.cells.map(cell => [cellKey(cell.identity), cell]))
    for (const cell of current.cells) {
      const prior = originalByKey.get(cellKey(cell.identity))
      if (prior && validOutcome(prior) && validOutcome(cell)) assertConsistentCells(prior, cell)
    }
    const reusable = [...current.cells, ...cachedRecord.cells].filter(validOutcome)
    if (!await verifyCells(this.physical, reusable.map(cell => ({ cell, identity: byKey.get(cellKey(cell.identity))! }))))
      throw new ProviderProtocolError('GEPA reusable repair evidence provenance rejected')
    const valid = new Set(reusable.map(cell => cellKey(cell.identity)))
    const missing = expected.filter(identity => !valid.has(cellKey(identity)))
    if (digestJson(missing) !== digestJson(input.missing)) throw new ProviderProtocolError('GEPA repair missing subset drift')
    if (envelope.limits.rolloutCells !== missing.length || envelope.limits.repairCells !== missing.length
      || Object.keys(envelope.limits).length !== 2)
      throw new ProviderProtocolError('GEPA repair reservation does not match frozen missing cells')
    if (digestJson([this.physical.integrity, this.physical.capabilities]) !== this.physicalIdentity
      || !this.physical.capabilities.taskSubsetPlans || !this.physical.capabilities.batchIndependentCells
      || !this.physical.capabilities.idempotentExecution
      || digestJson(await this.physical.describe(input.universe.partition)) !== digestJson(input.universe))
      throw new ProviderProtocolError('GEPA repair physical provider identity or capability drift')
    return { input, current }
  }
  async preflight(envelope: OperationEnvelope): Promise<void | { startsBudgetClock: boolean }> {
    await this.checked(envelope)
    return Date.now() >= this.input(envelope).deadlineAt ? { startsBudgetClock: false } : undefined
  }
  async prepareForDispatch(envelope: OperationEnvelope): Promise<{ startsBudgetClock: boolean }> {
    const { input, current } = await this.checked(envelope)
    const initial: RecordValue = { schemaVersion: 1, operationId: envelope.operationId,
      inputDigest: envelope.inputDigest, implementationDigest: envelope.implementationDigest,
      bindingDigest: envelope.bindingSetRef.digest, externalKey: this.key(input, current),
      stage: 'started', effectStarted: false }
    await this.flushArtifacts()
    await this.records.create(this.manifest.kind, envelope.operationId, initial)
    await this.read(envelope)
    return { startsBudgetClock: envelope.startsBudgetClock === true && Date.now() < input.deadlineAt }
  }
  private receipt(envelope: OperationEnvelope, amount: number): UsageReceipt {
    const cumulative = { rolloutCells: amount, repairCells: amount }
    return { source: 'gepa.evaluate', scope: 'operation', operationId: envelope.operationId,
      cursor: digestJson(cumulative), cumulative }
  }
  private async complete(envelope: OperationEnvelope, record: RecordValue,
    value: GepaPhysicalEvaluation, amount: number): Promise<CompletionEnvelope> {
    const { input } = await this.checked(envelope)
    const expected = new Map(input.missing.map(identity => [cellKey(identity), identity]))
    if (value.schemaVersion !== 1 || !Array.isArray(value.cells)) throw new ProviderProtocolError('GEPA repair execution schema invalid')
    const seen = new Set<string>()
    for (const cell of value.cells) {
      const key = cellKey(cell.identity), identity = expected.get(key)
      if (!identity || seen.has(key)) throw new ProviderProtocolError('GEPA repair returned duplicate or unrequested cell')
      seen.add(key); assertCell(cell, identity)
    }
    if (!await verifyCells(this.physical, value.cells.map(cell => ({ cell, identity: expected.get(cellKey(cell.identity))! }))))
      throw new ProviderProtocolError('GEPA repair cell provenance rejected')
    if (value.failure && (value.failure.kind !== 'execution-failure' && value.failure.kind !== 'budget-exhausted'
      || !value.failure.code || !value.failure.message || value.failure.kind === 'execution-failure' && !value.failure.evidenceRef))
      throw new ProviderProtocolError('GEPA repair failure provenance invalid')
    try {
      const executionRef = this.artifacts.putJson(value as unknown as JsonValue, 'gepa.physical-evaluation.v1')
      await this.flushArtifacts()
      const completion: CompletionEnvelope = { operationId: envelope.operationId, idempotencyKey: envelope.idempotencyKey,
        inputDigest: envelope.inputDigest, implementationDigest: envelope.implementationDigest,
        outcome: { kind: 'result', value: { executionRef } }, receipt: this.receipt(envelope, amount) }
      await this.records.write(this.manifest.kind, envelope.operationId, { ...record, stage: 'complete', completion })
      return completion
    } catch (error) {
      if (error instanceof ProviderProtocolError) throw error
      throw new ProviderReconcileError(error instanceof Error ? error.message : String(error), { cause: error })
    }
  }
  private async physicalInspection(envelope: OperationEnvelope, record: RecordValue) {
    const { input } = await this.checked(envelope)
    if (!this.physical.inspectEvaluation) return undefined
    return this.physical.inspectEvaluation({ plan: input.plan, snapshot: input.snapshot,
      cells: input.missing, idempotencyKey: record.externalKey, signal: this.inspectionSignal() })
  }
  async inspect(envelope: OperationEnvelope): Promise<ProviderInspection> {
    await this.preflight(envelope)
    const record = await this.read(envelope)
    if (!record) return { status: 'not-started' }
    if (record.stage === 'cancelled-before-start') return { status: 'cancelled', releaseConfirmed: true, receipt: this.receipt(envelope, 0) }
    if (record.completion) return { status: 'completed', completion: record.completion }
    if (this.attemptedThisInvocation.has(envelope.operationId)) return { status: 'running' }
    if (!record.effectStarted) return { status: 'not-started' }
    if (this.legacyInvocationEnabled && Date.now() < this.input(envelope).deadlineAt) return { status: 'replay-safe' }
    const observed = await this.physicalInspection(envelope, record)
    if (!observed) return Date.now() < this.input(envelope).deadlineAt ? { status: 'replay-safe' } : { status: 'unknown' }
    if (observed.status === 'running') return Date.now() < this.input(envelope).deadlineAt
      ? { status: 'replay-safe' } : { status: 'running', handle: observed.handle }
    if (observed.status === 'unknown') return Date.now() < this.input(envelope).deadlineAt
      ? { status: 'replay-safe' } : { status: 'unknown' }
    if (observed.status === 'partially-complete' && Date.now() < this.input(envelope).deadlineAt)
      return { status: 'replay-safe' }
    return { status: 'replay-safe' }
  }
  /** Read-only projection of the old public pending-operation fields. */
  async legacyPending(envelope: OperationEnvelope): Promise<GepaRepairPendingState | null> {
    await this.preflight(envelope)
    const record = await this.read(envelope)
    if (!record || record.completion || record.stage === 'cancelled-before-start' || !record.effectStarted) return null
    const fallback = record.pendingReason ?? 'deadline reached while external execution was unresolved'
    if (record.pendingState) return { state: record.pendingState, reason: fallback,
      ...(record.pendingHandle ? { handle: record.pendingHandle } : {}) }
    let observed: Awaited<ReturnType<NonNullable<SearchProvider['inspectEvaluation']>>> | undefined
    try { observed = await this.physicalInspection(envelope, record) }
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
    reason: string, observed?: Awaited<ReturnType<NonNullable<SearchProvider['inspectEvaluation']>>>): Promise<ProviderSubmission> {
    const state: GepaRepairPendingState['state'] = observed?.status === 'running' ? 'running'
      : observed?.status === 'partially-complete' ? 'partially-complete'
        : observed?.status === 'not-started' ? 'not-started' : 'unknown'
    const pendingReason = observed?.status === 'unknown' ? observed.reason ?? reason : reason
    try { await this.records.write(this.manifest.kind, envelope.operationId, {
      ...record, pendingReason, pendingState: state,
      ...(observed?.status === 'running' ? { pendingHandle: observed.handle } : {}) }) }
    catch (error) { throw new ProviderReconcileError(error instanceof Error ? error.message : String(error), { cause: error }) }
    return observed?.status === 'running' ? { status: 'running', handle: observed.handle } : { status: 'running' }
  }
  async submit(envelope: OperationEnvelope): Promise<ProviderSubmission> {
    const { input, current } = await this.checked(envelope)
    const initial: RecordValue = { schemaVersion: 1, operationId: envelope.operationId,
      inputDigest: envelope.inputDigest, implementationDigest: envelope.implementationDigest,
      bindingDigest: envelope.bindingSetRef.digest, externalKey: this.key(input, current),
      stage: 'started', effectStarted: false }
    await this.flushArtifacts()
    await this.records.create(this.manifest.kind, envelope.operationId, initial)
    const record = (await this.read(envelope))!
    if (record.stage === 'cancelled-before-start') throw new ProviderProtocolError('Cancelled GEPA repair cannot be submitted')
    if (record.completion) return { status: 'completed', completion: record.completion }
    if (this.attemptedThisInvocation.has(envelope.operationId)) return { status: 'running' }
    let observed: Awaited<ReturnType<NonNullable<SearchProvider['inspectEvaluation']>>> | undefined
    if (record.effectStarted && this.physical.inspectEvaluation
      && (!this.legacyInvocationEnabled || Date.now() >= input.deadlineAt)) {
      try { observed = await this.physicalInspection(envelope, record) }
      catch (error) {
        if (error instanceof SearchExecutionFailure) return { status: 'completed', completion: await this.complete(envelope,
          record, { schemaVersion: 1, cells: error.cells, failure: error.failure }, input.missing.length) }
        if (error instanceof SearchProtocolError) throw new ProviderProtocolError(error.message, { cause: error })
        return { status: 'running' }
      }
    }
    if (observed?.status === 'complete') return { status: 'completed', completion: await this.complete(envelope,
      record, { schemaVersion: 1, cells: observed.result.cells }, input.missing.length) }
    if (observed?.status === 'running' && Date.now() >= input.deadlineAt)
      return { status: 'running', handle: observed.handle }
    if (Date.now() >= input.deadlineAt) {
      if (!record.effectStarted || observed?.status === 'not-started') return { status: 'completed', completion: await this.complete(envelope,
        record, { schemaVersion: 1, cells: [], failure: budgetFailure('time') }, 0) }
      if (observed?.status === 'partially-complete') return { status: 'completed', completion: await this.complete(envelope,
        record, { schemaVersion: 1, cells: observed.cells, failure: budgetFailure('time') }, input.missing.length) }
      return { status: 'running' }
    }
    if (!record.effectStarted) {
      record.effectStarted = true
      await this.records.write(this.manifest.kind, envelope.operationId, record)
    }
    if (!input.missing.length) return { status: 'completed', completion: await this.complete(envelope,
      record, { schemaVersion: 1, cells: [] }, 0) }
    let cells: EvidenceCell[]
    try {
      this.attemptedThisInvocation.add(envelope.operationId)
      cells = await this.physical.evaluate({ plan: input.plan, snapshot: input.snapshot, cells: input.missing,
        idempotencyKey: record.externalKey, signal: this.physicalSignal() })
    } catch (error) {
      this.inspectionSignal()
      if (error instanceof SearchExecutionFailure) return { status: 'completed', completion: await this.complete(envelope,
        record, { schemaVersion: 1, cells: error.cells, failure: error.failure }, input.missing.length) }
      if (error instanceof ProviderProtocolError) throw error
      if (error instanceof SearchProtocolError) throw new ProviderProtocolError(error.message, { cause: error })
      let reason = error instanceof Error ? error.message : String(error)
      let inspected: Awaited<ReturnType<NonNullable<SearchProvider['inspectEvaluation']>>> | undefined
      if (this.physical.inspectEvaluation) {
        try {
          inspected = await this.physicalInspection(envelope, record)
        } catch (inspectionError) {
          if (inspectionError instanceof SearchExecutionFailure) return { status: 'completed', completion: await this.complete(envelope,
            record, { schemaVersion: 1, cells: inspectionError.cells, failure: inspectionError.failure }, input.missing.length) }
          if (inspectionError instanceof SearchProtocolError)
            throw new ProviderProtocolError(inspectionError.message, { cause: inspectionError })
          reason = inspectionError instanceof Error ? inspectionError.message : String(inspectionError)
        }
      }
      if (inspected?.status === 'complete') return { status: 'completed', completion: await this.complete(envelope,
        record, { schemaVersion: 1, cells: inspected.result.cells }, input.missing.length) }
      return this.rememberPending(envelope, record, reason, inspected)
    }
    return { status: 'completed', completion: await this.complete(envelope,
      record, { schemaVersion: 1, cells }, input.missing.length) }
  }
  async cancel(envelope: OperationEnvelope): Promise<ProviderInspection> {
    await this.preflight(envelope)
    const { input, current } = await this.checked(envelope)
    const initial: RecordValue = { schemaVersion: 1, operationId: envelope.operationId,
      inputDigest: envelope.inputDigest, implementationDigest: envelope.implementationDigest,
      bindingDigest: envelope.bindingSetRef.digest, externalKey: this.key(input, current),
      stage: 'cancelled-before-start', effectStarted: false }
    await this.flushArtifacts()
    await this.records.create(this.manifest.kind, envelope.operationId, initial)
    const record = (await this.read(envelope))!
    if (!record.effectStarted && record.stage === 'started') {
      record.stage = 'cancelled-before-start'
      await this.records.write(this.manifest.kind, envelope.operationId, record)
    }
    if (record.stage === 'cancelled-before-start') return { status: 'cancelled', releaseConfirmed: true, receipt: this.receipt(envelope, 0) }
    if (record.completion) return { status: 'completed', completion: record.completion }
    return { status: 'unknown' }
  }
  async collect(envelope: OperationEnvelope): Promise<CompletionEnvelope> {
    const observed = await this.inspect(envelope)
    if (observed.status !== 'completed') throw new Error(`GEPA repair result unavailable: ${observed.status}`)
    return observed.completion
  }
}
