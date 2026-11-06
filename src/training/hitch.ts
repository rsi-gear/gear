import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { digestJson } from './digest.js'
import { matchesHarnessRef } from './harness.js'
import { publicEndpointBinding, validateReadyEndpointBinding } from './endpoint-binding.js'
import { datasetDestination } from './snapshots.js'
import { modelEvidenceKey, validateModelEvidence } from './evaluation.js'
import { jsonProcess } from './process.js'
import { TrainingContractError, requireContract } from './schema.js'
import { atomicWrite, TrainingContentStore, withTrainingFileLock } from './store.js'
import { controlEvaluation, type OrderedEvaluationControl } from './hitch-control.js'
import { assertHitchAttempt, freezeHitchAttempt, hitchEndpointAttempt, publicHitchAttempts, readHitchEvalJournal, type HitchEvalJournal, type HitchAttemptJournal } from './hitch-attempts.js'
import type { ContentRef, EndpointModelEvaluationEvidence, EvaluationUsage, ModelEvaluationEvidence, ModelEvaluationRequest, ModelEvaluator, TrainingControlIntent } from './types.js'

type Json = Record<string, unknown>
export { verifyHitchEndpoint } from './hitch-endpoint.js'
const object = (value: unknown): Json => { requireContract(!!value && typeof value === 'object' && !Array.isArray(value), 'invalid-hitch-evidence', 'expected structured Hitch evidence'); return value as Json }
const array = (value: unknown): unknown[] => { requireContract(Array.isArray(value), 'invalid-hitch-evidence', 'expected an evidence array'); return value }
const string = (value: unknown): string => { requireContract(typeof value === 'string' && value.length > 0, 'invalid-hitch-evidence', 'expected an evidence identity'); return value }
const unknownGpuUsage = (): EvaluationUsage => ({ gpuSeconds: null, gpuSecondsSource: null })

export interface HitchModelEvaluatorOptions {
  command: string[]
  root: string
  workspace: string
  harnessSourceDirectory: string
  /** Dataset materialization only; no model runtime is loaded by evaluation. */
  python: string[]
  executionProvider?: string
  budgets: { timeoutSeconds: number; setupTimeoutSeconds: number; maxConcurrent: number; maxEpisodeSteps: 16; infrastructureRetries: 0; maxRepairRounds: number }
}

/** An evaluator owns task requests, never the endpoint or its physical resources. */
export class HitchModelEvaluator implements ModelEvaluator {
  constructor(readonly store: TrainingContentStore, readonly options: HitchModelEvaluatorOptions) {
    const b = options.budgets
    requireContract(Number.isSafeInteger(b.maxConcurrent) && b.maxConcurrent >= 1 && b.maxConcurrent <= 1024 && b.maxEpisodeSteps === 16 && b.infrastructureRetries === 0
      && Number.isSafeInteger(b.timeoutSeconds) && b.timeoutSeconds > 0 && Number.isSafeInteger(b.setupTimeoutSeconds) && b.setupTimeoutSeconds > 0
      && Number.isSafeInteger(b.maxRepairRounds) && b.maxRepairRounds >= 0 && b.maxRepairRounds <= 32,
    'invalid-evaluation-budgets', 'evaluation requires fixed positive timeouts, bounded trial concurrency, 16 steps and no hidden retries')
  }
  private call(args: string[], timeout = 60_000): Promise<unknown> { return jsonProcess(this.options.command, ['--root', this.options.root, ...args], undefined, timeout) }
  private directory(key: string): string { return join(this.options.workspace, 'evaluations', digestJson(key).slice(7)) }
  private async materialize(ref: ContentRef): Promise<string> {
    const destination = join(this.options.workspace, 'datasets', ref.digest.slice(7))
    await jsonProcess(this.options.python, ['-m', 'gear.training.cli.artifacts', 'materialize', '--store-root', this.store.root], { ref, destination }, 3_600_000)
    return datasetDestination(await this.store.readJson(ref), destination)
  }
  private usage(result?: Json, startedAt?: number): EvaluationUsage {
    const usage: EvaluationUsage = unknownGpuUsage()
    if (startedAt !== undefined) usage.elapsedSeconds = Math.max(0, (Date.now() - startedAt) / 1000)
    if (!result?.usage) return usage
    const upstream = object(result.usage)
    requireContract(typeof upstream.source === 'string' && upstream.source.length > 0, 'invalid-evaluation-usage', 'token and request usage needs its collection source')
    usage.usageSource = upstream.source
    for (const [wire, key] of [['requests', 'requests'], ['input_tokens', 'inputTokens'], ['output_tokens', 'outputTokens']] as const) {
      if (upstream[wire] === undefined) continue
      requireContract(Number.isSafeInteger(upstream[wire]) && Number(upstream[wire]) >= 0, 'invalid-evaluation-usage', 'Hitch returned invalid request or token usage')
      usage[key] = Number(upstream[wire])
    }
    return usage
  }
  /** Reconcile canonical terminal evidence without touching the endpoint or admitting work. */
  async reconcileEvidence(request: ModelEvaluationRequest, key: string): Promise<ModelEvaluationEvidence | undefined> {
    return withTrainingFileLock(join(this.directory(key), 'operation.lock'), async () => {
      let journal = await readHitchEvalJournal(this.directory(key))
      if (!journal?.evalId) return undefined
      assertHitchAttempt(journal, request)
      if (!journal.attempts) journal = (await freezeHitchAttempt(this.directory(key), request)).journal
      const attempt = journal.attempts!.at(-1)!
      requireContract(attempt.requestDigest === digestJson(request), 'evaluation-attempt-stale', 'terminal evidence must reconcile the current frozen attempt')
      let inspection: Json
      try { inspection = object(await this.call(['eval', 'inspect', journal.evalId!, '--json'])) }
      catch (error) { if (error instanceof TrainingContractError && error.code === 'eval_not_found') return undefined; throw error }
      const result = inspection.result ? object(inspection.result) : undefined
      if (!result || result.task_completed !== true || inspection.pending_reruns !== false
        || !['succeeded', 'failed', 'cancelled', 'completed'].includes(String(object(inspection.control).state))) return undefined
      const frozen = array(inspection.endpoint_attempts ?? [])
      if (frozen.length !== journal.attempts!.length || object(frozen.at(-1)).id !== attempt.id) return undefined
      const dataset = datasetDestination(await this.store.readJson(request.datasetRef), join(this.options.workspace, 'datasets', request.datasetRef.digest.slice(7)))
      const harnessRef = `${request.harnessAdapter}@git+${pathToFileURL(this.options.harnessSourceDirectory).href}#${request.harnessCommit}`
      journal.submitted = true
      if (attempt.repair) attempt.repair.pending = false
      return this.collectEvidence(request, key, journal, attempt, inspection, harnessRef, dataset)
    })
  }
  async observeUsage(request: ModelEvaluationRequest, key: string): Promise<EvaluationUsage> {
    return withTrainingFileLock(join(this.directory(key), 'operation.lock'), async () => {
      let journal: HitchEvalJournal
      try { journal = JSON.parse(await readFile(join(this.directory(key), 'state.json'), 'utf8')) as HitchEvalJournal }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return unknownGpuUsage(); throw error }
      assertHitchAttempt(journal, request)
      if (journal.evidence && !journal.attempts?.some(attempt => attempt.repair?.pending)) {
        const { gpuSeconds, gpuSecondsSource, usageSource, inputTokens, outputTokens, requests, elapsedSeconds } = journal.evidence
        return { gpuSeconds, gpuSecondsSource, ...(usageSource !== undefined ? { usageSource } : {}), ...(inputTokens !== undefined ? { inputTokens } : {}),
          ...(outputTokens !== undefined ? { outputTokens } : {}), ...(requests !== undefined ? { requests } : {}), ...(elapsedSeconds !== undefined ? { elapsedSeconds } : {}) }
      }
      if (!journal.submitted || !journal.evalId) return unknownGpuUsage()
      const inspection = object(await this.call(['eval', 'inspect', journal.evalId, '--json']))
      return this.usage(inspection.result ? object(inspection.result) : undefined, journal.startedAt)
    })
  }
  async cancel(request: ModelEvaluationRequest, key: string, intent: TrainingControlIntent = { schemaVersion: 2, sequence: 1, action: 'pause' }): Promise<EvaluationUsage & { tasksCompleted: boolean }> {
    requireContract(intent.action === 'pause', 'invalid-evaluation-control', 'cancel requires a pause intent')
    // Fence daemon admission before waiting for a concurrent materializer's lock.
    const before = await readHitchEvalJournal(this.directory(key))
    if (before) assertHitchAttempt(before, request)
    await controlEvaluation(this.options.workspace, before?.request ?? request, key, intent, args => this.call(args))
    return withTrainingFileLock(join(this.directory(key), 'operation.lock'), async () => {
      const latest = await readHitchEvalJournal(this.directory(key))
      const control = await controlEvaluation(this.options.workspace, latest?.request ?? request, key, intent, args => this.call(args))
      const path = join(this.directory(key), 'state.json')
      let journal: HitchEvalJournal
      try { journal = JSON.parse(await readFile(path, 'utf8')) as HitchEvalJournal }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        requireContract(!control.state.submitted, 'evaluation-journal-missing', 'an admitted evaluation needs its original task journal')
        return { ...unknownGpuUsage(), tasksCompleted: !control.state.pending_reruns }
      }
      assertHitchAttempt(journal, request)
      requireContract(!journal.evalId || journal.evalId === control.state.eval_id, 'evaluation-control-drift', 'cancellation returned another eval identity')
      requireContract(control.state.submitted || !journal.submitted, 'evaluation-control-drift', 'an admitted evaluation disappeared from the daemon index')
      journal.evalId = control.state.eval_id; journal.submitted = control.state.submitted
      if (journal.repair?.pending && !control.state.pending_reruns) { journal.repair.pending = false; delete journal.evidence }
      for (const attempt of journal.attempts ?? []) if (attempt.repair?.pending && !control.state.pending_reruns) {
        attempt.repair.pending = false; attempt.repair.cancelled = true; delete attempt.evidence; delete journal.evidence
      }
      await atomicWrite(path, journal)
      if (!journal.submitted) return { ...unknownGpuUsage(), tasksCompleted: !control.state.pending_reruns }
      const inspection = object(await this.call(['eval', 'inspect', journal.evalId, '--json']))
      const result = inspection.result ? object(inspection.result) : undefined
      return { ...this.usage(result, journal.startedAt), tasksCompleted: !control.state.pending_reruns && result?.task_completed === true
        && !['running', 'cancelling'].includes(String(object(inspection.control).state)) }
    })
  }
  async evaluate(request: ModelEvaluationRequest, key: string, intent: TrainingControlIntent = { schemaVersion: 2, sequence: 0, action: 'start' }, attemptContext?: { id: string; parentId?: string }): Promise<ModelEvaluationEvidence> {
    requireContract(request.schemaVersion === 2 && request.harnessAdapter === 'training-tool', 'unsupported-evaluation-harness', 'endpoint candidate evaluation currently requires training-tool')
    validateReadyEndpointBinding(request.endpointBinding, request.model, { ...request.condition, attempts: Math.max(...request.condition.slots.map(slot => slot.attempt)) }, [request.endpointBinding.deployment_receipt.source])
    requireContract(request.subject.weightsDigest === request.model.weightsDigest, 'evaluation-subject-drift', 'evaluation subject differs from its immutable model')
    requireContract(intent.action === 'start', 'invalid-evaluation-control', 'evaluate requires a start intent')
    requireContract(digestJson(this.options.budgets) === request.condition.budgetsDigest, 'evaluation-budget-drift', 'evaluation budgets differ from frozen conditions')
    return withTrainingFileLock(join(this.directory(key), 'operation.lock'), async () => {
      const { journal, attempt } = await freezeHitchAttempt(this.directory(key), request, attemptContext)
      const control = await controlEvaluation(this.options.workspace, journal.request!, key, intent, args => this.call(args))
      return this.evaluatePass(request, key, control, journal, attempt)
    })
  }
  private async evaluatePass(request: ModelEvaluationRequest, idempotencyKey: string, control: OrderedEvaluationControl, journal: HitchEvalJournal, attempt: HitchAttemptJournal): Promise<EndpointModelEvaluationEvidence> {
    const key = modelEvidenceKey({ subject: request.subject, condition: request.condition })
    const path = join(this.directory(idempotencyKey), 'state.json')
    assertHitchAttempt(journal, request)
    requireContract(!journal.evalId || journal.evalId === control.state.eval_id, 'evaluation-control-drift', 'ordered start returned another eval identity')
    requireContract(control.state.submitted || !journal.submitted, 'evaluation-control-drift', 'an admitted evaluation disappeared from the daemon index')
    journal.evalId = control.state.eval_id; journal.submitted = control.state.submitted
    if (attempt.repair?.cancelled) {
      requireContract((attempt.repairRounds ?? 0) < this.options.budgets.maxRepairRounds, 'evaluation-recovery-exhausted', 'cancelled repair exhausted its explicit repair budget')
      attempt.repairRounds = (attempt.repairRounds ?? 0) + 1
      attempt.repair = { id: `rerun_${digestJson([key, attempt.id, attempt.repairRounds, 'resume']).slice(7, 39)}`, pending: true }
    }
    await atomicWrite(path, journal)
    if (attempt.evidence) {
      if (attempt.evidence.complete || ((attempt.repairRounds ?? 0) >= this.options.budgets.maxRepairRounds && !attempt.repair?.pending)) return validateModelEvidence(attempt.evidence, request) as EndpointModelEvaluationEvidence
      if (!attempt.repair?.pending) {
        attempt.repairRounds = (attempt.repairRounds ?? 0) + 1
        attempt.repair = { id: `rerun_${digestJson([key, attempt.id, attempt.repairRounds]).slice(7, 39)}`, pending: true }
        attempt.retainedTrials = attempt.evidence.trials.filter(trial => trial.valid)
        await atomicWrite(path, journal)
      }
    }
    if (attempt.repair?.pending) {
      const attemptFile = join(this.directory(idempotencyKey), 'attempts', attempt.id, 'endpoint-attempt.json')
      if (attempt.parentId) {
        const capabilities = object(await this.call(['capabilities', '--json']))
        requireContract(capabilities.endpoint_evaluation_attempts === '1', 'evaluation-recovery-unavailable', 'Hitch must support explicit endpoint evaluation attempts')
        await atomicWrite(attemptFile, hitchEndpointAttempt(attempt))
      }
      try { await this.call(['eval', 'rerun', journal.evalId!, '--invalid', '--daemon', '--rerun-id', attempt.repair.id, '--control-file', control.file,
        ...(attempt.parentId ? ['--endpoint-attempt-file', attemptFile] : [])], 5_000) }
      catch (error) {
        if (error instanceof TrainingContractError && error.code === 'process-timeout') throw new TrainingContractError('evaluation-pending', 'Hitch repair is still running')
        throw error
      }
      attempt.repair.pending = false; delete attempt.evidence; delete journal.evidence
      await atomicWrite(path, journal)
    }
    const harnessRef = `${request.harnessAdapter}@git+${pathToFileURL(this.options.harnessSourceDirectory).href}#${request.harnessCommit}`
    const dataset = await this.materialize(request.datasetRef)
    const binding = publicEndpointBinding(journal.request!.endpointBinding)
    const bindingFile = join(this.directory(idempotencyKey), 'attempts', attempt.id, 'endpoint-binding.json')
    await atomicWrite(bindingFile, attempt.request.endpointBinding)
    if (!journal.submitted) {
      const accepted = object(await this.call(['eval', 'submit', '--dataset', dataset, '--harness', harnessRef,
        '--model', binding.endpoint_ref, '--model-binding-file', bindingFile,
        '--attempts', String(Math.max(...request.condition.slots.map(slot => slot.attempt))), '--max-concurrent', String(this.options.budgets.maxConcurrent), '--infrastructure-retries', '0',
        '--provider', this.options.executionProvider ?? 'local-docker', '--model-capture', 'proxy', '--require-model-capture',
        '--timeout', `${this.options.budgets.timeoutSeconds}s`, '--setup-timeout', `${this.options.budgets.setupTimeoutSeconds}s`, '--control-file', control.file]))
      requireContract(accepted.eval_id === control.state.eval_id, 'evaluation-control-drift', 'submission changed the reserved eval identity')
      journal.submitted = true
      await atomicWrite(path, journal)
    }
    const inspection = object(await this.call(['eval', 'inspect', journal.evalId, '--json']))
    return this.collectEvidence(request, idempotencyKey, journal, attempt, inspection, harnessRef, dataset)
  }
  private async collectEvidence(request: ModelEvaluationRequest, idempotencyKey: string, journal: HitchEvalJournal, attempt: HitchAttemptJournal,
    inspection: Json, harnessRef: string, dataset: string): Promise<EndpointModelEvaluationEvidence> {
    const key = modelEvidenceKey({ subject: request.subject, condition: request.condition })
    const path = join(this.directory(idempotencyKey), 'state.json'), binding = publicEndpointBinding(journal.request!.endpointBinding)
    if (!inspection.result) throw new TrainingContractError('evaluation-pending', `Hitch evaluation ${journal.evalId} is still running`)
    const actualRequest = object(inspection.request), result = object(inspection.result)
    requireContract(actualRequest.model === binding.endpoint_ref && actualRequest.harness_ref === harnessRef && actualRequest.dataset === dataset
      && actualRequest.timeout_ms === this.options.budgets.timeoutSeconds * 1000 && actualRequest.max_concurrent === this.options.budgets.maxConcurrent
      && actualRequest.infrastructure_retries === 0 && digestJson(actualRequest.endpoint_binding) === digestJson(binding),
    'hitch-evaluation-request-drift', 'Hitch changed the frozen evaluation request or binding')
    if (inspection.plan == null && result.status === 'failed' && result.failure_stage === 'preparing') {
      const error = object(result.error)
      requireContract(typeof error.code === 'string' && /^[a-z][a-z0-9_-]{0,79}$/.test(error.code), 'invalid-hitch-evidence', 'Hitch preparation failure needs a bounded code')
      throw new TrainingContractError('hitch-evaluation-preparation-failed', `Hitch evaluation ${journal.evalId} preparation failed (${error.code}); inspect retained diagnostics`)
    }
    requireContract(result.task_completed === true, 'evaluation-pending', 'waiting for Hitch task requests to terminate')
    requireContract(digestJson(object(object(inspection.plan).candidate).endpoint_binding) === digestJson(binding)
      && digestJson(result.endpoint_binding) === digestJson(binding), 'hitch-endpoint-drift', 'canonical evaluation changed its frozen endpoint')
    const frozenHarness = object(object(await this.store.readJson(request.subject.harnessRef)).hitch)
    await this.store.readBytes(request.verifierRef)
    const frozenAttempts = array(inspection.endpoint_attempts ?? [{ id: journal.attempts![0]!.id, endpoint_binding: binding }]).map(object)
    requireContract(frozenAttempts.length === journal.attempts!.length && frozenAttempts.every((value, index) => value.id === journal.attempts![index]!.id
      && value.parent_id === journal.attempts![index]!.parentId && digestJson(value.endpoint_binding) === digestJson(publicEndpointBinding(journal.attempts![index]!.request.endpointBinding))),
    'hitch-endpoint-attempt-drift', 'Hitch changed the frozen endpoint attempt lineage')
    const trials: EndpointModelEvaluationEvidence['trials'] = [], bindings = new Map<string, string>()
    for (const item of array(result.trials)) {
      const trial = object(item)
      if (typeof trial.run_id !== 'string') continue
      const runId = string(trial.run_id), taskId = string(trial.task_id), attempt = Number(trial.attempt)
      const slot = request.condition.slots.find(value => value.taskId === taskId && value.attempt === attempt)
      requireContract(slot, 'unexpected-evaluation-slot', 'Hitch returned an unselected task or attempt')
      const loaded = object(await this.call(['runs', 'inspect', runId, '--json']))
      requireContract(loaded.record_status === 'valid' && loaded.trajectory_status !== 'corrupt', 'corrupt-evaluation-run', 'canonical run integrity failed')
      const record = object(loaded.record), context = object(record.context), parent = object(record.parent), model = object(record.model)
      const harness = object(record.harness), protocol = object(record.protocol)
      const origin = journal.attempts!.find(value => digestJson(publicEndpointBinding(value.request.endpointBinding)) === digestJson(model.endpoint_binding))
      requireContract(origin, 'hitch-endpoint-drift', 'canonical run used an unadmitted endpoint attempt')
      const trialBinding = publicEndpointBinding(origin.request.endpointBinding)
      if (origin.parentId) requireContract(array(frozenAttempts.find(value => value.id === origin.id)!.selected_trials).some(value => {
        const slot = object(value); return slot.task_id === taskId && slot.attempt === attempt
      }), 'unexpected-evaluation-slot', 'repair executed a slot outside its frozen invalid selection')
      bindings.set(runId, origin.id)
      const task = request.datasetTasks.find(value => value.id === taskId)
      requireContract(task && task.environmentRef.digest === slot.environmentDigest, 'environment-descriptor-drift', 'slot environment identity differs')
      const environment = object(await this.store.readJson(task.environmentRef))
      requireContract(record.run_id === runId && parent.eval_id === journal.evalId && parent.attempt === attempt
        && context.kind === 'benchmark_task' && context.task_id === taskId && context.task_digest === environment.taskDigest
        && context.verifier_identity === environment.verifierIdentity && protocol.environment_identity === environment.hitchEnvironmentIdentity
        && model.provider === 'external-endpoint' && model.effective_id === trialBinding.wire_model && model.requested_id === trialBinding.endpoint_ref
        && digestJson(model.endpoint_binding) === digestJson(trialBinding)
        && harness.harness_id === frozenHarness.harnessId && harness.revision_identity === frozenHarness.revisionIdentity
        && harness.artifact_id === frozenHarness.artifactId && matchesHarnessRef(harness.requested_ref, harnessRef, request.harnessAdapter, request.harnessCommit),
      'canonical-evaluation-identity-drift', 'canonical run differs from the sealed task, verifier, environment, harness or endpoint')
      const evidence = object(await this.call(['verifier', 'inspect', runId, '--json'])), observation = object(record.observation ?? {})
      const valid = trial.observation_status === 'valid' && observation.status === 'valid'
        && object(evidence.verifier).status === 'complete' && observation.reward === trial.reward
      trials.push({ taskId, attempt, runId, valid, ...(valid ? { reward: Number(trial.reward) } : {}), inferenceError: !valid })
    }
    const evidence: EndpointModelEvaluationEvidence = { schemaVersion: 2, evalId: journal.evalId!, subject: request.subject, condition: request.condition,
      evidenceKey: key, endpointBinding: binding, endpointAttempts: publicHitchAttempts(journal, trials, bindings), trials, complete: trials.length === request.condition.slots.length && trials.every(trial => trial.valid),
      ...this.usage(result, journal.startedAt) }
    for (const retained of attempt.retainedTrials ?? []) requireContract(trials.some(trial => digestJson(trial) === digestJson(retained)), 'valid-slot-rerun', 'repair changed a valid observation')
    journal.evidence = validateModelEvidence(evidence, request) as EndpointModelEvaluationEvidence
    attempt.evidence = journal.evidence
    await atomicWrite(path, journal)
    return journal.evidence
  }
}
