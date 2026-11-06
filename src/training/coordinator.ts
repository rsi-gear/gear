import { readOfflineDataset, validateOfflineDataset, validateOfflineBatch } from './offline.js'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { digestJson } from './digest.js'
import { validateReadyEndpointBinding } from './endpoint-binding.js'
import { decideModel, devGate, evaluationAttemptId, modelEvaluationIdentity, modelEvaluationRequest, modelEvidenceKey, pairModelEvidence, validateModelEvidence } from './evaluation.js'
import { parseModelTrainingSpec, parseModelVersion, parseTrainerCheckpoint, parseTrainingArtifacts, parseTrainingBatch, parseTrainingCapabilities, parseTrainingHandle, parseTrainingRequest, parseTrainingStatus, parseUpdateCommit, requireContract } from './schema.js'
import { ModelTrainingStore } from './store.js'
import type * as T from './types.js'
import { evaluationControlIntent, sameTrainingControl, setEvaluationControl, setTrainingControl, trainingControlIntent } from './training-control.js'
import { chargeEvaluationUsage, refreshEvaluationUsage, savedEvaluationBinding } from './evaluation-usage.js'
import { proposalInputsDigest, proposalSpec, validateIterationTrainingSchedule } from './iteration-policy.js'

const emptyUsage = (): T.TrainingUsage => ({ gpuSeconds: 0, rolloutTokens: 0, groupResamples: 0 })
const terminal = (run: T.ModelTrainingRun): boolean => !!run.decision
export const trainingCompatibilityDigest = (request: T.TrainingRequest): string => digestJson({
  backend: request.trainer.backend, runtimeLock: request.trainer.runtimeLock, hyperparametersRef: request.trainer.hyperparametersRef,
  placement: request.trainer.placement ?? 'separate', trainingDeviceCount: request.trainingDevices.length,
  referenceModelRef: request.referenceModelRef, architecture: request.parentModel.architecture, dtype: request.parentModel.dtype,
  tokenizerDigest: request.parentModel.tokenizerDigest, chatTemplateDigest: request.parentModel.chatTemplateDigest,
  ...(request.trainer.recipe !== 'agent-grpo-v1' ? { recipe: request.trainer.recipe,
    batchLayout: { rolloutBatchSize: request.trainer.rolloutBatchSize, globalBatchSize: request.trainer.globalBatchSize, dataParallelSize: request.trainer.dataParallelSize },
    ...(request.offlineTraining ? { offlineTraining: request.offlineTraining } : { rollout: request.rollout }) } : {}),
  ...(request.schemaVersion === 2 ? { deployment: request.deployment, trainingDevices: request.trainingDevices } : {}),
})
export interface ModelPublisher {
  /** Must reconcile the same activation id after an uncertain result. New episodes only. */
  activate(model: T.ModelVersion, activationId: string): Promise<{ activationId: string; modelVersionId: string; active: true }>
}

export class ModelTrainingCoordinator {
  constructor(readonly store: ModelTrainingStore, readonly trainer: T.ModelTrainer, readonly evaluator: T.ModelEvaluator, readonly endpointPreparer?: T.ModelEndpointPreparer) {}

  async createExperiment(input: unknown): Promise<T.ModelExperimentState> {
    const spec = parseModelTrainingSpec(input)
    this.assertEndpointAuthorization(spec)
    const initial = parseModelVersion(await this.store.readJson(spec.initialModel))
    const reference = parseModelVersion(await this.store.readJson(spec.referenceModel))
    await validateIterationTrainingSchedule(this.store, spec, initial)
    requireContract(initial.architecture === reference.architecture && initial.dtype === reference.dtype
      && initial.tokenizerDigest === reference.tokenizerDigest && initial.chatTemplateDigest === reference.chatTemplateDigest,
    'reference-incompatible', 'reference and actor must use the same model and token semantics')
    // Resolve immutable control inputs now, not after a job has started.
    for (const ref of [spec.fixedHarness.manifestRef, spec.verifier, spec.trainer.hyperparametersRef, ...(spec.trainer.script ? [spec.trainer.script.sourceRef] : []), ...Object.values(spec.stages ?? {}).map(config => config.instructionsRef),
      ...Object.values(spec.datasets).flatMap(d => [d.snapshotRef, ...d.tasks.flatMap(t => [t.taskRef, t.environmentRef])]),
      ...(spec.iteration?.proposals.map(proposal => proposal.sourceRef) ?? [])]) await this.store.readBytes(ref)
    if (spec.offlineTraining) await validateOfflineDataset(this.store, spec, initial)
    const state: T.ModelExperimentState = { schemaVersion: 1, id: `exp_${randomUUID().replaceAll('-', '')}`,
      spec, specDigest: digestJson(spec), champion: { modelRef: spec.initialModel, revision: 0, baselineEvidence: {} }, runs: {}, releases: [], usage: emptyUsage() }
    const now = Date.now()
    if (spec.iteration) state.iteration = { schemaVersion: 1, status: 'running', control: { sequence: 0, action: 'start' },
      startedAt: new Date(now).toISOString(), deadlineAt: new Date(now + spec.iteration.maxWallClockSeconds * 1000).toISOString(),
      rounds: {}, nextProposalIndex: 0, consecutiveRejected: 0 }
    if (spec.endpointPreparation) state.endpointControl = { sequence: 0, action: 'start',
      deadlineAt: state.iteration?.deadlineAt ?? new Date(now + (this.endpointPreparer!.maxRuntimeSeconds ?? 3600) * 1000).toISOString() }
    await this.store.create(state)
    return state
  }

  async admit(experimentId: string, iterationSequence?: number): Promise<T.ModelTrainingRun> {
    await this.assertCurrentExperiment(experimentId)
    return this.store.transaction(experimentId, async state => {
      const iteration = state.iteration
      if (state.spec.iteration) {
        requireContract(iteration && iterationSequence === iteration.control.sequence && iteration.status === 'running'
          && iteration.control.action === 'start', 'iteration-control-stale', 'automatic admission requires the current running iteration intent')
        if (iteration.activeRoundIndex !== undefined) {
          const current = state.runs[iteration.rounds[String(iteration.activeRoundIndex)]!.runId]!
          requireContract(!terminal(current), 'iteration-decision-pending', 'commit the existing round decision before admitting another')
          return structuredClone(current)
        }
        requireContract(Date.now() < Date.parse(iteration.deadlineAt), 'iteration-deadline-exceeded', 'experiment wall clock deadline is exhausted')
        requireContract(Object.keys(iteration.rounds).length < state.spec.iteration.maxRounds, 'iteration-round-limit', 'declared maximum rounds have completed')
      } else requireContract(iterationSequence === undefined, 'iteration-not-authorized', 'this experiment was not created with iteration authority')
      requireContract(!Object.values(state.runs).some(currentRun => !terminal(currentRun)), 'training-run-active', 'finish or close the existing training run before admitting another')
      const parentModel = parseModelVersion(await this.store.readJson(state.champion.modelRef))
      const spec = proposalSpec(state.spec, iteration?.nextProposalIndex)
      requireContract(state.usage.gpuSeconds < spec.budgets.totalGpuSeconds && state.usage.rolloutTokens < spec.budgets.maxRolloutTokens,
        'budget-exhausted', 'experiment training budget is exhausted')
      let generatedTaskExclusionRef: T.ContentRef | undefined
      if (spec.stages?.taskSource) {
        const privateTasks = [...spec.datasets.dev.tasks, ...spec.datasets.heldOut.tasks]
        const fingerprints: string[] = [], instructions: string[] = []
        for (const task of privateTasks) {
          const manifest = await this.store.readJson<{ files?: { path: string; sha256: string }[] }>(task.taskRef)
          if (manifest.files) {
            fingerprints.push(digestJson(manifest.files.map(file => file.sha256).sort()))
            instructions.push(...manifest.files.filter(file => file.path.endsWith('instruction.md')).map(file => file.sha256))
          }
        }
        generatedTaskExclusionRef = await this.store.putJson({ ids: privateTasks.map(task => digestJson(task.id)),
          families: privateTasks.map(task => digestJson(task.family)), taskDigests: privateTasks.map(task => task.taskRef.digest), fingerprints, instructions })
      }
      const id = `train_${randomUUID().replaceAll('-', '')}`
      const request = parseTrainingRequest({ schemaVersion: spec.schemaVersion, ...(spec.schemaVersion === 2 ? { deployment: spec.deployment } : {}), trainingRunId: id, experimentId, parentModel, parentModelRef: state.champion.modelRef,
        ...(spec.stages ? { stages: spec.stages, ...(generatedTaskExclusionRef ? { generatedTaskExclusionRef } : {}), behaviorPolicyRef: state.champion.modelRef,
          updateStart: { mode: parentModel.trainerCheckpointRef ? 'resume' : 'cold-start', modelRef: state.champion.modelRef,
            ...(parentModel.trainerCheckpointRef ? { checkpointRef: parentModel.trainerCheckpointRef } : {}) } } : {}),
        referenceModelRef: spec.referenceModel, ...(parentModel.trainerCheckpointRef ? { resumeCheckpointRef: parentModel.trainerCheckpointRef } : {}),
        coldStart: !parentModel.trainerCheckpointRef, fixedHarness: spec.fixedHarness, trainDataset: spec.datasets.train, verifier: spec.verifier,
        trainer: spec.trainer, rollout: spec.rollout, ...(spec.offlineTraining ? { offlineTraining: spec.offlineTraining } : {}), trainingDevices: spec.resources.trainingDevices,
        budgets: { ...spec.budgets, totalGpuSeconds: spec.budgets.totalGpuSeconds - state.usage.gpuSeconds,
          maxRolloutTokens: spec.budgets.maxRolloutTokens - state.usage.rolloutTokens,
          maxGroupResamples: Math.max(0, spec.budgets.maxGroupResamples - state.usage.groupResamples) },
        recipeDigest: digestJson({ ...(spec.stages ? { stages: spec.stages } : {}), trainer: spec.trainer, rollout: spec.rollout, ...(spec.offlineTraining ? { offlineTraining: spec.offlineTraining } : {}), verifier: spec.verifier, referenceModelRef: spec.referenceModel,
          ...(spec.schemaVersion === 2 ? { deployment: spec.deployment } : {}) }),
        datasetSplitDigest: digestJson(spec.datasets),
        ...(iteration ? { deadlineAt: iteration.deadlineAt } : {}),
      })
      if (request.resumeCheckpointRef) {
        const checkpoint = parseTrainerCheckpoint(await this.store.readJson(request.resumeCheckpointRef))
        requireContract(checkpoint.actorWeightsDigest === parentModel.weightsDigest && checkpoint.compatibilityDigest === trainingCompatibilityDigest(request),
          'checkpoint-incompatible', 'champion checkpoint weights or training compatibility differ')
        if (request.offlineTraining) {
          const cursor = await this.store.readJson<{ position: number; datasetDigest: string }>(checkpoint.dataCursorRef)
          const data = await validateOfflineDataset(this.store, spec, parentModel)
          requireContract(cursor.position === checkpoint.committedUpdate * request.trainer.rolloutBatchSize
            && cursor.datasetDigest === request.offlineTraining.datasetRef.digest
            && cursor.position + request.trainer.updatesPerCandidate * request.trainer.rolloutBatchSize <= data.records.length * request.offlineTraining.maxEpochs,
          'offline-dataset-exhausted', 'accepted parent cursor must have enough data within the explicit epoch limit')
        }
      }
      const run: T.ModelTrainingRun = { schemaVersion: 1, id, parent: structuredClone(state.champion), request,
        idempotencyKey: `${experimentId}/${id}`, phase: 'admitted', execution: 'running', usage: emptyUsage(), resourcesReleased: true,
        heldOutQueries: 0, evaluationIntents: {}, evaluationTasksCompleted: true, ...(spec.endpointPreparation ? { inferenceResourcesReleased: true } : {}) }
      const sequence = Math.max(-1, ...Object.values(state.runs).map(currentRun => evaluationControlIntent(currentRun).sequence)) + 1
      requireContract(Number.isSafeInteger(sequence), 'evaluation-control-overflow', 'evaluation control sequence is exhausted')
      run.evaluationControl = { schemaVersion: 2, sequence, action: 'start' }
      if (iteration) {
        const roundIndex = Object.keys(iteration.rounds).length
        const proposalIndex = iteration.nextProposalIndex, proposal = state.spec.iteration!.proposals[proposalIndex]!
        run.iterationRound = { roundIndex, proposalIndex, proposalId: proposal.id, inputsDigest: proposalInputsDigest(state.spec, proposalIndex) }
        iteration.rounds[String(roundIndex)] = { runId: id, proposalIndex, recoveries: 0 }
        iteration.activeRoundIndex = roundIndex
        iteration.control.sequence++
      }
      if (state.endpointControl) {
        state.endpointControl.sequence = iteration?.control.sequence ?? state.endpointControl.sequence + 1
        state.endpointControl.action = 'start'
      }
      state.runs[id] = run
      return structuredClone(run)
    })
  }

  private async assertCurrentExperiment(id: string): Promise<void> {
    const state = await this.store.load(id)
    requireContract(state.spec.evaluation.provider === 'hitch-endpoint', 'historical-run-read-only',
      'historical managed inference experiments remain readable; create a new endpoint experiment to rerun')
    this.assertEndpointAuthorization(state.spec)
  }

  private assertEndpointAuthorization(spec: T.ModelTrainingSpec): void {
    if (this.endpointPreparer?.mode === 'managed-native') requireContract(spec.endpointPreparation?.mode === 'managed-native'
      && spec.endpointPreparation.profileDigest === this.endpointPreparer.configurationDigest,
    'managed-endpoint-not-authorized', 'managed deployment requires the exact profile digest frozen in this experiment')
    if (spec.endpointPreparation) requireContract(this.endpointPreparer?.mode === 'managed-native'
      && this.endpointPreparer.configurationDigest === spec.endpointPreparation.profileDigest
      && this.endpointPreparer.observe && this.endpointPreparer.acquireConsumer && this.endpointPreparer.releaseConsumer
      && this.endpointPreparer.retire && this.endpointPreparer.fence && this.endpointPreparer.retireOwned && this.endpointPreparer.releaseOwnership,
    'managed-endpoint-unconfigured', 'the frozen managed profile requires its complete owned lifecycle adapter')
  }

  async inspect(id: string, runId: string): Promise<T.ModelTrainingRun> {
    const state = await this.store.load(id)
    const run = state.runs[runId]
    requireContract(run, 'unknown-training-run', 'unknown model training run')
    return run
  }

  /** One reconciliation pass. Safe to repeat after a timeout or coordinator restart. */
  async advance(id: string, runId: string): Promise<T.ModelTrainingRun> {
    let state = await this.store.load(id)
    let run = await this.inspect(id, runId)
    if (terminal(run)) return run
    requireContract(state.spec.evaluation.provider === 'hitch-endpoint', 'historical-run-read-only', 'historical managed inference runs remain readable; start a new endpoint experiment to rerun')
    this.assertEndpointAuthorization(state.spec)
    if (state.iteration && state.iteration.control.action === 'pause' && run.execution !== 'pausing' && run.execution !== 'paused') return this.pause(id, runId, true)
    if (run.request.deadlineAt && Date.now() >= Date.parse(run.request.deadlineAt)) return this.pause(id, runId, true)
    if (run.execution === 'pausing') return this.pause(id, runId)
    if (run.execution === 'paused') return run
    try {
      await refreshEvaluationUsage(this.store, this.evaluator, state, run)
      state = await this.store.load(id)
      if (!run.handle) {
        if (run.resourcesReleased) {
          // Reconcile a pending baseline task before submitting training.
          // The shared endpoint has no Gear-owned evaluation devices.
          if (Object.keys(run.evaluationIntents).length === 0) await this.preflight(run.request)
          const parentModel = run.request.parentModel
          await this.evaluate(id, runId, parentModel, run.parent.modelRef, 'dev', true)
          await this.evaluate(id, runId, parentModel, run.parent.modelRef, 'held-out', true)
          run = await this.inspect(id, runId)
          if (run.execution === 'pausing' || run.execution === 'paused') return this.pause(id, runId)
          if (run.resourcesReleased) await this.preflight(run.request)
          // Persist submit intent before the external action. An uncertain
          // submission may already own GPUs and must go directly to reconciliation.
          await this.store.transaction(id, transactionState => {
            const currentRun = transactionState.runs[runId]!
            requireContract(!['pausing', 'paused'].includes(currentRun.execution), 'training-run-paused', 'a paused run cannot admit a training submission')
            if (currentRun.resourcesReleased) {
              const remaining = transactionState.spec.budgets.totalGpuSeconds - transactionState.usage.gpuSeconds
              requireContract(remaining > 0, 'budget-exhausted', 'baseline evaluation exhausted the experiment GPU budget')
              currentRun.request.budgets.totalGpuSeconds = Math.min(currentRun.request.budgets.totalGpuSeconds, remaining)
            }
            currentRun.resourcesReleased = false
          })
        }
        run = await this.inspect(id, runId)
        if (run.execution === 'pausing' || run.execution === 'paused') return this.pause(id, runId)
        const handle = await this.submitTrainer(run)
        requireContract(handle.requestDigest === digestJson(run.request), 'job-request-mismatch', 'training job does not match the frozen request')
        await this.store.transaction(id, transactionState => {
          const currentRun = transactionState.runs[runId]!
          requireContract(!currentRun.handle || digestJson(currentRun.handle) === digestJson(handle), 'job-handle-conflict', 'idempotent submission returned another job')
          currentRun.handle = handle
          if (sameTrainingControl(currentRun, run) && !['pausing', 'paused'].includes(currentRun.execution)) {
            currentRun.phase = 'collecting'
            delete currentRun.error
          }
        })
      }
      run = await this.inspect(id, runId)
      if (run.execution === 'pausing' || run.execution === 'paused') return this.pause(id, runId)
      if (!run.artifactsRef) {
        const status = parseTrainingStatus(await this.trainer.inspect(run.handle!))
        if (!await this.recordStatus(id, runId, status, false, run)) return this.inspect(id, runId)
        if (['paused', 'pausing', 'blocked', 'interrupted', 'failed'].includes(status.execution)) return this.inspect(id, runId)
        if (status.execution !== 'completed') return this.inspect(id, runId)
        if (status.phase === 'inconclusive') {
          await this.finish(id, runId, { outcome: 'inconclusive', reasons: [status.message ?? 'no-complete-training-batch'] })
          return this.inspect(id, runId)
        }
        const artifacts = parseTrainingArtifacts(await this.trainer.collect(run.handle!))
        await this.validateArtifacts(run, artifacts)
        state = await this.store.load(id)
        const artifactsRef = await this.store.putJson(artifacts)
        const candidateRef = await this.store.putJson(artifacts.model)
        await this.store.transaction(id, transactionState => {
          const currentRun = transactionState.runs[runId]!
          this.recordUsage(transactionState, currentRun, artifacts.usage)
          currentRun.artifactsRef = artifactsRef
          currentRun.candidateRef = candidateRef
          currentRun.resourcesReleased ||= artifacts.resourcesReleased
          if (!['pausing', 'paused'].includes(currentRun.execution)) {
            currentRun.phase = 'evaluating'
            currentRun.execution = 'running'
          }
        })
      }
      run = await this.inspect(id, runId)
      state = await this.store.load(id)
      if (!run.resourcesReleased) {
        if (!await this.recordStatus(id, runId, parseTrainingStatus(await this.trainer.inspect(run.handle!)), false, run)) return this.inspect(id, runId)
        run = await this.inspect(id, runId)
        state = await this.store.load(id)
      }
      const candidate = parseModelVersion(await this.store.readJson(run.candidateRef!))
      const baselineDev = await this.evaluate(id, runId, run.request.parentModel, run.parent.modelRef, 'dev', true)
      const candidateDev = await this.evaluate(id, runId, candidate, run.candidateRef!, 'dev', false)
      const dev = pairModelEvidence(baselineDev, candidateDev)
      const reasons = devGate(state.spec, dev)
      if (reasons.length) {
        await this.finish(id, runId, { outcome: 'rejected', reasons, dev })
      } else {
        const baselineHeldOut = await this.evaluate(id, runId, run.request.parentModel, run.parent.modelRef, 'held-out', true)
        const candidateHeldOut = await this.evaluate(id, runId, candidate, run.candidateRef!, 'held-out', false)
        const heldOut = pairModelEvidence(baselineHeldOut, candidateHeldOut)
        await this.finish(id, runId, decideModel(state.spec, dev, heldOut))
      }
    } catch (error) {
      try {
        const current = await this.store.load(id)
        if (terminal(current.runs[runId]!)) return current.runs[runId]!
        await refreshEvaluationUsage(this.store, this.evaluator, current, current.runs[runId]!)
        const metered = await this.store.load(id)
        if (!metered.runs[runId]!.artifactsRef && metered.runs[runId]!.status?.execution !== 'completed'
          && metered.usage.gpuSeconds >= metered.spec.budgets.totalGpuSeconds) {
          const paused = await this.pause(id, runId)
          await this.store.transaction(id, transactionState => {
            const currentRun = transactionState.runs[runId]!
            if (sameTrainingControl(currentRun, paused)) currentRun.error = 'experiment GPU budget is exhausted'
          })
          return this.inspect(id, runId)
        }
      } catch (observationError) {
        error = observationError
      }
      if (error instanceof Error && 'code' in error && ['evaluation-pending', 'evaluation-release-pending', 'evaluation-control-stale', 'inference-release-pending', 'waiting-for-deployment', 'training-release-pending', 'training-run-paused', 'training-control-stale', 'eval_control_stale', 'native-deployment-pending', 'native-deployment-stale'].includes(String(error.code))) {
        await this.store.transaction(id, transactionState => {
          const currentRun = transactionState.runs[runId]!
          if (!terminal(currentRun) && !['pausing', 'paused'].includes(currentRun.execution)) {
            currentRun.execution = 'running'
            if (error instanceof Error && 'code' in error && error.code === 'waiting-for-deployment') currentRun.error = error.message
            else delete currentRun.error
          }
        })
        return this.inspect(id, runId)
      }
      await this.store.transaction(id, transactionState => {
        const currentRun = transactionState.runs[runId]!
        if (!terminal(currentRun) && !['paused', 'pausing'].includes(currentRun.execution)) {
          currentRun.execution = 'blocked'
          currentRun.error = error instanceof Error ? error.message : String(error)
        }
      })
      throw error
    }
    return this.inspect(id, runId)
  }

  private async preflight(request: T.TrainingRequest): Promise<void> {
    if (request.schemaVersion === 2) requireContract(this.trainer.control, 'training-control-unavailable', 'v2 training requires durable ordered start and pause commands')
    const capabilities = parseTrainingCapabilities(await this.trainer.preflight(request))
    const required: (keyof Pick<T.TrainingCapabilities, 'trainingExternalBinding' | 'exactPolicyTokens' | 'policyFencing' | 'durableIdempotency' | 'checkpointEveryUpdate' | 'immutableHfExport'>)[] = request.offlineTraining
      ? ['durableIdempotency', 'checkpointEveryUpdate', 'immutableHfExport']
      : ['trainingExternalBinding', 'exactPolicyTokens', 'policyFencing', 'durableIdempotency', 'checkpointEveryUpdate', 'immutableHfExport']
    requireContract(required.every(k => capabilities[k]) && capabilities.blockers.length === 0
      && capabilities.runtimeLockDigest === digestJson(request.trainer.runtimeLock),
    'training-preflight-blocked', `training capabilities unavailable: ${capabilities.blockers.join(', ') || required.filter(k => !capabilities[k]).join(', ') || 'runtime lock mismatch'}`)
    requireContract(request.trainer.runtimeLock.validation === 'validated', 'gpu-probes-pending', 'cloud GPU compatibility probes must pass before training submission')
    for (const probe of request.trainer.runtimeLock.probeEvidenceRefs) await this.store.readBytes(probe)
  }

  private async submitTrainer(run: T.ModelTrainingRun): Promise<T.TrainingHandle> {
    if (run.request.schemaVersion === 1) return parseTrainingHandle(await this.trainer.submit(run.request, run.idempotencyKey))
    const intent = trainingControlIntent(run)
    requireContract(this.trainer.control && intent.action === 'start', 'training-control-unavailable', 'v2 submission requires a durable start intent')
    return parseTrainingStatus(await this.trainer.control(run.request, run.idempotencyKey, intent)).handle
  }
  private async stopTrainer(run: T.ModelTrainingRun): Promise<T.TrainingStatus> {
    if (run.request.schemaVersion === 1) return parseTrainingStatus(await this.trainer.cancel(run.handle!))
    const intent = trainingControlIntent(run)
    requireContract(this.trainer.control && intent.action === 'pause', 'training-control-unavailable', 'v2 cancellation requires a durable pause intent')
    return parseTrainingStatus(await this.trainer.control(run.request, run.idempotencyKey, intent))
  }

  private recordUsage(state: T.ModelExperimentState, run: T.ModelTrainingRun, usage: T.TrainingUsage): void {
    for (const key of ['gpuSeconds', 'rolloutTokens', 'groupResamples'] as const) {
      requireContract(usage[key] >= run.usage[key], 'usage-regression', 'resumption must preserve cumulative training cost')
      state.usage[key] += usage[key] - run.usage[key]
      run.usage[key] = usage[key]
    }
  }
  private async recordStatus(id: string, runId: string, status: T.TrainingStatus, cleanupOnly = false, expected?: T.ModelTrainingRun): Promise<boolean> {
    return this.store.transaction(id, transactionState => {
      const currentRun = transactionState.runs[runId]!
      if (expected && !sameTrainingControl(currentRun, expected)) return false
      requireContract(digestJson(status.handle) === digestJson(currentRun.handle), 'job-status-mismatch', 'trainer returned another job status')
      requireContract(!currentRun.status || status.committedUpdate >= currentRun.status.committedUpdate, 'checkpoint-regression', 'committed update cursor cannot move backwards')
      this.recordUsage(transactionState, currentRun, status.usage)
      currentRun.status = status
      if (!['pausing', 'paused'].includes(currentRun.execution) || !currentRun.resourcesReleased) currentRun.resourcesReleased = status.resourcesReleased
      // After collection this status describes cleanup of the original trainer;
      // it cannot move the candidate back out of evaluation or undo a pause.
      if (!currentRun.artifactsRef && !cleanupOnly && !['pausing', 'paused'].includes(currentRun.execution)) {
        currentRun.phase = status.phase
        currentRun.execution = status.execution
      }
      return true
    })
  }

  private endpointContext(state: T.ModelExperimentState, runId?: string): T.EndpointPreparationContext {
    const control = state.endpointControl ?? { sequence: state.iteration?.control.sequence ?? 0, action: state.iteration?.control.action ?? 'start',
      deadlineAt: state.iteration?.deadlineAt ?? new Date(Date.now() + 3600_000).toISOString() }
    return { experimentId: state.id, controllerDirectory: join(this.store.root, 'model-training-v1', state.id),
      ...(runId ? { runId } : {}), controlSequence: control.sequence, action: control.action, deadlineAt: control.deadlineAt }
  }

  async fenceEndpoints(id: string): Promise<void> {
    const state = await this.store.load(id)
    this.assertEndpointAuthorization(state.spec)
    if (state.spec.endpointPreparation) await this.endpointPreparer!.fence!(this.endpointContext(state))
  }

  /** This confirms inference cleanup independently of trainer/task termination. */
  async retireEndpoints(id: string): Promise<boolean> {
    const state = await this.store.load(id)
    if (!state.spec.endpointPreparation) return true
    this.assertEndpointAuthorization(state.spec)
    let released = true, reason: string | undefined
    for (const preparation of Object.values(state.endpointPreparations ?? {})) {
      if (!preparation.bindingRef || preparation.status === 'released') continue
      const binding = await this.store.readJson<T.ReadyEvaluationEndpointBinding>(preparation.bindingRef)
      const result = await this.endpointPreparer!.retire!(binding, this.endpointContext(await this.store.load(id)))
      released &&= result.status === 'released'
      reason ??= result.reason
      await this.store.transaction(id, current => {
        const saved = Object.values(current.endpointPreparations ?? {}).find(item => item.bindingRef?.digest === preparation.bindingRef!.digest)
        if (saved) saved.status = result.status === 'released' ? 'released' : 'blocked'
      })
    }
    const owned = await this.endpointPreparer!.retireOwned!(this.endpointContext(await this.store.load(id)))
    released &&= owned.status === 'released'
    reason ??= owned.reason
    await this.store.transaction(id, current => {
      if (!released && current.iteration) current.iteration.error = reason ?? 'owned inference cleanup is pending'
      for (const run of Object.values(current.runs)) {
        if (!run.evaluationTasksCompleted) continue
        run.inferenceResourcesReleased = released
        if (reason && !released) run.inferenceCleanupError = reason
        else delete run.inferenceCleanupError
      }
    })
    return released
  }

  async releaseEndpointOwnership(id: string): Promise<boolean> {
    const state = await this.store.load(id)
    if (!state.spec.endpointPreparation) return true
    const released = await this.endpointPreparer!.releaseOwnership!(this.endpointContext(state))
    if (!released.released) await this.store.transaction(id, current => { if (current.iteration) current.iteration.error = released.reason ?? 'deployment ownership release pending' })
    return released.released
  }

  private async prepareEndpoint(id: string, runId: string, model: T.ModelVersion, modelRef: T.ContentRef): Promise<T.ReadyEvaluationEndpointBinding> {
    requireContract(this.endpointPreparer, 'endpoint-preparation-unconfigured', 'configure an external per-model endpoint binding map')
    const state = await this.store.load(id)
    const intentDigest = digestJson({ modelVersionId: model.id, snapshotDigest: model.hfSnapshotRef.digest,
      configurationDigest: this.endpointPreparer.configurationDigest, common: state.spec.evaluation.common })
    const saved = await this.store.transaction(id, transactionState => {
      const preparations = transactionState.endpointPreparations ??= {}
      const existing = preparations[model.id]
      requireContract(!existing || existing.intentDigest === intentDigest, 'endpoint-preparation-drift', 'restore the original deployment preparation configuration')
      return preparations[model.id] ??= { schemaVersion: 1, intentDigest, modelRef, status: 'waiting' }
    })
    if (saved.status === 'ready') {
      const binding = validateReadyEndpointBinding(await this.store.readJson(saved.bindingRef!), model,
        state.spec.evaluation.common, this.endpointPreparer.trustedReceiptSources)
      if (!state.spec.endpointPreparation) return binding
      const observed = await this.endpointPreparer.observe!(binding, this.endpointContext(state, runId))
      if (observed) return validateReadyEndpointBinding(observed, model, state.spec.evaluation.common, this.endpointPreparer.trustedReceiptSources)
    }
    const current = await this.store.load(id)
    requireContract(!state.spec.endpointPreparation || current.endpointControl?.action === 'start'
      && Date.now() < Date.parse(current.endpointControl.deadlineAt), 'training-run-paused', 'managed deployment requires a current live start command')
    const prepared = await this.endpointPreparer.prepare(model, modelRef, this.endpointContext(current, runId))
    requireContract(prepared, 'waiting-for-deployment', `waiting for externally prepared endpoint: ${model.hfSnapshotRef.digest}`)
    const binding = validateReadyEndpointBinding(prepared, model, state.spec.evaluation.common, this.endpointPreparer.trustedReceiptSources)
    const bindingRef = await this.store.putJson(binding)
    return this.store.transaction(id, async transactionState => {
      const preparation = transactionState.endpointPreparations![model.id]!
      requireContract(preparation.intentDigest === intentDigest, 'endpoint-preparation-drift', 'deployment preparation intent changed')
      // First durable ready binding wins even when two controllers observe a mutable external map.
      if (preparation.status === 'ready' && !transactionState.spec.endpointPreparation) return this.store.readJson<T.ReadyEvaluationEndpointBinding>(preparation.bindingRef!)
      requireContract(!transactionState.spec.endpointPreparation || transactionState.endpointControl?.sequence === current.endpointControl?.sequence
        && transactionState.endpointControl?.action === 'start', 'training-control-stale', 'a newer stop command owns endpoint preparation')
      preparation.status = 'ready'; preparation.bindingRef = bindingRef
      return binding
    })
  }

  private async evaluate(id: string, runId: string, model: T.ModelVersion, modelRef: T.ContentRef, partition: 'dev' | 'held-out', baseline: boolean): Promise<T.ModelEvaluationEvidence> {
    let state = await this.store.load(id)
    let run = state.runs[runId]!
    requireContract(!['pausing', 'paused'].includes(run.execution), 'training-run-paused', 'a paused run cannot dispatch another evaluation')
    const evidenceKey = modelEvidenceKey(modelEvaluationIdentity(state.spec, model, modelRef, partition))
    const intentId = `${baseline ? 'baseline' : 'candidate'}:${partition}`
    let intent = run.evaluationIntents[intentId]
    let previous = intent?.evidenceRef ? validateModelEvidence(await this.store.readJson(intent.evidenceRef)) : undefined
    requireContract(!intent || intent.key === evidenceKey, 'evaluation-intent-drift', 'evaluation intent identity changed')
    if (previous?.complete) {
      requireContract(previous.evidenceKey === evidenceKey, 'evaluation-drift', 'saved complete evidence must match the frozen evaluation subject and conditions')
      for (const attempt of intent?.attempts ?? []) await this.releaseEvaluationConsumer(id, runId, intentId, attempt)
      return previous
    }
    const reusable = baseline ? run.parent.baselineEvidence[partition] : undefined
    if (reusable) {
      const evidence = validateModelEvidence(await this.store.readJson(reusable))
      if (evidence.evidenceKey === evidenceKey && evidence.complete) {
        await this.store.transaction(id, transactionState => { transactionState.runs[runId]!.evaluationIntents[intentId] = { key: evidenceKey, evidenceRef: reusable } })
        return evidence
      }
    }
    // An attempt retains its original connection even after the model's latest
    // deployment record advances. A dead instance never silently changes it.
    let attempt = intent?.attempts?.at(-1)
    let binding = attempt ? await this.store.readJson<T.ReadyEvaluationEndpointBinding>(attempt.bindingRef) : undefined
    if (binding && attempt && this.evaluator.reconcileEvidence) {
      const reconciled = await this.evaluator.reconcileEvidence(modelEvaluationRequest(state.spec, model, modelRef, partition, binding), `${id}/${evidenceKey}`)
      if (reconciled) {
        const evidence = validateModelEvidence(reconciled, modelEvaluationRequest(state.spec, model, modelRef, partition, binding))
        for (const valid of previous?.trials.filter(trial => trial.valid) ?? []) requireContract(evidence.trials.some(trial => digestJson(trial) === digestJson(valid)),
          'valid-slot-rerun', 'terminal reconciliation must preserve every valid observation')
        const evidenceRef = await this.store.putJson(evidence)
        await this.store.transaction(id, async current => {
          const currentRun = current.runs[runId]!, saved = currentRun.evaluationIntents[intentId]!
          await chargeEvaluationUsage(this.store, current, runId, intentId, evidence.schemaVersion === 2 ? evidence : { gpuSeconds: evidence.gpuSeconds, gpuSecondsSource: 'historical-owned-service' })
          const physical = saved.attempts!.find(item => item.id === attempt!.id)!
          physical.evidenceRef = evidenceRef; physical.status = 'terminal'
          if (saved.attempts!.at(-1)!.id === physical.id) {
            saved.evidenceRef = evidenceRef
            currentRun.evaluationTasksCompleted = true
            if (baseline && evidence.complete && current.champion.modelRef.digest === modelRef.digest) current.champion.baselineEvidence[partition] = evidenceRef
          }
        })
        await this.releaseEvaluationConsumer(id, runId, intentId, attempt)
        if (evidence.complete) {
          requireContract((await this.inspect(id, runId)).evaluationIntents[intentId]!.attempts!.at(-1)!.id === attempt.id,
            'evaluation-control-stale', 'a newer physical evaluation attempt owns the logical result')
          return evidence
        }
        previous = evidence
        state = await this.store.load(id); run = state.runs[runId]!; intent = run.evaluationIntents[intentId]!
        attempt = intent.attempts!.at(-1)!
      }
    }
    if (binding && state.spec.endpointPreparation) {
      const observed = await this.endpointPreparer!.observe!(binding, this.endpointContext(state, runId))
      if (!observed) {
        if (attempt!.status !== 'terminal') {
          await this.store.transaction(id, current => { setEvaluationControl(current.runs[runId]!, 'pause') })
          run = await this.inspect(id, runId)
          requireContract(this.evaluator.cancel, 'evaluation-cancel-unavailable', 'a dead deployment requires confirmed termination of its original tasks')
          const stopped = await this.evaluator.cancel(modelEvaluationRequest(state.spec, model, modelRef, partition, binding), `${id}/${evidenceKey}`, evaluationControlIntent(run))
          await this.store.transaction(id, current => chargeEvaluationUsage(this.store, current, runId, intentId, stopped))
          requireContract(stopped.tasksCompleted, 'evaluation-release-pending', 'original evaluation tasks must end before deploying a replacement instance')
          await this.store.transaction(id, current => {
            current.runs[runId]!.evaluationIntents[intentId]!.attempts!.at(-1)!.status = 'terminal'
            current.runs[runId]!.evaluationTasksCompleted = true
          })
        }
        await this.releaseEvaluationConsumer(id, runId, intentId, attempt!)
        const retired = await this.endpointPreparer!.retire!(binding, this.endpointContext(await this.store.load(id), runId))
        requireContract(retired.status === 'released', 'inference-release-pending', retired.reason ?? 'the old deployment incarnation must confirm release before repair')
        const attempts = intent!.attempts!.length
        requireContract(attempts < (state.spec.iteration?.recovery.maxEvaluationAttempts ?? 1), 'evaluation-attempt-budget-exhausted', 'the frozen deployment repair attempt budget is exhausted')
        await this.store.transaction(id, current => { setEvaluationControl(current.runs[runId]!, 'start') })
        binding = undefined
      } else {
        requireContract(digestJson(observed) === digestJson(binding), 'evaluation-binding-drift', 'observation must retain the same frozen deployment incarnation')
      }
    }
    if (attempt?.status === 'terminal') await this.releaseEvaluationConsumer(id, runId, intentId, attempt)
    binding ??= await this.prepareEndpoint(id, runId, model, modelRef)
    const request = modelEvaluationRequest(state.spec, model, modelRef, partition, binding)
    const bindingRef = await this.store.putJson(binding)
    const attemptId = evaluationAttemptId(binding)
    await this.store.transaction(id, transactionState => {
      const currentRun = transactionState.runs[runId]!
      requireContract(!['pausing', 'paused'].includes(currentRun.execution), 'training-run-paused', 'a paused run cannot admit another evaluation')
      if (!currentRun.evaluationIntents[intentId]) {
        if (partition === 'held-out' && !baseline) {
          const used = Object.values(transactionState.runs).reduce((sum, item) => sum + item.heldOutQueries, 0)
          requireContract(used < transactionState.spec.evaluation.policy.maxHeldOutEvaluations, 'held-out-budget-exhausted', 'the sealed held-out query budget is exhausted')
          currentRun.heldOutQueries++
        }
        currentRun.evaluationIntents[intentId] = { key: evidenceKey }
      }
      requireContract(currentRun.evaluationIntents[intentId]!.key === evidenceKey, 'evaluation-intent-drift', 'evaluation intent identity changed')
      const attempts = currentRun.evaluationIntents[intentId]!.attempts ??= []
      if (attempts.at(-1)?.id !== attemptId) {
        requireContract(!attempts.length || attempts.at(-1)!.status === 'terminal', 'evaluation-attempt-active', 'finish the old deployment attempt before admitting another')
        requireContract(attempts.length < (transactionState.spec.iteration?.recovery.maxEvaluationAttempts ?? 1), 'evaluation-attempt-budget-exhausted', 'the frozen deployment repair attempt budget is exhausted')
        attempts.push({ id: attemptId, ...(attempts.length ? { parentId: attempts.at(-1)!.id } : {}), bindingRef, status: 'active', consumerGeneration: 0 })
      } else {
        const current = attempts.at(-1)!
        if (current.status === 'terminal') current.consumerGeneration = (current.consumerGeneration ?? 0) + 1
        current.status = 'active'
      }
      currentRun.evaluationTasksCompleted = false
      if (transactionState.spec.endpointPreparation) currentRun.inferenceResourcesReleased = false
    })
    state = await this.store.load(id); run = state.runs[runId]!
    intent = run.evaluationIntents[intentId]!
    attempt = intent.attempts!.at(-1)!
    if (state.spec.endpointPreparation) await this.endpointPreparer!.acquireConsumer!(binding,
      { id: this.consumerId(runId, intentId, attempt), experimentId: id, runId, evaluationKey: `${id}/${evidenceKey}` }, this.endpointContext(state, runId))
    const evidence = validateModelEvidence(await this.evaluator.evaluate(request, `${id}/${evidenceKey}`, evaluationControlIntent(run),
      { id: attempt.id, ...(attempt.parentId ? { parentId: attempt.parentId } : {}) }), request)
    if (previous) {
      requireContract(previous.gpuSeconds === null || evidence.gpuSeconds !== null && evidence.gpuSeconds >= previous.gpuSeconds, 'evaluation-usage-regression', 'repair must retain cumulative evaluation cost')
      for (const valid of previous.trials.filter(t => t.valid)) requireContract(evidence.trials.some(t => digestJson(t) === digestJson(valid)),
        'valid-slot-rerun', 'evaluation repair cannot replace a valid observation, including reward zero')
    }
    const evidenceRef = await this.store.putJson(evidence)
    await this.store.transaction(id, async transactionState => {
      const currentRun = transactionState.runs[runId]!
      const saved = currentRun.evaluationIntents[intentId]!
      await chargeEvaluationUsage(this.store, transactionState, runId, intentId, evidence.schemaVersion === 2 ? evidence : { gpuSeconds: evidence.gpuSeconds, gpuSecondsSource: 'historical-owned-service' })
      const currentAttempt = saved.attempts!.find(item => item.id === attempt!.id)!
      currentAttempt.status = 'terminal'; currentAttempt.evidenceRef = evidenceRef
      if (saved.attempts!.at(-1)!.id === currentAttempt.id) {
        saved.evidenceRef = evidenceRef
        currentRun.evaluationTasksCompleted = true
        if (baseline && evidence.complete && transactionState.champion.modelRef.digest === modelRef.digest) transactionState.champion.baselineEvidence[partition] = evidenceRef
      }
    })
    await this.releaseEvaluationConsumer(id, runId, intentId, attempt)
    requireContract((await this.inspect(id, runId)).evaluationIntents[intentId]!.attempts!.at(-1)!.id === attempt.id,
      'evaluation-control-stale', 'a newer physical evaluation attempt owns the logical result')
    requireContract(evidence.complete, 'incomplete-evaluation', 'evaluation has missing or invalid slots; valid failures are retained and cannot be rerun')
    return evidence
  }

  private consumerId(runId: string, intentId: string, attempt: T.ModelEvaluationAttempt): string { return `${runId}/${intentId}/${attempt.id}/${attempt.consumerGeneration ?? 0}` }
  private async releaseEvaluationConsumer(id: string, runId: string, intentId: string, attempt: T.ModelEvaluationAttempt): Promise<void> {
    const state = await this.store.load(id)
    if (!state.spec.endpointPreparation) return
    const binding = await this.store.readJson<T.ReadyEvaluationEndpointBinding>(attempt.bindingRef)
    await this.endpointPreparer!.releaseConsumer!(binding, this.consumerId(runId, intentId, attempt), this.endpointContext(state, runId))
  }

  private async validateArtifacts(run: T.ModelTrainingRun, artifacts: T.TrainingArtifacts): Promise<void> {
    requireContract(digestJson(artifacts.handle) === digestJson(run.handle), 'job-artifacts-mismatch', 'artifacts belong to another job')
    const model = parseModelVersion(artifacts.model)
    const parent = run.request.parentModel
    requireContract(model.parentModelVersionId === parent.id && model.trainingRunId === run.id && model.trainerCheckpointRef?.digest === artifacts.checkpointRef.digest,
      'candidate-lineage-mismatch', 'candidate must descend from the frozen parent and completed trainer checkpoint')
    for (const key of ['architecture', 'dtype', 'tokenizerDigest', 'chatTemplateDigest'] as const) requireContract(model[key] === parent[key], 'candidate-semantics-drift', `candidate changed ${key}`)
    const checkpoint = parseTrainerCheckpoint(await this.store.readJson(artifacts.checkpointRef))
    requireContract(checkpoint.actorWeightsDigest === model.weightsDigest && checkpoint.hfExportRef.digest === model.hfSnapshotRef.digest
      && checkpoint.compatibilityDigest === trainingCompatibilityDigest(run.request), 'export-checkpoint-mismatch', 'HF export, actor and optimizer must describe one committed update')
    let baseUpdate = 0
    if (run.request.resumeCheckpointRef) baseUpdate = parseTrainerCheckpoint(await this.store.readJson(run.request.resumeCheckpointRef)).committedUpdate
    requireContract(artifacts.updateCommitRefs.length === run.request.trainer.updatesPerCandidate && checkpoint.committedUpdate === baseUpdate + artifacts.updateCommitRefs.length,
      'incomplete-updates', 'candidate must include each configured complete update')
    const offlineData = run.request.offlineTraining ? await readOfflineDataset(this.store, run.request.offlineTraining.datasetRef,
      run.request.parentModel, run.request.trainDataset, run.request.offlineTraining.maxSequenceTokens) : undefined
    const batches = new Set<string>()
    let previous: T.ContentRef | undefined
    for (const [i, ref] of artifacts.updateCommitRefs.entries()) {
      const commit = parseUpdateCommit(await this.store.readJson(ref))
      requireContract(commit.trainingRunId === run.id && commit.committedUpdate === baseUpdate + i + 1 && !batches.has(commit.consumedBatchDigest)
        && (i === 0 || commit.previousCommitRef?.digest === previous!.digest), 'invalid-update-ledger', 'update ledger has a duplicate batch, gap or wrong run')
      const committedCheckpoint = parseTrainerCheckpoint(await this.store.readJson(commit.checkpointRef))
      requireContract(committedCheckpoint.committedUpdate === commit.committedUpdate && committedCheckpoint.schedulerAndRngRef.digest === commit.rngRef.digest && committedCheckpoint.dataCursorRef.digest === commit.dataCursorRef.digest
        && committedCheckpoint.compatibilityDigest === checkpoint.compatibilityDigest, 'invalid-update-commit', 'checkpoint, RNG and data cursor must advance atomically')
      for (const content of [committedCheckpoint.hfExportRef, committedCheckpoint.actorStateRef, committedCheckpoint.optimizerStateRef, committedCheckpoint.schedulerAndRngRef, committedCheckpoint.dataCursorRef]) await this.store.readBytes(content)
      const batch = parseTrainingBatch(await this.store.readJson({ uri: `cas:${commit.consumedBatchDigest}`, digest: commit.consumedBatchDigest, mediaType: 'application/json' }))
      requireContract(batch.trainingRunId === run.id && batch.recipeDigest === run.request.recipeDigest && batch.datasetSplitDigest === run.request.datasetSplitDigest,
        'batch-provenance-mismatch', 'consumed batch differs from the frozen recipe or data partition')
      if (batch.schemaVersion === 3) await validateOfflineBatch(this.store, batch, run.request, committedCheckpoint, offlineData)
      else {
        requireContract(!run.request.offlineTraining, 'batch-recipe-mismatch', 'SFT cannot consume online trajectory batches')
        await this.store.readBytes(batch.groupsRef)
        await this.store.readBytes(batch.samplesRef)
      }
      batches.add(commit.consumedBatchDigest)
      previous = ref
      if (i === artifacts.updateCommitRefs.length - 1) requireContract(commit.checkpointRef.digest === artifacts.checkpointRef.digest, 'final-checkpoint-mismatch', 'candidate checkpoint is not the final committed update')
    }
    const validation = await this.store.readJson<Record<string, unknown>>(artifacts.exportValidationRef)
    requireContract(validation.schemaVersion === 1 && validation.valid === true && validation.weightsDigest === model.weightsDigest
      && validation.hfSnapshotDigest === model.hfSnapshotRef.digest && validation.checkpointDigest === artifacts.checkpointRef.digest,
    'export-not-validated', 'HF export integrity and actor-weight equality must be proven before evaluation')
    await this.store.readBytes(model.provenanceRef)
  }

  private async finish(id: string, runId: string, decision: T.ModelDecision, allowPaused = false): Promise<void> {
    const current = await this.inspect(id, runId)
    let finishing = current
    if (terminal(current) || !allowPaused && ['pausing', 'paused'].includes(current.execution)) return
    if (!current.resourcesReleased && current.handle) {
      const stopping = await this.store.transaction(id, transactionState => {
        const currentRun = transactionState.runs[runId]!
        requireContract(sameTrainingControl(currentRun, current), 'training-control-stale', 'a newer command owns training cleanup')
        setTrainingControl(currentRun, 'pause')
        return structuredClone(currentRun)
      })
      const status = await this.stopTrainer(stopping)
      await this.recordStatus(id, runId, status, true, stopping)
      finishing = stopping
      requireContract(status.resourcesReleased, 'training-release-pending', 'waiting for the original trainer to release its GPU ownership')
    }
    requireContract(await this.retireEndpoints(id), 'inference-release-pending', 'owned inference resources must confirm release before round finalization')
    await this.store.transaction(id, state => {
      const run = state.runs[runId]!
      if (!sameTrainingControl(run, finishing)) return
      if (terminal(run) || !allowPaused && ['pausing', 'paused'].includes(run.execution)) return
      requireContract(run.evaluationTasksCompleted && run.resourcesReleased, 'task-cleanup-pending', 'finalization requires evaluation tasks to end and training resources to release')
      if (state.usage.gpuSeconds > state.spec.budgets.totalGpuSeconds || state.usage.rolloutTokens > state.spec.budgets.maxRolloutTokens || state.usage.groupResamples > state.spec.budgets.maxGroupResamples) {
        decision = { ...decision, outcome: 'rejected', reasons: [...decision.reasons, 'experiment-budget-exceeded'] }
      }
      if (decision.outcome === 'accepted') {
        if (state.champion.revision !== run.parent.revision || state.champion.modelRef.digest !== run.parent.modelRef.digest) {
          decision = { ...decision, outcome: 'superseded', reasons: [...decision.reasons, 'champion-cas-conflict'] }
        } else {
          const dev = run.evaluationIntents['candidate:dev']?.evidenceRef
          const held = run.evaluationIntents['candidate:held-out']?.evidenceRef
          requireContract(run.candidateRef && dev && held, 'missing-promotion-evidence', 'champion promotion requires both independent evaluations')
          state.champion = { modelRef: run.candidateRef, revision: run.parent.revision + 1, trainingRunId: runId, baselineEvidence: { dev, 'held-out': held } }
        }
      }
      run.decision = decision
      run.phase = decision.outcome === 'accepted' ? 'accepted' : decision.outcome === 'inconclusive' ? 'inconclusive' : 'rejected'
      run.execution = 'completed'
      delete run.error
    })
  }

  async pause(id: string, runId: string, preserveIterationIntent = false): Promise<T.ModelTrainingRun> {
    await this.assertCurrentExperiment(id)
    await this.store.transaction(id, transactionState => {
      const iteration = transactionState.iteration
      if (iteration && !preserveIterationIntent && iteration.status === 'running') {
        iteration.status = 'pausing'; iteration.control = { sequence: iteration.control.sequence + 1, action: 'pause' }
        delete iteration.recovery
      }
      if (transactionState.endpointControl) {
        const previous = transactionState.endpointControl
        previous.sequence = iteration?.control.sequence ?? previous.sequence + (previous.action === 'pause' ? 0 : 1)
        previous.action = iteration?.control.action ?? 'pause'
      }
      const currentRun = transactionState.runs[runId]!
      if (!terminal(currentRun)) {
        setTrainingControl(currentRun, 'pause')
        setEvaluationControl(currentRun, 'pause')
        currentRun.execution = 'pausing'
      }
    })
    let run = await this.inspect(id, runId)
    if (terminal(run)) return run
    const state = await this.store.load(id)
    const errors: unknown[] = []
    let trainingReleased = run.resourcesReleased
    let evaluationReleased = true
    try { await this.fenceEndpoints(id) } catch (error) { errors.push(error) }
    // A pending/disconnected evaluation cannot prevent cancellation of its
    // independent trainer. Reconcile and charge each owner before returning.
    try {
      if (run.request.schemaVersion === 2 && (run.handle || !run.resourcesReleased)) {
        const status = await this.stopTrainer(run)
        requireContract(status.handle.requestDigest === digestJson(run.request), 'job-request-mismatch', 'cancelled job request changed')
        await this.store.transaction(id, transactionState => {
          const currentRun = transactionState.runs[runId]!
          requireContract(!currentRun.handle || digestJson(currentRun.handle) === digestJson(status.handle), 'job-handle-conflict', 'cancellation returned another job')
          currentRun.handle = status.handle
        })
        await this.recordStatus(id, runId, status, false, run)
        trainingReleased = status.resourcesReleased && ['paused', 'completed', 'failed', 'interrupted'].includes(status.execution)
      } else if (!run.handle && !run.resourcesReleased) {
        const handle = parseTrainingHandle(await this.trainer.submit(run.request, run.idempotencyKey))
        requireContract(handle.requestDigest === digestJson(run.request), 'job-request-mismatch', 'reconciled job request changed')
        await this.store.transaction(id, transactionState => { transactionState.runs[runId]!.handle = handle })
        run = await this.inspect(id, runId)
      }
      if (run.request.schemaVersion === 1 && run.handle && (!run.resourcesReleased || !run.artifactsRef)) {
        const status = parseTrainingStatus(await this.trainer.cancel(run.handle))
        await this.recordStatus(id, runId, status)
        trainingReleased = status.resourcesReleased && ['paused', 'completed', 'failed', 'interrupted'].includes(status.execution)
      }
    } catch (error) {
      trainingReleased = false
      errors.push(error)
    }
    for (const [intentId, intent] of Object.entries(run.evaluationIntents)) {
      try {
        const previous = intent.evidenceRef ? validateModelEvidence(await this.store.readJson(intent.evidenceRef)) : undefined
        if (previous?.complete) {
          for (const attempt of intent.attempts ?? []) await this.releaseEvaluationConsumer(id, runId, intentId, attempt)
          continue
        }
        await this.store.transaction(id, transactionState => { transactionState.runs[runId]!.evaluationTasksCompleted = false })
        requireContract(this.evaluator.cancel, 'evaluation-cancel-unavailable', 'pending evaluation must confirm cancellation before releasing this run')
        const [role, partition] = intentId.split(':') as [string, 'dev' | 'held-out']
        const modelRef = role === 'baseline' ? run.parent.modelRef : run.candidateRef!
        const model = parseModelVersion(await this.store.readJson(modelRef))
        const stopped = await this.evaluator.cancel(modelEvaluationRequest(state.spec, model, modelRef, partition, await savedEvaluationBinding(this.store, state, model, intentId, runId)), `${id}/${intent.key}`, evaluationControlIntent(run))
        await this.store.transaction(id, transactionState => chargeEvaluationUsage(this.store, transactionState, runId, intentId, stopped))
        evaluationReleased &&= stopped.tasksCompleted
        if (stopped.tasksCompleted) {
          await this.store.transaction(id, current => { for (const attempt of current.runs[runId]!.evaluationIntents[intentId]!.attempts ?? []) attempt.status = 'terminal' })
          for (const attempt of intent.attempts ?? []) await this.releaseEvaluationConsumer(id, runId, intentId, attempt)
        }
      } catch (error) {
        evaluationReleased = false
        errors.push(error)
      }
    }
    await this.store.transaction(id, transactionState => {
      const currentRun = transactionState.runs[runId]!
      if (!sameTrainingControl(currentRun, run)) return
      currentRun.evaluationTasksCompleted = evaluationReleased
      if (trainingReleased && evaluationReleased && !errors.length) {
        currentRun.execution = 'paused'
        currentRun.resourcesReleased = true
      }
    })
    if (errors.length && sameTrainingControl(await this.inspect(id, runId), run)) throw errors[0]
    return this.inspect(id, runId)
  }
  async resume(id: string, runId: string): Promise<T.ModelTrainingRun> {
    await this.assertCurrentExperiment(id)
    if ((await this.inspect(id, runId)).execution === 'pausing') await this.pause(id, runId)
    await this.store.transaction(id, transactionState => {
      requireContract(!transactionState.iteration || transactionState.iteration.status === 'running'
        && transactionState.iteration.control.action === 'start', 'iteration-paused', 'resume the experiment before resuming its round')
      if (transactionState.endpointControl && !transactionState.iteration) {
        transactionState.endpointControl.sequence++
        transactionState.endpointControl.action = 'start'
      }
      const currentRun = transactionState.runs[runId]!
      requireContract(currentRun && !terminal(currentRun), 'run-not-resumable', 'completed model run cannot resume')
      if (!currentRun.artifactsRef && currentRun.status?.execution !== 'completed') requireContract(transactionState.usage.gpuSeconds < transactionState.spec.budgets.totalGpuSeconds, 'budget-exhausted', 'cannot resume training after its GPU budget is exhausted')
      requireContract(currentRun.execution !== 'pausing', 'previous-resources-not-released', 'finish the pending pause before resuming')
      setTrainingControl(currentRun, 'start', currentRun.execution !== 'running')
      setEvaluationControl(currentRun, 'start', currentRun.execution !== 'running')
      currentRun.execution = 'running'
      delete currentRun.error
    })
    const run = await this.inspect(id, runId)
    // V2 resumes with a newer ordered intent; v1 retains its original submit API.
    if (run.handle && !run.artifactsRef) {
      const handle = await this.submitTrainer(run)
      requireContract(digestJson(handle) === digestJson(run.handle), 'resume-handle-mismatch', 'resume must retain the original job identity')
    }
    return this.advance(id, runId)
  }
  async close(id: string, runId: string, reason = 'closed-by-user', preserveIterationIntent = false): Promise<T.ModelTrainingRun> {
    const run = await this.pause(id, runId, preserveIterationIntent)
    if (terminal(run)) return run
    requireContract(run.resourcesReleased && run.evaluationTasksCompleted && run.execution === 'paused', 'task-cleanup-pending', 'wait for evaluation tasks to end and training GPU release before closing the run')
    await this.finish(id, runId, { outcome: 'inconclusive', reasons: [reason] }, true)
    return this.inspect(id, runId)
  }

  async publish(id: string, publisher: ModelPublisher, rollbackReleaseId?: string): Promise<T.ModelRelease> {
    const intent = await this.store.transaction(id, transactionState => {
      if (transactionState.activationIntent) {
        requireContract(transactionState.activationIntent.rollbackReleaseId === rollbackReleaseId, 'activation-pending', 'reconcile the pending activation before choosing a different release')
        return transactionState.activationIntent
      }
      const old = rollbackReleaseId ? transactionState.releases.find(release => release.id === rollbackReleaseId) : undefined
      requireContract(!rollbackReleaseId || old, 'unknown-release', 'rollback requires an existing sealed release')
      const modelRef = old?.modelRef ?? transactionState.champion.modelRef
      transactionState.activationIntent = { id: `activation_${randomUUID().replaceAll('-', '')}`, modelRef, expectedReleaseId: transactionState.activeReleaseId ?? null,
        ...(rollbackReleaseId ? { rollbackReleaseId } : {}) }
      return structuredClone(transactionState.activationIntent)
    })
    const model = parseModelVersion(await this.store.readJson(intent.modelRef))
    const activated = await publisher.activate(model, intent.id)
    requireContract(activated.active === true && activated.activationId === intent.id && activated.modelVersionId === model.id, 'activation-unconfirmed', 'release remains unchanged until activation is confirmed')
    return this.store.transaction(id, transactionState => {
      const existing = transactionState.releases.find(release => release.activationId === intent.id)
      if (existing) return existing
      requireContract(transactionState.activationIntent?.id === intent.id && (transactionState.activeReleaseId ?? null) === intent.expectedReleaseId, 'release-cas-conflict', 'active release changed during activation')
      const release: T.ModelRelease = { id: `release_${randomUUID().replaceAll('-', '')}`, modelRef: intent.modelRef, activatedAt: new Date().toISOString(),
        activationId: intent.id, ...(transactionState.activeReleaseId ? { previousReleaseId: transactionState.activeReleaseId } : {}) }
      transactionState.releases.push(release)
      transactionState.activeReleaseId = release.id
      delete transactionState.activationIntent
      return release
    })
  }
}
