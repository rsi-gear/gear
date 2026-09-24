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
import { assertCell, assertConsistentCells, cellKey, plannedCells, profile, validOutcome, verifyCells } from '../../search/evidence.js'
import { deliveredWorkplan, validateReceipt } from '../../search/diagnosis.js'
import { numeric, repetitionsForTask, seal, sorted, SearchProtocolError, utility, validateSnapshot, verifyDigest } from '../../search/contracts.js'
import { objectiveProfile, trialPassed } from '../../search/objective.js'
import type { CandidateWorkPlan, CellIdentity, DiagnosisDossier, DiagnosisFact, DiagnosisProvider, EvaluationScope, EvidenceCell,
  ResearchArchive, SearchProvider, Snapshot, StageEvaluationPlan, StageResult, TaskUniverse } from '../../search/types.js'
import type { ResearchFinding } from '../../search/types.js'
import type { GeneratedCandidate, SearchExecutionHooks } from '../../search/runtime.js'

type GepaKind = 'gepa.evaluate' | 'gepa.diagnose' | 'gepa.generate'
type RecordValue = { schemaVersion: 1; operationId: string; inputDigest: string; implementationDigest: string;
  bindingDigest: string; idempotencyKey: string; stage: 'started' | 'cancelled-before-start' | 'complete';
  request?: JsonValue; requestDigest?: string; completion?: CompletionEnvelope }
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
      || record.requestDigest !== (record.request === undefined ? undefined : jsonDigest(record.request)))
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

type EvaluateInput = { universe: TaskUniverse; plan: StageEvaluationPlan; snapshot: Snapshot }
type FrozenEvaluationRequest = { missing: CellIdentity[]; cached: EvidenceCell[]; repairCells: number }
export class GepaEvaluationProvider extends GepaOperationProvider {
  private readonly cellRoot: string
  private readonly initialCells = new Map<string, EvidenceCell>()
  private readonly physicalIntegrity: string
  private readonly capabilitiesDigest: string
  constructor(root: string, artifacts: FileArtifactStore, bindings: BindingStore, readonly physical: SearchProvider,
    initialArchive?: ResearchArchive) {
    super(root, 'gepa.evaluate', { providerIntegrity: physical.integrity, capabilities: physical.capabilities,
      initialArchiveDigest: initialArchive?.digest ?? null } as unknown as JsonValue,
      artifacts, bindings, ['rolloutCells', 'repairCells'],
      { type: 'object', required: ['universe', 'plan', 'snapshot'], properties: { universe: { type: 'any' }, plan: { type: 'any' }, snapshot: { type: 'any' } }, additionalProperties: false },
      { type: 'object', required: ['resultRef'], properties: { resultRef: { type: 'any' } }, additionalProperties: false })
    this.cellRoot = join(root, 'gepa-cells'); mkdirSync(this.cellRoot, { recursive: true })
    this.physicalIntegrity = physical.integrity
    this.capabilitiesDigest = digestJson(physical.capabilities)
    if (initialArchive) {
      verifyDigest(initialArchive)
      for (const result of initialArchive.results) for (const cell of result.cells) {
        const key = cellKey(cell.identity), previous = this.initialCells.get(key)
        if (previous && validOutcome(previous) && validOutcome(cell)) assertConsistentCells(previous, cell)
        if (!previous || validOutcome(cell)) this.initialCells.set(key, cell)
      }
    }
  }
  private input(envelope: OperationEnvelope): EvaluateInput { return envelope.input as unknown as EvaluateInput }
  private async cached(expected: CellIdentity[]): Promise<{ cells: EvidenceCell[]; missing: CellIdentity[]; repairCells: number }> {
    const cells: EvidenceCell[] = [], missing: CellIdentity[] = [], inspected: EvidenceCell[] = []
    let repairCells = 0
    for (const identity of expected) {
      const path = join(this.cellRoot, `${cellKey(identity).slice(7)}.json`)
      const cell = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as EvidenceCell : this.initialCells.get(cellKey(identity))
      if (!cell) { missing.push(identity); continue }
      assertCell(cell, identity); inspected.push(cell)
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
    const { universe, plan, snapshot } = this.input(envelope)
    verifyDigest(universe); verifyDigest(plan); validateSnapshot(snapshot)
    this.checkSnapshotBinding(envelope, snapshot)
    if (this.physical.integrity !== this.physicalIntegrity || digestJson(this.physical.capabilities) !== this.capabilitiesDigest)
      throw new Error('GEPA physical evaluator identity drift')
    if (plan.universeDigest !== universe.digest || plan.partition !== universe.partition || !plan.participantIds.includes(snapshot.candidateId)
      || digestJson(await this.physical.describe(universe.partition)) !== digestJson(universe)) throw new Error('GEPA evaluation input/provider drift')
    if (!this.physical.capabilities.taskSubsetPlans || !this.physical.capabilities.batchIndependentCells || !this.physical.capabilities.idempotentExecution)
      throw new Error('GEPA evaluation provider lacks subset/idempotent capabilities')
    if (!Number.isSafeInteger(envelope.limits.rolloutCells) || envelope.limits.rolloutCells! < 0
      || !Number.isSafeInteger(envelope.limits.repairCells) || envelope.limits.repairCells! < 0)
      throw new Error('GEPA evaluation reservation invalid')
  }
  private async result(envelope: OperationEnvelope, record: RecordValue, received: EvidenceCell[]): Promise<Result> {
    const { universe, plan, snapshot } = this.input(envelope)
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
    const existing = await this.cached(expected)
    const cellsByKey = new Map(existing.cells.map(cell => [cellKey(cell.identity), cell]))
    for (const cell of received) {
      const key = cellKey(cell.identity), previous = cellsByKey.get(key)
      if (previous) assertConsistentCells(previous, cell)
      cellsByKey.set(key, cell)
      const path = join(this.cellRoot, `${key.slice(7)}.json`)
      if (!durableCreate(path, canonicalJson(cell))) {
        const persisted = JSON.parse(readFileSync(path, 'utf8')) as EvidenceCell
        assertCell(persisted, byKey.get(key)!)
        if (validOutcome(persisted)) assertConsistentCells(persisted, cell)
        else durableWrite(path, canonicalJson(cell))
      }
    }
    const cells = [...request.cached, ...received]
    const result: StageResult = seal({ stagePlanDigest: plan.digest, snapshotDigest: snapshot.digest, cells, settled: true })
    profile(universe, plan, snapshot, result, 'auto')
    const resultRef = this.artifacts.putJson(result as unknown as JsonValue, 'gepa.stage-result.v1')
    return { outcome: { kind: 'result', value: { resultRef } },
      usage: { rolloutCells: requested.length, repairCells: request.repairCells } }
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
    if (!requested.length) return this.result(envelope, record, [])
    if (!this.physical.inspectEvaluation) return 'unknown'
    const observed = await this.physical.inspectEvaluation({ plan, snapshot, cells: requested,
      idempotencyKey: envelope.idempotencyKey, signal: new AbortController().signal })
    if (observed.status === 'complete') return this.result(envelope, record, observed.result.cells)
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
