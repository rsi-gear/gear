import { randomUUID } from 'node:crypto'
import { digestJson } from './digest.js'
import { trainEvaluationMode } from './deployment.js'
import { decideModel, devGate, modelEvaluationRequest, modelEvidenceKey, pairModelEvidence, validateModelEvidence } from './evaluation.js'
import { parseModelTrainingSpec, parseModelVersion, parseTrainerCheckpoint, parseTrainingArtifacts, parseTrainingBatch, parseTrainingCapabilities, parseTrainingHandle, parseTrainingRequest, parseTrainingStatus, parseUpdateCommit, requireContract } from './schema.js'
import { ModelTrainingStore } from './store.js'
import type * as T from './types.js'
import { evaluationControlIntent, sameTrainingControl, setEvaluationControl, setTrainingControl, trainingControlIntent } from './training-control.js'
import { chargeEvaluationUsage, refreshEvaluationUsage } from './evaluation-usage.js'

const emptyUsage = (): T.TrainingUsage => ({ gpuSeconds: 0, rolloutTokens: 0, groupResamples: 0 })
const terminal = (run: T.ModelTrainingRun): boolean => !!run.decision
export const trainingCompatibilityDigest = (request: T.TrainingRequest): string => digestJson({
  backend: request.trainer.backend, runtimeLock: request.trainer.runtimeLock, hyperparametersRef: request.trainer.hyperparametersRef,
  placement: request.trainer.placement ?? 'separate', trainingDeviceCount: request.trainingDevices.length,
  referenceModelRef: request.referenceModelRef, architecture: request.parentModel.architecture, dtype: request.parentModel.dtype,
  tokenizerDigest: request.parentModel.tokenizerDigest, chatTemplateDigest: request.parentModel.chatTemplateDigest,
  ...(request.schemaVersion === 2 ? { deployment: request.deployment, trainingDevices: request.trainingDevices } : {}),
})
export interface ModelPublisher {
  /** Must reconcile the same activation id after an uncertain result. New episodes only. */
  activate(model: T.ModelVersion, activationId: string): Promise<{ activationId: string; modelVersionId: string; active: true }>
}

export class ModelTrainingCoordinator {
  constructor(readonly store: ModelTrainingStore, readonly trainer: T.ModelTrainer, readonly evaluator: T.ModelEvaluator) {}

  async createExperiment(input: unknown): Promise<T.ModelExperimentState> {
    const spec = parseModelTrainingSpec(input)
    const initial = parseModelVersion(await this.store.readJson(spec.initialModel))
    const reference = parseModelVersion(await this.store.readJson(spec.referenceModel))
    requireContract(initial.architecture === reference.architecture && initial.dtype === reference.dtype
      && initial.tokenizerDigest === reference.tokenizerDigest && initial.chatTemplateDigest === reference.chatTemplateDigest,
    'reference-incompatible', 'reference and actor must use the same model and token semantics')
    // Resolve immutable control inputs now, not after a job has started.
    for (const ref of [spec.fixedHarness.manifestRef, spec.verifier, spec.trainer.hyperparametersRef,
      ...Object.values(spec.datasets).flatMap(d => [d.snapshotRef, ...d.tasks.flatMap(t => [t.taskRef, t.environmentRef])])]) await this.store.readBytes(ref)
    const state: T.ModelExperimentState = { schemaVersion: 1, id: `exp_${randomUUID().replaceAll('-', '')}`,
      spec, specDigest: digestJson(spec), champion: { modelRef: spec.initialModel, revision: 0, baselineEvidence: {} }, runs: {}, releases: [], usage: emptyUsage() }
    await this.store.create(state)
    return state
  }

  async admit(experimentId: string): Promise<T.ModelTrainingRun> {
    return this.store.transaction(experimentId, async state => {
      requireContract(!Object.values(state.runs).some(currentRun => !terminal(currentRun)), 'training-run-active', 'finish or close the existing training run before admitting another')
      const parentModel = parseModelVersion(await this.store.readJson(state.champion.modelRef))
      const spec = state.spec
      requireContract(state.usage.gpuSeconds < spec.budgets.totalGpuSeconds && state.usage.rolloutTokens < spec.budgets.maxRolloutTokens,
        'budget-exhausted', 'experiment training budget is exhausted')
      const id = `train_${randomUUID().replaceAll('-', '')}`
      const request = parseTrainingRequest({ schemaVersion: spec.schemaVersion, ...(spec.schemaVersion === 2 ? { deployment: spec.deployment } : {}), trainingRunId: id, experimentId, parentModel, parentModelRef: state.champion.modelRef,
        referenceModelRef: spec.referenceModel, ...(parentModel.trainerCheckpointRef ? { resumeCheckpointRef: parentModel.trainerCheckpointRef } : {}),
        coldStart: !parentModel.trainerCheckpointRef, fixedHarness: spec.fixedHarness, trainDataset: spec.datasets.train, verifier: spec.verifier,
        trainer: spec.trainer, rollout: spec.rollout, trainingDevices: spec.resources.trainingDevices,
        budgets: { ...spec.budgets, totalGpuSeconds: spec.budgets.totalGpuSeconds - state.usage.gpuSeconds,
          maxRolloutTokens: spec.budgets.maxRolloutTokens - state.usage.rolloutTokens,
          maxGroupResamples: Math.max(0, spec.budgets.maxGroupResamples - state.usage.groupResamples) },
        recipeDigest: digestJson({ trainer: spec.trainer, rollout: spec.rollout, verifier: spec.verifier, referenceModelRef: spec.referenceModel,
          ...(spec.schemaVersion === 2 ? { deployment: spec.deployment } : {}) }),
        datasetSplitDigest: digestJson(spec.datasets),
      })
      if (request.resumeCheckpointRef) {
        const checkpoint = parseTrainerCheckpoint(await this.store.readJson(request.resumeCheckpointRef))
        requireContract(checkpoint.actorWeightsDigest === parentModel.weightsDigest && checkpoint.compatibilityDigest === trainingCompatibilityDigest(request),
          'checkpoint-incompatible', 'champion checkpoint weights or training compatibility differ')
      }
      const run: T.ModelTrainingRun = { schemaVersion: 1, id, parent: structuredClone(state.champion), request,
        idempotencyKey: `${experimentId}/${id}`, phase: 'admitted', execution: 'running', usage: emptyUsage(), resourcesReleased: true,
        heldOutQueries: 0, evaluationIntents: {}, evaluationResourcesReleased: true }
      if (spec.schemaVersion === 2) {
        const sequence = Math.max(-1, ...Object.values(state.runs).map(currentRun => evaluationControlIntent(currentRun).sequence)) + 1
        requireContract(Number.isSafeInteger(sequence), 'evaluation-control-overflow', 'evaluation control sequence is exhausted')
        run.evaluationControl = { schemaVersion: 2, sequence, action: 'start' }
      }
      state.runs[id] = run
      return structuredClone(run)
    })
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
    if (run.execution === 'pausing') return this.pause(id, runId)
    if (run.execution === 'paused') return run
    try {
      await refreshEvaluationUsage(this.store, this.evaluator, state, run)
      state = await this.store.load(id)
      if (state.spec.schemaVersion === 2) requireContract(state.usage.gpuSeconds < state.spec.budgets.totalGpuSeconds, 'budget-exhausted', 'experiment GPU budget is exhausted')
      if (!run.handle) {
        if (run.resourcesReleased) {
          // A pending baseline owns its evaluation GPU. Reconcile that same
          // intent before requiring an idle training pool again.
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
        requireContract(trainEvaluationMode(state.spec) !== 'sequential' || artifacts.resourcesReleased, 'gpu-not-released', 'training must confirm process termination and GPU release before evaluation')
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
        if (metered.spec.schemaVersion === 2 && metered.usage.gpuSeconds >= metered.spec.budgets.totalGpuSeconds) {
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
      if (error instanceof Error && 'code' in error && ['evaluation-pending', 'training-release-pending', 'training-run-paused', 'training-control-stale', 'eval_control_stale'].includes(String(error.code))) {
        await this.store.transaction(id, transactionState => {
          const currentRun = transactionState.runs[runId]!
          if (!terminal(currentRun) && !['pausing', 'paused'].includes(currentRun.execution)) {
            currentRun.execution = 'running'
            delete currentRun.error
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
    const required = ['trainingExternalBinding', 'exactPolicyTokens', 'policyFencing', 'durableIdempotency', 'checkpointEveryUpdate', 'immutableHfExport'] as const
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

  private async evaluate(id: string, runId: string, model: T.ModelVersion, modelRef: T.ContentRef, partition: 'dev' | 'held-out', baseline: boolean): Promise<T.ModelEvaluationEvidence> {
    const state = await this.store.load(id)
    const run = state.runs[runId]!
    requireContract(!['pausing', 'paused'].includes(run.execution), 'training-run-paused', 'a paused run cannot dispatch another evaluation')
    const request = modelEvaluationRequest(state.spec, model, modelRef, partition)
    const evidenceKey = modelEvidenceKey({ subject: request.subject, condition: request.condition })
    const intentId = `${baseline ? 'baseline' : 'candidate'}:${partition}`
    const intent = run.evaluationIntents[intentId]
    const previous = intent?.evidenceRef ? validateModelEvidence(await this.store.readJson(intent.evidenceRef), request) : undefined
    if (previous?.complete) return previous
    const reusable = baseline ? run.parent.baselineEvidence[partition] : undefined
    if (reusable) {
      const evidence = validateModelEvidence(await this.store.readJson(reusable), request)
      requireContract(evidence.complete, 'baseline-reuse-blocked', 'saved baseline is incomplete; explicitly repair its missing or invalid slots')
      await this.store.transaction(id, transactionState => { transactionState.runs[runId]!.evaluationIntents[intentId] = { key: evidenceKey, evidenceRef: reusable } })
      return evidence
    }
    if (state.spec.schemaVersion === 2) requireContract(state.usage.gpuSeconds < state.spec.budgets.totalGpuSeconds, 'budget-exhausted', 'evaluation exhausted the experiment GPU budget')
    if (state.spec.schemaVersion === 2) requireContract(this.evaluator.observeUsage, 'evaluation-usage-unavailable', 'v2 evaluator must expose read-only cumulative GPU usage')
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
      currentRun.evaluationResourcesReleased = false
    })
    const evidence = validateModelEvidence(await this.evaluator.evaluate(request, `${id}/${evidenceKey}`, state.spec.schemaVersion === 2 ? evaluationControlIntent(run) : undefined), request)
    if (previous) {
      requireContract(evidence.gpuSeconds >= previous.gpuSeconds, 'evaluation-usage-regression', 'repair must retain cumulative evaluation cost')
      for (const valid of previous.trials.filter(t => t.valid)) requireContract(evidence.trials.some(t => digestJson(t) === digestJson(valid)),
        'valid-slot-rerun', 'evaluation repair cannot replace a valid observation, including reward zero')
    }
    const evidenceRef = await this.store.putJson(evidence)
    await this.store.transaction(id, async transactionState => {
      const currentRun = transactionState.runs[runId]!
      const saved = currentRun.evaluationIntents[intentId]!
      await chargeEvaluationUsage(this.store, transactionState, runId, intentId, evidence.gpuSeconds)
      saved.evidenceRef = evidenceRef
      currentRun.evaluationResourcesReleased = true
      if (baseline && evidence.complete && transactionState.champion.modelRef.digest === modelRef.digest) transactionState.champion.baselineEvidence[partition] = evidenceRef
    })
    requireContract(evidence.complete, 'incomplete-evaluation', 'evaluation has missing or invalid slots; valid failures are retained and cannot be rerun')
    return evidence
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
      await this.store.readBytes(batch.groupsRef)
      await this.store.readBytes(batch.samplesRef)
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
    await this.store.transaction(id, state => {
      const run = state.runs[runId]!
      if (!sameTrainingControl(run, finishing)) return
      if (terminal(run) || !allowPaused && ['pausing', 'paused'].includes(run.execution)) return
      requireContract(run.evaluationResourcesReleased && run.resourcesReleased, 'gpu-not-released', 'cannot finalize resource ownership without release confirmation')
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

  async pause(id: string, runId: string): Promise<T.ModelTrainingRun> {
    await this.store.transaction(id, transactionState => {
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
        if (previous?.complete) continue
        await this.store.transaction(id, transactionState => { transactionState.runs[runId]!.evaluationResourcesReleased = false })
        requireContract(this.evaluator.cancel, 'evaluation-cancel-unavailable', 'pending evaluation must confirm cancellation before releasing this run')
        const [role, partition] = intentId.split(':') as [string, 'dev' | 'held-out']
        const modelRef = role === 'baseline' ? run.parent.modelRef : run.candidateRef!
        const model = parseModelVersion(await this.store.readJson(modelRef))
        const stopped = await this.evaluator.cancel(modelEvaluationRequest(state.spec, model, modelRef, partition), `${id}/${intent.key}`, state.spec.schemaVersion === 2 ? evaluationControlIntent(run) : undefined)
        await this.store.transaction(id, transactionState => chargeEvaluationUsage(this.store, transactionState, runId, intentId, stopped.gpuSeconds))
        evaluationReleased &&= stopped.resourcesReleased
      } catch (error) {
        evaluationReleased = false
        errors.push(error)
      }
    }
    await this.store.transaction(id, transactionState => {
      const currentRun = transactionState.runs[runId]!
      if (!sameTrainingControl(currentRun, run)) return
      currentRun.evaluationResourcesReleased = evaluationReleased
      if (trainingReleased && evaluationReleased && !errors.length) {
        currentRun.execution = 'paused'
        currentRun.resourcesReleased = true
      }
    })
    if (errors.length && sameTrainingControl(await this.inspect(id, runId), run)) throw errors[0]
    return this.inspect(id, runId)
  }
  async resume(id: string, runId: string): Promise<T.ModelTrainingRun> {
    if ((await this.inspect(id, runId)).execution === 'pausing') await this.pause(id, runId)
    await this.store.transaction(id, transactionState => {
      const currentRun = transactionState.runs[runId]!
      requireContract(currentRun && !terminal(currentRun), 'run-not-resumable', 'completed model run cannot resume')
      if (transactionState.spec.schemaVersion === 2) requireContract(transactionState.usage.gpuSeconds < transactionState.spec.budgets.totalGpuSeconds, 'budget-exhausted', 'cannot resume after the experiment GPU budget is exhausted')
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
  async close(id: string, runId: string): Promise<T.ModelTrainingRun> {
    const run = await this.pause(id, runId)
    if (terminal(run)) return run
    requireContract(run.resourcesReleased && run.evaluationResourcesReleased && run.execution === 'paused', 'gpu-not-released', 'wait for cancellation and GPU release before closing the run')
    await this.finish(id, runId, { outcome: 'inconclusive', reasons: ['closed-by-user'] }, true)
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
