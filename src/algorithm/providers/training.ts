import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { FileArtifactStore, durableWrite, assertDigest } from '../artifacts.js'
import { BindingStore } from '../bindings.js'
import type { CompletionEnvelope, OperationEnvelope, OperationOutcome, OperationProvider, ProviderInspection, ProviderManifest, ProviderSubmission, UsageReceipt } from '../contracts.js'
import { assertJson, canonicalJson, jsonDigest, type JsonValue } from '../schema.js'
import { digestJson } from '../../training/digest.js'
import { preflightTrainingRequest, validateTrainingArtifacts } from '../../training/operation-contracts.js'
import { parseTrainingArtifacts, parseTrainingHandle, parseTrainingStatus, requireContract, TrainingContractError } from '../../training/schema.js'
import type { TrainingContentStore } from '../../training/store.js'
import type * as T from '../../training/types.js'
import { localSlimeJobLookup, mapFrozenTrainingRequest, nodeSlimeJobLookup, sealTrainingModelBinding, TRAINING_USAGE_SOURCE, trainingOperationImplementationDigest, verifyNodeTrainingRuntime, type TrainingJobLookup, type TrainingRequestMapping } from './training-mapping.js'
import { HitchModelEvaluator } from '../../training/hitch.js'
import { NodeSlimeModelTrainer, SlimeModelTrainer } from '../../training/slime.js'
import { hitchBackendIdentityDigest } from './model-evaluation.js'
import { ModelTrainingCoordinator } from '../../training/coordinator.js'
import { ModelTrainingStore } from '../../training/store.js'
import { durableCreate } from './provider-record.js'

type SavedMapping = {
  schemaVersion: 1
  operationId: string
  inputDigest: string
  implementationDigest: string
  bindingDigest: string
  request: T.TrainingRequest
  requestDigest: string
  idempotencyKey: string
  stage: 'prepared' | 'submit-intent' | 'running' | 'cancel-intent' | 'cancelled-before-start' | 'complete'
  handle?: T.TrainingHandle
  completion?: CompletionEnvelope
}
function unknownOrIntegrityError(error: unknown): ProviderInspection {
  if (error instanceof TrainingContractError && /drift|invalid|corrupt|conflict|stale|mismatch/u.test(error.code)) throw error
  return { status: 'unknown' }
}

export class SlimeTrainingOperationProvider implements OperationProvider {
  private readonly records: string
  private readonly implementationDigest: string
  private readonly lookupIdentityDigest: string
  constructor(readonly root: string, readonly bindings: BindingStore, readonly artifacts: FileArtifactStore,
    readonly trainingStore: TrainingContentStore, readonly trainer: T.ModelTrainer, readonly lookup: TrainingJobLookup) {
    this.records = join(root, 'operations'); mkdirSync(this.records, { recursive: true })
    this.lookupIdentityDigest = lookup.identityDigest
    this.implementationDigest = trainingOperationImplementationDigest(this.lookupIdentityDigest)
  }

  describe(): ProviderManifest {
    return { kind: 'training.slime', implementationDigest: this.implementationDigest, execution: 'external', supportsInspect: true,
      meteredDimensions: ['trainingGpuSeconds', 'rolloutTokens', 'groupResamples'], hardLimitDimensions: [],
      inputSchema: { type: 'object', properties: { plan: { type: 'any' }, learnerSlot: { type: 'string' }, harnessSlot: { type: 'string' } },
        required: ['plan', 'learnerSlot', 'harnessSlot'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { candidateBindingRef: { type: 'any' }, modelRef: { type: 'any' },
        checkpointRef: { type: 'any' }, trainingRunId: { type: 'string' }, requestDigest: { type: 'string' } },
        required: ['candidateBindingRef', 'modelRef', 'checkpointRef', 'trainingRunId', 'requestDigest'], additionalProperties: false },
    }
  }

  private path(envelope: OperationEnvelope): string { assertDigest(envelope.operationId); return join(this.records, `${envelope.operationId}.json`) }
  private read(envelope: OperationEnvelope, mapped: TrainingRequestMapping): SavedMapping | null {
    const path = this.path(envelope); if (!existsSync(path)) return null
    const value = JSON.parse(readFileSync(path, 'utf8')) as SavedMapping
    assertJson(value)
    requireContract(['prepared', 'submit-intent', 'running', 'cancel-intent', 'cancelled-before-start', 'complete'].includes(value.stage),
      'invalid-training-mapping', 'saved training stage is invalid')
    if (value.handle) parseTrainingHandle(value.handle)
    requireContract(value.schemaVersion === 1 && value.operationId === envelope.operationId && value.inputDigest === envelope.inputDigest
      && value.implementationDigest === envelope.implementationDigest && value.bindingDigest === envelope.bindingSetRef.digest
      && value.idempotencyKey === mapped.idempotencyKey && value.requestDigest === mapped.requestDigest
      && digestJson(value.request) === mapped.requestDigest,
    'training-request-drift', 'saved training mapping differs from frozen operation/request')
    return value
  }
  private save(envelope: OperationEnvelope, mapping: SavedMapping): void { durableWrite(this.path(envelope), canonicalJson(mapping)) }
  private async mapped(envelope: OperationEnvelope): Promise<TrainingRequestMapping> {
    requireContract(this.lookup.identityDigest === this.lookupIdentityDigest, 'training-backend-drift',
      'training job lookup backend identity changed')
    requireContract(envelope.kind === 'training.slime' && envelope.implementationDigest === this.implementationDigest,
      'training-provider-drift', 'training operation belongs to another implementation')
    return mapFrozenTrainingRequest(envelope, this.bindings, this.artifacts, this.trainingStore)
  }
  private ensure(envelope: OperationEnvelope, mapped: TrainingRequestMapping): SavedMapping {
    const existing = this.read(envelope, mapped)
    if (existing) return existing
    const mapping: SavedMapping = { schemaVersion: 1, operationId: envelope.operationId, inputDigest: envelope.inputDigest,
      implementationDigest: envelope.implementationDigest, bindingDigest: envelope.bindingSetRef.digest,
      request: mapped.request, requestDigest: mapped.requestDigest, idempotencyKey: mapped.idempotencyKey, stage: 'prepared' }
    if (durableCreate(this.path(envelope), canonicalJson(mapping))) return mapping
    return this.read(envelope, mapped)!
  }
  private expectedHandle(request: T.TrainingRequest, key: string): T.TrainingHandle {
    const base = { provider: 'slime' as const, jobId: `job_${digestJson(key).slice(7, 39)}`, requestDigest: digestJson(request) }
    return request.schemaVersion === 2
      ? { ...base, schemaVersion: 2, node: { nodeId: request.deployment.modelRuntime.nodeId, generation: request.deployment.modelRuntime.generation } }
      : { ...base, schemaVersion: 1 }
  }
  private assertStatus(mapping: SavedMapping, input: unknown): T.TrainingStatus {
    const status = parseTrainingStatus(input)
    const expected = this.expectedHandle(mapping.request, mapping.idempotencyKey)
    requireContract(digestJson(status.handle) === digestJson(expected)
      && (!mapping.handle || digestJson(mapping.handle) === digestJson(status.handle)),
    'training-status-drift', 'trainer status differs from frozen run/key/node')
    return status
  }
  private receipt(envelope: OperationEnvelope, usage: T.TrainingUsage, status: { phase: string; execution: string; resourcesReleased: boolean }): UsageReceipt {
    return { source: TRAINING_USAGE_SOURCE, scope: 'operation', operationId: envelope.operationId,
      cursor: digestJson({ usage, status }), cumulative: { trainingGpuSeconds: usage.gpuSeconds, rolloutTokens: usage.rolloutTokens, groupResamples: usage.groupResamples } }
  }
  private completion(envelope: OperationEnvelope, outcome: OperationOutcome, receipt: UsageReceipt): CompletionEnvelope {
    return { operationId: envelope.operationId, idempotencyKey: envelope.idempotencyKey, inputDigest: envelope.inputDigest,
      implementationDigest: envelope.implementationDigest, outcome, receipt }
  }
  private async finalFromStatus(envelope: OperationEnvelope, mapping: SavedMapping, status: T.TrainingStatus): Promise<ProviderInspection> {
    const receipt = this.receipt(envelope, status.usage, status)
    if (!status.resourcesReleased) return { status: 'running', handle: status.handle.jobId, receipt }
    let outcome: OperationOutcome
    let finalUsage = status.usage
    if (status.execution === 'completed' && status.phase === 'inconclusive') outcome = { kind: 'no-result', reason: status.message ?? 'no complete training batch' }
    else if (status.execution === 'completed') {
      const raw = parseTrainingArtifacts(await this.trainer.collect(status.handle))
      const validated = await validateTrainingArtifacts(this.trainingStore, mapping.request, status.handle, raw)
      requireContract(validated.resourcesReleased, 'gpu-not-released', 'trainer must confirm resource release before candidate evaluation')
      const modelRef = await this.trainingStore.putJson(validated.model)
      const candidateBindingRef = await sealTrainingModelBinding(this.artifacts, this.trainingStore, modelRef)
      outcome = { kind: 'result', value: { candidateBindingRef, modelRef, checkpointRef: validated.checkpointRef,
        trainingRunId: mapping.request.trainingRunId, requestDigest: mapping.requestDigest } as unknown as JsonValue }
      finalUsage = validated.usage
    } else if (['failed', 'blocked', 'interrupted'].includes(status.execution)) {
      outcome = { kind: 'error', code: `training-${status.execution}`, message: status.message ?? `training ${status.execution}` }
    } else if (status.execution === 'paused') {
      outcome = { kind: 'inconclusive', reason: status.message ?? 'training paused before a candidate was produced' }
    } else return { status: 'running', handle: status.handle.jobId, receipt }
    const complete = this.completion(envelope, outcome, this.receipt(envelope, finalUsage, status))
    mapping.stage = 'complete'; mapping.completion = complete; mapping.handle = status.handle
    this.save(envelope, mapping)
    return { status: 'completed', completion: complete }
  }

  private async replayCancel(envelope: OperationEnvelope, mapping: SavedMapping): Promise<ProviderInspection> {
    let stopped: T.TrainingStatus
    try {
      if (mapping.request.schemaVersion === 2) {
        requireContract(this.trainer.control, 'training-control-unavailable', 'v2 requires ordered pause')
        stopped = this.assertStatus(mapping, await this.trainer.control(mapping.request, mapping.idempotencyKey,
          { schemaVersion: 2, sequence: 1, action: 'pause' }))
      } else stopped = this.assertStatus(mapping, await this.trainer.cancel(mapping.handle ?? this.expectedHandle(mapping.request, mapping.idempotencyKey)))
    } catch (error) { return unknownOrIntegrityError(error) }
    return { status: 'cancelled', releaseConfirmed: stopped.resourcesReleased,
      receipt: this.receipt(envelope, stopped.usage, stopped) }
  }

  async preflight(envelope: OperationEnvelope): Promise<void> {
    const mapped = await this.mapped(envelope)
    await preflightTrainingRequest(this.trainingStore, this.trainer, mapped.request)
  }

  async inspect(envelope: OperationEnvelope): Promise<ProviderInspection> {
    const mapped = await this.mapped(envelope)
    const mapping = this.read(envelope, mapped)
    if (!mapping) return { status: 'not-started' }
    if (mapping.completion) return { status: 'completed', completion: mapping.completion }
    if (mapping.stage === 'cancelled-before-start') return { status: 'cancelled', releaseConfirmed: true,
      receipt: this.receipt(envelope, { gpuSeconds: 0, rolloutTokens: 0, groupResamples: 0 },
        { phase: 'admitted', execution: 'paused', resourcesReleased: true }) }
    if (mapping.stage === 'cancel-intent') return this.replayCancel(envelope, mapping)
    let status: T.TrainingStatus | null
    try { status = await this.lookup.find(mapping.request, mapping.idempotencyKey) }
    catch (error) { return unknownOrIntegrityError(error) }
    if (!status) return mapping.stage === 'prepared' || mapping.stage === 'submit-intent'
      ? { status: 'not-started' } : { status: 'unknown' }
    return this.finalFromStatus(envelope, mapping, this.assertStatus(mapping, status))
  }

  async submit(envelope: OperationEnvelope): Promise<ProviderSubmission> {
    const mapped = await this.mapped(envelope)
    const mapping = this.ensure(envelope, mapped)
    if (mapping.completion) return { status: 'completed', completion: mapping.completion }
    if (mapping.stage === 'cancelled-before-start') throw new Error('Cancelled training operation cannot be submitted')
    if (mapping.stage === 'cancel-intent') return { status: 'running' }
    const found = await this.lookup.find(mapping.request, mapping.idempotencyKey)
    if (found) {
      const observation = await this.finalFromStatus(envelope, mapping, this.assertStatus(mapping, found))
      return observation.status === 'completed' ? { status: 'completed', completion: observation.completion }
        : { status: 'running', ...(observation.status === 'running' && observation.handle ? { handle: observation.handle } : {}),
          ...(observation.receipt ? { receipt: observation.receipt } : {}) }
    }
    await preflightTrainingRequest(this.trainingStore, this.trainer, mapping.request)
    mapping.stage = 'submit-intent'; this.save(envelope, mapping)
    let handle: T.TrainingHandle
    if (mapping.request.schemaVersion === 2) {
      requireContract(this.trainer.control, 'training-control-unavailable', 'v2 requires ordered start')
      const status = this.assertStatus(mapping, await this.trainer.control(mapping.request, mapping.idempotencyKey, { schemaVersion: 2, sequence: 0, action: 'start' }))
      handle = status.handle
    } else handle = parseTrainingHandle(await this.trainer.submit(mapping.request, mapping.idempotencyKey))
    requireContract(digestJson(handle) === digestJson(this.expectedHandle(mapping.request, mapping.idempotencyKey)),
      'training-handle-drift', 'training submit returned another run/key/request')
    mapping.handle = handle; mapping.stage = 'running'; this.save(envelope, mapping)
    const status = this.assertStatus(mapping, await this.trainer.inspect(handle))
    const observation = await this.finalFromStatus(envelope, mapping, status)
    return observation.status === 'completed' ? { status: 'completed', completion: observation.completion }
      : { status: 'running', ...(observation.status === 'running' && observation.handle ? { handle: observation.handle } : {}),
        ...(observation.receipt ? { receipt: observation.receipt } : {}) }
  }

  async cancel(envelope: OperationEnvelope): Promise<ProviderInspection> {
    const mapped = await this.mapped(envelope)
    let mapping = this.read(envelope, mapped)
    const zero: T.TrainingUsage = { gpuSeconds: 0, rolloutTokens: 0, groupResamples: 0 }
    if (!mapping) {
      const tombstone: SavedMapping = { schemaVersion: 1, operationId: envelope.operationId, inputDigest: envelope.inputDigest,
        implementationDigest: envelope.implementationDigest, bindingDigest: envelope.bindingSetRef.digest,
        request: mapped.request, requestDigest: mapped.requestDigest, idempotencyKey: mapped.idempotencyKey,
        stage: 'cancelled-before-start' }
      mapping = durableCreate(this.path(envelope), canonicalJson(tombstone)) ? tombstone : this.read(envelope, mapped)!
    }
    if (mapping.completion) return { status: 'completed', completion: mapping.completion }
    if (mapping.stage === 'prepared' || mapping.stage === 'cancelled-before-start') {
      if (mapping.stage !== 'cancelled-before-start') { mapping.stage = 'cancelled-before-start'; this.save(envelope, mapping) }
      return { status: 'cancelled', releaseConfirmed: true,
        receipt: this.receipt(envelope, zero, { phase: 'admitted', execution: 'paused', resourcesReleased: true }) }
    }
    if (mapping.stage !== 'cancel-intent') { mapping.stage = 'cancel-intent'; this.save(envelope, mapping) }
    return this.replayCancel(envelope, mapping)
  }

  async collect(envelope: OperationEnvelope): Promise<CompletionEnvelope> {
    const result = await this.inspect(envelope)
    if (result.status !== 'completed') throw new Error(`Training result unavailable: ${result.status}`)
    return result.completion
  }
}

type LegacyMapping = { schemaVersion: 1; operationId: string; inputDigest: string; implementationDigest: string;
  experimentId: string; runId: string; baselineUsage: T.TrainingUsage; started: boolean; cancelRequested: boolean; completion?: CompletionEnvelope }

/** Runs an already admitted old experiment. The old coordinator remains its sole champion writer. */
export class LegacyTrainingCycleProvider implements OperationProvider {
  private readonly records: string
  private readonly owners: string
  private readonly implementationDigest: string
  private readonly backendIdentityDigest: string
  constructor(readonly root: string, readonly coordinator: ModelTrainingCoordinator, readonly store: ModelTrainingStore, readonly fixtureBackendIdentityDigest?: string) {
    this.records = join(root, 'legacy-operations'); mkdirSync(this.records, { recursive: true })
    this.owners = join(store.root, 'model-training-v1', 'algorithm-legacy-owners'); mkdirSync(this.owners, { recursive: true })
    this.backendIdentityDigest = this.currentBackendIdentity()
    this.implementationDigest = trainingOperationImplementationDigest(this.backendIdentityDigest)
  }
  private currentBackendIdentity(): string {
    const trainer = this.coordinator.trainer
    const evaluator = this.coordinator.evaluator
    const trainerDigest = trainer instanceof SlimeModelTrainer ? localSlimeJobLookup(trainer).identityDigest
      : trainer instanceof NodeSlimeModelTrainer ? nodeSlimeJobLookup(trainer).identityDigest : this.fixtureBackendIdentityDigest
    const evaluatorDigest = evaluator instanceof HitchModelEvaluator ? hitchBackendIdentityDigest(evaluator) : this.fixtureBackendIdentityDigest
    requireContract(trainerDigest && evaluatorDigest && /^(?:sha256:)?[a-f0-9]{64}$/u.test(trainerDigest)
      && /^(?:sha256:)?[a-f0-9]{64}$/u.test(evaluatorDigest), 'legacy-backend-identity',
    'real Slime/Hitch adapters or explicit fixture backend identity are required')
    return digestJson({ trainerDigest, evaluatorDigest })
  }
  describe(): ProviderManifest {
    return { kind: 'training.legacy_cycle', implementationDigest: this.implementationDigest, execution: 'external', supportsInspect: true,
      meteredDimensions: ['legacyGpuSeconds', 'legacyRolloutTokens', 'legacyGroupResamples'], hardLimitDimensions: [],
      inputSchema: { type: 'object', properties: { experimentId: { type: 'string' }, runId: { type: 'string' } },
        required: ['experimentId', 'runId'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { experimentId: { type: 'string' }, runId: { type: 'string' },
        candidateRef: { type: 'any' }, decision: { type: 'any' } }, required: ['experimentId', 'runId', 'candidateRef', 'decision'], additionalProperties: false },
    }
  }
  private path(envelope: OperationEnvelope): string { assertDigest(envelope.operationId); return join(this.records, `${envelope.operationId}.json`) }
  private ownRun(envelope: OperationEnvelope, experimentId: string, runId: string): void {
    const path = join(this.owners, `owner-${digestJson([experimentId, runId]).slice(7)}.json`)
    const owner = canonicalJson({ experimentId, runId, operationId: envelope.operationId })
    const temporary = `${path}.${randomUUID()}.tmp`
    const descriptor = openSync(temporary, 'wx', 0o600)
    try { writeSync(descriptor, owner); fsyncSync(descriptor) } finally { closeSync(descriptor) }
    try {
      try { linkSync(temporary, path) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    } finally { unlinkSync(temporary) }
    const directory = openSync(this.owners, 'r'); try { fsyncSync(directory) } finally { closeSync(directory) }
    requireContract(readFileSync(path, 'utf8') === owner, 'legacy-run-already-owned',
      'one admitted legacy run cannot be charged by two operations')
  }
  private input(envelope: OperationEnvelope): { experimentId: string; runId: string } {
    requireContract(this.currentBackendIdentity() === this.backendIdentityDigest, 'legacy-backend-drift',
      'legacy trainer/evaluator runtime changed')
    requireContract(envelope.kind === 'training.legacy_cycle' && envelope.implementationDigest === this.implementationDigest
      && envelope.inputDigest === jsonDigest(envelope.input), 'legacy-cycle-identity', 'legacy cycle operation identity changed')
    const input = envelope.input as { experimentId: string; runId: string }
    requireContract(input && typeof input.experimentId === 'string' && typeof input.runId === 'string',
      'invalid-legacy-cycle', 'legacy cycle needs already admitted experiment/run ids')
    return input
  }
  private read(envelope: OperationEnvelope): LegacyMapping | null {
    const path = this.path(envelope); if (!existsSync(path)) return null
    const mapping = JSON.parse(readFileSync(path, 'utf8')) as LegacyMapping; assertJson(mapping)
    requireContract(typeof mapping.started === 'boolean' && typeof mapping.cancelRequested === 'boolean'
      && mapping.baselineUsage && Object.values(mapping.baselineUsage).every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0),
    'invalid-legacy-mapping', 'saved legacy accounting or status is invalid')
    const input = this.input(envelope)
    this.ownRun(envelope, input.experimentId, input.runId)
    requireContract(mapping.schemaVersion === 1 && mapping.operationId === envelope.operationId && mapping.inputDigest === envelope.inputDigest
      && mapping.implementationDigest === envelope.implementationDigest && mapping.experimentId === input.experimentId && mapping.runId === input.runId,
    'legacy-cycle-drift', 'saved legacy operation differs from frozen ids')
    return mapping
  }
  private save(envelope: OperationEnvelope, mapping: LegacyMapping): void { durableWrite(this.path(envelope), canonicalJson(mapping)) }
  private async admitted(envelope: OperationEnvelope): Promise<{ input: { experimentId: string; runId: string }; run: T.ModelTrainingRun; state: T.ModelExperimentState }> {
    const input = this.input(envelope)
    const state = await this.store.load(input.experimentId)
    const run = await this.coordinator.inspect(input.experimentId, input.runId)
    requireContract(run.request.experimentId === input.experimentId && run.request.trainingRunId === input.runId,
      'legacy-cycle-drift', 'legacy run is not the admitted frozen request')
    if (this.coordinator.trainer instanceof NodeSlimeModelTrainer) await verifyNodeTrainingRuntime(this.coordinator.trainer, run.request)
    return { input, run, state }
  }
  private receipt(envelope: OperationEnvelope, mapping: LegacyMapping, state: T.ModelExperimentState): UsageReceipt {
    const run = state.runs[mapping.runId]
    requireContract(run, 'legacy-run-missing', 'owned legacy run disappeared')
    const runUsage = this.runUsage(run)
    const delta = { gpuSeconds: runUsage.gpuSeconds - mapping.baselineUsage.gpuSeconds,
      rolloutTokens: runUsage.rolloutTokens - mapping.baselineUsage.rolloutTokens,
      groupResamples: runUsage.groupResamples - mapping.baselineUsage.groupResamples }
    requireContract(Object.values(delta).every(value => value >= 0), 'legacy-usage-regression', 'legacy cumulative usage cannot regress')
    return { source: 'training.legacy_cycle', scope: 'operation', operationId: envelope.operationId,
      cursor: digestJson({ usage: state.usage, decision: state.runs[mapping.runId]?.decision ?? null }),
      cumulative: { legacyGpuSeconds: delta.gpuSeconds, legacyRolloutTokens: delta.rolloutTokens, legacyGroupResamples: delta.groupResamples } }
  }
  private runUsage(run: T.ModelTrainingRun): T.TrainingUsage {
    return { gpuSeconds: run.usage.gpuSeconds + Object.values(run.evaluationIntents)
      .reduce((total, intent) => total + (intent.chargedGpuSeconds ?? 0), 0),
      rolloutTokens: run.usage.rolloutTokens, groupResamples: run.usage.groupResamples }
  }
  private completion(envelope: OperationEnvelope, mapping: LegacyMapping, run: T.ModelTrainingRun, state: T.ModelExperimentState): CompletionEnvelope {
    const decision = run.decision!
    const outcome: OperationOutcome = decision.outcome === 'accepted' && run.candidateRef
      ? { kind: 'result', value: { experimentId: mapping.experimentId, runId: mapping.runId, candidateRef: run.candidateRef, decision } as unknown as JsonValue }
      : decision.outcome === 'inconclusive' ? { kind: 'inconclusive', reason: decision.reasons.join('; ') || 'legacy cycle inconclusive' }
        : { kind: 'no-result', reason: decision.reasons.join('; ') || decision.outcome }
    return { operationId: envelope.operationId, idempotencyKey: envelope.idempotencyKey, inputDigest: envelope.inputDigest,
      implementationDigest: envelope.implementationDigest, outcome, receipt: this.receipt(envelope, mapping, state) }
  }
  private async observe(envelope: OperationEnvelope, advance: boolean): Promise<ProviderInspection> {
    const mapping = this.read(envelope)
    if (!mapping) return { status: 'not-started' }
    if (mapping.completion) return { status: 'completed', completion: mapping.completion }
    const { run: before } = await this.admitted(envelope)
    if (mapping.cancelRequested) {
      try { await this.coordinator.pause(mapping.experimentId, mapping.runId) }
      catch { return { status: 'unknown' } }
    }
    if (advance && mapping.started && !before.decision && !mapping.cancelRequested) {
      try { await this.coordinator.advance(mapping.experimentId, mapping.runId) }
      catch { return { status: 'unknown' } }
    }
    const { run, state } = await this.admitted(envelope)
    const receipt = this.receipt(envelope, mapping, state)
    if (mapping.cancelRequested) return { status: 'cancelled', releaseConfirmed: run.resourcesReleased && run.evaluationResourcesReleased, receipt }
    if (run.decision && run.resourcesReleased && run.evaluationResourcesReleased) {
      const completion = this.completion(envelope, mapping, run, state)
      mapping.completion = completion; this.save(envelope, mapping)
      return { status: 'completed', completion }
    }
    return { status: 'running', receipt }
  }
  async preflight(envelope: OperationEnvelope): Promise<void> { await this.admitted(envelope) }
  inspect(envelope: OperationEnvelope): Promise<ProviderInspection> { return this.observe(envelope, true) }
  async submit(envelope: OperationEnvelope): Promise<ProviderSubmission> {
    const { input, run } = await this.admitted(envelope)
    this.ownRun(envelope, input.experimentId, input.runId)
    let mapping = this.read(envelope)
    if (!mapping) {
      mapping = { schemaVersion: 1, operationId: envelope.operationId, inputDigest: envelope.inputDigest,
        implementationDigest: envelope.implementationDigest, experimentId: input.experimentId, runId: input.runId,
        baselineUsage: this.runUsage(run), started: false, cancelRequested: false }
      if (!durableCreate(this.path(envelope), canonicalJson(mapping))) mapping = this.read(envelope)!
    }
    if (mapping.cancelRequested) throw new Error('Cancelled legacy operation cannot be submitted')
    if (!mapping.started) { mapping.started = true; this.save(envelope, mapping) }
    const observed = await this.observe(envelope, true)
    return observed.status === 'completed' ? { status: 'completed', completion: observed.completion }
      : { status: 'running', ...(observed.receipt ? { receipt: observed.receipt } : {}) }
  }
  async cancel(envelope: OperationEnvelope): Promise<ProviderInspection> {
    let mapping = this.read(envelope)
    if (!mapping) {
      const { input, run } = await this.admitted(envelope)
      this.ownRun(envelope, input.experimentId, input.runId)
      const tombstone: LegacyMapping = { schemaVersion: 1, operationId: envelope.operationId, inputDigest: envelope.inputDigest,
        implementationDigest: envelope.implementationDigest, experimentId: input.experimentId, runId: input.runId,
        baselineUsage: this.runUsage(run), started: false, cancelRequested: true }
      mapping = durableCreate(this.path(envelope), canonicalJson(tombstone)) ? tombstone : this.read(envelope)!
    }
    if (mapping.completion) return { status: 'completed', completion: mapping.completion }
    mapping.cancelRequested = true; this.save(envelope, mapping)
    return this.observe(envelope, false)
  }
  async collect(envelope: OperationEnvelope): Promise<CompletionEnvelope> {
    const status = await this.inspect(envelope)
    if (status.status !== 'completed') throw new Error(`Legacy result unavailable: ${status.status}`)
    return status.completion
  }
}
