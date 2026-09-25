import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { FileArtifactStore, assertDigest } from '../artifacts.js'
import { BindingStore } from '../bindings.js'
import { ProviderProtocolError, ProviderReconcileError } from '../provider-errors.js'
import { FileProviderRecordBackend, type ArtifactCheckpoint, type ProviderRecordBackend } from '../runtime/persistence.js'
import type { CompletionEnvelope, OperationEnvelope, OperationOutcome, OperationProvider, ProviderInspection,
  ProviderDispatchContext, ProviderManifest, ProviderSubmission, UsageReceipt } from '../contracts.js'
import { canonicalJson, jsonDigest, type JsonValue } from '../schema.js'
import { implementationClosureDigest } from '../data/identity.js'
import { digestJson } from '../../state/digest.js'
import { assertCell, assertConsistentCells, cellKey, completeEvidence, plannedCells, profile, validOutcome, verifyCells } from '../../search/evidence.js'
import { deliveredWorkplan, validateReceipt } from '../../search/diagnosis.js'
import { numeric, plannedCellCount, processTasks, repetitionsForTask, safeId, seal, sorted, SearchProtocolError, utility, validateSnapshot, verifyDigest } from '../../search/contracts.js'
import { objectiveProfile, trialPassed } from '../../search/objective.js'
import type { CandidateWorkPlan, CellIdentity, DiagnosisDossier, DiagnosisFact, DiagnosisProvider, EvaluationScope, EvidenceCell, ExternalRecovery,
  ResearchArchive, SearchProgress, SearchProvider, SearchStageFailure, Snapshot, StageEvaluationPlan, StageResult, TaskUniverse } from '../../search/types.js'
import type { ResearchFinding } from '../../search/types.js'
import type { GeneratedCandidate, SearchExecutionHooks } from '../../search/runtime.js'
import type { SearchJournal } from '../../search/store.js'
import { validateSearchSchema } from '../../search/schema.js'
import { GepaPhysicalExecutionError, hasPhysicalGenerationInspection, type PhysicalGenerationInspection } from './gepa-hooks.js'
import { budgetFailure, SearchExecutionFailure, searchDeadline } from '../../search/recovery.js'
import { SearchBudgetExceeded } from '../../search/store.js'
import { zeroUsage, type Usage } from '../../search/store.js'
import { firstGepaBudgetFailure, type GepaBudgetCut, type GepaBudgetFailure } from '../recipes/gepa-budget.js'

type GepaKind = 'gepa.evaluate' | 'gepa.diagnose' | 'gepa.generate'
export type GepaPhysicalRoundIdentity = { evolutionId: string; roundId: string }
type LegacyBudgetInput = { budgetCut?: GepaBudgetCut; roundStartedAt?: number }
type LegacyBudgetDecision = { digest: string; cost: Usage | null; failure: GepaBudgetFailure | 'diagnosisInputTokens' | 'diagnosisOutputTokens' | null }
export type GepaLegacyPendingState = { state: 'running' | 'unknown' | 'not-started' | 'partially-complete';
  reason: string; handle?: string }
type RecordValue = { schemaVersion: 1; operationId: string; inputDigest: string; implementationDigest: string;
  bindingDigest: string; idempotencyKey: string; externalKey: string;
  stage: 'prepared' | 'started' | 'cancelled-before-start' | 'complete';
  request?: JsonValue; requestDigest?: string; evaluationCells?: EvidenceCell[]; evaluationCellsDigest?: string;
  evaluationFailure?: SearchStageFailure; evaluationFailureDigest?: string; evaluationNotStarted?: boolean;
  diagnosisValue?: { facts: DiagnosisFact[]; inputTokens: number; outputTokens: number; failure?: SearchStageFailure };
  diagnosisValueDigest?: string; generatedValue?: GeneratedCandidate; generatedValueDigest?: string;
  pendingReason?: string; pendingState?: GepaLegacyPendingState['state']; pendingHandle?: string;
  legacyBudgetDecision?: LegacyBudgetDecision;
  completion?: CompletionEnvelope }
type Result = { outcome: OperationOutcome; usage: Record<string, number> }
class PhysicalTransportPending extends Error {
  constructor(error: unknown, readonly observation?: Pick<GepaLegacyPendingState, 'state' | 'handle' | 'reason'>) {
    super(error instanceof Error ? error.message : String(error), { cause: error })
  }
}
function validateObservedState(observed: ExternalRecovery<unknown> | undefined,
  allowPartial: boolean, allowAbsent = false): void {
  if (observed === undefined && allowAbsent) return
  if (observed === null || typeof observed !== 'object'
    || !['complete', 'not-started', 'partially-complete', 'running', 'unknown'].includes(observed.status))
    throw new SearchProtocolError('invalid external recovery state')
  if (observed.status === 'running' && (typeof observed.handle !== 'string' || !observed.handle))
    throw new SearchProtocolError('running recovery needs its original handle')
  if (observed.status === 'partially-complete' && (!allowPartial || !Array.isArray(observed.cells)
    || observed.cells.length === 0))
    throw new SearchProtocolError('partial recovery requires completed evaluation cells')
}
function pendingObservation(observed: ExternalRecovery<unknown> | undefined,
  reason: string, allowPartial = false): Pick<GepaLegacyPendingState, 'state' | 'handle' | 'reason'> {
  validateObservedState(observed, allowPartial, true)
  if (observed?.status === 'running') return { state: 'running', handle: observed.handle, reason }
  if (observed?.status === 'partially-complete') return { state: 'partially-complete',
    reason: 'completed evaluation cells are saved; remaining batches have not started' }
  if (observed?.status === 'not-started') return { state: 'not-started', reason }
  return { state: 'unknown', reason: observed?.status === 'unknown' ? observed.reason ?? reason : reason }
}

/** Old physical services remain responsible for their durable original-key lookup. This adapter never retries an unknown started effect. */
abstract class GepaOperationProvider implements OperationProvider {
  private readonly manifest: ProviderManifest
  private readonly attemptedThisInvocation = new Set<string>()
  private readonly observedThisInvocation = new Map<string, { inputDigest: string; observed: ExternalRecovery<unknown> }>()
  private readonly failedInspectionThisInvocation = new Map<string, { inputDigest: string; failure: SearchExecutionFailure }>()
  protected legacyInvocationEnabled = false
  private invocation: { runSignal: AbortSignal; inspectSignal: AbortSignal; deadlineAt: number;
    expire(): void; dispose(): void } | undefined
  protected readonly records: ProviderRecordBackend
  protected constructor(root: string, kind: GepaKind, implementationConfiguration: JsonValue,
    readonly artifacts: FileArtifactStore, readonly bindings: BindingStore,
    dimensions: string[], inputSchema: ProviderManifest['inputSchema'], outputSchema: ProviderManifest['outputSchema'],
    records?: ProviderRecordBackend) {
    this.records = records ?? new FileProviderRecordBackend(root, { 'gepa.cell': 'gepa-cells', 'gepa.process': 'gepa-process' })
    const persistenceIdentity = 'identityDigest' in this.records ? this.records.identityDigest : null
    this.manifest = { kind, implementationDigest: implementationClosureDigest(['providers/gepa-operations'],
      { kind, implementationConfiguration, persistenceIdentity }), inputSchema, outputSchema, meteredDimensions: dimensions,
      hardLimitDimensions: [], execution: 'external', supportsInspect: true,
      supportsIdempotentReplay: true }
  }
  describe(): ProviderManifest { return structuredClone(this.manifest) }
  /** Call once at the start of each explicit legacy public run, never between kernel ticks. */
  beginLegacyInvocation(context?: { callerSignal: AbortSignal; deadlineAt: number }): () => void {
    this.invocation?.dispose()
    this.legacyInvocationEnabled = true
    this.attemptedThisInvocation.clear()
    this.observedThisInvocation.clear()
    this.failedInspectionThisInvocation.clear()
    const timed = context ? searchDeadline(context.callerSignal, context.deadlineAt) : undefined
    const clockJump = context ? new AbortController() : undefined
    const invocation = context && timed && clockJump ? {
      runSignal: AbortSignal.any([timed.signal, clockJump.signal]), inspectSignal: context.callerSignal,
      deadlineAt: context.deadlineAt,
      expire: () => { if (Date.now() >= context.deadlineAt && !clockJump.signal.aborted)
        clockJump.abort(new SearchBudgetExceeded('time')) },
      dispose: () => timed.dispose() } : undefined
    this.invocation = invocation
    return () => {
      if (this.invocation === invocation) {
        invocation?.dispose()
        this.invocation = undefined
        this.legacyInvocationEnabled = false
        this.attemptedThisInvocation.clear()
        this.observedThisInvocation.clear()
        this.failedInspectionThisInvocation.clear()
      }
    }
  }
  protected physicalSignal(): AbortSignal {
    this.invocation?.expire()
    return this.invocation?.runSignal ?? new AbortController().signal
  }
  protected deadlineExpired(): boolean {
    this.invocation?.expire()
    const signal = this.invocation?.runSignal
    return !!signal?.aborted && signal.reason instanceof SearchBudgetExceeded
  }
  protected inspectionSignal(): AbortSignal {
    const signal = this.invocation?.inspectSignal ?? new AbortController().signal
    signal.throwIfAborted()
    return AbortSignal.any([signal, AbortSignal.timeout(10000)])
  }
  protected markPhysicalAttempt(envelope: OperationEnvelope): void {
    if (this.legacyInvocationEnabled) this.attemptedThisInvocation.add(envelope.operationId)
  }
  protected wasPhysicalAttempted(envelope: OperationEnvelope): boolean {
    return this.attemptedThisInvocation.has(envelope.operationId)
  }
  protected captureObservation(envelope: OperationEnvelope, observed: ExternalRecovery<unknown>): void {
    validateObservedState(observed, this.manifest.kind === 'gepa.evaluate')
    this.observedThisInvocation.set(envelope.operationId, { inputDigest: envelope.inputDigest, observed })
  }
  protected capturedObservation(envelope: OperationEnvelope): ExternalRecovery<unknown> | undefined {
    const captured = this.observedThisInvocation.get(envelope.operationId)
    if (captured && captured.inputDigest !== envelope.inputDigest)
      throw new ProviderProtocolError('GEPA pending observation identity drift')
    return captured?.observed
  }
  protected captureInspectionFailure(envelope: OperationEnvelope, failure: SearchExecutionFailure): void {
    this.failedInspectionThisInvocation.set(envelope.operationId, { inputDigest: envelope.inputDigest, failure })
  }
  protected capturedInspectionFailure(envelope: OperationEnvelope): SearchExecutionFailure | undefined {
    const captured = this.failedInspectionThisInvocation.get(envelope.operationId)
    if (captured && captured.inputDigest !== envelope.inputDigest)
      throw new ProviderProtocolError('GEPA inspection failure identity drift')
    return captured?.failure
  }
  protected async flushArtifacts(): Promise<void> {
    await (this.artifacts as FileArtifactStore & Partial<ArtifactCheckpoint>).flush?.()
  }
  protected physicalKey(envelope: OperationEnvelope): string { return envelope.idempotencyKey }
  protected roundIdentity(identity: GepaPhysicalRoundIdentity | undefined): GepaPhysicalRoundIdentity | undefined {
    if (!identity) return undefined
    if (typeof identity.evolutionId !== 'string' || !identity.evolutionId) throw new Error('GEPA evolution identity missing')
    safeId(identity.roundId)
    return identity
  }
  protected check(envelope: OperationEnvelope): void {
    if (envelope.kind !== this.manifest.kind || envelope.implementationDigest !== this.manifest.implementationDigest
      || envelope.inputDigest !== jsonDigest(envelope.input) || envelope.idempotencyKey !== envelope.operationId)
      throw new Error('GEPA operation identity drift')
    this.bindings.read(envelope.bindingSetRef)
  }
  protected checkSnapshotBinding(envelope: OperationEnvelope, snapshot: Snapshot): void {
    const harnessRef = this.bindings.read(envelope.bindingSetRef).slots.harness
    if (!harnessRef) throw new Error('GEPA snapshot has no harness binding')
    const harness = this.artifacts.getJson(harnessRef) as Record<string, unknown>
    if (harness.commitOid !== snapshot.commit || harness.manifestDigest !== snapshot.manifestDigest)
      throw new Error('GEPA operation binding/snapshot mismatch')
  }
  protected receipt(envelope: OperationEnvelope, usage: Record<string, number>): UsageReceipt {
    for (const dimension of this.manifest.meteredDimensions) {
      const amount = usage[dimension]
      if (!Number.isSafeInteger(amount) || amount! < 0)
        throw new Error(`GEPA usage invalid for ${dimension}`)
      if ((envelope.input as Record<string, unknown>).roundIdentity && amount! > envelope.limits[dimension]!)
        throw new SearchProtocolError('provider exceeded reserved budget')
    }
    return { source: this.manifest.kind, scope: 'operation', operationId: envelope.operationId,
      cursor: digestJson(usage), cumulative: usage }
  }
  protected async read(envelope: OperationEnvelope): Promise<RecordValue | null> {
    const record = await this.records.read<RecordValue>(envelope.kind, envelope.operationId)
    if (!record) return null
    if (!record || record.schemaVersion !== 1 || !['prepared', 'started', 'cancelled-before-start', 'complete'].includes(record.stage)
      || record.operationId !== envelope.operationId || record.inputDigest !== envelope.inputDigest
      || record.implementationDigest !== envelope.implementationDigest || record.bindingDigest !== envelope.bindingSetRef.digest
      || record.idempotencyKey !== envelope.idempotencyKey || record.externalKey !== this.physicalKey(envelope)
      || record.requestDigest !== (record.request === undefined ? undefined : jsonDigest(record.request))
      || record.pendingReason !== undefined && typeof record.pendingReason !== 'string'
      || record.pendingState !== undefined && !['running', 'unknown', 'not-started', 'partially-complete'].includes(record.pendingState)
      || record.pendingHandle !== undefined && typeof record.pendingHandle !== 'string'
      || record.evaluationNotStarted !== undefined && typeof record.evaluationNotStarted !== 'boolean'
      || record.evaluationCellsDigest !== (record.evaluationCells === undefined ? undefined : digestJson(record.evaluationCells))
      || record.evaluationFailureDigest !== (record.evaluationFailure === undefined ? undefined : digestJson(record.evaluationFailure))
      || record.diagnosisValueDigest !== (record.diagnosisValue === undefined ? undefined : digestJson(record.diagnosisValue))
      || record.generatedValueDigest !== (record.generatedValue === undefined ? undefined : digestJson(record.generatedValue)))
      throw new Error('GEPA operation record drift')
    if (record.legacyBudgetDecision) verifyDigest(record.legacyBudgetDecision)
    return record
  }
  private async create(envelope: OperationEnvelope, stage: RecordValue['stage'], request?: JsonValue): Promise<{ record: RecordValue; created: boolean }> {
    const value: RecordValue = { schemaVersion: 1, operationId: envelope.operationId, inputDigest: envelope.inputDigest,
      implementationDigest: envelope.implementationDigest, bindingDigest: envelope.bindingSetRef.digest,
      idempotencyKey: envelope.idempotencyKey, externalKey: this.physicalKey(envelope), stage,
      ...(request === undefined ? {} : { request, requestDigest: jsonDigest(request) }) }
    await this.flushArtifacts()
    const { created } = await this.records.create(envelope.kind, envelope.operationId, value)
    return { record: (await this.read(envelope))!, created }
  }
  private async complete(envelope: OperationEnvelope, value: Result): Promise<CompletionEnvelope> {
    const completion: CompletionEnvelope = { operationId: envelope.operationId, idempotencyKey: envelope.idempotencyKey,
      inputDigest: envelope.inputDigest, implementationDigest: envelope.implementationDigest, outcome: value.outcome,
      receipt: this.receipt(envelope, value.usage) }
    const record = (await this.read(envelope))!
    if (record.stage === 'cancelled-before-start') throw new Error('GEPA operation was cancelled before starting')
    await this.flushArtifacts()
    record.stage = 'complete'; record.completion = completion
    await this.records.write(envelope.kind, envelope.operationId, record)
    return completion
  }
  protected abstract validate(envelope: OperationEnvelope): Promise<void>
  protected freezeRequest(_envelope: OperationEnvelope, _context?: ProviderDispatchContext): Promise<JsonValue | undefined> | JsonValue | undefined { return undefined }
  protected legacyReserveCost(_envelope: OperationEnvelope, _record: RecordValue): Promise<Usage | null> | Usage | null {
    return null
  }
  protected legacyBeforeReserveFailure(_envelope: OperationEnvelope, _record: RecordValue): Promise<LegacyBudgetDecision['failure']> | LegacyBudgetDecision['failure'] {
    return null
  }
  protected legacyBudgetDecision(record: RecordValue): LegacyBudgetDecision | undefined {
    return record.legacyBudgetDecision
  }
  private legacyBudgetInput(envelope: OperationEnvelope): { cut: GepaBudgetCut; roundStartedAt: number } | undefined {
    const input = envelope.input as LegacyBudgetInput & { roundIdentity?: GepaPhysicalRoundIdentity }
    if (input.budgetCut === undefined && input.roundStartedAt === undefined) return undefined
    if (!input.budgetCut || !Number.isSafeInteger(input.roundStartedAt) || input.roundStartedAt! < 0)
      throw new ProviderProtocolError('GEPA frozen budget admission is incomplete')
    verifyDigest(input.budgetCut)
    const round = this.roundIdentity(input.roundIdentity)
    if (!round || input.budgetCut.roundId !== round.roundId)
      throw new ProviderProtocolError('GEPA frozen budget admission round mismatch')
    return { cut: input.budgetCut, roundStartedAt: input.roundStartedAt! }
  }
  private budgetDelta(context: ProviderDispatchContext): { spent: Usage; reserved: Usage } {
    const dimensions = { cells: 'rolloutCells', repairCells: 'repairCells',
      diagnosisInputTokens: 'diagnosisInputTokens', diagnosisOutputTokens: 'diagnosisOutputTokens',
      generationTokens: 'generationTokens', generationRequests: 'generationRequests' } as const
    const spent = zeroUsage(), reserved = zeroUsage()
    for (const [resource, dimension] of Object.entries(dimensions) as Array<[keyof Usage, string]>) {
      spent[resource] = context.spent[dimension] ?? 0
      reserved[resource] = context.reservedExcludingSelf[dimension] ?? 0
      if (!Number.isSafeInteger(spent[resource]) || spent[resource] < 0
        || !Number.isSafeInteger(reserved[resource]) || reserved[resource] < 0)
        throw new ProviderProtocolError('GEPA Campaign budget snapshot is invalid')
    }
    return { spent, reserved }
  }
  protected legacyRemaining(envelope: OperationEnvelope, context: ProviderDispatchContext,
    resource: keyof Usage): number | null {
    const budget = this.legacyBudgetInput(envelope)
    if (!budget) return null
    const delta = this.budgetDelta(context)
    const used = delta.spent[resource] + delta.reserved[resource]
    const bounds = (['round', 'evolution'] as const).flatMap(layer => {
      const limit = budget.cut[layer].limit[resource]
      return limit === null ? [] : [limit - budget.cut[layer].used[resource] - used]
    })
    return bounds.length ? Math.min(...bounds) : null
  }
  protected startsBudgetClock(_envelope: OperationEnvelope, _record: RecordValue): boolean {
    return !this.deadlineExpired()
  }
  protected abstract execute(envelope: OperationEnvelope, record: RecordValue, newlyStarted: boolean): Promise<Result>
  protected abstract recover(envelope: OperationEnvelope, record: RecordValue): Promise<'not-started' | 'replay-safe' | 'running' | 'unknown'>
  protected lookupLegacyPending(_envelope: OperationEnvelope, _record: RecordValue): Promise<ExternalRecovery<unknown> | undefined> {
    return Promise.resolve(undefined)
  }
  /** A read-only compatibility view; the facade owns the old pending-operation journal pointer. */
  async legacyPending(envelope: OperationEnvelope): Promise<GepaLegacyPendingState | null> {
    await this.preflight(envelope)
    const record = await this.read(envelope)
    if (!record || record.completion || record.stage === 'cancelled-before-start' || record.stage === 'prepared') return null
    const captured = this.legacyInvocationEnabled ? this.capturedObservation(envelope) : undefined
    const fallback = captured && this.deadlineExpired()
      ? 'deadline reached while external execution was unresolved'
      : record.pendingReason ?? 'deadline reached while external execution was unresolved'
    if (!captured && record.pendingState) return { state: record.pendingState, reason: fallback,
      ...(record.pendingHandle ? { handle: record.pendingHandle } : {}) }
    let inspected: ExternalRecovery<unknown> | undefined
    try {
      inspected = captured ?? await this.lookupLegacyPending(envelope, record)
      validateObservedState(inspected, this.manifest.kind === 'gepa.evaluate', true)
    }
    catch (error) {
      if (error instanceof ProviderProtocolError) throw error
      if (error instanceof SearchProtocolError) throw new ProviderProtocolError(error.message, { cause: error })
      return { state: 'unknown', reason: error instanceof Error ? error.message : String(error) }
    }
    if (inspected?.status === 'complete') return null
    if (inspected?.status === 'running') return { state: 'running', handle: inspected.handle, reason: fallback }
    if (inspected?.status === 'partially-complete') return { state: 'partially-complete',
      reason: 'completed evaluation cells are saved; remaining batches have not started' }
    if (inspected?.status === 'not-started') return { state: 'not-started', reason: fallback }
    return { state: 'unknown', reason: inspected?.status === 'unknown' ? inspected.reason ?? fallback : fallback }
  }
  protected cancelStarted(envelope: OperationEnvelope, record: RecordValue): Promise<Result | 'not-started' | 'replay-safe' | 'running' | 'unknown'> {
    return this.recover(envelope, record)
  }
  async preflight(envelope: OperationEnvelope): Promise<void | { startsBudgetClock: boolean }> {
    this.check(envelope); await this.validate(envelope)
    if (this.legacyBudgetInput(envelope)) return undefined
    return this.deadlineExpired() ? { startsBudgetClock: false } : undefined
  }
  async prepareForDispatch(envelope: OperationEnvelope,
    context?: ProviderDispatchContext): Promise<{ startsBudgetClock: boolean }> {
    // Preparation may freeze a trusted cache split, but cannot start a physical
    // effect. A crash before the Campaign clock commit reuses this exact plan.
    await this.preflight(envelope)
    const existing = await this.read(envelope)
    const record = existing ?? (await this.create(envelope, 'prepared', await this.freezeRequest(envelope, context))).record
    const budget = this.legacyBudgetInput(envelope)
    if (budget) {
      if (!context) throw new ProviderProtocolError('GEPA layered budget dispatch context is required')
      if (context.dispatchAdmitted) {
        if (!record.legacyBudgetDecision) throw new ProviderProtocolError('GEPA admitted dispatch has no frozen budget decision')
      } else {
        if (record.stage !== 'prepared') throw new ProviderProtocolError('GEPA started effect has no durable dispatch admission')
        const cost = await this.legacyReserveCost(envelope, record)
        const early = await this.legacyBeforeReserveFailure(envelope, record)
        const failure = early ?? (cost === null ? null : firstGepaBudgetFailure({
          cut: budget.cut, delta: this.budgetDelta(context), cost,
          roundStartedAt: budget.roundStartedAt,
          ...(context.budgetStartedAt === undefined ? {} : { campaignBudgetStartedAt: context.budgetStartedAt }),
          now: Date.now() }))
        if (!failure && cost) {
          const dimensions = { rolloutCells: 'cells', repairCells: 'repairCells',
            diagnosisInputTokens: 'diagnosisInputTokens', diagnosisOutputTokens: 'diagnosisOutputTokens',
            generationTokens: 'generationTokens', generationRequests: 'generationRequests' } as const
          for (const dimension of this.manifest.meteredDimensions) {
            const resource = dimensions[dimension as keyof typeof dimensions]
            if (!resource || cost[resource] > envelope.limits[dimension]!)
              throw new ProviderProtocolError('GEPA frozen reservation is below physical cost')
          }
        }
        record.legacyBudgetDecision = seal({ cost, failure })
        await this.records.write(envelope.kind, envelope.operationId, record)
      }
      return { startsBudgetClock: record.legacyBudgetDecision!.cost !== null
        && record.legacyBudgetDecision!.failure === null }
    }
    return { startsBudgetClock: envelope.startsBudgetClock === true && this.startsBudgetClock(envelope, record) }
  }
  async inspect(envelope: OperationEnvelope): Promise<ProviderInspection> {
    await this.preflight(envelope)
    const record = await this.read(envelope)
    if (!record) return { status: 'not-started' }
    if (record.stage === 'cancelled-before-start') return { status: 'cancelled', releaseConfirmed: true,
      receipt: this.receipt(envelope, Object.fromEntries(this.manifest.meteredDimensions.map(d => [d, 0]))) }
    if (record.stage === 'prepared') return { status: 'not-started' }
    if (record.completion) return { status: 'completed', completion: record.completion }
    if (record.diagnosisValue || record.generatedValue) return { status: 'replay-safe' }
    if (this.wasPhysicalAttempted(envelope)) return { status: 'running' }
    if (this.legacyInvocationEnabled && !this.deadlineExpired()) return { status: 'replay-safe' }
    const recovered = await this.recover(envelope, record)
    return { status: recovered }
  }
  async submit(envelope: OperationEnvelope): Promise<ProviderSubmission> {
    await this.preflight(envelope)
    const existing = await this.read(envelope)
    if (this.legacyBudgetInput(envelope) && !existing?.legacyBudgetDecision)
      throw new ProviderProtocolError('GEPA layered budget dispatch was not prepared')
    let createdRecord: { record: RecordValue; created: boolean }
    try { createdRecord = await this.create(envelope, 'started', existing ? undefined : await this.freezeRequest(envelope)) }
    catch (error) {
      if (error instanceof ProviderProtocolError) throw error
      if (error instanceof SearchProtocolError) throw new ProviderProtocolError(error.message, { cause: error })
      throw new ProviderReconcileError(error instanceof Error ? error.message : String(error), { cause: error })
    }
    const { record, created } = createdRecord
    if (record.stage === 'cancelled-before-start') throw new Error('Cancelled GEPA operation cannot be submitted')
    const prepared = record.stage === 'prepared'
    if (prepared) {
      record.stage = 'started'
      try { await this.records.write(envelope.kind, envelope.operationId, record) }
      catch (error) { throw new ProviderReconcileError(error instanceof Error ? error.message : String(error), { cause: error }) }
    }
    const newlyStarted = created || prepared
    const observed = newlyStarted ? { status: 'not-started' as const } : await this.inspect(envelope)
    if (observed.status === 'completed') return { status: 'completed', completion: observed.completion }
    if (!created && observed.status !== 'not-started' && observed.status !== 'replay-safe') return { status: 'running' }
    try { return { status: 'completed', completion: await this.complete(envelope, await this.execute(envelope, record, newlyStarted)) } }
    catch (error) {
      if (error instanceof PhysicalTransportPending || error instanceof ProjectionPending) {
        const pending = await this.read(envelope)
        if (pending?.stage === 'started') {
          const observed = error instanceof PhysicalTransportPending ? error.observation : undefined
          try { await this.records.write(envelope.kind, envelope.operationId, {
            ...pending, pendingReason: observed?.reason ?? error.message,
            pendingState: observed?.state ?? 'unknown',
            ...(observed?.handle ? { pendingHandle: observed.handle } : {}) }) }
          catch (writeError) { throw new ProviderReconcileError(
            writeError instanceof Error ? writeError.message : String(writeError), { cause: writeError }) }
          if (observed?.state === 'running' && observed.handle) return { status: 'running', handle: observed.handle }
        }
        return { status: 'running' }
      }
      if (error instanceof ProviderProtocolError) throw error
      if (error instanceof SearchProtocolError) throw new ProviderProtocolError(error.message, { cause: error })
      throw new ProviderReconcileError(error instanceof Error ? error.message : String(error), { cause: error })
    }
  }
  async cancel(envelope: OperationEnvelope): Promise<ProviderInspection> {
    await this.preflight(envelope)
    const { record } = await this.create(envelope, 'cancelled-before-start')
    if (record.stage === 'prepared') {
      record.stage = 'cancelled-before-start'
      await this.records.write(envelope.kind, envelope.operationId, record)
    }
    if (record.stage === 'cancelled-before-start') return { status: 'cancelled', releaseConfirmed: true,
      receipt: this.receipt(envelope, Object.fromEntries(this.manifest.meteredDimensions.map(d => [d, 0]))) }
    if (record.completion) return { status: 'completed', completion: record.completion }
    // The old physical SPI has no cancel acknowledgement. Inspect the original key
    // so that a completed result can settle, but retain reservations while unknown.
    const recovered = await this.cancelStarted(envelope, record)
    if (recovered === 'running' || recovered === 'unknown' || recovered === 'replay-safe' || recovered === 'not-started')
      return { status: recovered === 'replay-safe' || recovered === 'not-started' ? 'unknown' : recovered }
    return { status: 'completed', completion: await this.complete(envelope, recovered) }
  }
  async collect(envelope: OperationEnvelope): Promise<CompletionEnvelope> {
    const observed = await this.inspect(envelope)
    if (observed.status !== 'completed') throw new Error(`GEPA result unavailable: ${observed.status}`)
    return observed.completion
  }
}

type EvaluateInput = LegacyBudgetInput & { roundIdentity?: GepaPhysicalRoundIdentity; universe: TaskUniverse; plan: StageEvaluationPlan; snapshot: Snapshot;
  processMode: 'off' | 'auto' | 'required'; progressProcessMode?: 'off' | 'auto' | 'required';
  projectionPolicy?: 'complete' | 'defer' }
type FrozenEvaluationRequest = { missing: CellIdentity[]; cached: EvidenceCell[]; repairCells: number }
type ProjectionRecord = { schemaVersion: 1; operationId: string; inputDigest: string; baseCellDigest: string;
  key: string; stage: 'started' | 'complete'; cell?: EvidenceCell }
class ProjectionPending extends Error {
  constructor(readonly status: 'running' | 'unknown') { super(`GEPA process projection ${status}`) }
}
function richerCell(previous: EvidenceCell, candidate: EvidenceCell): EvidenceCell {
  if (!validOutcome(previous)) return candidate
  if (!validOutcome(candidate)) throw new SearchProtocolError('GEPA recovery cannot discard a valid outcome')
  const extendsEvidence = (base: EvidenceCell, next: EvidenceCell): boolean => {
    try {
      assertConsistentCells(base, next)
      return base.process?.status !== 'available' || next.process?.status === 'available'
    } catch { return false }
  }
  if (extendsEvidence(previous, candidate)) return candidate
  if (extendsEvidence(candidate, previous)) return previous
  throw new SearchProtocolError('GEPA cached and original evidence cannot be merged without changing a valid field')
}
export class GepaEvaluationProvider extends GepaOperationProvider {
  private readonly initialCells = new Map<string, EvidenceCell>()
  private readonly physicalIntegrity: string
  private readonly capabilitiesDigest: string
  private progressTail: Promise<void> = Promise.resolve()
  private readonly runningProjectedThisInvocation = new Set<string>()
  constructor(root: string, artifacts: FileArtifactStore, bindings: BindingStore, readonly physical: SearchProvider,
    initialArchive?: ResearchArchive, records?: ProviderRecordBackend, readonly legacyJournal?: SearchJournal) {
    super(root, 'gepa.evaluate', { providerIntegrity: physical.integrity, capabilities: physical.capabilities,
      initialArchiveDigest: initialArchive?.digest ?? null, legacyGlobalCache: !!legacyJournal } as unknown as JsonValue,
      artifacts, bindings, ['rolloutCells', 'repairCells'],
      { type: 'object', required: ['universe', 'plan', 'snapshot', 'processMode'], properties: { roundIdentity: { type: 'object',
        required: ['evolutionId', 'roundId'], properties: { evolutionId: { type: 'string' }, roundId: { type: 'string' } },
        additionalProperties: false }, budgetCut: { type: 'any' }, roundStartedAt: { type: 'integer' },
        universe: { type: 'any' }, plan: { type: 'any' },
        snapshot: { type: 'any' }, processMode: { type: 'string', enum: ['off', 'auto', 'required'] },
        progressProcessMode: { type: 'string', enum: ['off', 'auto', 'required'] },
        projectionPolicy: { type: 'string', enum: ['complete', 'defer'] } }, additionalProperties: false },
      { type: 'object', required: ['resultRef'], properties: { resultRef: { type: 'any' } }, additionalProperties: false }, records)
    this.physicalIntegrity = physical.integrity
    this.capabilitiesDigest = digestJson(physical.capabilities)
    if (!records) for (const directory of ['gepa-cells', 'gepa-process']) mkdirSync(join(root, directory), { recursive: true })
    if (initialArchive) {
      verifyDigest(initialArchive)
      for (const result of initialArchive.results) for (const cell of result.cells) {
        const key = cellKey(cell.identity), previous = this.initialCells.get(key)
        if (!previous) this.initialCells.set(key, cell)
        else if (validOutcome(previous) && validOutcome(cell)) this.initialCells.set(key, richerCell(previous, cell))
        else if (validOutcome(cell)) this.initialCells.set(key, cell)
      }
    }
  }
  private input(envelope: OperationEnvelope): EvaluateInput { return envelope.input as unknown as EvaluateInput }
  override beginLegacyInvocation(context?: { callerSignal: AbortSignal; deadlineAt: number }): () => void {
    const dispose = super.beginLegacyInvocation(context)
    this.runningProjectedThisInvocation.clear()
    return () => {
      dispose()
      this.runningProjectedThisInvocation.clear()
    }
  }
  private async progress(envelope: OperationEnvelope, result?: StageResult): Promise<void> {
    if (!this.legacyJournal) return
    const { roundIdentity, universe, plan, snapshot, processMode, progressProcessMode } = this.input(envelope)
    const stage = plan.stage
    if (stage === 'held-out') return
    const round = this.roundIdentity(roundIdentity)
    if (!round) throw new ProviderProtocolError('Legacy GEPA progress requires frozen round identity')
    const update = async () => {
      const key = `rounds/${round.roundId}/progress`
      const progress = await this.legacyJournal!.read<SearchProgress>(key)
        ?? { phase: 'bootstrap' as const, evaluations: [], decisions: [] }
      const previous = progress.evaluations.find(row => row.stagePlanDigest === plan.digest
        && row.candidateId === snapshot.candidateId)
      if (!result && (previous?.state === 'settled'
        || this.legacyInvocationEnabled && this.runningProjectedThisInvocation.has(envelope.operationId))) return
      const projected = result ? profile(universe, plan, snapshot, result, progressProcessMode ?? processMode) : undefined
      const coverage = projected ? { coverage: projected.coverage, processCoverage: projected.processCoverage,
        outcomeComplete: projected.outcomeComplete,
        ...(projected.objectiveScore ? { objectiveScore: projected.objectiveScore,
          rawMetrics: projected.rawMetrics!, objectiveComplete: projected.objectiveComplete! } : {}),
        processComplete: projected.processComplete, processTaskIds: projected.processTaskIds,
        tasks: projected.tasks, supportDigest: projected.supportDigest } : undefined
      const row: SearchProgress['evaluations'][number] = { stage, stagePlanDigest: plan.digest,
        scopeDigest: plan.scopeDigest, candidateId: snapshot.candidateId,
        state: result ? 'settled' : 'running', plannedCells: plannedCellCount(universe, plan.taskIds),
        ...(coverage ? { profile: coverage } : {}), ...(result?.failure ? { failure: result.failure } : {}) }
      progress.evaluations = [...progress.evaluations.filter(item => item !== previous), row]
      await this.legacyJournal!.write(key, progress)
      if (!result && this.legacyInvocationEnabled) this.runningProjectedThisInvocation.add(envelope.operationId)
      if (projected?.objectiveScore) await this.legacyJournal!.put(projected.objectiveScore)
    }
    const current = this.progressTail.then(update, update)
    this.progressTail = current.catch(() => {})
    try { await current }
    catch (error) { throw new ProviderReconcileError(error instanceof Error ? error.message : String(error), { cause: error }) }
  }
  override async prepareForDispatch(envelope: OperationEnvelope,
    context?: ProviderDispatchContext): Promise<{ startsBudgetClock: boolean }> {
    await this.preflight(envelope)
    await this.progress(envelope)
    return super.prepareForDispatch(envelope, context)
  }
  private cellId(identity: CellIdentity): string { return cellKey(identity).slice(7) }
  private projectionId(envelope: OperationEnvelope, identity: CellIdentity): string {
    return digestJson([envelope.operationId, cellKey(identity)]).slice(7)
  }
  private async readCell(identity: CellIdentity): Promise<EvidenceCell | undefined> {
    if (this.legacyJournal) {
      const pointer = await this.legacyJournal.read<{ ref: string }>(`cells/${this.cellId(identity)}`)
      return pointer ? this.legacyJournal.object<EvidenceCell>(pointer.ref) : undefined
    }
    return this.records.read<EvidenceCell>('gepa.cell', this.cellId(identity))
  }
  private async writeCell(cell: EvidenceCell): Promise<void> {
    if (this.legacyJournal) {
      const key = `cells/${this.cellId(cell.identity)}`
      const current = await this.legacyJournal.read<{ ref: string }>(key)
      const previous = current ? await this.legacyJournal.object<EvidenceCell>(current.ref) : undefined
      if (previous) assertCell(previous, cell.identity)
      const selected = previous ? richerCell(previous, cell) : cell
      if (selected.rawMetrics) await this.legacyJournal.put(selected.rawMetrics)
      await this.legacyJournal.put(selected)
      if (current?.ref !== selected.digest) await this.legacyJournal.write(key, { ref: selected.digest })
      return
    }
    await this.records.write('gepa.cell', this.cellId(cell.identity), cell)
  }
  private async readProjection(envelope: OperationEnvelope, identity: CellIdentity): Promise<ProjectionRecord | undefined> {
    return this.records.read<ProjectionRecord>('gepa.process', this.projectionId(envelope, identity))
  }
  protected override physicalKey(envelope: OperationEnvelope): string {
    const { roundIdentity, plan, snapshot } = this.input(envelope)
    const round = this.roundIdentity(roundIdentity)
    if (!round) return envelope.idempotencyKey
    const name = `evaluation-${digestJson([plan.digest, snapshot.digest]).slice(7)}`
    return digestJson([round.evolutionId, round.roundId, name])
  }
  private async cached(expected: CellIdentity[]): Promise<{ cells: EvidenceCell[]; missing: CellIdentity[]; repairCells: number }> {
    const cells: EvidenceCell[] = [], missing: CellIdentity[] = [], inspected: EvidenceCell[] = []
    let repairCells = 0
    for (const identity of expected) {
      const persisted = await this.readCell(identity)
      const archived = this.initialCells.get(cellKey(identity))
      for (const item of [persisted, archived]) if (item) { assertCell(item, identity); inspected.push(item) }
      const cell = persisted && archived
        ? validOutcome(persisted) && validOutcome(archived) ? richerCell(archived, persisted)
          : validOutcome(persisted) ? persisted : validOutcome(archived) ? archived : persisted
        : persisted ?? archived
      if (!cell) { missing.push(identity); continue }
      if (!validOutcome(cell)) { missing.push(identity); repairCells++; continue }
      cells.push(cell)
    }
    if (!await verifyCells(this.physical, inspected.map(cell => ({ cell, identity: expected.find(i => cellKey(i) === cellKey(cell.identity))! }))))
      throw new ProviderProtocolError('GEPA cached cell provenance rejected')
    return { cells, missing, repairCells }
  }
  protected override async freezeRequest(envelope: OperationEnvelope): Promise<JsonValue> {
    await this.progress(envelope)
    const { universe, plan, snapshot } = this.input(envelope)
    const { cells, missing, repairCells } = await this.cached(plannedCells(universe, plan, snapshot))
    if (this.legacyJournal) {
      const round = this.roundIdentity(this.input(envelope).roundIdentity)
      if (!round) throw new ProviderProtocolError('Legacy GEPA evaluation requires frozen round identity')
      await this.legacyJournal.put(plan)
      await this.legacyJournal.put(snapshot)
      const binding = seal({ stagePlanDigest: plan.digest, participantId: snapshot.candidateId, sealedSnapshotDigest: snapshot.digest })
      const bindingName = `binding-${digestJson([plan.digest, snapshot.candidateId]).slice(7)}`
      const frozenBinding = await this.legacyJournal.freeze(round.roundId, bindingName, () => binding)
      if (frozenBinding.digest !== binding.digest)
        throw new SearchProtocolError('stage participant is already bound to a different snapshot')
      const inputName = `evaluation-${digestJson([plan.digest, snapshot.digest]).slice(7)}-input`
      const frozen = seal({ request: { plan, snapshot, cells: missing }, cached: cells, repairCells })
      const saved = await this.legacyJournal.freeze(round.roundId, inputName, () => frozen)
      if (saved.digest !== frozen.digest) throw new ProviderProtocolError('GEPA evaluation cache split changed')
    }
    return { missing, cached: cells, repairCells } as unknown as JsonValue
  }
  protected override startsBudgetClock(envelope: OperationEnvelope, record: RecordValue): boolean {
    if (this.deadlineExpired()) return false
    const request = record.request as unknown as FrozenEvaluationRequest | undefined
    if (!request) throw new ProviderProtocolError('GEPA evaluation dispatch plan missing')
    return request.missing.length > 0 && request.missing.length <= envelope.limits.rolloutCells!
      && request.repairCells <= envelope.limits.repairCells!
  }
  protected override legacyReserveCost(_envelope: OperationEnvelope, record: RecordValue): Usage | null {
    const request = record.request as unknown as FrozenEvaluationRequest | undefined
    if (!request) throw new ProviderProtocolError('GEPA evaluation dispatch plan missing')
    return request.missing.length ? { ...zeroUsage(), cells: request.missing.length,
      repairCells: request.repairCells } : null
  }
  protected async validate(envelope: OperationEnvelope): Promise<void> {
    const { universe, plan, snapshot, processMode, projectionPolicy } = this.input(envelope)
    verifyDigest(universe); verifyDigest(plan); validateSnapshot(snapshot)
    if (!['off', 'auto', 'required'].includes(processMode)) throw new Error('GEPA process mode is not frozen')
    if (projectionPolicy !== undefined && !['complete', 'defer'].includes(projectionPolicy))
      throw new Error('GEPA projection policy is not frozen')
    this.checkSnapshotBinding(envelope, snapshot)
    if (this.physical.integrity !== this.physicalIntegrity
      || digestJson(this.physical.capabilities) !== this.capabilitiesDigest)
      throw new Error('GEPA physical evaluator identity drift')
    if (plan.universeDigest !== universe.digest || plan.partition !== universe.partition || !plan.participantIds.includes(snapshot.candidateId)
      || digestJson(await this.physical.describe(universe.partition)) !== digestJson(universe)) throw new Error('GEPA evaluation input/provider drift')
    if (!this.physical.capabilities.taskSubsetPlans || !this.physical.capabilities.batchIndependentCells || !this.physical.capabilities.idempotentExecution)
      throw new Error('GEPA evaluation provider lacks subset/idempotent capabilities')
    if (!Number.isSafeInteger(envelope.limits.rolloutCells) || envelope.limits.rolloutCells! < 0
      || !Number.isSafeInteger(envelope.limits.repairCells) || envelope.limits.repairCells! < 0)
      throw new Error('GEPA evaluation reservation invalid')
  }
  /** One durable projection key names the original run's process/raw-metric read, never a fresh Target rollout. */
  private async project(envelope: OperationEnvelope, evaluationRecord: RecordValue, base: EvidenceCell): Promise<EvidenceCell> {
    if (!this.physical.completeProcess) throw new Error('GEPA process completion capability is absent')
    const key = digestJson([evaluationRecord.externalKey, base.digest])
    const projectionId = this.projectionId(envelope, base.identity)
    const intent: ProjectionRecord = { schemaVersion: 1, operationId: envelope.operationId,
      inputDigest: envelope.inputDigest, baseCellDigest: base.digest, key, stage: 'started' }
    const createdRecord = await this.records.create('gepa.process', projectionId, intent)
    const created = createdRecord.created, record = createdRecord.record
    if (record.schemaVersion !== 1 || record.operationId !== intent.operationId
      || record.inputDigest !== intent.inputDigest || record.baseCellDigest !== intent.baseCellDigest
      || record.key !== key || !['started', 'complete'].includes(record.stage))
      throw new Error('GEPA process projection identity drift')
    const settle = async (cell: EvidenceCell): Promise<EvidenceCell> => {
      assertCell(cell, base.identity)
      if (!validOutcome(cell)) throw new SearchProtocolError('GEPA process completion replaced a valid outcome')
      assertConsistentCells(base, cell)
      if (!await verifyCells(this.physical, [{ cell, identity: base.identity }]))
        throw new ProviderProtocolError('GEPA process completion provenance rejected')
      await this.records.write('gepa.process', projectionId, { ...intent, stage: 'complete', cell })
      let chosen = cell
      const previous = await this.readCell(cell.identity)
      if (previous) {
        assertCell(previous, base.identity)
        chosen = richerCell(previous, cell)
      }
      await this.writeCell(chosen)
      return chosen
    }
    if (record.stage === 'complete') {
      if (!record.cell) throw new SearchProtocolError('GEPA completed process projection omitted evidence')
      return settle(record.cell)
    }
    if (!created) {
      if (!this.physical.inspectProcess) throw new ProjectionPending('unknown')
      let observed: Awaited<ReturnType<NonNullable<SearchProvider['inspectProcess']>>>
      try { observed = await this.physical.inspectProcess(base, key, this.inspectionSignal()) }
      catch (error) { if (error instanceof SearchProtocolError) throw error; throw new ProjectionPending('unknown') }
      if (observed.status === 'complete') {
        if (observed.result.cells.length !== 1) throw new Error('GEPA process inspection returned unexpected cells')
        return settle(observed.result.cells[0]!)
      }
      if (observed.status !== 'not-started') throw new ProjectionPending(observed.status === 'running' ? 'running' : 'unknown')
      // The old SearchProvider promises the same key is idempotent; do not make a new projection key.
    }
    let projected: EvidenceCell
    try { projected = await this.physical.completeProcess(base, key, this.physicalSignal()) }
    catch (error) {
      if (error instanceof SearchProtocolError) throw error
      if (this.physical.inspectProcess) {
        let observed: Awaited<ReturnType<NonNullable<SearchProvider['inspectProcess']>>> | undefined
        try {
          observed = await this.physical.inspectProcess(base, key, this.inspectionSignal())
        } catch (inspectionError) {
          if (inspectionError instanceof SearchProtocolError) throw inspectionError
        }
        if (observed?.status === 'complete') {
          if (observed.result.cells.length !== 1) throw new Error('GEPA process inspection returned unexpected cells')
          return settle(observed.result.cells[0]!)
        }
        if (observed?.status === 'running') throw new ProjectionPending('running')
      }
      throw new ProjectionPending('unknown')
    }
    return settle(projected)
  }
  private async result(envelope: OperationEnvelope, record: RecordValue, received: EvidenceCell[],
    failure?: SearchStageFailure, notStarted = false): Promise<Result> {
    const { universe, plan, snapshot, processMode, projectionPolicy } = this.input(envelope)
    const expected = plannedCells(universe, plan, snapshot)
    const request = record.request as unknown as FrozenEvaluationRequest
    if (!request || !Array.isArray(request.missing) || !Array.isArray(request.cached)
      || !Number.isSafeInteger(request.repairCells)
      || request.repairCells < 0 || request.repairCells > request.missing.length)
      throw new Error('GEPA frozen evaluation request missing')
    const requested = request.missing
    const requestKeys = new Set(requested.map(cellKey))
    const byKey = new Map(expected.map(identity => [cellKey(identity), identity]))
    const seen = new Set<string>()
    for (const cell of received) {
      const key = cellKey(cell.identity), identity = byKey.get(key)
      if (!identity || !requestKeys.has(key) || seen.has(key)) throw new ProviderProtocolError('GEPA evaluation returned unrequested or duplicate cells')
      assertCell(cell, identity); seen.add(key)
    }
    if (!await verifyCells(this.physical, received.map(cell => ({ cell, identity: byKey.get(cellKey(cell.identity))! }))))
      throw this.input(envelope).roundIdentity
        ? new SearchProtocolError('provider rejected cell provenance')
        : new ProviderProtocolError('GEPA evaluation cell provenance rejected')
    if (record.evaluationCells) {
      if (digestJson(record.evaluationCells) !== digestJson(received))
        throw new ProviderProtocolError('GEPA original evaluation cells changed on recovery')
      if (digestJson(record.evaluationFailure ?? null) !== digestJson(failure ?? null))
        throw new ProviderProtocolError('GEPA original evaluation failure changed on recovery')
      if (record.evaluationNotStarted !== notStarted)
        throw new ProviderProtocolError('GEPA original evaluation execution status changed on recovery')
    } else {
      record.evaluationCells = received
      record.evaluationCellsDigest = digestJson(received)
      record.evaluationNotStarted = notStarted
      if (failure) { record.evaluationFailure = failure; record.evaluationFailureDigest = digestJson(failure) }
      await this.records.write(envelope.kind, envelope.operationId, record)
    }
    const existing = await this.cached(expected)
    const cellsByKey = new Map(existing.cells.map(cell => [cellKey(cell.identity), cell]))
    for (const cell of received) {
      const key = cellKey(cell.identity), previous = cellsByKey.get(key)
      const selected = previous ? richerCell(previous, cell) : cell
      cellsByKey.set(key, selected)
      if (this.legacyJournal) await this.writeCell(selected)
      else {
        const persistedRecord = await this.records.create('gepa.cell', this.cellId(selected.identity), selected)
        if (!persistedRecord.created) {
          const persisted = persistedRecord.record
          assertCell(persisted, byKey.get(key)!)
          const latest = richerCell(persisted, selected)
          cellsByKey.set(key, latest)
          if (latest.digest !== persisted.digest) await this.writeCell(latest)
        }
      }
    }
    const originals = [...request.cached, ...received]
    let cells = originals.map(cell => cellsByKey.get(cellKey(cell.identity)) ?? cell)
    const usage = { rolloutCells: notStarted ? 0 : requested.length, repairCells: notStarted ? 0 : request.repairCells }
    this.receipt(envelope, usage)
    const applicable = new Set(processTasks(universe, processMode))
    const requiredMetrics = new Set([...(universe.objective?.terms.filter(term => term.weight !== 0).map(term => term.metric) ?? []),
      ...(universe.objective?.constraints.map(constraint => constraint.metric) ?? [])])
    const missingProjection = (cell: EvidenceCell): boolean => validOutcome(cell) && (
      applicable.has(cell.identity.taskId) && cell.process?.status !== 'available'
      || [...requiredMetrics].some(metric => cell.rawMetrics?.metrics[metric]?.status !== 'available'))
    for (const cell of projectionPolicy === 'defer' ? [] : [...cells]) {
      const original = originals.find(item => cellKey(item.identity) === cellKey(cell.identity))!
      if (!missingProjection(cell) && !await this.readProjection(envelope, cell.identity)) continue
      if (!this.physical.completeProcess) return { outcome: { kind: 'error', code: 'PROCESS_COMPLETION_UNSUPPORTED',
        message: 'Original-run process/raw-metric completion is unavailable from this provider' }, usage }
      const projected = await this.project(envelope, record, original)
      const before: StageResult = seal({ stagePlanDigest: plan.digest, snapshotDigest: snapshot.digest, cells, settled: true })
      cells = completeEvidence(before, [projected]).cells
      if (missingProjection(projected)) return { outcome: { kind: 'error', code: 'PROCESS_COMPLETION_INCOMPLETE',
        message: 'Original-run process/raw-metric completion did not supply the required evidence' }, usage }
    }
    const result: StageResult = seal({ stagePlanDigest: plan.digest, snapshotDigest: snapshot.digest, cells,
      settled: true, ...(failure ? { failure } : {}) })
    profile(universe, plan, snapshot, result, processMode)
    if (this.legacyJournal) {
      const round = this.roundIdentity(this.input(envelope).roundIdentity)!
      await this.legacyJournal.put(result)
      const key = `rounds/${round.roundId}/evaluation-${digestJson([plan.digest, snapshot.digest]).slice(7)}`
      const saved = await this.legacyJournal.read<{ ref: string }>(key)
      if (saved && saved.ref !== result.digest) throw new ProviderProtocolError('GEPA original evaluation pointer conflict')
      if (!saved) await this.legacyJournal.write(key, { ref: result.digest })
    }
    await this.progress(envelope, result)
    const resultRef = this.artifacts.putJson(result as unknown as JsonValue, 'gepa.stage-result.v1')
    return { outcome: { kind: 'result', value: { resultRef } }, usage }
  }
  protected async execute(envelope: OperationEnvelope, record: RecordValue, newlyStarted: boolean): Promise<Result> {
    const { plan, snapshot, universe } = this.input(envelope)
    const request = record.request as unknown as FrozenEvaluationRequest
    const requested = request.missing
    const denied = this.legacyBudgetDecision(record)?.failure
    if (denied) return this.result(envelope, record, [], budgetFailure(denied), true)
    if (requested.length > envelope.limits.rolloutCells! || request.repairCells > envelope.limits.repairCells!)
      return { outcome: { kind: 'no-result', reason: 'rollout-cell-budget-exhausted' },
      usage: { rolloutCells: 0, repairCells: 0 } }
    // A durable original result may still need process projections. Resume from
    // that exact evidence; a projection response loss must not rerun rollout.
    if (record.evaluationCells) return this.result(envelope, record, record.evaluationCells,
      record.evaluationFailure, record.evaluationNotStarted)
    if (!requested.length) return this.result(envelope, record, [])
    if (this.deadlineExpired() && newlyStarted)
      return this.result(envelope, record, [], budgetFailure('time'), true)
    const inspectedFailure = this.legacyInvocationEnabled ? this.capturedInspectionFailure(envelope) : undefined
    if (inspectedFailure) return this.result(envelope, record, inspectedFailure.cells, inspectedFailure.failure)
    let observed = (this.legacyInvocationEnabled ? this.capturedObservation(envelope) : undefined) as
      Awaited<ReturnType<NonNullable<SearchProvider['inspectEvaluation']>>> | undefined
    if (this.physical.inspectEvaluation && (!this.legacyInvocationEnabled || this.deadlineExpired())) {
      let inspectionFailed = false
      if (!observed) {
        try {
          observed = await this.physical.inspectEvaluation({ plan, snapshot, cells: requested,
            idempotencyKey: record.externalKey, signal: this.inspectionSignal() })
        } catch (error) {
          inspectionFailed = true
          this.inspectionSignal()
          if (error instanceof SearchExecutionFailure)
            return this.result(envelope, record, error.cells, error.failure)
          if (error instanceof SearchProtocolError) throw error
        }
      }
      if (!inspectionFailed) validateObservedState(observed, true)
      if (observed) this.captureObservation(envelope, observed)
      if (observed?.status === 'complete') return this.result(envelope, record, observed.result.cells)
      if (observed?.status === 'not-started' && this.deadlineExpired())
        return this.result(envelope, record, [], budgetFailure('time'), true)
      if (observed?.status === 'partially-complete' && this.deadlineExpired())
        return this.result(envelope, record, observed.cells, budgetFailure('time'))
    }
    if (this.deadlineExpired()) throw new PhysicalTransportPending(new SearchBudgetExceeded('time'),
      pendingObservation(observed, 'deadline reached while external execution was unresolved', true))
    let cells: EvidenceCell[]
    try {
      this.markPhysicalAttempt(envelope)
      cells = await this.physical.evaluate({ plan, snapshot, cells: requested,
        idempotencyKey: record.externalKey, signal: this.physicalSignal() })
    } catch (error) {
      this.inspectionSignal()
      if (error instanceof SearchExecutionFailure)
        return this.result(envelope, record, error.cells, error.failure)
      let inspected: Awaited<ReturnType<NonNullable<SearchProvider['inspectEvaluation']>>> | undefined
      let reason = error instanceof Error ? error.message : String(error)
      if (!(error instanceof SearchProtocolError) && this.physical.inspectEvaluation) {
        try {
          inspected = await this.physical.inspectEvaluation({ plan, snapshot, cells: requested,
            idempotencyKey: record.externalKey, signal: this.inspectionSignal() })
          validateObservedState(inspected, true)
        } catch (inspectionError) {
          this.inspectionSignal()
          if (inspectionError instanceof SearchExecutionFailure)
            return this.result(envelope, record, inspectionError.cells, inspectionError.failure)
          if (inspectionError instanceof SearchProtocolError) throw inspectionError
          reason = inspectionError instanceof Error ? inspectionError.message : String(inspectionError)
        }
      }
      if (inspected?.status === 'complete') return this.result(envelope, record, inspected.result.cells)
      if (this.deadlineExpired() && inspected?.status === 'not-started')
        return this.result(envelope, record, [], budgetFailure('time'), true)
      if (this.deadlineExpired() && inspected?.status === 'partially-complete')
        return this.result(envelope, record, inspected.cells, budgetFailure('time'))
      throw error instanceof SearchProtocolError ? error
        : new PhysicalTransportPending(error, pendingObservation(inspected, reason, true))
    }
    return this.result(envelope, record, cells)
  }
  protected async recover(envelope: OperationEnvelope, record: RecordValue): Promise<'replay-safe' | 'running' | 'unknown'> {
    const { plan, snapshot } = this.input(envelope)
    const request = record.request as unknown as FrozenEvaluationRequest
    const requested = request.missing
    if (requested.length > envelope.limits.rolloutCells! || request.repairCells > envelope.limits.repairCells!
      || !requested.length) return 'replay-safe'
    if (record.evaluationCells) {
      if (this.input(envelope).projectionPolicy === 'defer') return 'replay-safe'
      // Once the original evaluation has been sealed, replay may only finish its
      // process projections. A started projection with an unknown physical effect
      // is not evidence that re-dispatch is safe.
      const originals = [...request.cached, ...record.evaluationCells]
      let running = false
      for (const base of originals) {
        const projection = await this.readProjection(envelope, base.identity)
        if (!projection) continue
        const key = digestJson([record.externalKey, base.digest])
        if (projection.schemaVersion !== 1 || projection.operationId !== envelope.operationId
          || projection.inputDigest !== envelope.inputDigest || projection.baseCellDigest !== base.digest
          || projection.key !== key || !['started', 'complete'].includes(projection.stage))
          throw new Error('GEPA process projection identity drift')
        if (projection.stage === 'complete') continue
        if (!this.physical.inspectProcess) return 'unknown'
        const observed = await this.physical.inspectProcess(base, key, this.inspectionSignal())
        if (observed.status === 'unknown') return 'unknown'
        if (observed.status === 'running') running = true
      }
      return running ? 'running' : 'replay-safe'
    }
    // The old SearchProvider contract requires same-key idempotent execution even
    // when it has no inspection capability. Only this verified GEPA adapter opts
    // into the kernel's explicit replay path; other unknown effects stay unknown.
    if (!this.physical.inspectEvaluation)
      return this.legacyInvocationEnabled && !!this.input(envelope).roundIdentity ? 'replay-safe' : 'unknown'
    if (this.legacyInvocationEnabled && this.capturedInspectionFailure(envelope)) return 'replay-safe'
    let observed = (this.legacyInvocationEnabled ? this.capturedObservation(envelope) : undefined) as
      Awaited<ReturnType<NonNullable<SearchProvider['inspectEvaluation']>>> | undefined
    if (!observed) {
      try { observed = await this.physical.inspectEvaluation({ plan, snapshot, cells: requested,
        idempotencyKey: record.externalKey, signal: this.inspectionSignal() }) }
      catch (error) {
        if (error instanceof SearchExecutionFailure) {
          this.captureInspectionFailure(envelope, error)
          return 'replay-safe'
        }
        throw error
      }
    }
    this.captureObservation(envelope, observed)
    // The old SearchProvider explicitly promises same-key idempotent execution.
    // A subsequent *public* run may call it once even while inspection says
    // running/unknown; the in-memory invocation gate stops a second kernel tick.
    if (observed.status === 'not-started' && this.deadlineExpired()) return 'replay-safe'
    if (observed.status === 'partially-complete' && this.deadlineExpired()) return 'replay-safe'
    if (this.legacyInvocationEnabled && !this.deadlineExpired() && this.input(envelope).roundIdentity) return 'replay-safe'
    return observed.status === 'complete' ? 'replay-safe'
      : observed.status === 'running' ? 'running' : 'unknown'
  }
  protected override async lookupLegacyPending(envelope: OperationEnvelope, record: RecordValue): Promise<ExternalRecovery<unknown> | undefined> {
    if (!this.physical.inspectEvaluation) return undefined
    const { plan, snapshot } = this.input(envelope)
    const request = record.request as unknown as FrozenEvaluationRequest
    const observed = await this.physical.inspectEvaluation({ plan, snapshot, cells: request.missing,
      idempotencyKey: record.externalKey, signal: this.inspectionSignal() })
    validateObservedState(observed, true)
    return observed
  }
}

type DiagnoseInput = LegacyBudgetInput & { roundIdentity?: GepaPhysicalRoundIdentity; snapshot: Snapshot; universe: TaskUniverse;
  taskIds: string[]; baseline: StageResult }
export class GepaDiagnosisProvider extends GepaOperationProvider {
  private readonly identityDigest: string
  constructor(root: string, artifacts: FileArtifactStore, bindings: BindingStore, readonly physical: DiagnosisProvider,
    records?: ProviderRecordBackend, readonly legacyJournal?: SearchJournal) {
    super(root, 'gepa.diagnose', { integrity: physical.integrity,
      sanitizationPolicyDigest: physical.sanitizationPolicyDigest, legacyPointers: !!legacyJournal } as JsonValue,
      artifacts, bindings, ['diagnosisInputTokens', 'diagnosisOutputTokens'],
      { type: 'object', required: ['snapshot', 'universe', 'taskIds', 'baseline'], properties: {
        roundIdentity: { type: 'object', required: ['evolutionId', 'roundId'], properties: {
          evolutionId: { type: 'string' }, roundId: { type: 'string' } }, additionalProperties: false },
        budgetCut: { type: 'any' }, roundStartedAt: { type: 'integer' },
        snapshot: { type: 'any' }, universe: { type: 'any' }, taskIds: { type: 'array', items: { type: 'string' } }, baseline: { type: 'any' } }, additionalProperties: false },
      { type: 'object', required: ['dossierRef'], properties: { dossierRef: { type: 'any' } }, additionalProperties: false }, records)
    this.identityDigest = digestJson([physical.integrity, physical.sanitizationPolicyDigest])
  }
  private input(envelope: OperationEnvelope): DiagnoseInput { return envelope.input as unknown as DiagnoseInput }
  private legacyName(envelope: OperationEnvelope): string {
    const { snapshot, baseline, taskIds } = this.input(envelope)
    return `diagnosis-${digestJson([snapshot.digest, baseline.digest, taskIds]).slice(7)}`
  }
  private async completedLegacyDossier(envelope: OperationEnvelope): Promise<DiagnosisDossier | undefined> {
    if (!this.legacyJournal) return undefined
    const { roundIdentity, snapshot, universe, taskIds, baseline } = this.input(envelope)
    const round = this.roundIdentity(roundIdentity)!
    const pointer = await this.legacyJournal.read<{ ref: string }>(`rounds/${round.roundId}/${this.legacyName(envelope)}`)
    if (!pointer) return undefined
    const dossier = await this.legacyJournal.object<DiagnosisDossier>(pointer.ref)
    validateSearchSchema('DiagnosisDossier', dossier)
    verifyDigest(dossier)
    if (dossier.digest !== pointer.ref || dossier.parentSnapshotDigest !== snapshot.digest
      || dossier.universeDigest !== universe.digest || digestJson(dossier.taskIds) !== digestJson(taskIds)
      || digestJson(dossier.baselineEvidenceDigests) !== digestJson([baseline.digest])
      || dossier.classifierIntegrity !== this.physical.integrity
      || dossier.sanitizationPolicyDigest !== this.physical.sanitizationPolicyDigest)
      throw new ProviderProtocolError('GEPA frozen diagnosis dossier does not match its parent evidence')
    return dossier
  }
  protected override async freezeRequest(envelope: OperationEnvelope, context?: ProviderDispatchContext): Promise<JsonValue> {
    const { snapshot, universe, taskIds, baseline } = this.input(envelope)
    if (this.input(envelope).budgetCut && !context)
      throw new ProviderProtocolError('GEPA diagnosis budget context is required before freezing request')
    const inputCap = context ? this.legacyRemaining(envelope, context, 'diagnosisInputTokens') : null
    const outputCap = context ? this.legacyRemaining(envelope, context, 'diagnosisOutputTokens') : null
    const request = seal({ snapshot, universe, taskIds, cells: baseline.cells,
      maxInputTokens: inputCap ?? envelope.limits.diagnosisInputTokens!,
      maxOutputTokens: outputCap ?? envelope.limits.diagnosisOutputTokens! })
    // The old runtime rejects a zero remaining diagnosis cap from inside the
    // input-freeze callback, so there is no legacy input pointer to publish.
    if (this.legacyJournal && request.maxInputTokens !== 0 && request.maxOutputTokens !== 0) {
      const round = this.roundIdentity(this.input(envelope).roundIdentity)!
      const frozen = await this.legacyJournal.freeze(round.roundId, `${this.legacyName(envelope)}-input`, () => request)
      verifyDigest(frozen)
      if (canonicalJson(frozen as unknown as JsonValue) !== canonicalJson(request as unknown as JsonValue)) {
        // The old outer diagnosis freeze returns its first completed dossier
        // before computing a fresh token cap. A later parent can therefore
        // reuse the same named diagnosis even after the remaining budget moves.
        if (!await this.completedLegacyDossier(envelope)
          || frozen.snapshot.digest !== snapshot.digest || frozen.universe.digest !== universe.digest
          || digestJson(frozen.taskIds) !== digestJson(taskIds)
          || digestJson(frozen.cells) !== digestJson(baseline.cells))
          throw new ProviderProtocolError('GEPA diagnosis input pointer drift')
      }
      return frozen as unknown as JsonValue
    }
    return request as unknown as JsonValue
  }
  override async prepareForDispatch(envelope: OperationEnvelope,
    context?: ProviderDispatchContext): Promise<{ startsBudgetClock: boolean }> {
    const disposition = await super.prepareForDispatch(envelope, context)
    const record = await this.read(envelope)
    return !record?.diagnosisValue && await this.completedLegacyDossier(envelope)
      ? { startsBudgetClock: false } : disposition
  }
  protected override startsBudgetClock(envelope: OperationEnvelope, _record: RecordValue): boolean {
    return !this.deadlineExpired() && envelope.limits.diagnosisInputTokens! > 0
      && envelope.limits.diagnosisOutputTokens! > 0
  }
  protected override async legacyReserveCost(_envelope: OperationEnvelope, record: RecordValue): Promise<Usage | null> {
    if (await this.completedLegacyDossier(_envelope)) return null
    const request = record.request as { maxInputTokens?: number; maxOutputTokens?: number } | undefined
    if (!request) throw new ProviderProtocolError('GEPA diagnosis dispatch plan missing')
    if (request.maxInputTokens === 0 || request.maxOutputTokens === 0) return null
    return { ...zeroUsage(), diagnosisInputTokens: request.maxInputTokens!,
      diagnosisOutputTokens: request.maxOutputTokens! }
  }
  protected override async legacyBeforeReserveFailure(envelope: OperationEnvelope,
    record: RecordValue): Promise<LegacyBudgetDecision['failure']> {
    if (await this.completedLegacyDossier(envelope)) return null
    const request = record.request as { maxInputTokens?: number; maxOutputTokens?: number } | undefined
    if (!request) throw new ProviderProtocolError('GEPA diagnosis dispatch plan missing')
    return request.maxInputTokens === 0 ? 'diagnosisInputTokens'
      : request.maxOutputTokens === 0 ? 'diagnosisOutputTokens' : null
  }
  protected override physicalKey(envelope: OperationEnvelope): string {
    const { roundIdentity, snapshot, baseline, taskIds } = this.input(envelope)
    const round = this.roundIdentity(roundIdentity)
    return round ? digestJson([round.roundId, this.legacyName(envelope)]) : envelope.idempotencyKey
  }
  protected async validate(envelope: OperationEnvelope): Promise<void> {
    const { snapshot, universe, taskIds, baseline } = this.input(envelope)
    if (digestJson([this.physical.integrity, this.physical.sanitizationPolicyDigest]) !== this.identityDigest)
      throw new Error('GEPA diagnosis provider identity drift')
    validateSnapshot(snapshot); verifyDigest(universe); verifyDigest(baseline)
    this.checkSnapshotBinding(envelope, snapshot)
    if (universe.partition !== 'seed' || baseline.snapshotDigest !== snapshot.digest
      || taskIds.some(id => !universe.tasks.some(task => task.id === id))
      || !Number.isSafeInteger(envelope.limits.diagnosisInputTokens) || envelope.limits.diagnosisInputTokens! < 0
      || !Number.isSafeInteger(envelope.limits.diagnosisOutputTokens) || envelope.limits.diagnosisOutputTokens! < 0)
      throw new Error('GEPA diagnosis input or reservation invalid')
  }
  private async result(envelope: OperationEnvelope, record: RecordValue,
    value: { facts: DiagnosisFact[]; inputTokens: number; outputTokens: number;
    failure?: SearchStageFailure }): Promise<Result> {
    const { snapshot, universe, taskIds, baseline } = this.input(envelope)
    for (const fact of value.facts) {
      const cells = baseline.cells.filter(cell => cell.identity.taskId === fact.taskId)
      const refs = new Set(cells.flatMap(cell => [cell.evidenceRef,
        ...(cell.outcome.status === 'available' ? [cell.outcome.evidenceRef] : []),
        ...(cell.process?.status === 'available' ? [cell.process.evidenceRef] : [])]))
      if (!taskIds.includes(fact.taskId) || fact.evidenceRefs.some(ref => !refs.has(ref)))
        throw this.input(envelope).roundIdentity
          ? new SearchProtocolError('diagnosis fact lacks parent seed provenance')
          : new ProviderProtocolError('GEPA diagnosis fact lacks parent evidence provenance')
      if (fact.status === 'supported-hypothesis') {
        if (universe.objective) {
          const projected = objectiveProfile(universe, [fact.taskId], cells)
          if (!fact.evidenceRefs.length || !projected.objectiveComplete) throw new ProviderProtocolError('GEPA objective hypothesis missing evidence')
          if (fact.objectiveEvidence && fact.objectiveEvidence.digest !== projected.objectiveScore?.digest)
            throw new ProviderProtocolError('GEPA objective hypothesis evidence mismatch')
        } else if (!fact.evidenceRefs.length || !cells.some(cell => cell.outcome.status === 'available'
          && numeric(utility(cell.outcome.rawValue, universe.tasks.find(task => task.id === fact.taskId)!.outcome))
            < universe.tasks.find(task => task.id === fact.taskId)!.successUtility))
          throw new ProviderProtocolError('GEPA failure cluster lacks valid business failure')
      }
      if (fact.status === 'successful-control' && (!fact.evidenceRefs.length
        || cells.length !== repetitionsForTask(universe, fact.taskId).length || !cells.every(cell => trialPassed(cell, universe))))
        throw new ProviderProtocolError('GEPA successful control lacks complete evidence')
    }
    const facts = [...value.facts]
    for (const taskId of taskIds) if (!facts.some(fact => fact.taskId === taskId)) {
      const cells = baseline.cells.filter(cell => cell.identity.taskId === taskId)
      const complete = cells.length === repetitionsForTask(universe, taskId).length && cells.every(validOutcome)
      const successful = complete && cells.every(cell => trialPassed(cell, universe))
      facts.push({ taskId, evidenceRefs: sorted(cells.map(cell => cell.evidenceRef)),
        status: !complete ? 'infrastructure-invalid' : successful ? 'successful-control' : 'unresolved' })
    }
    const dossier: DiagnosisDossier = seal({ parentSnapshotDigest: snapshot.digest, universeDigest: universe.digest,
      taskIds, baselineEvidenceDigests: [baseline.digest], facts, classifierIntegrity: this.physical.integrity,
      sanitizationPolicyDigest: this.physical.sanitizationPolicyDigest,
      ...(value.failure ? { failure: value.failure } : {}) })
    const usage = { diagnosisInputTokens: value.inputTokens, diagnosisOutputTokens: value.outputTokens }
    this.receipt(envelope, usage)
    if (record.diagnosisValue) {
      if (record.diagnosisValueDigest !== digestJson(value))
        throw new ProviderProtocolError('GEPA diagnosis response changed on recovery')
    } else {
      record.diagnosisValue = value
      record.diagnosisValueDigest = digestJson(value)
      await this.records.write(envelope.kind, envelope.operationId, record)
    }
    if (this.legacyJournal) {
      const round = this.roundIdentity(this.input(envelope).roundIdentity)!
      const name = this.legacyName(envelope)
      const path = `rounds/${round.roundId}/${name}`
      await this.legacyJournal.put(seal(value))
      await this.legacyJournal.put(dossier)
      const consumed = seal({ stagePlanDigest: baseline.stagePlanDigest, snapshotDigest: baseline.snapshotDigest,
        resultDigest: baseline.digest, consumer: 'diagnosis' as const, consumerDigest: dossier.digest })
      const frozen = await this.legacyJournal.freeze(round.roundId,
        `consumed-${digestJson([baseline.stagePlanDigest, baseline.snapshotDigest]).slice(7)}`, () => consumed)
      verifyDigest(frozen)
      if (frozen.stagePlanDigest !== baseline.stagePlanDigest || frozen.snapshotDigest !== baseline.snapshotDigest
        || frozen.resultDigest !== baseline.digest)
        throw new ProviderProtocolError('GEPA diagnosis evidence consumption drift')
      const saved = await this.legacyJournal.read<{ ref: string }>(path)
      if (saved && saved.ref !== dossier.digest) throw new ProviderProtocolError('GEPA diagnosis pointer conflict')
      if (!saved) await this.legacyJournal.write(path, { ref: dossier.digest })
    }
    const dossierRef = this.artifacts.putJson(dossier as unknown as JsonValue, 'gepa.dossier.v1')
    return { outcome: { kind: 'result', value: { dossierRef } }, usage }
  }
  protected async execute(envelope: OperationEnvelope, record: RecordValue, newlyStarted: boolean): Promise<Result> {
    if (record.diagnosisValue) return this.result(envelope, record, record.diagnosisValue)
    const reused = await this.completedLegacyDossier(envelope)
    if (reused) {
      const dossierRef = this.artifacts.putJson(reused as unknown as JsonValue, 'gepa.dossier.v1')
      return { outcome: { kind: 'result', value: { dossierRef } },
        usage: { diagnosisInputTokens: 0, diagnosisOutputTokens: 0 } }
    }
    const denied = this.legacyBudgetDecision(record)?.failure
    if (denied) return { outcome: { kind: 'error', code: 'SEARCH_BUDGET_EXHAUSTED',
      message: new SearchBudgetExceeded(denied).message, retryable: false },
      usage: { diagnosisInputTokens: 0, diagnosisOutputTokens: 0 } }
    const frozenCaps = record.request as unknown as { maxInputTokens: number; maxOutputTokens: number } | undefined
    const maxInputTokens = frozenCaps?.maxInputTokens ?? envelope.limits.diagnosisInputTokens!
    const maxOutputTokens = frozenCaps?.maxOutputTokens ?? envelope.limits.diagnosisOutputTokens!
    if (record.request) {
      const request = record.request as unknown as { snapshot: Snapshot; universe: TaskUniverse; taskIds: string[];
        cells: EvidenceCell[]; maxInputTokens: number; maxOutputTokens: number }
      const input = this.input(envelope)
      if (request.snapshot.digest !== input.snapshot.digest || request.universe.digest !== input.universe.digest
        || canonicalJson(request.taskIds) !== canonicalJson(input.taskIds)
        || canonicalJson(request.cells as unknown as JsonValue) !== canonicalJson(input.baseline.cells as unknown as JsonValue)
        || !Number.isSafeInteger(request.maxInputTokens) || request.maxInputTokens < 0
        || !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 0
        || request.maxInputTokens > envelope.limits.diagnosisInputTokens!
        || request.maxOutputTokens > envelope.limits.diagnosisOutputTokens!)
        throw new ProviderProtocolError('GEPA diagnosis frozen request drift')
      const cost = this.legacyBudgetDecision(record)?.cost
      if (cost && (cost.diagnosisInputTokens !== request.maxInputTokens
        || cost.diagnosisOutputTokens !== request.maxOutputTokens))
        throw new ProviderProtocolError('GEPA diagnosis frozen reservation drift')
    }
    const inspectedFailure = this.legacyInvocationEnabled ? this.capturedInspectionFailure(envelope) : undefined
    if (inspectedFailure) return this.result(envelope, record, { facts: [], failure: inspectedFailure.failure,
      inputTokens: maxInputTokens, outputTokens: maxOutputTokens })
    if (maxInputTokens === 0 || maxOutputTokens === 0)
      return { outcome: { kind: 'no-result', reason: this.input(envelope).roundIdentity
        ? budgetFailure(maxInputTokens === 0 ? 'diagnosisInputTokens' : 'diagnosisOutputTokens').message
        : 'diagnosis-budget-exhausted' },
        usage: { diagnosisInputTokens: 0, diagnosisOutputTokens: 0 } }
    const timedOut = () => this.result(envelope, record, { facts: [], failure: budgetFailure('time'),
      inputTokens: 0, outputTokens: 0 })
    if (this.deadlineExpired() && newlyStarted) return timedOut()
    const { snapshot, universe, taskIds, baseline } = this.input(envelope)
    let observed = (this.legacyInvocationEnabled ? this.capturedObservation(envelope) : undefined) as
      Awaited<ReturnType<NonNullable<DiagnosisProvider['inspectDiagnosis']>>> | undefined
    if (this.physical.inspectDiagnosis && (!this.legacyInvocationEnabled || this.deadlineExpired())) {
      let inspectionFailed = false
      if (!observed) {
        try {
          observed = await this.physical.inspectDiagnosis(record.externalKey, this.inspectionSignal())
        } catch (error) {
          inspectionFailed = true
          this.inspectionSignal()
          if (error instanceof SearchExecutionFailure) return this.result(envelope, record, { facts: [], failure: error.failure,
            inputTokens: maxInputTokens, outputTokens: maxOutputTokens })
          if (error instanceof SearchProtocolError) throw error
        }
      }
      if (!inspectionFailed) validateObservedState(observed, false)
      if (observed) this.captureObservation(envelope, observed)
      if (observed?.status === 'complete') return this.result(envelope, record, observed.result)
      if (observed?.status === 'not-started' && this.deadlineExpired()) return timedOut()
      if (observed?.status === 'partially-complete')
        throw new SearchProtocolError('partial recovery requires completed evaluation cells')
    }
    if (this.deadlineExpired()) throw new PhysicalTransportPending(new SearchBudgetExceeded('time'),
      pendingObservation(observed, 'deadline reached while external execution was unresolved'))
    let value: Awaited<ReturnType<DiagnosisProvider['diagnose']>>
    try {
      this.markPhysicalAttempt(envelope)
      value = await this.physical.diagnose({ snapshot, universe, taskIds, cells: baseline.cells,
        idempotencyKey: record.externalKey, maxInputTokens,
        maxOutputTokens, signal: this.physicalSignal() })
    } catch (error) {
      this.inspectionSignal()
      if (error instanceof SearchExecutionFailure) return this.result(envelope, record, { facts: [], failure: error.failure,
        inputTokens: maxInputTokens, outputTokens: maxOutputTokens })
      if (error instanceof SearchProtocolError) throw error
      let reason = error instanceof Error ? error.message : String(error)
      let inspected: Awaited<ReturnType<NonNullable<DiagnosisProvider['inspectDiagnosis']>>> | undefined
      if (this.physical.inspectDiagnosis) {
        try {
          inspected = await this.physical.inspectDiagnosis(record.externalKey, this.inspectionSignal())
          validateObservedState(inspected, false)
        }
        catch (inspectionError) {
          this.inspectionSignal()
          if (inspectionError instanceof SearchExecutionFailure) return this.result(envelope, record, {
            facts: [], failure: inspectionError.failure, inputTokens: maxInputTokens,
            outputTokens: maxOutputTokens })
          if (inspectionError instanceof SearchProtocolError) throw inspectionError
          reason = inspectionError instanceof Error ? inspectionError.message : String(inspectionError)
        }
      }
      if (inspected?.status === 'complete') return this.result(envelope, record, inspected.result)
      if (inspected?.status === 'not-started' && this.deadlineExpired()) return timedOut()
      throw new PhysicalTransportPending(error, pendingObservation(inspected, reason))
    }
    return this.result(envelope, record, value)
  }
  protected async recover(envelope: OperationEnvelope, record: RecordValue): Promise<'replay-safe' | 'running' | 'unknown'> {
    const request = record.request as unknown as { maxInputTokens: number; maxOutputTokens: number } | undefined
    if (this.legacyBudgetDecision(record)?.failure || request?.maxInputTokens === 0 || request?.maxOutputTokens === 0
      || envelope.limits.diagnosisInputTokens === 0 || envelope.limits.diagnosisOutputTokens === 0)
      return 'replay-safe'
    if (!this.physical.inspectDiagnosis)
      return this.legacyInvocationEnabled && !!this.input(envelope).roundIdentity ? 'replay-safe' : 'unknown'
    if (this.legacyInvocationEnabled && this.capturedInspectionFailure(envelope)) return 'replay-safe'
    let observed = (this.legacyInvocationEnabled ? this.capturedObservation(envelope) : undefined) as
      Awaited<ReturnType<NonNullable<DiagnosisProvider['inspectDiagnosis']>>> | undefined
    if (!observed) {
      try { observed = await this.physical.inspectDiagnosis(record.externalKey, this.inspectionSignal()) }
      catch (error) {
        if (error instanceof SearchExecutionFailure) {
          this.captureInspectionFailure(envelope, error)
          return 'replay-safe'
        }
        throw error
      }
    }
    this.captureObservation(envelope, observed)
    if (observed.status === 'not-started' && this.deadlineExpired()) return 'replay-safe'
    if (this.legacyInvocationEnabled && !this.deadlineExpired() && this.input(envelope).roundIdentity) return 'replay-safe'
    return observed.status === 'complete' ? 'replay-safe'
      : observed.status === 'running' ? 'running' : 'unknown'
  }
  protected override async lookupLegacyPending(_envelope: OperationEnvelope, record: RecordValue): Promise<ExternalRecovery<unknown> | undefined> {
    if (!this.physical.inspectDiagnosis) return undefined
    const observed = await this.physical.inspectDiagnosis(record.externalKey, this.inspectionSignal())
    validateObservedState(observed, false)
    return observed
  }
}

type GenerateInput = LegacyBudgetInput & { roundIdentity?: GepaPhysicalRoundIdentity; workplan: CandidateWorkPlan; dossier: DiagnosisDossier; scope: EvaluationScope;
  parent: Snapshot; plan: StageEvaluationPlan; baseline: StageResult; universe: TaskUniverse;
  findings: ResearchFinding[]; handoffFindingDigests?: string[]; processMode: 'off' | 'auto' | 'required' }
export type GepaGenerationMetering = { generationTokens: boolean; generationRequests: boolean }
export class GepaGenerationProvider extends GepaOperationProvider {
  constructor(root: string, artifacts: FileArtifactStore, bindings: BindingStore, readonly hooks: SearchExecutionHooks,
    readonly hookImplementationDigest: string, records?: ProviderRecordBackend,
    readonly metering: GepaGenerationMetering = { generationTokens: true, generationRequests: true },
    readonly legacyJournal?: SearchJournal) {
    assertDigest(hookImplementationDigest)
    if (typeof metering.generationTokens !== 'boolean' || typeof metering.generationRequests !== 'boolean')
      throw new Error('GEPA generation metering configuration invalid')
    super(root, 'gepa.generate', { hookImplementationDigest,
      typedPhysicalInspection: hasPhysicalGenerationInspection(hooks), metering,
      legacyHandoff: !!legacyJournal }, artifacts, bindings,
      Object.entries(metering).filter(([, enabled]) => enabled).map(([dimension]) => dimension),
      { type: 'object', required: ['workplan', 'dossier', 'scope', 'parent', 'plan', 'baseline', 'universe', 'findings', 'processMode'],
        properties: { roundIdentity: { type: 'object', required: ['evolutionId', 'roundId'], properties: {
          evolutionId: { type: 'string' }, roundId: { type: 'string' } }, additionalProperties: false },
          budgetCut: { type: 'any' }, roundStartedAt: { type: 'integer' },
          workplan: { type: 'any' }, dossier: { type: 'any' }, scope: { type: 'any' }, parent: { type: 'any' },
          plan: { type: 'any' }, baseline: { type: 'any' }, universe: { type: 'any' }, findings: { type: 'array', items: { type: 'any' } },
          handoffFindingDigests: { type: 'array', items: { type: 'string' } },
          processMode: { type: 'string' } }, additionalProperties: false },
      { type: 'object', required: ['generatedRef'], properties: {
        generatedRef: { type: 'any' }, candidateSetRef: { type: 'any' } }, additionalProperties: false }, records)
  }
  private input(envelope: OperationEnvelope): GenerateInput { return envelope.input as unknown as GenerateInput }
  protected override startsBudgetClock(envelope: OperationEnvelope, _record: RecordValue): boolean {
    return !this.deadlineExpired() && !this.budgetInsufficient(envelope, this.input(envelope).workplan)
  }
  protected override legacyReserveCost(envelope: OperationEnvelope, _record: RecordValue): Usage {
    const budget = this.input(envelope).workplan.generationBudget
    return { ...zeroUsage(), generationTokens: budget.maxTokens ?? 0,
      generationRequests: budget.maxModelRequests ?? 0 }
  }
  protected override physicalKey(envelope: OperationEnvelope): string {
    const { roundIdentity, workplan } = this.input(envelope)
    const round = this.roundIdentity(roundIdentity)
    return round ? digestJson([round.roundId, workplan.digest, 'generation']) : envelope.idempotencyKey
  }
  protected async validate(envelope: OperationEnvelope): Promise<void> {
    const { workplan, dossier, scope, parent, plan, baseline, universe, findings, handoffFindingDigests } = this.input(envelope)
    for (const value of [workplan, dossier, scope, plan, baseline, universe]) verifyDigest(value)
    validateSnapshot(parent)
    this.checkSnapshotBinding(envelope, parent)
    if (workplan.parentSnapshotDigest !== parent.digest || workplan.dossierDigest !== dossier.digest
      || workplan.scopeDigest !== scope.digest || workplan.localStagePlanDigest !== plan.digest
      || baseline.stagePlanDigest !== plan.digest
      || baseline.snapshotDigest !== parent.digest || universe.partition !== 'seed') throw new Error('GEPA generation context drift')
    const handoff = handoffFindingDigests ?? []
    if (!Array.isArray(handoff) || handoff.some(digest => typeof digest !== 'string'))
      throw new Error('GEPA generation handoff findings malformed')
    if (this.legacyJournal) {
      const frozen = await this.legacyJournal.read<{ refs: string[] }>(`findings/${parent.digest.slice(7)}`)
      if (digestJson(handoff) !== digestJson(frozen?.refs ?? []))
        throw new Error('GEPA generation handoff findings changed')
    } else if (handoff.length) throw new Error('GEPA generation handoff requires a trusted journal')
    if (!Array.isArray(findings) || digestJson(findings.map(item => item.digest))
      !== digestJson(sorted([...parent.findingRefs, ...handoff])))
      throw new Error('GEPA generation parent findings drift')
    for (const finding of findings) verifyDigest(finding)
    if (this.metering.generationTokens && (!Number.isSafeInteger(envelope.limits.generationTokens) || envelope.limits.generationTokens! < 0)
      || this.metering.generationRequests && (!Number.isSafeInteger(envelope.limits.generationRequests) || envelope.limits.generationRequests! < 0))
      throw new Error('GEPA generation reservation invalid')
  }
  private usage(tokens: number | undefined, requests: number | undefined): Record<string, number> {
    const usage: Record<string, number> = {}
    if (this.metering.generationTokens) {
      if (!Number.isSafeInteger(tokens) || tokens! < 0) throw new ProviderProtocolError('GEPA generation omitted measured token usage')
      usage.generationTokens = tokens!
    }
    if (this.metering.generationRequests) {
      if (!Number.isSafeInteger(requests) || requests! < 0) throw new ProviderProtocolError('GEPA generation omitted measured request usage')
      usage.generationRequests = requests!
    }
    return usage
  }
  private budgetInsufficient(envelope: OperationEnvelope, workplan: CandidateWorkPlan): boolean {
    return this.metering.generationTokens && envelope.limits.generationTokens! < (workplan.generationBudget.maxTokens ?? 0)
      || this.metering.generationRequests && envelope.limits.generationRequests! < (workplan.generationBudget.maxModelRequests ?? 0)
  }
  private executionFailure(envelope: OperationEnvelope, error: SearchExecutionFailure): GeneratedCandidate {
    const input = this.input(envelope)
    return seal({ changedPaths: [], reason: error.message,
      usage: { ...(input.workplan.generationBudget.maxTokens === undefined ? {}
        : { tokens: envelope.limits.generationTokens ?? input.workplan.generationBudget.maxTokens }),
      ...(input.workplan.generationBudget.maxModelRequests === undefined ? {}
        : { requests: envelope.limits.generationRequests ?? input.workplan.generationBudget.maxModelRequests }) } })
  }
  private async result(envelope: OperationEnvelope, record: RecordValue, value: GeneratedCandidate): Promise<Result> {
    verifyDigest(value)
    const input = this.input(envelope)
    if (input.roundIdentity) {
      if (input.workplan.generationBudget.maxTokens !== undefined && value.usage.tokens === undefined)
        throw new SearchProtocolError('bounded generation requires token accounting')
      if (input.workplan.generationBudget.maxModelRequests !== undefined && value.usage.requests === undefined)
        throw new SearchProtocolError('bounded generation requires request accounting')
    }
    const usage = this.usage(value.usage.tokens, value.usage.requests)
    if (!value.snapshot) {
      await this.checkpointGenerated(envelope, record, value, usage)
      await this.persistGenerated(envelope, value)
      const generatedRef = this.artifacts.putJson(value as unknown as JsonValue, 'gepa.generated.v1')
      return { outcome: { kind: 'result', value: { generatedRef } }, usage }
    }
    validateSnapshot(value.snapshot); await this.hooks.verifySnapshot(value.snapshot)
    if (value.snapshot.candidateId !== input.workplan.candidateId || value.snapshot.parentIds.length !== 1
      || value.snapshot.parentIds[0] !== input.parent.candidateId || !value.receipt || !value.sessionId)
      throw new ProviderProtocolError('GEPA generated candidate parent or receipt mismatch')
    const delivery = deliveredWorkplan(input.workplan, input.dossier, input.findings, input.scope)
    validateReceipt(value.receipt, delivery, value.sessionId)
    await this.checkpointGenerated(envelope, record, value, usage)
    await this.persistGenerated(envelope, value)
    const candidateRef = this.artifacts.putJson({ schemaVersion: 1, kind: 'git-harness', commitOid: value.snapshot.commit,
      manifestDigest: value.snapshot.manifestDigest } as JsonValue, 'harness.directory.v1')
    const candidateSetRef = this.bindings.derive(envelope.bindingSetRef, { harness: candidateRef })
    const generatedRef = this.artifacts.putJson(value as unknown as JsonValue, 'gepa.generated.v1')
    return { outcome: { kind: 'result', value: { generatedRef, candidateSetRef } as unknown as JsonValue }, usage }
  }
  private async checkpointGenerated(envelope: OperationEnvelope, record: RecordValue,
    value: GeneratedCandidate, usage: Record<string, number>): Promise<void> {
    this.receipt(envelope, usage)
    if (record.generatedValue) {
      if (record.generatedValueDigest !== digestJson(value))
        throw new ProviderProtocolError('GEPA generated response changed on recovery')
    } else {
      record.generatedValue = value
      record.generatedValueDigest = digestJson(value)
      await this.records.write(envelope.kind, envelope.operationId, record)
    }
  }
  private async persistGenerated(envelope: OperationEnvelope, value: GeneratedCandidate): Promise<void> {
    if (!this.legacyJournal) return
    const { roundIdentity, workplan } = this.input(envelope)
    const round = this.roundIdentity(roundIdentity)!
    const path = `rounds/${round.roundId}/generated-${workplan.candidateId}`
    await this.legacyJournal.put(value)
    const saved = await this.legacyJournal.read<{ ref: string }>(path)
    if (saved && saved.ref !== value.digest) throw new ProviderProtocolError('GEPA generated pointer conflict')
    if (!saved) await this.legacyJournal.write(path, { ref: value.digest })
  }
  private async inspectPhysicalOutcome(key: string) {
    const hooks = this.hooks
    if (!hasPhysicalGenerationInspection(hooks)) throw new Error('GEPA physical inspection unavailable')
    const signal = this.inspectionSignal()
    return new Promise<PhysicalGenerationInspection>((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      hooks.inspectGenerationOutcome(key).then(value => {
        if (!value || !['complete', 'error', 'not-started', 'unknown'].includes(value.status))
          reject(new SearchProtocolError('invalid external recovery state'))
        else resolve(value)
      }, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }
  protected async execute(envelope: OperationEnvelope, record: RecordValue, newlyStarted: boolean): Promise<Result> {
    if (record.generatedValue) return this.result(envelope, record, record.generatedValue)
    const denied = this.legacyBudgetDecision(record)?.failure
    if (denied) return this.result(envelope, record, seal({ changedPaths: [],
      reason: new SearchBudgetExceeded(denied).message, usage: { tokens: 0, requests: 0 } }))
    const inspectedFailure = this.legacyInvocationEnabled ? this.capturedInspectionFailure(envelope) : undefined
    if (inspectedFailure) return this.result(envelope, record, this.executionFailure(envelope, inspectedFailure))
    const input = this.input(envelope)
    if (this.budgetInsufficient(envelope, input.workplan))
      return { outcome: { kind: 'no-result', reason: 'generation-budget-exhausted' },
        usage: this.usage(0, 0) }
    const timedOut = () => this.result(envelope, record, seal({ changedPaths: [],
      reason: budgetFailure('time').message, usage: { tokens: 0, requests: 0 } }))
    if (this.deadlineExpired() && newlyStarted) return timedOut()
    let prior: ExternalRecovery<unknown> | undefined
    if (hasPhysicalGenerationInspection(this.hooks) && (!this.legacyInvocationEnabled || this.deadlineExpired())) {
      const captured = this.legacyInvocationEnabled ? this.capturedObservation(envelope) : undefined
      let observed = (captured?.status === 'complete' ? captured.result
        : captured?.status === 'not-started' ? { status: 'not-started' }
          : captured?.status === 'unknown' ? { status: 'unknown' } : undefined) as PhysicalGenerationInspection | undefined
      if (!observed) {
        try {
          observed = await this.inspectPhysicalOutcome(record.externalKey)
        } catch (error) {
          this.inspectionSignal()
          if (error instanceof SearchExecutionFailure) return this.result(envelope, record, this.executionFailure(envelope, error))
          if (error instanceof SearchProtocolError) throw error
        }
      }
      prior = observed?.status === 'not-started' ? { status: 'not-started' }
        : observed?.status === 'unknown' ? { status: 'unknown' } : undefined
      if (prior) this.captureObservation(envelope, prior)
      if (observed?.status === 'complete') return this.result(envelope, record, observed.result)
      if (observed?.status === 'not-started' && this.deadlineExpired()) return timedOut()
      if (observed?.status === 'error') return { outcome: { kind: 'error', code: observed.code,
        message: observed.message, retryable: false }, usage: this.usage(observed.usage.tokens, observed.usage.requests) }
    } else if (this.hooks.inspectGeneration && (!this.legacyInvocationEnabled || this.deadlineExpired())) {
      let observed = (this.legacyInvocationEnabled ? this.capturedObservation(envelope) : undefined) as
        Awaited<ReturnType<NonNullable<SearchExecutionHooks['inspectGeneration']>>> | undefined
      if (!observed) {
        try {
          observed = await this.hooks.inspectGeneration(record.externalKey, this.inspectionSignal())
        } catch (error) {
          this.inspectionSignal()
          if (error instanceof SearchExecutionFailure) return this.result(envelope, record, this.executionFailure(envelope, error))
          if (error instanceof SearchProtocolError) throw error
        }
      }
      prior = observed
      if (prior) this.captureObservation(envelope, prior)
      if (observed?.status === 'complete') return this.result(envelope, record, observed.result)
      if (observed?.status === 'not-started' && this.deadlineExpired()) return timedOut()
      if (observed?.status === 'partially-complete')
        throw new SearchProtocolError('partial recovery requires completed evaluation cells')
    }
    if (this.deadlineExpired()) throw new PhysicalTransportPending(new SearchBudgetExceeded('time'),
      pendingObservation(prior, 'deadline reached while external execution was unresolved'))
    const delivery = deliveredWorkplan(input.workplan, input.dossier, input.findings, input.scope)
    let value: GeneratedCandidate
    try {
      this.markPhysicalAttempt(envelope)
      value = await this.hooks.generate({ delivery, parent: input.parent, baseline: input.baseline,
        baselineContext: { universe: input.universe, plan: input.plan,
          scope: input.scope, processMode: input.processMode }, idempotencyKey: record.externalKey,
        signal: this.physicalSignal() })
    } catch (error) {
      this.inspectionSignal()
      if (error instanceof SearchExecutionFailure)
        return this.result(envelope, record, this.executionFailure(envelope, error))
      if (error instanceof GepaPhysicalExecutionError) return { outcome: { kind: 'error', code: error.code,
        message: error.message, retryable: false }, usage: this.usage(error.usage.tokens, error.usage.requests) }
      if (error instanceof SearchProtocolError) throw error
      let reason = error instanceof Error ? error.message : String(error)
      if (hasPhysicalGenerationInspection(this.hooks)) {
        try {
          const inspected = await this.inspectPhysicalOutcome(record.externalKey)
          if (inspected.status === 'complete') return this.result(envelope, record, inspected.result)
          if (inspected.status === 'error') return { outcome: { kind: 'error', code: inspected.code,
            message: inspected.message, retryable: false }, usage: this.usage(inspected.usage.tokens, inspected.usage.requests) }
          if (inspected.status === 'not-started' && this.deadlineExpired()) return timedOut()
          throw new PhysicalTransportPending(error, pendingObservation(
            inspected.status === 'not-started' ? { status: 'not-started' }
              : { status: 'unknown' }, reason))
        } catch (inspectionError) {
          this.inspectionSignal()
          if (inspectionError instanceof PhysicalTransportPending) throw inspectionError
          if (inspectionError instanceof SearchExecutionFailure)
            return this.result(envelope, record, this.executionFailure(envelope, inspectionError))
          if (inspectionError instanceof SearchProtocolError) throw inspectionError
          reason = inspectionError instanceof Error ? inspectionError.message : String(inspectionError)
        }
      } else if (this.hooks.inspectGeneration) {
        try {
          const inspected = await this.hooks.inspectGeneration(record.externalKey, this.inspectionSignal())
          validateObservedState(inspected, false)
          if (inspected.status === 'complete') return this.result(envelope, record, inspected.result)
          if (inspected.status === 'not-started' && this.deadlineExpired()) return timedOut()
          throw new PhysicalTransportPending(error, pendingObservation(inspected, reason))
        } catch (inspectionError) {
          this.inspectionSignal()
          if (inspectionError instanceof PhysicalTransportPending) throw inspectionError
          if (inspectionError instanceof SearchExecutionFailure)
            return this.result(envelope, record, this.executionFailure(envelope, inspectionError))
          if (inspectionError instanceof SearchProtocolError) throw inspectionError
          reason = inspectionError instanceof Error ? inspectionError.message : String(inspectionError)
        }
      }
      throw new PhysicalTransportPending(error, pendingObservation(undefined, reason))
    }
    return this.result(envelope, record, value)
  }
  protected async recover(envelope: OperationEnvelope, record: RecordValue): Promise<'not-started' | 'replay-safe' | 'running' | 'unknown'> {
    const input = this.input(envelope)
    if (this.budgetInsufficient(envelope, input.workplan))
      return 'replay-safe'
    if (this.legacyInvocationEnabled && this.capturedInspectionFailure(envelope)) return 'replay-safe'
    if (hasPhysicalGenerationInspection(this.hooks)) {
      const captured = this.legacyInvocationEnabled ? this.capturedObservation(envelope) : undefined
      let observed = (captured?.status === 'complete' ? captured.result
        : captured?.status === 'not-started' ? { status: 'not-started' }
          : captured?.status === 'unknown' ? { status: 'unknown' } : undefined) as PhysicalGenerationInspection | undefined
      if (!observed) {
        try { observed = await this.inspectPhysicalOutcome(record.externalKey) }
        catch (error) {
          if (error instanceof SearchExecutionFailure) {
            this.captureInspectionFailure(envelope, error)
            return 'replay-safe'
          }
          throw error
        }
      }
      this.captureObservation(envelope, observed.status === 'not-started' ? { status: 'not-started' }
        : observed.status === 'unknown' ? { status: 'unknown' } : { status: 'complete', result: observed })
      if (observed.status === 'not-started') return this.deadlineExpired() ? 'replay-safe' : 'not-started'
      if (observed.status === 'error' || observed.status === 'complete') return 'replay-safe'
      return this.legacyInvocationEnabled && !this.deadlineExpired() && input.roundIdentity ? 'replay-safe' : 'unknown'
    }
    if (!this.hooks.inspectGeneration)
      return this.legacyInvocationEnabled && !this.deadlineExpired() && !!input.roundIdentity ? 'replay-safe' : 'unknown'
    let observed = (this.legacyInvocationEnabled ? this.capturedObservation(envelope) : undefined) as
      Awaited<ReturnType<NonNullable<SearchExecutionHooks['inspectGeneration']>>> | undefined
    if (!observed) {
      try { observed = await this.hooks.inspectGeneration(record.externalKey, this.inspectionSignal()) }
      catch (error) {
        if (error instanceof SearchExecutionFailure) {
          this.captureInspectionFailure(envelope, error)
          return 'replay-safe'
        }
        throw error
      }
    }
    this.captureObservation(envelope, observed)
    if (observed.status === 'not-started' && this.deadlineExpired()) return 'replay-safe'
    if (this.legacyInvocationEnabled && !this.deadlineExpired() && input.roundIdentity) return 'replay-safe'
    return observed.status === 'complete' ? 'replay-safe'
      : observed.status === 'running' ? 'running' : 'unknown'
  }
  protected override async lookupLegacyPending(_envelope: OperationEnvelope, record: RecordValue): Promise<ExternalRecovery<unknown> | undefined> {
    if (hasPhysicalGenerationInspection(this.hooks)) {
      const observed = await this.inspectPhysicalOutcome(record.externalKey)
      return observed.status === 'complete' || observed.status === 'error' ? { status: 'complete', result: observed }
        : observed.status === 'not-started' ? { status: 'not-started' } : { status: 'unknown' }
    }
    if (!this.hooks.inspectGeneration) return undefined
    const observed = await this.hooks.inspectGeneration(record.externalKey, this.inspectionSignal())
    validateObservedState(observed, false)
    return observed
  }
  protected async cancelStarted(envelope: OperationEnvelope, record: RecordValue): Promise<Result | 'not-started' | 'replay-safe' | 'running' | 'unknown'> {
    if (!hasPhysicalGenerationInspection(this.hooks)) {
      return this.recover(envelope, record)
    }
    const input = this.input(envelope)
    const delivery = deliveredWorkplan(input.workplan, input.dossier, input.findings, input.scope)
    const observed = await this.hooks.cancelGenerationOutcome({ delivery, parent: input.parent,
      baseline: input.baseline, baselineContext: { universe: input.universe, plan: input.plan,
        scope: input.scope, processMode: input.processMode }, idempotencyKey: record.externalKey,
      signal: this.physicalSignal() })
    if (observed.status === 'error') return { outcome: { kind: 'error', code: observed.code,
      message: observed.message, retryable: false }, usage: this.usage(observed.usage.tokens, observed.usage.requests) }
    if (observed.status === 'complete') return this.result(envelope, record, observed.result)
    return 'unknown'
  }
}
