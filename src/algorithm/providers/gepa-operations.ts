import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FileArtifactStore, assertDigest, durableWrite } from '../artifacts.js'
import { BindingStore } from '../bindings.js'
import type { CompletionEnvelope, OperationEnvelope, OperationOutcome, OperationProvider, ProviderInspection,
  ProviderManifest, ProviderSubmission, UsageReceipt } from '../contracts.js'
import { canonicalJson, jsonDigest, type JsonValue } from '../schema.js'
import { implementationClosureDigest } from '../data/identity.js'
import { durableCreate } from './provider-record.js'
import { digestJson } from '../../state/digest.js'
import { assertCell, assertConsistentCells, cellKey, completeEvidence, plannedCells, profile, validOutcome, verifyCells } from '../../search/evidence.js'
import { deliveredWorkplan, validateReceipt } from '../../search/diagnosis.js'
import { numeric, processTasks, repetitionsForTask, seal, sorted, SearchProtocolError, utility, validateSnapshot, verifyDigest } from '../../search/contracts.js'
import { objectiveProfile, trialPassed } from '../../search/objective.js'
import type { CandidateWorkPlan, CellIdentity, DiagnosisDossier, DiagnosisFact, DiagnosisProvider, EvaluationScope, EvidenceCell,
  ResearchArchive, SearchProvider, Snapshot, StageEvaluationPlan, StageResult, TaskUniverse } from '../../search/types.js'
import type { ResearchFinding } from '../../search/types.js'
import type { GeneratedCandidate, SearchExecutionHooks } from '../../search/runtime.js'

type GepaKind = 'gepa.evaluate' | 'gepa.diagnose' | 'gepa.generate'
type RecordValue = { schemaVersion: 1; operationId: string; inputDigest: string; implementationDigest: string;
  bindingDigest: string; idempotencyKey: string; stage: 'started' | 'cancelled-before-start' | 'complete';
  request?: JsonValue; requestDigest?: string; evaluationCells?: EvidenceCell[]; evaluationCellsDigest?: string;
  completion?: CompletionEnvelope }
type Result = { outcome: OperationOutcome; usage: Record<string, number> }

/** Old physical services remain responsible for their durable original-key lookup. This adapter never retries an unknown started effect. */
abstract class GepaOperationProvider implements OperationProvider {
  private readonly records: string
  private readonly manifest: ProviderManifest
  protected constructor(root: string, kind: GepaKind, implementationConfiguration: JsonValue,
    readonly artifacts: FileArtifactStore, readonly bindings: BindingStore,
    dimensions: string[], inputSchema: ProviderManifest['inputSchema'], outputSchema: ProviderManifest['outputSchema']) {
    this.records = join(root, kind); mkdirSync(this.records, { recursive: true })
    this.manifest = { kind, implementationDigest: implementationClosureDigest(['providers/gepa-operations'],
      { kind, implementationConfiguration }), inputSchema, outputSchema, meteredDimensions: dimensions,
      hardLimitDimensions: [], execution: 'external', supportsInspect: true }
  }
  describe(): ProviderManifest { return structuredClone(this.manifest) }
  protected path(envelope: OperationEnvelope): string {
    assertDigest(envelope.operationId)
    return join(this.records, `${envelope.operationId}.json`)
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
    }
    return { source: this.manifest.kind, scope: 'operation', operationId: envelope.operationId,
      cursor: digestJson(usage), cumulative: usage }
  }
  private read(envelope: OperationEnvelope): RecordValue | null {
    const path = this.path(envelope)
    if (!existsSync(path)) return null
    const record = JSON.parse(readFileSync(path, 'utf8')) as RecordValue
    if (!record || record.schemaVersion !== 1 || !['started', 'cancelled-before-start', 'complete'].includes(record.stage)
      || record.operationId !== envelope.operationId || record.inputDigest !== envelope.inputDigest
      || record.implementationDigest !== envelope.implementationDigest || record.bindingDigest !== envelope.bindingSetRef.digest
      || record.idempotencyKey !== envelope.idempotencyKey
      || record.requestDigest !== (record.request === undefined ? undefined : jsonDigest(record.request))
      || record.evaluationCellsDigest !== (record.evaluationCells === undefined ? undefined : digestJson(record.evaluationCells)))
      throw new Error('GEPA operation record drift')
    return record
  }
  private create(envelope: OperationEnvelope, stage: RecordValue['stage'], request?: JsonValue): { record: RecordValue; created: boolean } {
    const value: RecordValue = { schemaVersion: 1, operationId: envelope.operationId, inputDigest: envelope.inputDigest,
      implementationDigest: envelope.implementationDigest, bindingDigest: envelope.bindingSetRef.digest,
      idempotencyKey: envelope.idempotencyKey, stage,
      ...(request === undefined ? {} : { request, requestDigest: jsonDigest(request) }) }
    const created = durableCreate(this.path(envelope), canonicalJson(value))
    return { record: created ? value : this.read(envelope)!, created }
  }
  private complete(envelope: OperationEnvelope, value: Result): CompletionEnvelope {
    const completion: CompletionEnvelope = { operationId: envelope.operationId, idempotencyKey: envelope.idempotencyKey,
      inputDigest: envelope.inputDigest, implementationDigest: envelope.implementationDigest, outcome: value.outcome,
      receipt: this.receipt(envelope, value.usage) }
    const record = this.read(envelope)!
    if (record.stage === 'cancelled-before-start') throw new Error('GEPA operation was cancelled before starting')
    record.stage = 'complete'; record.completion = completion
    durableWrite(this.path(envelope), canonicalJson(record))
    return completion
  }
  protected abstract validate(envelope: OperationEnvelope): Promise<void>
  protected freezeRequest(_envelope: OperationEnvelope): Promise<JsonValue | undefined> | JsonValue | undefined { return undefined }
  protected abstract execute(envelope: OperationEnvelope, record: RecordValue): Promise<Result>
  protected abstract recover(envelope: OperationEnvelope, record: RecordValue): Promise<Result | 'running' | 'unknown'>
  async preflight(envelope: OperationEnvelope): Promise<void> { this.check(envelope); await this.validate(envelope) }
  async inspect(envelope: OperationEnvelope): Promise<ProviderInspection> {
    await this.preflight(envelope)
    const record = this.read(envelope)
    if (!record) return { status: 'not-started' }
    if (record.stage === 'cancelled-before-start') return { status: 'cancelled', releaseConfirmed: true,
      receipt: this.receipt(envelope, Object.fromEntries(this.manifest.meteredDimensions.map(d => [d, 0]))) }
    if (record.completion) return { status: 'completed', completion: record.completion }
    const recovered = await this.recover(envelope, record)
    if (recovered === 'running' || recovered === 'unknown') return { status: recovered }
    return { status: 'completed', completion: this.complete(envelope, recovered) }
  }
  async submit(envelope: OperationEnvelope): Promise<ProviderSubmission> {
    await this.preflight(envelope)
    const { record, created } = this.create(envelope, 'started', await this.freezeRequest(envelope))
    if (record.stage === 'cancelled-before-start') throw new Error('Cancelled GEPA operation cannot be submitted')
    const observed = created ? { status: 'not-started' as const } : await this.inspect(envelope)
    if (observed.status === 'completed') return { status: 'completed', completion: observed.completion }
    if (!created) return { status: 'running' }
    try { return { status: 'completed', completion: this.complete(envelope, await this.execute(envelope, record)) } }
    catch (error) {
      if (error instanceof SearchProtocolError) throw error
      if (error instanceof Error && /drift|invalid|mismatch|forged|provenance|budget|reserved|exceeds/u.test(error.message)) throw error
      return { status: 'running' }
    }
  }
  async cancel(envelope: OperationEnvelope): Promise<ProviderInspection> {
    await this.preflight(envelope)
    const { record } = this.create(envelope, 'cancelled-before-start')
    if (record.stage === 'cancelled-before-start') return { status: 'cancelled', releaseConfirmed: true,
      receipt: this.receipt(envelope, Object.fromEntries(this.manifest.meteredDimensions.map(d => [d, 0]))) }
    if (record.completion) return { status: 'completed', completion: record.completion }
    // The old physical SPI has no cancel acknowledgement. Inspect the original key
    // so that a completed result can settle, but retain reservations while unknown.
    const recovered = await this.recover(envelope, record)
    if (recovered === 'running' || recovered === 'unknown') return { status: recovered }
    return { status: 'completed', completion: this.complete(envelope, recovered) }
  }
  async collect(envelope: OperationEnvelope): Promise<CompletionEnvelope> {
    const observed = await this.inspect(envelope)
    if (observed.status !== 'completed') throw new Error(`GEPA result unavailable: ${observed.status}`)
    return observed.completion
  }
}

type EvaluateInput = { universe: TaskUniverse; plan: StageEvaluationPlan; snapshot: Snapshot;
  processMode: 'off' | 'auto' | 'required' }
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
  private readonly cellRoot: string
  private readonly projectionRoot: string
  private readonly initialCells = new Map<string, EvidenceCell>()
  private readonly physicalIntegrity: string
  private readonly capabilitiesDigest: string
  constructor(root: string, artifacts: FileArtifactStore, bindings: BindingStore, readonly physical: SearchProvider,
    initialArchive?: ResearchArchive) {
    super(root, 'gepa.evaluate', { providerIntegrity: physical.integrity, capabilities: physical.capabilities,
      processCompletion: !!physical.completeProcess, processInspection: !!physical.inspectProcess,
      initialArchiveDigest: initialArchive?.digest ?? null } as unknown as JsonValue,
      artifacts, bindings, ['rolloutCells', 'repairCells'],
      { type: 'object', required: ['universe', 'plan', 'snapshot', 'processMode'], properties: { universe: { type: 'any' }, plan: { type: 'any' },
        snapshot: { type: 'any' }, processMode: { type: 'string', enum: ['off', 'auto', 'required'] } }, additionalProperties: false },
      { type: 'object', required: ['resultRef'], properties: { resultRef: { type: 'any' } }, additionalProperties: false })
    this.cellRoot = join(root, 'gepa-cells'); mkdirSync(this.cellRoot, { recursive: true })
    this.projectionRoot = join(root, 'gepa-process'); mkdirSync(this.projectionRoot, { recursive: true })
    this.physicalIntegrity = physical.integrity
    this.capabilitiesDigest = digestJson([physical.capabilities, !!physical.completeProcess, !!physical.inspectProcess])
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
  private async cached(expected: CellIdentity[]): Promise<{ cells: EvidenceCell[]; missing: CellIdentity[]; repairCells: number }> {
    const cells: EvidenceCell[] = [], missing: CellIdentity[] = [], inspected: EvidenceCell[] = []
    let repairCells = 0
    for (const identity of expected) {
      const path = join(this.cellRoot, `${cellKey(identity).slice(7)}.json`)
      const persisted = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as EvidenceCell : undefined
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
      throw new Error('GEPA cached cell provenance rejected')
    return { cells, missing, repairCells }
  }
  protected override async freezeRequest(envelope: OperationEnvelope): Promise<JsonValue> {
    const { universe, plan, snapshot } = this.input(envelope)
    const { cells, missing, repairCells } = await this.cached(plannedCells(universe, plan, snapshot))
    return { missing, cached: cells, repairCells } as unknown as JsonValue
  }
  protected async validate(envelope: OperationEnvelope): Promise<void> {
    const { universe, plan, snapshot, processMode } = this.input(envelope)
    verifyDigest(universe); verifyDigest(plan); validateSnapshot(snapshot)
    if (!['off', 'auto', 'required'].includes(processMode)) throw new Error('GEPA process mode is not frozen')
    this.checkSnapshotBinding(envelope, snapshot)
    if (this.physical.integrity !== this.physicalIntegrity
      || digestJson([this.physical.capabilities, !!this.physical.completeProcess, !!this.physical.inspectProcess]) !== this.capabilitiesDigest)
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
  private async project(envelope: OperationEnvelope, base: EvidenceCell): Promise<EvidenceCell> {
    if (!this.physical.completeProcess) throw new Error('GEPA process completion capability is absent')
    const key = digestJson([envelope.operationId, 'process', base.digest])
    const path = join(this.projectionRoot, `${envelope.operationId}-${cellKey(base.identity).slice(7)}.json`)
    const intent: ProjectionRecord = { schemaVersion: 1, operationId: envelope.operationId,
      inputDigest: envelope.inputDigest, baseCellDigest: base.digest, key, stage: 'started' }
    const created = durableCreate(path, canonicalJson(intent))
    const record = created ? intent : JSON.parse(readFileSync(path, 'utf8')) as ProjectionRecord
    if (record.schemaVersion !== 1 || record.operationId !== intent.operationId
      || record.inputDigest !== intent.inputDigest || record.baseCellDigest !== intent.baseCellDigest
      || record.key !== key || !['started', 'complete'].includes(record.stage))
      throw new Error('GEPA process projection identity drift')
    const settle = async (cell: EvidenceCell): Promise<EvidenceCell> => {
      assertCell(cell, base.identity)
      if (!validOutcome(cell)) throw new SearchProtocolError('GEPA process completion replaced a valid outcome')
      assertConsistentCells(base, cell)
      if (!await verifyCells(this.physical, [{ cell, identity: base.identity }]))
        throw new Error('GEPA process completion provenance rejected')
      durableWrite(path, canonicalJson({ ...intent, stage: 'complete', cell }))
      const cellPath = join(this.cellRoot, `${cellKey(cell.identity).slice(7)}.json`)
      let chosen = cell
      if (existsSync(cellPath)) {
        const previous = JSON.parse(readFileSync(cellPath, 'utf8')) as EvidenceCell
        assertCell(previous, base.identity)
        chosen = richerCell(previous, cell)
      }
      durableWrite(cellPath, canonicalJson(chosen))
      return chosen
    }
    if (record.stage === 'complete') {
      if (!record.cell) throw new SearchProtocolError('GEPA completed process projection omitted evidence')
      return settle(record.cell)
    }
    if (!created) {
      if (!this.physical.inspectProcess) throw new ProjectionPending('unknown')
      let observed: Awaited<ReturnType<NonNullable<SearchProvider['inspectProcess']>>>
      try { observed = await this.physical.inspectProcess(base, key, new AbortController().signal) }
      catch (error) { if (error instanceof SearchProtocolError) throw error; throw new ProjectionPending('unknown') }
      if (observed.status === 'complete') {
        if (observed.result.cells.length !== 1) throw new Error('GEPA process inspection returned unexpected cells')
        return settle(observed.result.cells[0]!)
      }
      if (observed.status !== 'not-started') throw new ProjectionPending(observed.status === 'running' ? 'running' : 'unknown')
      // The old SearchProvider promises the same key is idempotent; do not make a new projection key.
    }
    let projected: EvidenceCell
    try { projected = await this.physical.completeProcess(base, key, new AbortController().signal) }
    catch (error) {
      if (error instanceof SearchProtocolError) throw error
      if (this.physical.inspectProcess) {
        let observed: Awaited<ReturnType<NonNullable<SearchProvider['inspectProcess']>>> | undefined
        try {
          observed = await this.physical.inspectProcess(base, key, new AbortController().signal)
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
  private async result(envelope: OperationEnvelope, record: RecordValue, received: EvidenceCell[]): Promise<Result> {
    const { universe, plan, snapshot, processMode } = this.input(envelope)
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
      if (!identity || !requestKeys.has(key) || seen.has(key)) throw new Error('GEPA evaluation returned unrequested or duplicate cells')
      assertCell(cell, identity); seen.add(key)
    }
    if (!await verifyCells(this.physical, received.map(cell => ({ cell, identity: byKey.get(cellKey(cell.identity))! }))))
      throw new Error('GEPA evaluation cell provenance rejected')
    if (record.evaluationCells) {
      if (digestJson(record.evaluationCells) !== digestJson(received))
        throw new Error('GEPA original evaluation cells changed on recovery')
    } else {
      record.evaluationCells = received
      record.evaluationCellsDigest = digestJson(received)
      durableWrite(this.path(envelope), canonicalJson(record))
    }
    const existing = await this.cached(expected)
    const cellsByKey = new Map(existing.cells.map(cell => [cellKey(cell.identity), cell]))
    for (const cell of received) {
      const key = cellKey(cell.identity), previous = cellsByKey.get(key)
      const selected = previous ? richerCell(previous, cell) : cell
      cellsByKey.set(key, selected)
      const path = join(this.cellRoot, `${key.slice(7)}.json`)
      if (!durableCreate(path, canonicalJson(selected))) {
        const persisted = JSON.parse(readFileSync(path, 'utf8')) as EvidenceCell
        assertCell(persisted, byKey.get(key)!)
        const latest = richerCell(persisted, selected)
        cellsByKey.set(key, latest)
        if (latest.digest !== persisted.digest) durableWrite(path, canonicalJson(latest))
      }
    }
    const originals = [...request.cached, ...received]
    let cells = originals.map(cell => cellsByKey.get(cellKey(cell.identity)) ?? cell)
    const usage = { rolloutCells: requested.length, repairCells: request.repairCells }
    const applicable = new Set(processTasks(universe, processMode))
    const requiredMetrics = new Set([...(universe.objective?.terms.filter(term => term.weight !== 0).map(term => term.metric) ?? []),
      ...(universe.objective?.constraints.map(constraint => constraint.metric) ?? [])])
    const missingProjection = (cell: EvidenceCell): boolean => validOutcome(cell) && (
      applicable.has(cell.identity.taskId) && cell.process?.status !== 'available'
      || [...requiredMetrics].some(metric => cell.rawMetrics?.metrics[metric]?.status !== 'available'))
    for (const cell of [...cells]) {
      const original = originals.find(item => cellKey(item.identity) === cellKey(cell.identity))!
      const projectionPath = join(this.projectionRoot, `${envelope.operationId}-${cellKey(cell.identity).slice(7)}.json`)
      if (!missingProjection(cell) && !existsSync(projectionPath)) continue
      if (!this.physical.completeProcess) return { outcome: { kind: 'error', code: 'PROCESS_COMPLETION_UNSUPPORTED',
        message: 'Original-run process/raw-metric completion is unavailable from this provider' }, usage }
      const projected = await this.project(envelope, original)
      const before: StageResult = seal({ stagePlanDigest: plan.digest, snapshotDigest: snapshot.digest, cells, settled: true })
      cells = completeEvidence(before, [projected]).cells
      if (missingProjection(projected)) return { outcome: { kind: 'error', code: 'PROCESS_COMPLETION_INCOMPLETE',
        message: 'Original-run process/raw-metric completion did not supply the required evidence' }, usage }
    }
    const result: StageResult = seal({ stagePlanDigest: plan.digest, snapshotDigest: snapshot.digest, cells, settled: true })
    profile(universe, plan, snapshot, result, processMode)
    const resultRef = this.artifacts.putJson(result as unknown as JsonValue, 'gepa.stage-result.v1')
    return { outcome: { kind: 'result', value: { resultRef } }, usage }
  }
  protected async execute(envelope: OperationEnvelope, record: RecordValue): Promise<Result> {
    const { plan, snapshot, universe } = this.input(envelope)
    const request = record.request as unknown as FrozenEvaluationRequest
    const requested = request.missing
    if (requested.length > envelope.limits.rolloutCells! || request.repairCells > envelope.limits.repairCells!)
      return { outcome: { kind: 'no-result', reason: 'rollout-cell-budget-exhausted' },
      usage: { rolloutCells: 0, repairCells: 0 } }
    if (!requested.length) return this.result(envelope, record, [])
    const cells = await this.physical.evaluate({ plan, snapshot, cells: requested,
      idempotencyKey: envelope.idempotencyKey, signal: new AbortController().signal })
    return this.result(envelope, record, cells)
  }
  protected async recover(envelope: OperationEnvelope, record: RecordValue): Promise<Result | 'running' | 'unknown'> {
    const { plan, snapshot } = this.input(envelope)
    const request = record.request as unknown as FrozenEvaluationRequest
    const requested = request.missing
    if (requested.length > envelope.limits.rolloutCells! || request.repairCells > envelope.limits.repairCells!)
      return { outcome: { kind: 'no-result', reason: 'rollout-cell-budget-exhausted' },
      usage: { rolloutCells: 0, repairCells: 0 } }
    if (record.evaluationCells) {
      try { return await this.result(envelope, record, record.evaluationCells) }
      catch (error) { if (error instanceof ProjectionPending) return error.status; throw error }
    }
    if (!requested.length) {
      try { return await this.result(envelope, record, []) }
      catch (error) { if (error instanceof ProjectionPending) return error.status; throw error }
    }
    if (!this.physical.inspectEvaluation) return 'unknown'
    const observed = await this.physical.inspectEvaluation({ plan, snapshot, cells: requested,
      idempotencyKey: envelope.idempotencyKey, signal: new AbortController().signal })
    if (observed.status === 'complete') {
      try { return await this.result(envelope, record, observed.result.cells) }
      catch (error) { if (error instanceof ProjectionPending) return error.status; throw error }
    }
    return observed.status === 'running' ? 'running' : 'unknown'
  }
}

type DiagnoseInput = { snapshot: Snapshot; universe: TaskUniverse; taskIds: string[]; baseline: StageResult }
export class GepaDiagnosisProvider extends GepaOperationProvider {
  private readonly identityDigest: string
  constructor(root: string, artifacts: FileArtifactStore, bindings: BindingStore, readonly physical: DiagnosisProvider) {
    super(root, 'gepa.diagnose', { integrity: physical.integrity, sanitizationPolicyDigest: physical.sanitizationPolicyDigest } as JsonValue,
      artifacts, bindings, ['diagnosisInputTokens', 'diagnosisOutputTokens'],
      { type: 'object', required: ['snapshot', 'universe', 'taskIds', 'baseline'], properties: {
        snapshot: { type: 'any' }, universe: { type: 'any' }, taskIds: { type: 'array', items: { type: 'string' } }, baseline: { type: 'any' } }, additionalProperties: false },
      { type: 'object', required: ['dossierRef'], properties: { dossierRef: { type: 'any' } }, additionalProperties: false })
    this.identityDigest = digestJson([physical.integrity, physical.sanitizationPolicyDigest])
  }
  private input(envelope: OperationEnvelope): DiagnoseInput { return envelope.input as unknown as DiagnoseInput }
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
  private result(envelope: OperationEnvelope, value: { facts: DiagnosisFact[]; inputTokens: number; outputTokens: number }): Result {
    const { snapshot, universe, taskIds, baseline } = this.input(envelope)
    for (const fact of value.facts) {
      const cells = baseline.cells.filter(cell => cell.identity.taskId === fact.taskId)
      const refs = new Set(cells.flatMap(cell => [cell.evidenceRef,
        ...(cell.outcome.status === 'available' ? [cell.outcome.evidenceRef] : []),
        ...(cell.process?.status === 'available' ? [cell.process.evidenceRef] : [])]))
      if (!taskIds.includes(fact.taskId) || fact.evidenceRefs.some(ref => !refs.has(ref)))
        throw new Error('GEPA diagnosis fact lacks parent evidence provenance')
      if (fact.status === 'supported-hypothesis') {
        if (universe.objective) {
          const projected = objectiveProfile(universe, [fact.taskId], cells)
          if (!fact.evidenceRefs.length || !projected.objectiveComplete) throw new Error('GEPA objective hypothesis missing evidence')
          if (fact.objectiveEvidence && fact.objectiveEvidence.digest !== projected.objectiveScore?.digest)
            throw new Error('GEPA objective hypothesis evidence mismatch')
        } else if (!fact.evidenceRefs.length || !cells.some(cell => cell.outcome.status === 'available'
          && numeric(utility(cell.outcome.rawValue, universe.tasks.find(task => task.id === fact.taskId)!.outcome))
            < universe.tasks.find(task => task.id === fact.taskId)!.successUtility))
          throw new Error('GEPA failure cluster lacks valid business failure')
      }
      if (fact.status === 'successful-control' && (!fact.evidenceRefs.length
        || cells.length !== repetitionsForTask(universe, fact.taskId).length || !cells.every(cell => trialPassed(cell, universe))))
        throw new Error('GEPA successful control lacks complete evidence')
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
      sanitizationPolicyDigest: this.physical.sanitizationPolicyDigest })
    const dossierRef = this.artifacts.putJson(dossier as unknown as JsonValue, 'gepa.dossier.v1')
    return { outcome: { kind: 'result', value: { dossierRef } },
      usage: { diagnosisInputTokens: value.inputTokens, diagnosisOutputTokens: value.outputTokens } }
  }
  protected async execute(envelope: OperationEnvelope): Promise<Result> {
    if (envelope.limits.diagnosisInputTokens === 0 || envelope.limits.diagnosisOutputTokens === 0)
      return { outcome: { kind: 'no-result', reason: 'diagnosis-budget-exhausted' },
        usage: { diagnosisInputTokens: 0, diagnosisOutputTokens: 0 } }
    const { snapshot, universe, taskIds, baseline } = this.input(envelope)
    const value = await this.physical.diagnose({ snapshot, universe, taskIds, cells: baseline.cells,
      idempotencyKey: envelope.idempotencyKey, maxInputTokens: envelope.limits.diagnosisInputTokens!,
      maxOutputTokens: envelope.limits.diagnosisOutputTokens!, signal: new AbortController().signal })
    return this.result(envelope, value)
  }
  protected async recover(envelope: OperationEnvelope): Promise<Result | 'running' | 'unknown'> {
    if (envelope.limits.diagnosisInputTokens === 0 || envelope.limits.diagnosisOutputTokens === 0)
      return { outcome: { kind: 'no-result', reason: 'diagnosis-budget-exhausted' },
        usage: { diagnosisInputTokens: 0, diagnosisOutputTokens: 0 } }
    if (!this.physical.inspectDiagnosis) return 'unknown'
    const observed = await this.physical.inspectDiagnosis(envelope.idempotencyKey, new AbortController().signal)
    if (observed.status === 'complete') return this.result(envelope, observed.result)
    return observed.status === 'running' ? 'running' : 'unknown'
  }
}

type GenerateInput = { workplan: CandidateWorkPlan; dossier: DiagnosisDossier; scope: EvaluationScope;
  parent: Snapshot; plan: StageEvaluationPlan; baseline: StageResult; universe: TaskUniverse;
  findings: ResearchFinding[]; processMode: 'off' | 'auto' | 'required' }
export class GepaGenerationProvider extends GepaOperationProvider {
  constructor(root: string, artifacts: FileArtifactStore, bindings: BindingStore, readonly hooks: SearchExecutionHooks,
    readonly hookImplementationDigest: string) {
    assertDigest(hookImplementationDigest)
    super(root, 'gepa.generate', { hookImplementationDigest }, artifacts, bindings,
      ['generationTokens', 'generationRequests'],
      { type: 'object', required: ['workplan', 'dossier', 'scope', 'parent', 'plan', 'baseline', 'universe', 'findings', 'processMode'],
        properties: { workplan: { type: 'any' }, dossier: { type: 'any' }, scope: { type: 'any' }, parent: { type: 'any' },
          plan: { type: 'any' }, baseline: { type: 'any' }, universe: { type: 'any' }, findings: { type: 'array', items: { type: 'any' } },
          processMode: { type: 'string' } }, additionalProperties: false },
      { type: 'object', required: ['generatedRef', 'candidateSetRef'], properties: {
        generatedRef: { type: 'any' }, candidateSetRef: { type: 'any' } }, additionalProperties: false })
  }
  private input(envelope: OperationEnvelope): GenerateInput { return envelope.input as unknown as GenerateInput }
  protected async validate(envelope: OperationEnvelope): Promise<void> {
    const { workplan, dossier, scope, parent, plan, baseline, universe, findings } = this.input(envelope)
    for (const value of [workplan, dossier, scope, plan, baseline, universe]) verifyDigest(value)
    validateSnapshot(parent)
    this.checkSnapshotBinding(envelope, parent)
    if (workplan.parentSnapshotDigest !== parent.digest || workplan.dossierDigest !== dossier.digest
      || workplan.scopeDigest !== scope.digest || workplan.localStagePlanDigest !== plan.digest
      || baseline.stagePlanDigest !== plan.digest
      || baseline.snapshotDigest !== parent.digest || universe.partition !== 'seed') throw new Error('GEPA generation context drift')
    if (!Array.isArray(findings) || digestJson(findings.map(item => item.digest)) !== digestJson(parent.findingRefs))
      throw new Error('GEPA generation parent findings drift')
    for (const finding of findings) verifyDigest(finding)
    if (!Number.isSafeInteger(envelope.limits.generationTokens) || envelope.limits.generationTokens! < 0
      || !Number.isSafeInteger(envelope.limits.generationRequests) || envelope.limits.generationRequests! < 0)
      throw new Error('GEPA generation reservation invalid')
  }
  private async result(envelope: OperationEnvelope, value: GeneratedCandidate): Promise<Result> {
    verifyDigest(value)
    const input = this.input(envelope)
    if (!Number.isSafeInteger(value.usage.tokens) || value.usage.tokens! < 0
      || !Number.isSafeInteger(value.usage.requests) || value.usage.requests! < 0)
      throw new Error('GEPA generation omitted measured final usage')
    const usage = { generationTokens: value.usage.tokens!, generationRequests: value.usage.requests! }
    if (!value.snapshot) return { outcome: { kind: 'no-result', reason: value.reason ?? 'GEPA generated no candidate' }, usage }
    validateSnapshot(value.snapshot); await this.hooks.verifySnapshot(value.snapshot)
    if (value.snapshot.candidateId !== input.workplan.candidateId || value.snapshot.parentIds.length !== 1
      || value.snapshot.parentIds[0] !== input.parent.candidateId || !value.receipt || !value.sessionId)
      throw new Error('GEPA generated candidate parent or receipt mismatch')
    const delivery = deliveredWorkplan(input.workplan, input.dossier, input.findings, input.scope)
    validateReceipt(value.receipt, delivery, value.sessionId)
    const candidateRef = this.artifacts.putJson({ schemaVersion: 1, kind: 'git-harness', commitOid: value.snapshot.commit,
      manifestDigest: value.snapshot.manifestDigest } as JsonValue, 'harness.directory.v1')
    const candidateSetRef = this.bindings.derive(envelope.bindingSetRef, { harness: candidateRef })
    const generatedRef = this.artifacts.putJson(value as unknown as JsonValue, 'gepa.generated.v1')
    return { outcome: { kind: 'result', value: { generatedRef, candidateSetRef } as unknown as JsonValue }, usage }
  }
  protected async execute(envelope: OperationEnvelope): Promise<Result> {
    const input = this.input(envelope)
    if (envelope.limits.generationTokens! < (input.workplan.generationBudget.maxTokens ?? 0)
      || envelope.limits.generationRequests! < (input.workplan.generationBudget.maxModelRequests ?? 0))
      return { outcome: { kind: 'no-result', reason: 'generation-budget-exhausted' },
        usage: { generationTokens: 0, generationRequests: 0 } }
    const delivery = deliveredWorkplan(input.workplan, input.dossier, input.findings, input.scope)
    const value = await this.hooks.generate({ delivery, parent: input.parent, baseline: input.baseline,
      baselineContext: { universe: input.universe, plan: input.plan,
        scope: input.scope, processMode: input.processMode }, idempotencyKey: envelope.idempotencyKey,
      signal: new AbortController().signal })
    return this.result(envelope, value)
  }
  protected async recover(envelope: OperationEnvelope): Promise<Result | 'running' | 'unknown'> {
    const input = this.input(envelope)
    if (envelope.limits.generationTokens! < (input.workplan.generationBudget.maxTokens ?? 0)
      || envelope.limits.generationRequests! < (input.workplan.generationBudget.maxModelRequests ?? 0))
      return { outcome: { kind: 'no-result', reason: 'generation-budget-exhausted' },
        usage: { generationTokens: 0, generationRequests: 0 } }
    if (!this.hooks.inspectGeneration) return 'unknown'
    const observed = await this.hooks.inspectGeneration(envelope.idempotencyKey, new AbortController().signal)
    if (observed.status === 'complete') return this.result(envelope, observed.result)
    return observed.status === 'running' ? 'running' : 'unknown'
  }
}
