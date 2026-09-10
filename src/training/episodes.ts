import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { digestJson } from './digest.js'
import { matchesHarnessRef } from './harness.js'
import { datasetDestination } from './snapshots.js'
import { parseContentRef, parseFeedbackRecord, parseGenerationReceipt, parsePolicyLease, parseTrainingEpisode, parseTrainingExternalBinding, parseTrainingRequest, requireContract, TrainingContractError } from './schema.js'
import { jsonProcess } from './process.js'
import { atomicWrite, TrainingContentStore, withTrainingFileLock } from './store.js'
import { ModelNodeTransport, syncContentGraph } from './transport.js'
import type { ContentRef, GenerationReceipt, PolicyLease, TrainingExternalBinding, TrainingHandle, TrainingRequestV2 } from './types.js'
import type { TrainingDeploymentConfig } from './types.js'
import { assertHitchCommit, observeHitchController, verifyExecutionPlacement } from './placement-observation.js'

type Json = Record<string, unknown>
const object = (value: unknown): Json => { requireContract(!!value && typeof value === 'object' && !Array.isArray(value), 'invalid-episode-data', 'expected structured episode data'); return value as Json }
const text = (value: unknown): string => { requireContract(typeof value === 'string' && !!value, 'invalid-episode-data', 'expected a nonempty episode identity'); return value }
const list = (value: unknown): unknown[] => { requireContract(Array.isArray(value), 'invalid-episode-data', 'expected an episode array'); return value }
const same = (a: unknown, b: unknown): boolean => digestJson(a) === digestJson(b)

export interface RolloutIntent {
  schemaVersion: 2; id: string; jobId: string; incarnation: string; trainingRunId: string; inputDigest: string; key: string
  context: Json; binding: TrainingExternalBinding; lease: PolicyLease; gateway: { nodePort: number }; credential: string
}
interface IntentEntry { intent: RolloutIntent; cancelRequested: boolean; ack: { evalId: string } | null; result: Json | null }
interface ControllerEpisodeState { intentDigest: string; submitted: boolean; evalId?: string; result?: Json }
export interface TrainingEpisodeControllerOptions {
  command: string[]; root: string; workspace: string; harnessSourceDirectory: string; python: string[]; episodeTimeoutSeconds: number
  deployment?: TrainingDeploymentConfig
}

export function episodeAddress(intent: RolloutIntent) {
  return { id: intent.id, inputDigest: intent.inputDigest, jobId: intent.jobId, incarnation: intent.incarnation,
    batchId: intent.lease.batchId, policyVersion: intent.lease.policyVersion, fencingToken: intent.lease.fencingToken }
}

/** Validate against the train-only request, never against fields supplied by the task agent. */
export function validateRolloutIntent(value: unknown, request: TrainingRequestV2, handle: TrainingHandle): RolloutIntent {
  const input = object(value); const { inputDigest, ...body } = input
  requireContract(input.schemaVersion === 2 && inputDigest === digestJson(body) && input.jobId === handle.jobId
    && input.trainingRunId === request.trainingRunId && typeof input.incarnation === 'string', 'episode-intent-drift', 'node intent changed its job, request or input digest')
  const context = object(input.context), lease = parsePolicyLease(input.lease), binding = parseTrainingExternalBinding(input.binding)
  const task = request.trainDataset.tasks.find(task => task.id === context.taskId)
  const sampling = request.rollout.sampling
  requireContract(task && same(context.taskRef, task.taskRef) && same(context.environmentRef, task.environmentRef)
    && same(context.harnessRef, request.fixedHarness.manifestRef) && context.id === input.id && context.trainingRunId === request.trainingRunId
    && context.runId === null && context.logicalAttempt === 1 && Number.isSafeInteger(context.slot) && Number(context.slot) >= 0 && Number(context.slot) < request.rollout.groupSize
    && context.policyVersion === lease.policyVersion && context.runtimeInstanceId === lease.runtimeInstanceId && context.batchId === lease.batchId
    && context.wireModel === lease.policyVersion && context.tokenizerDigest === request.parentModel.tokenizerDigest && context.chatTemplateDigest === request.parentModel.chatTemplateDigest
    && context.generationContractDigest === request.trainer.runtimeLock.protocolDigest && context.verifierVersion === request.verifier.digest
    && context.maxContextTokens === sampling.maxContextTokens && context.maxEpisodeSteps === request.budgets.maxEpisodeSteps && context.maxRolloutTokens === request.budgets.maxRolloutTokens
    && same(context.sampling, { temperature: 1, top_p: 1, top_k: -1, repetition_penalty: 1, max_new_tokens: sampling.maxNewTokens,
      skip_special_tokens: false, spaces_between_special_tokens: false, no_stop_trim: true }),
  'episode-assignment-drift', 'rollout intent is not an authorized frozen train slot')
  requireContract(lease.trainingRunId === request.trainingRunId && lease.parentModelVersionId === request.parentModel.id && lease.state === 'serving'
    && binding.trainingRunId === request.trainingRunId && binding.bindingId === context.bindingId && binding.expectedPolicyVersion === lease.policyVersion
    && binding.fencingToken === lease.fencingToken && binding.expiresAt === lease.expiresAt && binding.policyLeaseRef.digest === digestJson(lease)
    && binding.generationContractDigest === request.trainer.runtimeLock.protocolDigest && binding.maxOutputTokens === sampling.maxNewTokens
    && binding.maxEpisodeSteps === request.budgets.maxEpisodeSteps && lease.samplingDigest === digestJson(context.sampling),
  'episode-policy-drift', 'episode binding changed its policy, fence or generation contract')
  requireContract(input.key === digestJson([request.trainingRunId, lease.batchId, task.taskRef.digest, context.groupId, context.slot])
    && /^[a-f0-9]{64}$/.test(text(input.credential)) && Number.isInteger(object(input.gateway).nodePort), 'episode-submission-drift', 'episode key, credential or route is invalid')
  return { ...input, context, lease, binding } as unknown as RolloutIntent
}

/** Controller-owned journals reconcile public Hitch operations one logical slot at a time. */
export class TrainingEpisodeCoordinator {
  constructor(readonly store: TrainingContentStore, readonly transport: ModelNodeTransport, readonly options: TrainingEpisodeControllerOptions,
    private readonly invoke = jsonProcess, private readonly fetcher: typeof fetch = fetch) {}
  private path(jobId: string): string {
    requireContract(/^job_[a-f0-9]{32}$/.test(jobId), 'invalid-job-handle', 'controller journal requires a canonical node job ID')
    return join(this.options.workspace, 'training-episodes', jobId)
  }
  private async call(args: string[], payload?: unknown, timeout = 60_000): Promise<unknown> {
    try { return await this.invoke(this.options.command, ['--root', this.options.root, ...args], payload, timeout) }
    catch (error) {
      if (error instanceof TrainingContractError) error.message = `Hitch ${args.slice(0, 2).join(' ')}: ${error.message}`
      throw error
    }
  }
  async preflight(request: TrainingRequestV2): Promise<void> {
    if (this.options.deployment) await verifyExecutionPlacement(request.deployment, this.options.deployment, this.options, request.trainer.runtimeLock.hitchCommit, this.invoke)
    else assertHitchCommit(await observeHitchController(this.options, this.invoke), request.trainer.runtimeLock.hitchCommit)
    const caps = object(await this.call(['capabilities', '--json']))
    for (const capability of ['training_external_binding', 'exact_policy_tokens', 'training_policy_fencing']) {
      requireContract(caps[capability] === '1', 'hitch-capability-missing', `controller Hitch lacks ${capability}`)
    }
    requireContract(list(caps.training_harnesses).includes(request.fixedHarness.adapter), 'hitch-harness-missing', 'controller Hitch lacks the fixed training harness')
    if (request.deployment.taskExecution.placement === 'remote') requireContract(caps.remote_training_external_binding === '2', 'remote-training-capability-missing', 'selected provider requires the versioned remote training binding/capture capability')
    for (const task of request.trainDataset.tasks) {
      await this.store.readBytes(task.taskRef); await this.store.readBytes(task.environmentRef)
    }
    await this.store.readBytes(request.fixedHarness.manifestRef); await this.store.readBytes(request.verifier)
  }
  async remember(request: TrainingRequestV2, jobId: string): Promise<void> {
    const path = join(this.path(jobId), 'request.json')
    await withTrainingFileLock(path + '.lock', async () => {
      let old: unknown
      try { old = JSON.parse(await readFile(path, 'utf8')) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      requireContract(!old || same(old, request), 'episode-request-drift', 'controller job request changed')
      if (!old) await atomicWrite(path, request)
    })
  }
  private async entries(handle: TrainingHandle, renew: boolean): Promise<IntentEntry[]> {
    const entries: IntentEntry[] = []; let cursor = 0
    do {
      const response = object(await this.transport.call('training.episodes.list', { handle, renew: renew && cursor === 0, cursor }))
      requireContract(response.schemaVersion === 2 && response.jobId === handle.jobId, 'episode-job-drift', 'node journal belongs to another job')
      entries.push(...list(response.entries) as unknown as IntentEntry[])
      if (response.nextCursor === null) return entries
      requireContract(Number.isSafeInteger(response.nextCursor) && Number(response.nextCursor) > cursor, 'episode-cursor-drift', 'node journal cursor must advance')
      cursor = Number(response.nextCursor)
    } while (true)
  }
  async reconcile(handle: TrainingHandle, cancel = false): Promise<{ pending: boolean }> {
    return this.withControl(handle, reconcile => reconcile(cancel))
  }
  async withControl<R>(handle: TrainingHandle, action: (reconcile: (cancel?: boolean) => Promise<{ pending: boolean }>) => Promise<R>): Promise<R> {
    return withTrainingFileLock(join(this.path(handle.jobId), 'coordinator.lock'), () => action(cancel => this.reconcileLocked(handle, cancel)))
  }
  private async reconcileLocked(handle: TrainingHandle, cancel = false): Promise<{ pending: boolean }> {
    const request = parseTrainingRequest(JSON.parse(await readFile(join(this.path(handle.jobId), 'request.json'), 'utf8')))
    requireContract(request.schemaVersion === 2 && digestJson(request) === handle.requestDigest, 'episode-request-drift', 'controller journal is not bound to this node job')
    let heartbeat: Promise<void> | undefined; let contactError: unknown
    const fenced = new Set<string>()
    const observe = (entries: IntentEntry[]) => { for (const entry of entries) if (entry.cancelRequested) fenced.add(entry.intent.id) }
    const timer = cancel ? undefined : setInterval(() => {
      if (heartbeat) return
      heartbeat = this.entries(handle, true).then(observe).catch(error => { contactError = error }).finally(() => { heartbeat = undefined })
    }, 2_000)
    try {
      const entries = await this.entries(handle, !cancel)
      observe(entries)
      if (!cancel && this.options.deployment) await verifyExecutionPlacement(request.deployment, this.options.deployment, this.options, request.trainer.runtimeLock.hitchCommit, this.invoke)
      for (const entry of entries) {
        const intent = validateRolloutIntent(entry.intent, request, handle)
        const serving = () => {
          if (contactError || fenced.has(intent.id)) throw new TrainingContractError('controller-contact-lost', 'model-node contact or policy lease was lost; stop dispatching new episodes')
        }
        await this.reconcileOne(handle, request, { ...entry, intent }, cancel || entry.cancelRequested, serving)
      }
      return { pending: (await this.entries(handle, false)).some(entry => !entry.result) }
    } finally { if (timer) clearInterval(timer); await heartbeat }
  }
  private async reconcileOne(handle: TrainingHandle, request: TrainingRequestV2, entry: IntentEntry, cancel: boolean, serving: () => void): Promise<void> {
    const { intent } = entry; const address = episodeAddress(intent)
    const directory = join(this.path(handle.jobId), digestJson(intent.id).slice(7)), statePath = join(directory, 'state.json')
    let state: ControllerEpisodeState
    try { state = JSON.parse(await readFile(statePath, 'utf8')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      state = { intentDigest: intent.inputDigest, submitted: false }; await atomicWrite(statePath, state)
    }
    requireContract(state.intentDigest === intent.inputDigest, 'episode-intent-drift', 'controller intent journal changed')
    await atomicWrite(join(directory, 'intent.json'), intent)
    if (entry.result) {
      requireContract(state.result && same(entry.result, state.result), 'episode-result-drift', 'node result differs from durable controller feedback')
      return
    }
    const resolve = async (result: Json) => {
      state.result = result; await atomicWrite(statePath, state)
      await this.transport.call('training.episodes.result', { handle, address, result })
    }
    if (state.result) { await resolve(state.result); return }
    if (entry.ack) {
      requireContract(!state.evalId || state.evalId === entry.ack.evalId, 'episode-ack-conflict', 'controller and node disagree about canonical eval')
      state.evalId = entry.ack.evalId; state.submitted = true; await atomicWrite(statePath, state)
    }
    if (cancel && !state.submitted) { await resolve({ schemaVersion: 2, outcome: 'cancelled', evalId: null, reason: 'cancelled' }); return }
    const harness = `${request.fixedHarness.adapter}@git+${pathToFileURL(this.options.harnessSourceDirectory).href}#${request.fixedHarness.commit}`
    const task = request.trainDataset.tasks.find(task => task.id === intent.context.taskId)!
    const datasetRoot = join(this.options.workspace, 'datasets', task.taskRef.digest.slice(7))
    const dataset = datasetDestination(await this.store.readJson(task.taskRef), datasetRoot)
    if (!state.evalId) {
      if (!state.submitted) {
        serving()
        await this.invoke(this.options.python, ['-m', 'gear_training.artifacts', 'materialize', '--store-root', this.store.root], { ref: task.taskRef, destination: datasetRoot }, 3_600_000)
        await this.transport.download(this.store, intent.binding.policyLeaseRef)
        const endpoint = await this.transport.gateway(this.options.workspace, intent.gateway.nodePort)
        const response = await this.fetcher(`${endpoint}/v1/lease`, { headers: { Authorization: `Bearer ${intent.credential}` }, signal: AbortSignal.timeout(10_000) })
        requireContract(response.ok, 'training-route-unavailable', 'controller cannot reach the exact generation lease')
        const lease = object(await response.json())
        requireContract(lease.episodeId === intent.id && lease.trainingRunId === request.trainingRunId && lease.policyVersion === intent.lease.policyVersion
          && lease.fencingToken === intent.lease.fencingToken && lease.state === 'serving' && lease.capture === 'exact-policy-tokens-v1'
          && lease.generationContractDigest === request.trainer.runtimeLock.protocolDigest, 'training-route-drift', 'gateway route points to another policy or episode')
        serving()
        const registered = object(await this.call(['training', 'register', '--file', '-'], { schema_version: '1', binding: intent.binding, base_url: endpoint + '/v1', credential: intent.credential }))
        requireContract(same(registered.binding, intent.binding), 'training-binding-drift', 'Hitch registration changed the frozen binding')
        await atomicWrite(join(directory, 'binding.json'), intent.binding)
        serving(); state.submitted = true; await atomicWrite(statePath, state)
      }
      // Replay the exact durable submission after a lost reply, including during
      // cancellation. Its old lease cannot be relabeled as a fresh generation.
      const accepted = object(await this.call(['eval', 'submit', '--dataset', dataset, '--harness', harness, '--model', `training/${intent.binding.bindingId}`,
        '--attempts', '1', '--max-concurrent', '1', '--infrastructure-retries', '0', '--training-binding-file', join(directory, 'binding.json'),
        '--provider', request.deployment.taskExecution.provider, '--model-capture', 'proxy', '--require-model-capture',
        '--timeout', `${this.options.episodeTimeoutSeconds}s`, '--idempotency-key', intent.key]))
      state.evalId = text(accepted.eval_id); await atomicWrite(statePath, state)
    }
    await this.transport.call('training.episodes.ack', { handle, address, ack: { evalId: state.evalId } })
    if (cancel) await this.call(['eval', 'cancel', state.evalId])
    const inspection = object(await this.call(['eval', 'inspect', state.evalId, '--json']))
    const submission = object(inspection.request), acceptedRequest = object(submission.request ?? submission)
    requireContract(same(acceptedRequest.training_binding, intent.binding), 'hitch-binding-drift', 'Hitch inspection lost the episode binding')
    requireContract(acceptedRequest.harness_ref === harness, 'hitch-harness-source-drift', 'accepted Hitch submission changed the frozen harness source')
    if (!inspection.result || ['running', 'cancelling'].includes(String(object(inspection.control ?? {}).state))) return
    const result = object(inspection.result), trials = list(result.trials)
    requireContract(['succeeded', 'failed', 'cancelled', 'timed_out'].includes(String(result.status)), 'hitch-terminal-drift', 'unexpected Hitch terminal status')
    if (cancel) { await resolve({ schemaVersion: 2, outcome: 'cancelled', evalId: state.evalId, reason: 'cancelled' }); return }
    if (trials.length !== 1 || typeof object(trials[0]).run_id !== 'string') {
      await resolve({ schemaVersion: 2, outcome: 'rejected', evalId: state.evalId, reason: 'missing-canonical-run' }); return
    }
    const trial = object(trials[0]), runId = text(trial.run_id)
    const native = object(await this.transport.call('training.episodes.receipts', { handle, address }))
    requireContract(native.runId === runId, 'hitch-canonical-run-mismatch', 'verifier and generation used different physical runs')
    if (!native.complete) { await resolve({ schemaVersion: 2, outcome: 'rejected', evalId: state.evalId, reason: 'incomplete-receipts' }); return }
    const receiptRefs = list(native.receiptRefs).map(parseContentRef)
    await syncContentGraph(this.transport, this.store, receiptRefs, 'download')
    const receipts: GenerationReceipt[] = []
    for (const ref of receiptRefs) receipts.push(parseGenerationReceipt(await this.store.readJson(ref)))
    const loaded = object(await this.call(['runs', 'inspect', runId, '--json']))
    const verifier = object(await this.call(['verifier', 'inspect', runId, '--json']))
    const terminal = object(await this.call(['training', 'evidence', runId, '--json']))
    const record = object(loaded.record), context = object(record.context), parent = object(record.parent), model = object(record.model), protocol = object(record.protocol), actualHarness = object(record.harness)
    const environment = object(await this.store.readJson(task.environmentRef)), expectedHarness = object(object(await this.store.readJson(request.fixedHarness.manifestRef)).hitch)
    requireContract(loaded.record_status === 'valid' && loaded.trajectory_status !== 'corrupt' && record.run_id === runId
      && parent.eval_id === state.evalId && parent.attempt === 1 && (trial.attempt ?? 1) === 1 && trial.task_id === task.id
      && context.kind === 'benchmark_task' && context.task_id === task.id && context.task_digest === environment.taskDigest && context.verifier_identity === environment.verifierIdentity
      && protocol.environment_identity === environment.hitchEnvironmentIdentity && model.provider === 'slime-training' && model.effective_id === intent.lease.policyVersion && model.identity_resolved === true
      && actualHarness.harness_id === expectedHarness.harnessId && actualHarness.revision_identity === expectedHarness.revisionIdentity && actualHarness.artifact_id === expectedHarness.artifactId
      && matchesHarnessRef(actualHarness.requested_ref, harness, request.fixedHarness.adapter, request.fixedHarness.commit)
      && object(terminal.training_external).policy_version === intent.lease.policyVersion,
    'training-canonical-identity-drift', 'canonical task/verifier/environment/harness/policy differs from its frozen training slot')
    const evidenceRef = await this.store.putJson({ inspection, loaded, verifier, terminal })
    const observation = object(record.observation ?? {})
    if (trial.observation_status !== 'valid' || observation.status !== 'valid' || observation.reward !== trial.reward
      || object(verifier.verifier).status !== 'complete' || terminal.termination !== 'terminated' || !Number.isFinite(trial.reward)) {
      await resolve({ schemaVersion: 2, outcome: 'rejected', evalId: state.evalId, reason: 'invalid-canonical-observation', evidenceRef }); return
    }
    const verificationRef = await this.store.putJson({ schemaVersion: 2, kind: 'controller-verifier-observation', runId, verifierVersion: request.verifier.digest,
      reward: trial.reward, valid: true, sourceEvidenceRef: evidenceRef })
    const feedback = parseFeedbackRecord({ schemaVersion: 1, id: `feedback_${digestJson([intent.id, evidenceRef]).slice(7, 39)}`, episodeId: intent.id, runId,
      receiptIds: receipts.map(receipt => receipt.id), verifierVersion: request.verifier.digest, verifierEvidenceRef: verificationRef, outcome: 'valid', reward: trial.reward })
    const episode = parseTrainingEpisode({ schemaVersion: 1, id: intent.id, groupId: intent.context.groupId, slot: intent.context.slot, harnessRef: request.fixedHarness.manifestRef,
      taskRef: task.taskRef, environmentRef: task.environmentRef, policyVersion: intent.lease.policyVersion, runId, receiptIds: feedback.receiptIds, feedbackId: feedback.id,
      termination: 'terminated', eligibility: 'eligible', rejectionReasons: [] })
    const assembly = { schemaVersion: 2, kind: 'controller-episode-verification', episodeId: intent.id, runId, taskDigest: task.taskRef.digest,
      environmentDigest: task.environmentRef.digest, harnessDigest: request.fixedHarness.manifestRef.digest, verifierVersion: request.verifier.digest, feedbackDigest: digestJson(feedback) }
    const feedbackRef = await this.store.putJson(feedback), episodeRef = await this.store.putJson(episode), assemblyRef = await this.store.putJson(assembly)
    // Only these projections travel to the trainer. Raw canonical/verifier data
    // and all task files remain in the controller CAS, referenced for collection.
    for (const ref of [verificationRef, feedbackRef, episodeRef, assemblyRef]) await this.transport.upload(this.store, ref)
    const resolution = { schemaVersion: 2, outcome: 'feedback', evalId: state.evalId, feedbackRef, episodeRef, assemblyRef }
    // Establish exact native-sample admission before journaling immutable
    // feedback. A lost reply can retry; a known invalid sample is rejected.
    const admission = object(await this.transport.call('training.episodes.admit', { handle, address, result: resolution }))
    requireContract(typeof admission.valid === 'boolean', 'invalid-episode-admission', 'node did not establish sample admission')
    if (!admission.valid) {
      const reason = text(admission.reason)
      requireContract(/^[a-z][a-z0-9-]{0,127}$/.test(reason), 'invalid-episode-admission', 'node admission needs a bounded reason')
      await resolve({ schemaVersion: 2, outcome: 'rejected', evalId: state.evalId, reason, evidenceRef }); return
    }
    await resolve(resolution)
  }
}
