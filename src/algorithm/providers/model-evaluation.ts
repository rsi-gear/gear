import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { assertDigest, durableWrite, FileArtifactStore } from '../artifacts.js'
import { BindingStore } from '../bindings.js'
import type { CompletionEnvelope, OperationEnvelope, OperationProvider, ProviderInspection, ProviderManifest, ProviderSubmission, UsageReceipt } from '../contracts.js'
import { assertJson, canonicalJson, jsonDigest, type JsonValue } from '../schema.js'
import { digestJson } from '../../training/digest.js'
import { modelEvaluationRequest, validateModelEvidence } from '../../training/evaluation.js'
import { HitchModelEvaluator } from '../../training/hitch.js'
import { TrainingContractError, requireContract } from '../../training/schema.js'
import type { TrainingContentStore } from '../../training/store.js'
import type * as T from '../../training/types.js'
import { resolveFrozenTrainingBindings, trainingOperationImplementationDigest } from './training-mapping.js'
import { durableCreate } from './provider-record.js'

export const EVALUATION_USAGE_SOURCE = 'training.evaluate'
export const MODEL_EVIDENCE_SCHEMA = 'training.model-evidence.v1'
function executablePath(name: string): string {
  if (name.includes('/')) return realpathSync(name)
  for (const directory of (process.env.PATH ?? '').split(':')) {
    const path = join(directory, name)
    if (existsSync(path) && statSync(path).isFile()) return realpathSync(path)
  }
  throw new Error(`Evaluation executable unavailable: ${name}`)
}
/** Seal the controller's actual Hitch command, installed source tree and Python executable. */
export function hitchBackendIdentityDigest(evaluator: HitchModelEvaluator): string {
  const hash = createHash('sha256')
  hash.update(digestJson(evaluator.options))
  const paths = [executablePath(evaluator.options.command[0]!), executablePath(evaluator.options.python[0]!),
    ...evaluator.options.command.slice(1).filter(isAbsolute).map(path => realpathSync(path))]
  const seen = new Set<string>()
  for (const path of paths) {
    if (seen.has(path)) continue
    seen.add(path)
    let packageRoot = dirname(path)
    while (packageRoot !== dirname(packageRoot) && !existsSync(join(packageRoot, 'package.json'))) packageRoot = dirname(packageRoot)
    const root = existsSync(join(packageRoot, 'package.json')) ? packageRoot : null
    if (!root || path === paths[0] || path === paths[1]) {
      const bytes = readFileSync(path); hash.update(path); hash.update(String(bytes.length)); hash.update(bytes)
      continue
    }
    let count = 0
    const visit = (directory: string): void => {
      for (const name of readdirSync(directory).sort()) {
        if (name === 'node_modules' || name === '.git') continue
        const child = join(directory, name); const stat = lstatSync(child)
        requireContract(!stat.isSymbolicLink(), 'hitch-source-symlink', 'Hitch source identity cannot contain symlinks')
        if (stat.isDirectory()) visit(child)
        else if (stat.isFile()) {
          requireContract(++count <= 10_000, 'hitch-source-too-large', 'Hitch source identity exceeds the safe file count')
          const bytes = readFileSync(child)
          hash.update(relative(root, child)); hash.update(String(bytes.length)); hash.update(bytes)
        }
      }
    }
    visit(root)
  }
  return hash.digest('hex')
}
type EvaluationInput = { plan: T.ModelTrainingSpec; learnerSlot: string; harnessSlot: string; partition: 'dev' | 'held-out' }
type SavedEvaluation = { schemaVersion: 1; operationId: string; inputDigest: string; implementationDigest: string;
  bindingDigest: string; request: T.ModelEvaluationRequest; requestDigest: string; key: string;
  stage: 'submit-intent' | 'release-intent' | 'cancel-intent' | 'cancelled-before-start' | 'complete'; evidence?: T.ModelEvaluationEvidence; completion?: CompletionEnvelope }

/** The existing Hitch journal owns evaluation replay; this record freezes its original request/key before invoking it. */
export class ModelEvaluationOperationProvider implements OperationProvider {
  private readonly records: string
  private readonly implementationDigest: string
  private readonly backendIdentityDigest: string
  constructor(readonly root: string, readonly bindings: BindingStore, readonly artifacts: FileArtifactStore,
    readonly trainingStore: TrainingContentStore, readonly evaluator: T.ModelEvaluator, backendIdentityDigest?: string) {
    requireContract(evaluator.cancel, 'evaluation-release-unavailable', 'evaluation provider requires explicit resource-release confirmation')
    this.backendIdentityDigest = evaluator instanceof HitchModelEvaluator ? hitchBackendIdentityDigest(evaluator) : backendIdentityDigest ?? ''
    requireContract(/^[a-f0-9]{64}$/u.test(this.backendIdentityDigest), 'evaluation-backend-identity',
      'non-Hitch test evaluators require an explicit fixture identity')
    this.records = join(root, 'evaluations'); mkdirSync(this.records, { recursive: true })
    this.implementationDigest = trainingOperationImplementationDigest(this.backendIdentityDigest)
  }
  describe(): ProviderManifest {
    return { kind: 'model.evaluate', implementationDigest: this.implementationDigest, execution: 'external', supportsInspect: true,
      meteredDimensions: ['evaluationGpuSeconds'], hardLimitDimensions: [],
      inputSchema: { type: 'object', properties: { plan: { type: 'any' }, learnerSlot: { type: 'string' },
        harnessSlot: { type: 'string' }, partition: { type: 'string' } },
      required: ['plan', 'learnerSlot', 'harnessSlot', 'partition'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { evidenceRef: { type: 'any' }, evidenceKey: { type: 'string' },
        partition: { type: 'string' } }, required: ['evidenceRef', 'evidenceKey', 'partition'], additionalProperties: false } }
  }
  private path(envelope: OperationEnvelope): string { assertDigest(envelope.operationId); return join(this.records, `${envelope.operationId}.json`) }
  private async request(envelope: OperationEnvelope): Promise<T.ModelEvaluationRequest> {
    if (this.evaluator instanceof HitchModelEvaluator) requireContract(hitchBackendIdentityDigest(this.evaluator) === this.backendIdentityDigest,
      'evaluation-backend-drift', 'Hitch command, installed source or evaluator configuration changed')
    requireContract(envelope.kind === 'model.evaluate' && envelope.implementationDigest === this.implementationDigest
      && envelope.inputDigest === jsonDigest(envelope.input) && envelope.idempotencyKey === envelope.operationId,
    'evaluation-operation-drift', 'evaluation operation identity changed')
    const input = envelope.input as unknown as EvaluationInput
    requireContract(input && (input.partition === 'dev' || input.partition === 'held-out'),
      'invalid-evaluation-partition', 'evaluation requires a dev or held-out partition')
    const { plan, modelBinding } = await resolveFrozenTrainingBindings(
      { plan: input.plan, learnerSlot: input.learnerSlot, harnessSlot: input.harnessSlot } as unknown as JsonValue,
      envelope.bindingSetRef, this.bindings, this.artifacts, this.trainingStore)
    requireContract(Number.isFinite(envelope.limits.evaluationGpuSeconds) && (envelope.limits.evaluationGpuSeconds ?? 0) > 0,
      'evaluation-reservation', 'evaluation requires a GPU-second reservation')
    return modelEvaluationRequest(plan, modelBinding.model, modelBinding.modelRef, input.partition)
  }
  private read(envelope: OperationEnvelope, request: T.ModelEvaluationRequest): SavedEvaluation | null {
    const path = this.path(envelope); if (!existsSync(path)) return null
    const value = JSON.parse(readFileSync(path, 'utf8')) as SavedEvaluation; assertJson(value)
    requireContract(['submit-intent', 'release-intent', 'cancel-intent', 'cancelled-before-start', 'complete'].includes(value.stage),
      'invalid-evaluation-mapping', 'saved evaluation stage is invalid')
    if (value.stage === 'release-intent') validateModelEvidence(value.evidence, request)
    requireContract(value.schemaVersion === 1 && value.operationId === envelope.operationId && value.inputDigest === envelope.inputDigest
      && value.implementationDigest === envelope.implementationDigest && value.bindingDigest === envelope.bindingSetRef.digest
      && value.key === envelope.idempotencyKey && value.requestDigest === digestJson(request)
      && digestJson(value.request) === value.requestDigest,
    'evaluation-request-drift', 'saved evaluation mapping differs from frozen request/key')
    return value
  }
  private save(envelope: OperationEnvelope, value: SavedEvaluation): void { durableWrite(this.path(envelope), canonicalJson(value)) }
  private create(envelope: OperationEnvelope, request: T.ModelEvaluationRequest, stage: SavedEvaluation['stage']): SavedEvaluation {
    const value: SavedEvaluation = { schemaVersion: 1, operationId: envelope.operationId, inputDigest: envelope.inputDigest,
      implementationDigest: envelope.implementationDigest, bindingDigest: envelope.bindingSetRef.digest,
      request, requestDigest: digestJson(request), key: envelope.idempotencyKey, stage }
    if (durableCreate(this.path(envelope), canonicalJson(value))) return value
    return this.read(envelope, request)!
  }
  private receipt(envelope: OperationEnvelope, gpuSeconds: number): UsageReceipt {
    requireContract(Number.isFinite(gpuSeconds) && gpuSeconds >= 0, 'invalid-evaluation-usage', 'evaluation GPU usage must be finite and nonnegative')
    return { source: EVALUATION_USAGE_SOURCE, scope: 'operation', operationId: envelope.operationId,
      cursor: digestJson(gpuSeconds), cumulative: { evaluationGpuSeconds: gpuSeconds } }
  }
  private async usage(envelope: OperationEnvelope, saved: SavedEvaluation): Promise<UsageReceipt | undefined> {
    if (!this.evaluator.observeUsage) return undefined
    try { const observed = await this.evaluator.observeUsage(saved.request, saved.key)
      return observed.gpuSeconds === null ? undefined : this.receipt(envelope, observed.gpuSeconds) }
    catch (error) {
      if (error instanceof TrainingContractError && /drift|invalid|corrupt|conflict|stale|mismatch/u.test(error.code)) throw error
      return undefined
    }
  }
  private async pending(envelope: OperationEnvelope, saved: SavedEvaluation, status: 'running' | 'unknown'): Promise<ProviderInspection> {
    const receipt = await this.usage(envelope, saved)
    return { status, ...(receipt ? { receipt } : {}) }
  }
  private async reconcile(envelope: OperationEnvelope, saved: SavedEvaluation): Promise<ProviderInspection> {
    if (saved.completion) return { status: 'completed', completion: saved.completion }
    if (saved.stage === 'cancelled-before-start') return { status: 'cancelled', releaseConfirmed: true, receipt: this.receipt(envelope, 0) }
    if (saved.stage === 'cancel-intent') return this.replayCancel(envelope, saved)
    if (saved.stage === 'release-intent') return this.finalize(envelope, saved)
    let evidence: T.ModelEvaluationEvidence
    try { evidence = validateModelEvidence(await this.evaluator.evaluate(saved.request, saved.key,
      saved.request.deployment ? { schemaVersion: 2, sequence: 0, action: 'start' } : undefined), saved.request) }
    catch (error) {
      if (error instanceof TrainingContractError && error.code === 'evaluation-pending') return this.pending(envelope, saved, 'running')
      if (error instanceof TrainingContractError && /drift|invalid|corrupt|conflict|stale|mismatch/u.test(error.code)) throw error
      return this.pending(envelope, saved, 'unknown')
    }
    saved.evidence = evidence; saved.stage = 'release-intent'; this.save(envelope, saved)
    return this.finalize(envelope, saved)
  }
  private async finalize(envelope: OperationEnvelope, saved: SavedEvaluation): Promise<ProviderInspection> {
    const evidence = validateModelEvidence(saved.evidence, saved.request)
    let stopped: { resourcesReleased: boolean; gpuSeconds: number }
    try { stopped = await this.evaluator.cancel!(saved.request, saved.key,
      saved.request.deployment ? { schemaVersion: 2, sequence: 1, action: 'pause' } : undefined) }
    catch (error) {
      if (error instanceof TrainingContractError && /drift|invalid|corrupt|conflict|stale|mismatch/u.test(error.code)) throw error
      return this.pending(envelope, saved, 'unknown')
    }
    requireContract(stopped.gpuSeconds >= evidence.gpuSeconds, 'evaluation-usage-regression', 'release accounting cannot lose evaluation usage')
    if (!stopped.resourcesReleased) return { status: 'running', receipt: this.receipt(envelope, stopped.gpuSeconds) }
    // Incomplete evidence is a scientific inconclusive result, never a promoted candidate.
    const evidenceRef = this.artifacts.putJson(evidence as unknown as JsonValue, MODEL_EVIDENCE_SCHEMA)
    const completion: CompletionEnvelope = { operationId: envelope.operationId, idempotencyKey: envelope.idempotencyKey,
      inputDigest: envelope.inputDigest, implementationDigest: envelope.implementationDigest,
      outcome: evidence.complete ? { kind: 'result', value: { evidenceRef, evidenceKey: evidence.evidenceKey,
        partition: saved.request.condition.partition } as unknown as JsonValue } : { kind: 'inconclusive', reason: 'incomplete fixed evaluation slots' },
      receipt: this.receipt(envelope, stopped.gpuSeconds) }
    saved.stage = 'complete'; saved.completion = completion; this.save(envelope, saved)
    return { status: 'completed', completion }
  }
  private async replayCancel(envelope: OperationEnvelope, saved: SavedEvaluation): Promise<ProviderInspection> {
    if (!this.evaluator.cancel) return this.pending(envelope, saved, 'unknown')
    try { const stopped = await this.evaluator.cancel(saved.request, saved.key,
      saved.request.deployment ? { schemaVersion: 2, sequence: 1, action: 'pause' } : undefined)
      return { status: 'cancelled', releaseConfirmed: stopped.resourcesReleased, receipt: this.receipt(envelope, stopped.gpuSeconds) } }
    catch (error) {
      if (error instanceof TrainingContractError && /drift|invalid|corrupt|conflict|stale|mismatch/u.test(error.code)) throw error
      return this.pending(envelope, saved, 'unknown')
    }
  }
  async preflight(envelope: OperationEnvelope): Promise<void> { await this.request(envelope) }
  async inspect(envelope: OperationEnvelope): Promise<ProviderInspection> {
    const request = await this.request(envelope); const saved = this.read(envelope, request)
    return saved ? this.reconcile(envelope, saved) : { status: 'not-started' }
  }
  async submit(envelope: OperationEnvelope): Promise<ProviderSubmission> {
    const request = await this.request(envelope)
    const saved = this.read(envelope, request) ?? this.create(envelope, request, 'submit-intent')
    if (saved.stage === 'cancelled-before-start') throw new Error('Cancelled evaluation operation cannot be submitted')
    const observed = await this.reconcile(envelope, saved)
    return observed.status === 'completed' ? { status: 'completed', completion: observed.completion }
      : { status: 'running', ...(observed.receipt ? { receipt: observed.receipt } : {}) }
  }
  async cancel(envelope: OperationEnvelope): Promise<ProviderInspection> {
    const request = await this.request(envelope)
    const saved = this.read(envelope, request) ?? this.create(envelope, request, 'cancelled-before-start')
    if (saved.stage === 'cancelled-before-start') return { status: 'cancelled', releaseConfirmed: true, receipt: this.receipt(envelope, 0) }
    if (saved.completion) return { status: 'completed', completion: saved.completion }
    if (saved.stage !== 'cancel-intent') { saved.stage = 'cancel-intent'; this.save(envelope, saved) }
    return this.replayCancel(envelope, saved)
  }
  async collect(envelope: OperationEnvelope): Promise<CompletionEnvelope> {
    const observed = await this.inspect(envelope)
    if (observed.status !== 'completed') throw new Error(`Evaluation result unavailable: ${observed.status}`)
    return observed.completion
  }
}
