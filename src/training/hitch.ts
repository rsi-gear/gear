import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { digestJson } from './digest.js'
import { matchesHarnessRef } from './harness.js'
import { datasetDestination } from './snapshots.js'
import { modelEvidenceKey, validateModelEvidence } from './evaluation.js'
import { jsonProcess } from './process.js'
import { TrainingContractError, requireContract } from './schema.js'
import { atomicWrite, TrainingContentStore, withTrainingFileLock } from './store.js'
import type { ContentRef, ModelEvaluationEvidence, ModelEvaluationRequest, ModelEvaluator, ModelNodeConnection } from './types.js'
import type { TrainingDeploymentConfig } from './types.js'
import { verifyExecutionPlacement } from './placement-observation.js'
import { controlEvaluation, type OrderedEvaluationControl } from './hitch-control.js'
import type { TrainingControlIntent } from './types.js'
import { hitchModelNodeBinding, registerHitchModelNode } from './hitch-model-node.js'

type Json = Record<string, unknown>
const object = (v: unknown): Json => { requireContract(!!v && typeof v === 'object' && !Array.isArray(v), 'invalid-hitch-evidence', 'expected a structured Hitch object'); return v as Json }
const array = (v: unknown): unknown[] => { requireContract(Array.isArray(v), 'invalid-hitch-evidence', 'expected an evidence array'); return v }
const string = (v: unknown): string => { requireContract(typeof v === 'string' && v.length > 0, 'invalid-hitch-evidence', 'expected an evidence identity'); return v }
export const inferenceCommonDigest = (lock: Json): string => digestJson({ engine: lock.engine, runtime_id: lock.runtime_id,
  profile: lock.profile, execution: lock.execution, resources: lock.resources, ...(lock.model_node ? { model_node: lock.model_node } : {}) })

export interface HitchModelEvaluatorOptions {
  command: string[]
  root: string
  workspace: string
  harnessSourceDirectory: string
  python: string[]
  /** Private connection for immutable evaluation SGLang; gateway differs from the rollout gateway. */
  modelNode?: Omit<ModelNodeConnection, 'workspace'>
  artifactStorage?: 'controller' | 'model-node'
  deployment?: TrainingDeploymentConfig
  /** Hash this entire object as evaluation.common.budgetsDigest. */
  budgets: { timeoutSeconds: number; setupTimeoutSeconds: number; maxConcurrent: 1; maxEpisodeSteps: 16; infrastructureRetries: 0; maxRepairRounds: number }
}
interface EvalJournal { key: string; requestDigest: string; startedAt: number; evalId?: string; inferenceId?: string; modelId?: string; evidence?: ModelEvaluationEvidence;
  submitted?: boolean; repairRounds?: number; repair?: { id: string; pending: boolean }; retainedTrials?: ModelEvaluationEvidence['trials']; serviceUsage?: Record<string, number>; serviceScopes?: string[] }

export function evaluationModelNode(request: ModelEvaluationRequest): ReturnType<typeof hitchModelNodeBinding> | undefined {
  const node = request.deployment?.modelRuntime
  if (!node) return undefined
  requireContract(node.launcher === 'process', 'unsupported-model-launcher', 'v2 evaluation requires the process model-node launcher')
  requireContract(request.condition.deploymentDigest === digestJson(request.deployment), 'evaluation-deployment-drift', 'evaluation condition must bind its complete frozen placement')
  return hitchModelNodeBinding(node)
}

/** Public Hitch CLI only. Each pass reconciles one durable eval; it never reruns valid failures. */
export class HitchModelEvaluator implements ModelEvaluator {
  constructor(readonly store: TrainingContentStore, readonly options: HitchModelEvaluatorOptions) {
    const b = options.budgets
    requireContract(b.maxConcurrent === 1 && b.maxEpisodeSteps === 16 && b.infrastructureRetries === 0
      && Number.isSafeInteger(b.timeoutSeconds) && b.timeoutSeconds > 0 && Number.isSafeInteger(b.setupTimeoutSeconds) && b.setupTimeoutSeconds > 0
      && Number.isSafeInteger(b.maxRepairRounds) && b.maxRepairRounds >= 0 && b.maxRepairRounds <= 32,
    'invalid-evaluation-budgets', 'v1 evaluation requires fixed positive timeouts, one concurrent trial, 16 steps and no hidden retries')
  }
  private call(args: string[], timeout = 60_000): Promise<unknown> { return jsonProcess(this.options.command, ['--root', this.options.root, ...args], undefined, timeout) }
  private async materialize(ref: ContentRef, kind: string): Promise<string> {
    const destination = join(this.options.workspace, kind, ref.digest.slice(7))
    await jsonProcess(this.options.python, ['-m', 'gear_training.artifacts', 'materialize', '--store-root', this.store.root], { ref, destination }, 3_600_000)
    return kind === 'datasets' ? datasetDestination(await this.store.readJson(ref), destination) : destination
  }
  private async prepareNode(request: ModelEvaluationRequest): Promise<string | undefined> {
    const binding = evaluationModelNode(request)
    if (!binding) { requireContract(!this.options.modelNode, 'evaluation-deployment-drift', 'v1 evaluator cannot silently select a model node'); return undefined }
    requireContract(this.options.modelNode, 'managed-node-not-configured', 'v2 evaluation requires a private model-node connection')
    if (this.options.deployment) await verifyExecutionPlacement(request.deployment!, this.options.deployment, this.options)
    const capabilities = object(await this.call(['capabilities', '--json']))
    requireContract(capabilities.managed_model_node === '2' && capabilities.model_node_usage === '2', 'managed-node-capability-missing', 'Hitch must support managed model-node selection and durable device usage')
    requireContract(this.options.artifactStorage !== 'model-node' || capabilities.model_node_storage === '1',
      'remote-model-storage-unavailable', 'Hitch must support model-node artifact storage')
    if (request.deployment!.taskExecution.placement === 'remote') requireContract(capabilities.remote_managed_model_node === '2',
      'remote-model-capability-missing', 'remote Harbor requires a versioned managed-node model route')
    const directory = join(this.options.workspace, 'model-nodes', digestJson(binding).slice(7))
    return registerHitchModelNode(this.options, binding, directory)
  }
  private async services(request: ModelEvaluationRequest, journal: EvalJournal, stop: boolean): Promise<{ resourcesReleased: boolean; gpuSeconds: number }> {
    const binding = evaluationModelNode(request)
    const scopes = [...(journal.evalId ? [journal.evalId] : []), ...(journal.serviceScopes ?? [])]
    const keys = new Set(scopes.map(scope => digestJson({ inference_id: journal.inferenceId, cache_scope_owner: scope })))
    const records = array(object(await this.call(['local', 'status', '--json'])).services).map(object)
      .filter(s => s.inference_id === journal.inferenceId && (!binding || keys.has(string(s.isolation_key))))
    if (!binding) {
      const owned = records.filter(s => !['stopped', 'failed'].includes(String(s.state)))
      if (stop) for (const service of owned) await this.call(['local', 'stop', string(service.service_id), '--json'])
      return { resourcesReleased: owned.length === 0, gpuSeconds: (Date.now() - journal.startedAt) / 1000 }
    }
    journal.serviceUsage ??= {}
    let released = true
    for (const record of records) {
      requireContract(digestJson(record.model_node) === digestJson(binding), 'model-node-service-drift', 'Hitch service belongs to another model node')
      const id = string(record.service_id)
      const usage = object(await this.call(['local', 'inspect-service', id, '--json']))
      requireContract(usage.schema_version === '2' && usage.service_id === id && usage.inference_id === journal.inferenceId
        && digestJson(usage.model_node) === digestJson(binding) && typeof usage.resources_released === 'boolean'
        && typeof usage.gpu_seconds === 'number' && Number.isFinite(usage.gpu_seconds) && usage.gpu_seconds >= (journal.serviceUsage[id] ?? 0),
      'model-node-usage-drift', 'model-node ownership or cumulative GPU usage is invalid')
      journal.serviceUsage[id] = usage.gpu_seconds
      if (!usage.resources_released) { released = false; if (stop) await this.call(['local', 'stop', id, '--json']) }
    }
    requireContract(Object.keys(journal.serviceUsage).every(id => records.some(s => s.service_id === id)), 'model-node-service-missing', 'an owned model-node service disappeared before reconciliation')
    return { resourcesReleased: released, gpuSeconds: Object.values(journal.serviceUsage).reduce((sum, value) => sum + value, 0) }
  }
  async observeUsage(request: ModelEvaluationRequest, key: string): Promise<{ gpuSeconds: number | null }> {
    requireContract(request.deployment, 'unsupported-evaluation-usage', 'live evaluation usage requires a model-node deployment')
    const directory = join(this.options.workspace, 'evaluations', digestJson(key).slice(7))
    return withTrainingFileLock(join(directory, 'operation.lock'), async () => {
      let journal: EvalJournal
      try { journal = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')) as EvalJournal }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { gpuSeconds: null }; throw error }
      requireContract(journal.requestDigest === digestJson(request) && journal.key === modelEvidenceKey({ subject: request.subject, condition: request.condition }),
        'evaluation-idempotency-conflict', 'usage request differs from the frozen evaluation')
      if (!journal.inferenceId) return { gpuSeconds: null }
      const usage = await this.services(request, journal, false)
      await atomicWrite(join(directory, 'state.json'), journal)
      return { gpuSeconds: Math.max(journal.evidence?.gpuSeconds ?? 0, usage.gpuSeconds) }
    })
  }
  async cancel(request: ModelEvaluationRequest, key: string, intent: TrainingControlIntent = { schemaVersion: 2, sequence: 1, action: 'pause' }): Promise<{ resourcesReleased: boolean; gpuSeconds: number }> {
    if (!request.deployment) return this.cancelPass(request, key)
    requireContract(intent.action === 'pause', 'invalid-evaluation-control', 'cancel requires a pause intent')
    // Fence remote admission even while a materializer holds the local journal.
    await controlEvaluation(this.options.workspace, request, key, intent, args => this.call(args))
    return withTrainingFileLock(join(this.options.workspace, 'evaluations', digestJson(key).slice(7), 'operation.lock'), async () => {
      const control = await controlEvaluation(this.options.workspace, request, key, intent, args => this.call(args))
      return this.cancelPass(request, key, control)
    })
  }
  private async cancelPass(request: ModelEvaluationRequest, key: string, control?: OrderedEvaluationControl): Promise<{ resourcesReleased: boolean; gpuSeconds: number }> {
    const journalPath = join(this.options.workspace, 'evaluations', digestJson(key).slice(7), 'state.json')
    let journal: EvalJournal
    try { journal = JSON.parse(await readFile(journalPath, 'utf8')) as EvalJournal } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      if (!control) return { resourcesReleased: true, gpuSeconds: 0 }
      requireContract(!control.state.submitted, 'evaluation-journal-missing', 'an admitted evaluation requires its original controller journal for service cleanup')
      journal = { key: modelEvidenceKey({ subject: request.subject, condition: request.condition }), requestDigest: digestJson(request), startedAt: Date.now(),
        evalId: control.state.eval_id, submitted: false }
      await atomicWrite(journalPath, journal)
    }
    requireContract(journal.requestDigest === digestJson(request), 'evaluation-idempotency-conflict', 'cancellation request differs from the frozen evaluation')
    if (control) {
      requireContract(!journal.evalId || journal.evalId === control.state.eval_id, 'evaluation-control-drift', 'ordered cancellation belongs to another eval')
      requireContract(control.state.submitted || !(journal.submitted ?? !!journal.evalId), 'evaluation-control-drift', 'an admitted evaluation disappeared from the daemon index')
      journal.evalId = control.state.eval_id; journal.submitted = control.state.submitted
      await atomicWrite(journalPath, journal)
      if (!journal.submitted) return { resourcesReleased: !control.state.pending_reruns, gpuSeconds: 0 }
    }
    const pending = async () => {
      const usage = await this.services(request, journal, false)
      await atomicWrite(journalPath, journal)
      return { resourcesReleased: false, gpuSeconds: usage.gpuSeconds }
    }
    if (!control && !journal.evalId && journal.inferenceId) {
      // A submit reply may have been lost. Reconcile the same intent before cancelling.
      try { await this.evaluate(request, key) } catch (e) { if (!(e instanceof TrainingContractError) || e.code !== 'evaluation-pending') throw e }
      journal = JSON.parse(await readFile(journalPath, 'utf8')) as EvalJournal
    }
    if (control?.state.pending_reruns) return pending()
    if (control && journal.repair?.pending) {
      // A repair can finish while its reply is lost. Refresh canonical evidence
      // after resume before deciding whether another repair round is needed.
      journal.repair.pending = false; delete journal.evidence
      await atomicWrite(journalPath, journal)
    }
    if (!control && journal.repair?.pending && journal.evalId) {
      await this.call(['eval', 'rerun-cancel', journal.evalId, journal.repair.id])
      try { await this.call(['eval', 'rerun', journal.evalId, '--invalid', '--daemon', '--rerun-id', journal.repair.id], 1_000) }
      catch (e) {
        if (e instanceof TrainingContractError && e.code === 'process-timeout') return pending()
        throw e
      }
      journal.repair.pending = false; await atomicWrite(journalPath, journal)
    }
    if (journal.evalId) {
      if (!control) await this.call(['eval', 'cancel', journal.evalId])
      const inspection = object(await this.call(['eval', 'inspect', journal.evalId, '--json']))
      if (!inspection.result || ['running', 'cancelling'].includes(String(object(inspection.control).state))) return pending()
    }
    const released = await this.services(request, journal, true)
    const gpuSeconds = Math.max(journal.evidence?.gpuSeconds ?? 0, released.gpuSeconds)
    if (journal.evidence) { journal.evidence.gpuSeconds = gpuSeconds; await atomicWrite(journalPath, journal) }
    await atomicWrite(journalPath, journal)
    return { resourcesReleased: released.resourcesReleased, gpuSeconds }
  }
  async evaluate(request: ModelEvaluationRequest, idempotencyKey: string, intent: TrainingControlIntent = { schemaVersion: 2, sequence: 0, action: 'start' }): Promise<ModelEvaluationEvidence> {
    if (!request.deployment) return this.evaluatePass(request, idempotencyKey)
    requireContract(intent.action === 'start', 'invalid-evaluation-control', 'evaluate requires a start intent')
    return withTrainingFileLock(join(this.options.workspace, 'evaluations', digestJson(idempotencyKey).slice(7), 'operation.lock'), async () => {
      const control = await controlEvaluation(this.options.workspace, request, idempotencyKey, intent, args => this.call(args))
      return this.evaluatePass(request, idempotencyKey, control)
    })
  }
  private async evaluatePass(request: ModelEvaluationRequest, idempotencyKey: string, control?: OrderedEvaluationControl): Promise<ModelEvaluationEvidence> {
    requireContract(request.harnessAdapter === 'training-tool' && request.evaluationDevices.length === 1,
      'unsupported-evaluation-topology', 'v1 evaluator requires training-tool and one pinned evaluation GPU')
    requireContract(digestJson(this.options.budgets) === request.condition.budgetsDigest, 'evaluation-budget-drift', 'evaluation budgets differ from the frozen condition')
    const key = modelEvidenceKey({ subject: request.subject, condition: request.condition })
    const journalPath = join(this.options.workspace, 'evaluations', digestJson(idempotencyKey).slice(7), 'state.json')
    let journal: EvalJournal
    try { journal = JSON.parse(await readFile(journalPath, 'utf8')) as EvalJournal } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      journal = { key, requestDigest: digestJson(request), startedAt: Date.now() }
      await atomicWrite(journalPath, journal)
    }
    requireContract(journal.key === key && journal.requestDigest === digestJson(request), 'evaluation-idempotency-conflict', 'evaluation key was reused for another frozen request')
    if (control) {
      requireContract(!journal.evalId || journal.evalId === control.state.eval_id, 'evaluation-control-drift', 'ordered start belongs to another eval')
      requireContract(control.state.submitted || !(journal.submitted ?? !!journal.evalId), 'evaluation-control-drift', 'an admitted evaluation disappeared from the daemon index')
      journal.evalId = control.state.eval_id; journal.submitted = control.state.submitted
      await atomicWrite(journalPath, journal)
    }
    if (journal.evidence) {
      if (journal.evidence.complete || ((journal.repairRounds ?? 0) >= this.options.budgets.maxRepairRounds && !journal.repair?.pending)) return validateModelEvidence(journal.evidence, request)
      if (!journal.repair?.pending) {
        journal.repairRounds = (journal.repairRounds ?? 0) + 1
        journal.repair = { id: `rerun_${digestJson([key, journal.repairRounds]).slice(7, 39)}`, pending: true }
        if (request.deployment) journal.serviceScopes = [...(journal.serviceScopes ?? []), `${journal.evalId}:${journal.repair.id}`]
        journal.retainedTrials = journal.evidence.trials.filter(t => t.valid)
        await atomicWrite(journalPath, journal)
      }
      try { await this.call(['eval', 'rerun', journal.evalId!, '--invalid', '--daemon', '--rerun-id', journal.repair.id, ...(control ? ['--control-file', control.file] : [])], 5_000) }
      catch (e) {
        if (e instanceof TrainingContractError && e.code === 'process-timeout') throw new TrainingContractError('evaluation-pending', 'repairing only missing or invalid Hitch slots')
        throw e
      }
      journal.repair.pending = false; delete journal.evidence
      await atomicWrite(journalPath, journal)
    }
    const harnessRef = `${request.harnessAdapter}@git+${pathToFileURL(this.options.harnessSourceDirectory).href}#${request.harnessCommit}`
    const dataset = await this.materialize(request.datasetRef, 'datasets')
    const nodeFile = await this.prepareNode(request)
    const nodeArgs = nodeFile ? ['--model-node-file', nodeFile] : []
    if (!journal.inferenceId) {
      let imported: Json
      if (this.options.artifactStorage === 'model-node') {
        requireContract(nodeFile, 'managed-node-not-configured', 'remote model storage requires a pinned model node')
        const refFile = join(this.options.workspace, 'model-refs', request.model.hfSnapshotRef.digest.slice(7) + '.json')
        await atomicWrite(refFile, request.model.hfSnapshotRef)
        imported = object(await this.call(['models', 'add-node', refFile, ...nodeArgs, '--name', request.model.id.slice(7), '--json'], 3_600_000))
      } else {
        const directory = await this.materialize(request.model.hfSnapshotRef, 'models')
        imported = object(await this.call(['models', 'add', directory, '--name', request.model.id.slice(7), '--json'], 3_600_000))
      }
      const snapshot = object(await this.store.readJson(request.model.hfSnapshotRef))
      const files = array(snapshot.files).map(v => { const f = object(v); return { path: f.path, size: f.size, sha256: f.sha256 } })
      requireContract(digestJson(imported.files) === digestJson(files) && imported.architecture === request.model.architecture
        && imported.dtype === request.model.dtype && imported.tokenizer_digest === request.model.tokenizerDigest
        && imported.template_digest === request.model.chatTemplateDigest && imported.quantization === null,
      'hitch-import-drift', 'Hitch import differs from the sealed HF export')
      journal.modelId = string(imported.model_id)
      const planned = object(await this.call(['local', 'plan', `local/${journal.modelId}`, '--harness', harnessRef,
        '--gpu', request.evaluationDevices[0]!, ...nodeArgs, '--offline', '--json'], 3_600_000))
      const lock = object(planned.lock)
      this.validateLock(lock, journal.modelId, request)
      journal.inferenceId = string(lock.inference_id)
      await atomicWrite(journalPath, journal)
    }
    // Revalidate the immutable model and lock on every reconciliation, including after a daemon restart.
    await this.call(['models', 'inspect', `local/${journal.modelId}`, '--verify', ...(this.options.artifactStorage === 'model-node' ? nodeArgs : []), '--json'], 3_600_000)
    const lock = object(await this.call(['local', 'inspect', journal.inferenceId, '--json']))
    this.validateLock(lock, journal.modelId!, request)
    if (control ? !journal.submitted : !journal.evalId) {
      const accepted = object(await this.call(['eval', 'submit', '--dataset', dataset, '--harness', harnessRef, '--model', `local/${journal.modelId}`,
        '--inference', journal.inferenceId, ...nodeArgs, '--offline',
        '--attempts', String(Math.max(...request.condition.slots.map(s => s.attempt))), '--max-concurrent', '1', '--infrastructure-retries', '0',
        '--provider', request.deployment?.taskExecution.provider ?? 'local-docker', '--model-capture', 'proxy', '--require-model-capture',
        '--timeout', `${this.options.budgets.timeoutSeconds}s`, '--setup-timeout', `${this.options.budgets.setupTimeoutSeconds}s`,
        ...(control ? ['--control-file', control.file] : ['--idempotency-key', idempotencyKey])]))
      if (control) requireContract(accepted.eval_id === control.state.eval_id, 'evaluation-control-drift', 'submission changed its reserved eval identity')
      journal.evalId = string(accepted.eval_id)
      if (control) journal.submitted = true
      await atomicWrite(journalPath, journal)
    }
    const inspection = object(await this.call(['eval', 'inspect', journal.evalId!, '--json']))
    const usage = await this.services(request, journal, !!inspection.result)
    await atomicWrite(journalPath, journal)
    if (!inspection.result) throw new TrainingContractError('evaluation-pending', `Hitch evaluation ${journal.evalId} is still running`)
    // Release this evaluator's exact services, so a sequential trainer can acquire the pool.
    if (!usage.resourcesReleased) throw new TrainingContractError('evaluation-pending', 'waiting for evaluation inference processes to release the GPU')
    const actualRequest = object(inspection.request)
    requireContract(actualRequest.model === `local/${journal.modelId}` && actualRequest.harness_ref === harnessRef
      && actualRequest.dataset === dataset && actualRequest.timeout_ms === this.options.budgets.timeoutSeconds * 1000
      && actualRequest.max_concurrent === 1 && actualRequest.infrastructure_retries === 0,
    'hitch-evaluation-request-drift', 'Hitch changed the frozen evaluation request')
    const result = object(inspection.result)
    if (inspection.plan == null && result.status === 'failed' && result.failure_stage === 'preparing') {
      const error = object(result.error)
      requireContract(typeof error.code === 'string' && /^[a-z][a-z0-9_-]{0,79}$/.test(error.code),
        'invalid-hitch-evidence', 'Hitch preparation failure must contain a bounded error code')
      throw new TrainingContractError('hitch-evaluation-preparation-failed', `Hitch evaluation ${journal.evalId} preparation failed (${error.code}); inspect its retained diagnostics`)
    }
    const candidate = object(object(inspection.plan).candidate)
    requireContract(candidate.inference_id === journal.inferenceId, 'hitch-inference-drift', 'canonical evaluation used another inference lock')
    const modelNode = evaluationModelNode(request)
    if (modelNode) requireContract(digestJson(candidate.model_node) === digestJson(modelNode)
      && digestJson(object(actualRequest.local_inference).model_node) === digestJson(modelNode)
      && object(object(inspection.submission).execution).provider === request.deployment!.taskExecution.provider
      && Object.keys(journal.serviceUsage ?? {}).length > 0, 'hitch-model-node-drift', 'canonical evaluation must retain its model-node identity and durable service usage')
    const frozenHarness = object(object(await this.store.readJson(request.subject.harnessRef)).hitch)
    await this.store.readBytes(request.verifierRef)
    const trials: ModelEvaluationEvidence['trials'] = []
    for (const item of array(object(inspection.result).trials)) {
      const trial = object(item)
      if (typeof trial.run_id !== 'string') continue // missing slots remain incomplete
      const runId = string(trial.run_id)
      const taskId = string(trial.task_id); const attempt = Number(trial.attempt)
      const slot = request.condition.slots.find(s => s.taskId === taskId && s.attempt === attempt)
      requireContract(slot, 'unexpected-evaluation-slot', 'Hitch returned an unselected task or attempt')
      const loaded = object(await this.call(['runs', 'inspect', runId, '--json']))
      requireContract(loaded.record_status === 'valid' && loaded.trajectory_status !== 'corrupt', 'corrupt-evaluation-run', 'canonical run integrity failed')
      const record = object(loaded.record)
      const context = object(record.context); const parent = object(record.parent); const model = object(record.model)
      const harness = object(record.harness); const protocol = object(record.protocol)
      if (modelNode) requireContract(digestJson(model.model_node) === digestJson(modelNode), 'canonical-model-node-drift', 'canonical run used another model-node generation')
      const task = request.datasetTasks.find(t => t.id === taskId)
      requireContract(task && task.environmentRef.digest === slot.environmentDigest, 'environment-descriptor-drift', 'slot environment identity differs')
      const environment = object(await this.store.readJson(task.environmentRef))
      requireContract(record.run_id === runId && parent.eval_id === journal.evalId && parent.attempt === attempt
        && context.kind === 'benchmark_task' && context.task_id === taskId && context.task_digest === environment.taskDigest
        && context.verifier_identity === environment.verifierIdentity && protocol.environment_identity === environment.hitchEnvironmentIdentity
        && model.effective_id === journal.modelId && model.inference_id === journal.inferenceId && model.identity_resolved === true
        && harness.harness_id === frozenHarness.harnessId && harness.revision_identity === frozenHarness.revisionIdentity
        && harness.artifact_id === frozenHarness.artifactId && matchesHarnessRef(harness.requested_ref, harnessRef, request.harnessAdapter, request.harnessCommit),
      'canonical-evaluation-identity-drift', 'canonical run differs from the sealed task, verifier, environment, harness or model')
      const evidence = object(await this.call(['verifier', 'inspect', runId, '--json']))
      const observation = object(record.observation ?? {})
      const valid = trial.observation_status === 'valid' && observation.status === 'valid'
        && object(evidence.verifier).status === 'complete' && observation.reward === trial.reward
      trials.push({ taskId, attempt, runId, valid, ...(valid ? { reward: Number(trial.reward) } : {}), inferenceError: !valid })
    }
    const e: ModelEvaluationEvidence = { schemaVersion: 1, evalId: journal.evalId!, subject: request.subject, condition: request.condition, evidenceKey: key,
      hitchModelId: journal.modelId!, inferenceLockRef: await this.store.putJson(lock), trials,
      complete: trials.length === request.condition.slots.length && trials.every(t => t.valid), gpuSeconds: usage.gpuSeconds }
    for (const retained of journal.retainedTrials ?? []) requireContract(trials.some(t => digestJson(t) === digestJson(retained)),
      'valid-slot-rerun', 'repair changed an existing valid observation')
    journal.evidence = validateModelEvidence(e, request)
    await atomicWrite(journalPath, journal)
    return journal.evidence
  }
  private validateLock(lock: Json, modelId: string, request: ModelEvaluationRequest): void {
    const node = evaluationModelNode(request)
    requireContract(node ? lock.schema_version === '2' && digestJson(lock.model_node) === digestJson(node) : !lock.model_node,
      'inference-node-drift', 'inference lock differs from the selected model-node identity')
    const c = request.condition; const execution = object(lock.execution); const platform = object(execution.platform)
    requireContract(lock.model_id === modelId && lock.profile === 'baseline' && inferenceCommonDigest(lock) === c.runtimeDigest
      && digestJson(lock.protocol) === c.protocolDigest && digestJson(lock.generation) === c.samplingDigest
      && platform.backend === 'cuda' && platform.device_constraint === request.evaluationDevices[0]
      && object(lock.protocol).api === 'chat-completions' && object(lock.generation).max_output_tokens === 2048,
    'inference-common-condition-drift', 'actual Hitch inference lock differs from the frozen common condition')
  }
}
