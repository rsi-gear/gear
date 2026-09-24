import { digestJson } from './digest.js'
import { parseModelVersion, parseTrainerCheckpoint, parseTrainingArtifacts, parseTrainingBatch, parseTrainingCapabilities, parseUpdateCommit, requireContract } from './schema.js'
import type { TrainingContentStore } from './store.js'
import type * as T from './types.js'

/** Shared by legacy admission and standalone training operations. */
export const trainingCompatibilityDigest = (request: T.TrainingRequest): string => digestJson({
  backend: request.trainer.backend, runtimeLock: request.trainer.runtimeLock, hyperparametersRef: request.trainer.hyperparametersRef,
  placement: request.trainer.placement ?? 'separate', trainingDeviceCount: request.trainingDevices.length,
  referenceModelRef: request.referenceModelRef, architecture: request.parentModel.architecture, dtype: request.parentModel.dtype,
  tokenizerDigest: request.parentModel.tokenizerDigest, chatTemplateDigest: request.parentModel.chatTemplateDigest,
  ...(request.schemaVersion === 2 ? { deployment: request.deployment, trainingDevices: request.trainingDevices } : {}),
})

export async function validateTrainingReference(store: TrainingContentStore, parent: T.ModelVersion, referenceRef: T.ContentRef): Promise<T.ModelVersion> {
  const reference = parseModelVersion(await store.readJson(referenceRef))
  requireContract(parent.architecture === reference.architecture && parent.dtype === reference.dtype
    && parent.tokenizerDigest === reference.tokenizerDigest && parent.chatTemplateDigest === reference.chatTemplateDigest,
  'reference-incompatible', 'reference and actor must use the same model and token semantics')
  return reference
}

export async function validateTrainingResumeCheckpoint(store: TrainingContentStore, request: T.TrainingRequest): Promise<void> {
  if (!request.resumeCheckpointRef) return
  const checkpoint = parseTrainerCheckpoint(await store.readJson(request.resumeCheckpointRef))
  requireContract(checkpoint.actorWeightsDigest === request.parentModel.weightsDigest && checkpoint.compatibilityDigest === trainingCompatibilityDigest(request),
    'checkpoint-incompatible', 'champion checkpoint weights or training compatibility differ')
}

export async function preflightTrainingRequest(store: TrainingContentStore, trainer: T.ModelTrainer, request: T.TrainingRequest): Promise<void> {
  if (request.schemaVersion === 2) requireContract(trainer.control, 'training-control-unavailable', 'v2 training requires durable ordered start and pause commands')
  const capabilities = parseTrainingCapabilities(await trainer.preflight(request))
  const required = ['trainingExternalBinding', 'exactPolicyTokens', 'policyFencing', 'durableIdempotency', 'checkpointEveryUpdate', 'immutableHfExport'] as const
  requireContract(required.every(k => capabilities[k]) && capabilities.blockers.length === 0
    && capabilities.runtimeLockDigest === digestJson(request.trainer.runtimeLock),
  'training-preflight-blocked', `training capabilities unavailable: ${capabilities.blockers.join(', ') || required.filter(k => !capabilities[k]).join(', ') || 'runtime lock mismatch'}`)
  requireContract(request.trainer.runtimeLock.validation === 'validated', 'gpu-probes-pending', 'cloud GPU compatibility probes must pass before training submission')
  for (const probe of request.trainer.runtimeLock.probeEvidenceRefs) await store.readBytes(probe)
}

/** The full checkpoint, update-ledger, HF-export and batch-provenance gate. */
export async function validateTrainingArtifacts(store: TrainingContentStore, request: T.TrainingRequest, handle: T.TrainingHandle, input: unknown): Promise<T.TrainingArtifacts> {
  const artifacts = parseTrainingArtifacts(input)
  requireContract(digestJson(artifacts.handle) === digestJson(handle), 'job-artifacts-mismatch', 'artifacts belong to another job')
  const model = parseModelVersion(artifacts.model)
  const parent = request.parentModel
  requireContract(model.parentModelVersionId === parent.id && model.trainingRunId === request.trainingRunId && model.trainerCheckpointRef?.digest === artifacts.checkpointRef.digest,
    'candidate-lineage-mismatch', 'candidate must descend from the frozen parent and completed trainer checkpoint')
  for (const key of ['architecture', 'dtype', 'tokenizerDigest', 'chatTemplateDigest'] as const) requireContract(model[key] === parent[key], 'candidate-semantics-drift', `candidate changed ${key}`)
  const checkpoint = parseTrainerCheckpoint(await store.readJson(artifacts.checkpointRef))
  requireContract(checkpoint.actorWeightsDigest === model.weightsDigest && checkpoint.hfExportRef.digest === model.hfSnapshotRef.digest
    && checkpoint.compatibilityDigest === trainingCompatibilityDigest(request), 'export-checkpoint-mismatch', 'HF export, actor and optimizer must describe one committed update')
  let baseUpdate = 0
  if (request.resumeCheckpointRef) baseUpdate = parseTrainerCheckpoint(await store.readJson(request.resumeCheckpointRef)).committedUpdate
  requireContract(artifacts.updateCommitRefs.length === request.trainer.updatesPerCandidate && checkpoint.committedUpdate === baseUpdate + artifacts.updateCommitRefs.length,
    'incomplete-updates', 'candidate must include each configured complete update')
  const batches = new Set<string>()
  let previous: T.ContentRef | undefined
  for (const [i, ref] of artifacts.updateCommitRefs.entries()) {
    const commit = parseUpdateCommit(await store.readJson(ref))
    requireContract(commit.trainingRunId === request.trainingRunId && commit.committedUpdate === baseUpdate + i + 1 && !batches.has(commit.consumedBatchDigest)
      && (i === 0 || commit.previousCommitRef?.digest === previous!.digest), 'invalid-update-ledger', 'update ledger has a duplicate batch, gap or wrong run')
    const committedCheckpoint = parseTrainerCheckpoint(await store.readJson(commit.checkpointRef))
    requireContract(committedCheckpoint.committedUpdate === commit.committedUpdate && committedCheckpoint.schedulerAndRngRef.digest === commit.rngRef.digest && committedCheckpoint.dataCursorRef.digest === commit.dataCursorRef.digest
      && committedCheckpoint.compatibilityDigest === checkpoint.compatibilityDigest, 'invalid-update-commit', 'checkpoint, RNG and data cursor must advance atomically')
    for (const content of [committedCheckpoint.hfExportRef, committedCheckpoint.actorStateRef, committedCheckpoint.optimizerStateRef, committedCheckpoint.schedulerAndRngRef, committedCheckpoint.dataCursorRef]) await store.readBytes(content)
    const batch = parseTrainingBatch(await store.readJson({ uri: `cas:${commit.consumedBatchDigest}`, digest: commit.consumedBatchDigest, mediaType: 'application/json' }))
    requireContract(batch.trainingRunId === request.trainingRunId && batch.recipeDigest === request.recipeDigest && batch.datasetSplitDigest === request.datasetSplitDigest,
      'batch-provenance-mismatch', 'consumed batch differs from the frozen recipe or data partition')
    await store.readBytes(batch.groupsRef)
    await store.readBytes(batch.samplesRef)
    batches.add(commit.consumedBatchDigest)
    previous = ref
    if (i === artifacts.updateCommitRefs.length - 1) requireContract(commit.checkpointRef.digest === artifacts.checkpointRef.digest, 'final-checkpoint-mismatch', 'candidate checkpoint is not the final committed update')
  }
  const validation = await store.readJson<Record<string, unknown>>(artifacts.exportValidationRef)
  requireContract(validation.schemaVersion === 1 && validation.valid === true && validation.weightsDigest === model.weightsDigest
    && validation.hfSnapshotDigest === model.hfSnapshotRef.digest && validation.checkpointDigest === artifacts.checkpointRef.digest,
  'export-not-validated', 'HF export integrity and actor-weight equality must be proven before evaluation')
  await store.readBytes(model.provenanceRef)
  return artifacts
}
