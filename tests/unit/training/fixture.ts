import { sealModelVersion } from '../../../src/training/schema.js'
import { digestJson } from '../../../src/training/digest.js'
import type * as T from '../../../src/training/types.js'
import { ModelTrainingStore } from '../../../src/training/store.js'
import { trainingCompatibilityDigest } from '../../../src/training/coordinator.js'
import { modelEvidenceKey } from '../../../src/training/evaluation.js'

export async function fixture(store: ModelTrainingStore): Promise<T.ModelTrainingSpecV1> {
  const ref = await store.putJson({ fixture: true })
  const model = sealModelVersion({ schemaVersion: 1, hfSnapshotRef: ref, weightsDigest: digestJson('initial-weights'),
    tokenizerDigest: ref.digest, chatTemplateDigest: ref.digest, architecture: 'TinyForCausalLM', dtype: 'float32', provenanceRef: ref })
  const modelRef = await store.putJson(model)
  const split = async (name: string): Promise<T.DatasetPartition> => ({ snapshotRef: await store.putJson({ split: name }), exactDataAuthorized: name === 'train',
    tasks: [{ id: name, family: name, taskRef: await store.putJson({ task: name }), environmentRef: ref }] })
  return { schemaVersion: 1, kind: 'model-training', name: 'CPU contract fixture', fixedHarness: { commit: '1'.repeat(40), manifestRef: ref, adapter: 'training-tool' },
    initialModel: modelRef, referenceModel: modelRef, datasets: { train: await split('train'), dev: await split('dev'), heldOut: await split('held') }, verifier: ref,
    trainer: { provider: 'slime', runtimeLock: { schemaVersion: 1, slimeCommit: '41014d1f29e201137fdffce737bb8bac65bc5219', hitchCommit: '2'.repeat(40),
      imageDigest: ref.digest, pythonVersion: '3.12', cudaVersion: 'fixture', pytorchVersion: 'fixture', megatronCommit: '3'.repeat(40), sglangVersion: 'fixture',
      bridgeDigest: ref.digest, protocolDigest: ref.digest, patchDigests: [], validation: 'validated', probeEvidenceRefs: [ref] },
      recipe: 'agent-grpo-v1', backend: 'megatron', hyperparametersRef: ref, updatesPerCandidate: 1, checkpointEveryUpdate: true,
      optimizerResetPolicy: 'initial-cold-start-only', rolloutBatchSize: 1, globalBatchSize: 4, dataParallelSize: 1 },
    rollout: { provider: 'hitch', mode: 'synchronous', groupSize: 4, maxPolicyLag: 0,
      sampling: { temperature: 1, topP: 1, topK: -1, repetitionPenalty: 1, maxNewTokens: 16, maxContextTokens: 128 },
      episodeFormat: 'linear-token-trajectory-v1', capture: 'exact-policy-tokens-v1', truncation: 'reject', zeroVarianceGroup: 'skip-with-bounded-resampling',
      compaction: false, subagents: false, auxiliaryModelCalls: false },
    evaluation: { provider: 'hitch-managed-local', topology: 'local-docker-harbor-dataset', samplingProfile: 'baseline',
      common: { runtimeDigest: ref.digest, protocolDigest: ref.digest, samplingDigest: ref.digest, budgetsDigest: ref.digest, attempts: 2 },
      policy: { minDevGain: .1, maxHeldOutRegression: 0, maxInferenceErrorRate: 0, requiredTaskIds: [], maxHeldOutEvaluations: 3 } },
    resources: { mode: 'sequential', trainingDevices: ['GPU-fixture', 'GPU-rollout-fixture'], evaluationDevices: ['GPU-fixture'] },
    budgets: { totalGpuSeconds: 100, maxRolloutTokens: 1000, maxEpisodeSteps: 4, maxGroupResamples: 2 }, publication: { mode: 'explicit' } }
}

export class FixtureTrainer implements T.ModelTrainer {
  submissions = 0
  requests: T.TrainingRequest[] = []
  released = true
  failSubmitOnce = false
  private request?: T.TrainingRequest
  private handle?: T.TrainingHandle
  private artifact?: T.TrainingArtifacts
  private commands = new Map<string, T.TrainingControlIntent>()
  constructor(private store: ModelTrainingStore) {}
  async preflight(r: T.TrainingRequest): Promise<T.TrainingCapabilities> { return { schemaVersion: 1, trainingExternalBinding: true, exactPolicyTokens: true,
    policyFencing: true, durableIdempotency: true, checkpointEveryUpdate: true, immutableHfExport: true, runtimeLockDigest: digestJson(r.trainer.runtimeLock), blockers: [] } }
  async submit(r: T.TrainingRequest): Promise<T.TrainingHandle> {
    if (!this.handle || this.handle.requestDigest !== digestJson(r) || !this.requests.some(previous => digestJson(previous) === digestJson(r))) {
      this.request = r; this.requests.push(r); this.submissions++
      this.handle = { schemaVersion: 1, provider: 'slime', jobId: r.trainingRunId, requestDigest: digestJson(r) }; delete this.artifact
    }
    if (this.failSubmitOnce) { this.failSubmitOnce = false; throw new Error('submit reply lost') }
    return this.handle
  }
  async inspect(h: T.TrainingHandle): Promise<T.TrainingStatus> { return { schemaVersion: 1, handle: h, phase: 'checkpointed', execution: 'completed', committedUpdate: 1,
    usage: { gpuSeconds: 1, rolloutTokens: 4, groupResamples: 0 }, resourcesReleased: this.released } }
  async cancel(h: T.TrainingHandle): Promise<T.TrainingStatus> { return { ...await this.inspect(h), execution: 'paused', resourcesReleased: true } }
  async control(r: T.TrainingRequest, key: string, intent: T.TrainingControlIntent): Promise<T.TrainingStatus> {
    const previous = this.commands.get(key)
    if (previous && (previous.sequence > intent.sequence || previous.sequence === intent.sequence && previous.action !== intent.action)) {
      throw Object.assign(new Error('a newer command fences this request'), { code: 'training-control-stale' })
    }
    this.commands.set(key, structuredClone(intent))
    if (intent.action === 'start') return this.inspect(await this.submit(r))
    this.request ??= r
    this.handle ??= { schemaVersion: 1, provider: 'slime', jobId: r.trainingRunId, requestDigest: digestJson(r) }
    const status = await this.cancel(this.handle)
    return this.submissions ? status : { ...status, committedUpdate: 0, usage: { gpuSeconds: 0, rolloutTokens: 0, groupResamples: 0 } }
  }
  async collect(h: T.TrainingHandle): Promise<T.TrainingArtifacts> {
    if (this.artifact) return this.artifact
    const r = this.request!
    const ref = await this.store.putJson({ fixture: 'checkpoint-state' })
    const hf = await this.store.putJson({ fixture: 'export', runId: r.trainingRunId })
    const weights = digestJson({ weights: r.trainingRunId })
    const base = r.resumeCheckpointRef ? (await this.store.readJson<T.TrainerCheckpoint>(r.resumeCheckpointRef)).committedUpdate : 0
    const cp: T.TrainerCheckpoint = { schemaVersion: 1, actorWeightsDigest: weights, hfExportRef: hf, actorStateRef: ref, optimizerStateRef: ref,
      schedulerAndRngRef: ref, dataCursorRef: ref, committedUpdate: base + 1, compatibilityDigest: trainingCompatibilityDigest(r) }
    const checkpointRef = await this.store.putJson(cp)
    const batchBody: Omit<T.TrainingBatchManifest, 'id'> = { schemaVersion: 1, trainingRunId: r.trainingRunId, policyVersion: 'fixture',
      recipeDigest: r.recipeDigest, datasetSplitDigest: r.datasetSplitDigest, groupsRef: ref, samplesRef: ref, sourceEvidenceDigest: ref.digest, state: 'sealed' }
    const batchRef = await this.store.putJson({ ...batchBody, id: digestJson(batchBody) })
    const commit: T.UpdateCommitManifest = { schemaVersion: 1, trainingRunId: r.trainingRunId, checkpointRef, consumedBatchDigest: batchRef.digest,
      committedUpdate: base + 1, rngRef: ref, dataCursorRef: ref }
    const model = sealModelVersion({ schemaVersion: 1, parentModelVersionId: r.parentModel.id, hfSnapshotRef: hf, weightsDigest: weights,
      tokenizerDigest: r.parentModel.tokenizerDigest, chatTemplateDigest: r.parentModel.chatTemplateDigest, architecture: r.parentModel.architecture,
      dtype: r.parentModel.dtype, trainingRunId: r.trainingRunId, trainerCheckpointRef: checkpointRef, provenanceRef: ref })
    this.artifact = { schemaVersion: 1, handle: h, model, checkpointRef, updateCommitRefs: [await this.store.putJson(commit)],
      exportValidationRef: await this.store.putJson({ schemaVersion: 1, valid: true, weightsDigest: weights, hfSnapshotDigest: hf.digest, checkpointDigest: checkpointRef.digest }),
      usage: { gpuSeconds: 1, rolloutTokens: 4, groupResamples: 0 }, resourcesReleased: this.released }
    return this.artifact
  }
}

export class FixtureEvaluator implements T.ModelEvaluator {
  calls: T.ModelEvaluationRequest[] = []
  candidateReward = 1
  heldOutReward = 1
  failOnce = false
  beforeReturn?: () => Promise<void>
  constructor(private store: ModelTrainingStore) {}
  async observeUsage(): Promise<{ gpuSeconds: number | null }> { return { gpuSeconds: 0 } }
  async evaluate(r: T.ModelEvaluationRequest): Promise<T.ModelEvaluationEvidence> {
    this.calls.push(r)
    if (this.failOnce) { this.failOnce = false; throw new Error('eval interrupted') }
    const reward = r.model.trainingRunId ? r.condition.partition === 'dev' ? this.candidateReward : this.heldOutReward : 0
    await this.beforeReturn?.()
    return { schemaVersion: 1, evalId: `eval-${this.calls.length}`, subject: r.subject, condition: r.condition,
      evidenceKey: modelEvidenceKey({ subject: r.subject, condition: r.condition }), hitchModelId: digestJson(r.model.id), inferenceLockRef: await this.store.putJson({ fixture: 'lock' }),
      trials: r.condition.slots.map((s, i) => ({ taskId: s.taskId, attempt: s.attempt, runId: `${this.calls.length}-run-${i}`, valid: true, reward, inferenceError: false })), complete: true, gpuSeconds: 0 }
  }
}
