import { digestJson } from './digest.js'
import { actorRolloutPlacement, gpuUuids, parseFrozenExecutionPlacement, parseNodeGpus } from './deployment.js'
import type * as T from './types.js'

export class TrainingContractError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'TrainingContractError' }
}
export function requireContract(ok: unknown, code: string, message: string): asserts ok {
  if (!ok) throw new TrainingContractError(code, message)
}

type Check = (value: unknown, path: string) => void
type Field = Check | { optional: Check }
const fail = (p: string, expected: string): never => { throw new TrainingContractError('invalid-contract', `${p}: expected ${expected}`) }
const str: Check = (v, p) => { if (typeof v !== 'string' || !v.trim() || /<[^>]+>/.test(v)) fail(p, 'non-placeholder string') }
const num: Check = (v, p) => { if (typeof v !== 'number' || !Number.isFinite(v)) fail(p, 'finite number') }
const nonnegative: Check = (v, p) => { num(v, p); if ((v as number) < 0) fail(p, 'non-negative number') }
const integer: Check = (v, p) => { nonnegative(v, p); if (!Number.isSafeInteger(v)) fail(p, 'safe integer') }
const positive: Check = (v, p) => { integer(v, p); if (v === 0) fail(p, 'positive integer') }
const bool: Check = (v, p) => { if (typeof v !== 'boolean') fail(p, 'boolean') }
const literal = (...values: unknown[]): Check => (v, p) => { if (!values.includes(v)) fail(p, JSON.stringify(values)) }
const pattern = (regex: RegExp): Check => (v, p) => { str(v, p); if (!regex.test(v as string)) fail(p, regex.source) }
const hash = pattern(/^sha256:[0-9a-f]{64}$/)
const commit = pattern(/^[0-9a-f]{40}$/)
const optional = (check: Check): Field => ({ optional: check })
const array = (check: Check, min = 0): Check => (v, p) => {
  if (!Array.isArray(v) || v.length < min) fail(p, `array of length >= ${min}`)
  ;(v as unknown[]).forEach((value, i) => check(value, `${p}[${i}]`))
}
const object = (fields: Record<string, Field>): Check => (v, p) => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(p, 'object')
  const record = v as Record<string, unknown>
  for (const k of Object.keys(record)) if (!(k in fields)) fail(`${p}.${k}`, 'known field')
  for (const [k, field] of Object.entries(fields)) {
    if (typeof field === 'function') field(record[k], `${p}.${k}`)
    else if (record[k] !== undefined) field.optional(record[k], `${p}.${k}`)
  }
}
const timestamp: Check = (v, p) => { str(v, p); if (!Number.isFinite(Date.parse(v as string))) fail(p, 'ISO timestamp') }
const ref = object({ uri: str, digest: hash, mediaType: str })
const version = literal(1)
const usage = object({ gpuSeconds: nonnegative, rolloutTokens: integer, groupResamples: integer })
const model = object({ schemaVersion: version, id: hash, parentModelVersionId: optional(hash), hfSnapshotRef: ref,
  weightsDigest: hash, tokenizerDigest: hash, chatTemplateDigest: hash, architecture: str, dtype: str,
  trainingRunId: optional(str), trainerCheckpointRef: optional(ref), provenanceRef: ref })
const checkpoint = object({ schemaVersion: version, actorWeightsDigest: hash, hfExportRef: ref, actorStateRef: ref,
  optimizerStateRef: ref, schedulerAndRngRef: ref, dataCursorRef: ref, committedUpdate: positive, compatibilityDigest: hash })
const updateCommit = object({ schemaVersion: version, trainingRunId: str, checkpointRef: ref, consumedBatchDigest: hash,
  committedUpdate: positive, rngRef: ref, dataCursorRef: ref, previousCommitRef: optional(ref), replayOfBatch: optional(hash) })
const runtimeLockFields = { slimeCommit: commit, hitchCommit: commit,
  pythonVersion: str, cudaVersion: str, pytorchVersion: str, megatronCommit: commit, sglangVersion: str, bridgeDigest: hash,
  protocolDigest: hash, patchDigests: array(hash), validation: literal('pending-gpu', 'validated'), probeEvidenceRefs: array(ref) }
const runtimeLock: Check = (value, path) => {
  if (value && typeof value === 'object' && (value as { schemaVersion?: unknown }).schemaVersion === 2) {
    object({ ...runtimeLockFields, schemaVersion: literal(2), runtime: object({ kind: literal('python-env'), nodeRuntimeDigest: hash,
      outerImageDigest: (v, p) => { if (v !== null) hash(v, p) } }) })(value, path)
  } else object({ ...runtimeLockFields, schemaVersion: version, imageDigest: hash })(value, path)
}
const harness = object({ commit, manifestRef: ref, adapter: str })
const partition = object({ snapshotRef: ref, tasks: array(object({ id: str, family: str, taskRef: ref, environmentRef: ref }), 1), exactDataAuthorized: bool })
const trainer = object({ provider: literal('slime'), runtimeLock, recipe: literal('agent-grpo-v1'), backend: literal('megatron'),
  placement: optional(literal('separate', 'colocated')),
  hyperparametersRef: ref, updatesPerCandidate: positive, checkpointEveryUpdate: literal(true), optimizerResetPolicy: literal('initial-cold-start-only'),
  rolloutBatchSize: positive, globalBatchSize: positive, dataParallelSize: positive })
const sampling = object({ temperature: literal(1), topP: literal(1), topK: literal(-1), repetitionPenalty: literal(1), maxNewTokens: positive, maxContextTokens: positive })
const rollout = object({ provider: literal('hitch'), mode: literal('synchronous'), groupSize: positive, maxPolicyLag: literal(0), sampling,
  episodeFormat: literal('linear-token-trajectory-v1'), capture: literal('exact-policy-tokens-v1'), truncation: literal('reject'),
  zeroVarianceGroup: literal('skip-with-bounded-resampling', 'keep'), compaction: literal(false), subagents: literal(false), auxiliaryModelCalls: literal(false) })
const budgets = object({ totalGpuSeconds: nonnegative, maxRolloutTokens: positive, maxEpisodeSteps: positive, maxGroupResamples: integer })
const spec = object({ schemaVersion: version, kind: literal('model-training'), name: str, fixedHarness: harness,
  initialModel: ref, referenceModel: ref, datasets: object({ train: partition, dev: partition, heldOut: partition }), verifier: ref, trainer, rollout,
  evaluation: object({ provider: literal('hitch-managed-local'), topology: literal('local-docker-harbor-dataset'), samplingProfile: literal('baseline'),
    common: object({ runtimeDigest: hash, protocolDigest: hash, samplingDigest: hash, budgetsDigest: hash, attempts: positive }),
    policy: object({ minDevGain: nonnegative, maxHeldOutRegression: nonnegative, maxInferenceErrorRate: nonnegative, requiredTaskIds: array(str), maxHeldOutEvaluations: positive }) }),
  resources: object({ trainingDevices: array(str, 1), evaluationDevices: array(str, 1), mode: literal('isolated', 'sequential') }), budgets,
  publication: object({ mode: literal('explicit') }) })
const request = object({ schemaVersion: version, trainingRunId: str, experimentId: str, parentModel: model, parentModelRef: ref,
  referenceModelRef: ref, resumeCheckpointRef: optional(ref), coldStart: bool, fixedHarness: harness, trainDataset: partition, verifier: ref,
  trainer, rollout, budgets, trainingDevices: array(str, 1), recipeDigest: hash, datasetSplitDigest: hash })
const handle: Check = (v, p) => {
  const v2 = !!v && typeof v === 'object' && (v as { schemaVersion?: unknown }).schemaVersion === 2
  object({ schemaVersion: literal(v2 ? 2 : 1), provider: literal('slime'), jobId: pattern(/^[a-zA-Z0-9_-]+$/), requestDigest: hash,
    ...(v2 ? { node: object({ nodeId: pattern(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/), generation: pattern(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/) }) } : {}) })(v, p)
}
const phase = literal('admitted', 'collecting', 'batch-sealed', 'training', 'checkpointed', 'exporting', 'evaluating', 'accepted', 'rejected', 'inconclusive')
const execution = literal('running', 'pausing', 'paused', 'interrupted', 'blocked', 'failed', 'completed')
const status = object({ schemaVersion: version, handle, phase, execution, committedUpdate: integer, usage, resourcesReleased: bool,
  message: optional(str), latestCommitRef: optional(ref) })
const artifacts = object({ schemaVersion: version, handle, model, checkpointRef: ref, updateCommitRefs: array(ref, 1),
  exportValidationRef: ref, usage, resourcesReleased: bool })
const subject = object({ harnessRef: ref, modelVersionRef: ref, weightsDigest: hash })
const condition = object({ schemaVersion: version, partition: literal('dev', 'held-out'), datasetDigest: hash,
  slots: array(object({ taskId: str, attempt: positive, environmentDigest: hash }), 1), verifierDigest: hash, budgetsDigest: hash,
  samplingDigest: hash, runtimeDigest: hash, protocolDigest: hash, tokenizerDigest: hash, chatTemplateDigest: hash, architecture: str, dtype: str, deploymentDigest: optional(hash) })
const evidence = object({ schemaVersion: version, evalId: str, subject, condition, evidenceKey: hash, hitchModelId: hash, inferenceLockRef: ref,
  trials: array(object({ taskId: str, attempt: positive, runId: str, valid: bool, reward: optional(num), inferenceError: bool })), complete: bool, gpuSeconds: nonnegative })

function parse<T>(check: Check, value: unknown, label: string): T { check(value, label); return structuredClone(value) as T }
export const parseContentRef = (v: unknown): T.ContentRef => parse(ref, v, 'ContentRef')
export const parseTrainerCheckpoint = (v: unknown): T.TrainerCheckpoint => parse(checkpoint, v, 'TrainerCheckpoint')
export const parseUpdateCommit = (v: unknown): T.UpdateCommitManifest => parse(updateCommit, v, 'UpdateCommitManifest')
export const parseTrainingHandle = (v: unknown): T.TrainingHandle => parse(handle, v, 'TrainingHandle')
export const parseTrainingStatus = (v: unknown): T.TrainingStatus => parse(status, v, 'TrainingStatus')
export const parseTrainingArtifacts = (v: unknown): T.TrainingArtifacts => parse(artifacts, v, 'TrainingArtifacts')
export const parseModelEvaluationEvidence = (v: unknown): T.ModelEvaluationEvidence => parse(evidence, v, 'ModelEvaluationEvidence')
export const parseEvaluationCondition = (v: unknown): T.ModelEvaluationCondition => parse(condition, v, 'ModelEvaluationCondition')
export const parseTrainingCapabilities = (v: unknown): T.TrainingCapabilities => parse(object({ schemaVersion: version,
  trainingExternalBinding: bool, exactPolicyTokens: bool, policyFencing: bool, durableIdempotency: bool,
  checkpointEveryUpdate: bool, immutableHfExport: bool, runtimeLockDigest: hash, blockers: array(str) }), v, 'TrainingCapabilities')

export function parseModelVersion(v: unknown): T.ModelVersion {
  const result = parse<T.ModelVersion>(model, v, 'ModelVersion')
  const { id, ...body } = result
  requireContract(digestJson(body) === id, 'model-digest-mismatch', 'ModelVersion id does not match its immutable manifest')
  requireContract(!result.trainingRunId || !!result.trainerCheckpointRef, 'missing-checkpoint', 'trained model requires a trainer checkpoint')
  return result
}
export function sealModelVersion(body: Omit<T.ModelVersion, 'id'>): T.ModelVersion {
  return parseModelVersion({ ...body, id: digestJson(body) })
}

function validateRecipe(t: T.ModelTrainingSpec['trainer'], r: T.ModelTrainingSpec['rollout'], b: T.ModelTrainingSpec['budgets']): void {
  requireContract(t.runtimeLock.slimeCommit === '41014d1f29e201137fdffce737bb8bac65bc5219', 'unsupported-slime', 'Slime commit must match the tested bridge contract')
  requireContract(r.groupSize >= 2, 'invalid-grpo-group', 'GRPO requires at least two independent slots')
  const n = t.rolloutBatchSize * r.groupSize
  requireContract(Number.isSafeInteger(n) && n % t.globalBatchSize === 0 && t.globalBatchSize % t.dataParallelSize === 0,
    'invalid-batch-layout', 'B × G must be divisible by global batch size, which must be divisible by DP size')
  requireContract(r.sampling.maxNewTokens < r.sampling.maxContextTokens, 'invalid-token-budget', 'output budget must leave room for the prompt')
  requireContract(b.totalGpuSeconds > 0, 'invalid-gpu-budget', 'an explicit positive GPU budget is required')
  requireContract(t.runtimeLock.validation !== 'validated' || t.runtimeLock.probeEvidenceRefs.length > 0,
    'missing-probes', 'validated runtime requires GPU compatibility probe evidence')
}
function validateTrainingDevices(t: T.ModelTrainingSpec['trainer'], devices: string[]): void {
  requireContract(new Set(devices).size === devices.length, 'duplicate-device', 'training GPU pool has duplicate devices')
  const minimum = t.dataParallelSize + (t.placement === 'colocated' ? 0 : 1)
  requireContract(devices.length >= minimum, 'gpu-allocation-overflow', 'training GPU pool must fit actor DP and rollout placement')
}
export function parseTrainingRequest(v: unknown): T.TrainingRequest {
  if (v && typeof v === 'object' && (v as { schemaVersion?: unknown }).schemaVersion === 2) {
    const input = structuredClone(v) as T.TrainingRequestV2
    const deployment = parseFrozenExecutionPlacement(input.deployment)
    const devices = parseNodeGpus(input.trainingDevices, deployment.modelRuntime.nodeId)
    requireContract(input.trainer && !('placement' in input.trainer), 'duplicate-placement', 'v2 placement belongs in deployment.gpuScheduling')
    const { deployment: _, ...body } = input
    parseTrainingRequestBody({ ...body, schemaVersion: 1, trainingDevices: gpuUuids(devices),
      trainer: { ...input.trainer, placement: actorRolloutPlacement(input) } })
    validateRuntimePlacement(input.trainer.runtimeLock, deployment)
    return input
  }
  const result = parseTrainingRequestBody(v)
  requireContract(result.trainer.runtimeLock.schemaVersion === 1, 'invalid-runtime-placement', 'v1 requests require the original container runtime lock')
  return result
}
function parseTrainingRequestBody(v: unknown): T.TrainingRequestV1 {
  const result = parse<T.TrainingRequestV1>(request, v, 'TrainingRequest')
  parseModelVersion(result.parentModel)
  requireContract(result.fixedHarness.adapter === 'training-tool', 'unsupported-training-harness', 'v1 exact training requires the fixed linear training-tool harness')
  validateRecipe(result.trainer, result.rollout, result.budgets)
  validateTrainingDevices(result.trainer, result.trainingDevices)
  requireContract(result.trainDataset.exactDataAuthorized, 'exact-data-not-authorized', 'train tasks must allow exact training capture')
  requireContract(result.coldStart === !result.resumeCheckpointRef, 'invalid-resume', 'cold start and optimizer resume are mutually exclusive')
  requireContract(!result.parentModel.trainerCheckpointRef || result.resumeCheckpointRef?.digest === result.parentModel.trainerCheckpointRef.digest,
    'optimizer-reset', 'a trained champion must resume its matching optimizer checkpoint')
  return result
}
export function parseModelTrainingSpec(v: unknown): T.ModelTrainingSpec {
  if (v && typeof v === 'object' && (v as { schemaVersion?: unknown }).schemaVersion === 2) {
    const input = structuredClone(v) as T.ModelTrainingSpecV2
    const deployment = parseFrozenExecutionPlacement(input.deployment)
    requireContract(input.resources && Object.keys(input.resources).sort().join(',') === 'evaluationDevices,trainingDevices',
      'invalid-gpu-pool', 'v2 resources require only trainingDevices and evaluationDevices')
    const trainingDevices = parseNodeGpus(input.resources.trainingDevices, deployment.modelRuntime.nodeId)
    const evaluationDevices = parseNodeGpus(input.resources.evaluationDevices, deployment.modelRuntime.nodeId)
    requireContract(input.evaluation?.provider === 'hitch-managed' && input.evaluation.topology === 'harbor-dataset',
      'invalid-evaluation-provider', 'v2 evaluates through Hitch with independently selected task and model nodes')
    requireContract(input.trainer && !('placement' in input.trainer), 'duplicate-placement', 'v2 placement belongs in deployment.gpuScheduling')
    const { deployment: _, ...body } = input
    parseModelTrainingSpecBody({ ...body, schemaVersion: 1,
      trainer: { ...input.trainer, placement: actorRolloutPlacement(input) },
      evaluation: { ...input.evaluation, provider: 'hitch-managed-local', topology: 'local-docker-harbor-dataset' },
      resources: { trainingDevices: gpuUuids(trainingDevices), evaluationDevices: gpuUuids(evaluationDevices), mode: deployment.gpuScheduling.trainEvaluation } })
    validateRuntimePlacement(input.trainer.runtimeLock, deployment)
    return input
  }
  const result = parseModelTrainingSpecBody(v)
  requireContract(result.trainer.runtimeLock.schemaVersion === 1, 'invalid-runtime-placement', 'v1 experiments require the original container runtime lock')
  return result
}
function validateRuntimePlacement(lock: T.TrainingRuntimeLock, deployment: T.FrozenExecutionPlacement): void {
  if (lock.schemaVersion === 2) requireContract(deployment.modelRuntime.launcher === 'process'
    && lock.runtime.nodeRuntimeDigest === deployment.modelRuntime.runtimeDigest,
  'invalid-runtime-placement', 'Python runtime lock must match the frozen process model node')
}
function parseModelTrainingSpecBody(v: unknown): T.ModelTrainingSpecV1 {
  const result = parse<T.ModelTrainingSpecV1>(spec, v, 'ModelTrainingSpec')
  requireContract(result.fixedHarness.adapter === 'training-tool', 'unsupported-training-harness', 'v1 exact training requires training-tool for training and evaluation')
  validateRecipe(result.trainer, result.rollout, result.budgets)
  validateTrainingDevices(result.trainer, result.resources.trainingDevices)
  requireContract(result.datasets.train.exactDataAuthorized, 'exact-data-not-authorized', 'train tasks must allow exact capture')
  const seen = new Map<string, string>()
  for (const [name, split] of Object.entries(result.datasets)) {
    const ids = new Set<string>()
    for (const task of split.tasks) {
      requireContract(!ids.has(task.id), 'duplicate-task', `${name}: duplicate task ${task.id}`); ids.add(task.id)
      for (const key of [`id:${task.id}`, `family:${task.family}`, `content:${task.taskRef.digest}`]) {
        requireContract(!seen.has(key) || seen.get(key) === name, 'dataset-leakage', `${key} occurs in multiple data partitions`)
        seen.set(key, name)
      }
    }
  }
  const devices = result.resources
  for (const pool of [devices.trainingDevices, devices.evaluationDevices]) requireContract(new Set(pool).size === pool.length, 'duplicate-device', 'GPU pool has duplicate devices')
  requireContract(devices.mode !== 'isolated' || !devices.trainingDevices.some(d => devices.evaluationDevices.includes(d)), 'gpu-ownership-conflict', 'isolated training and evaluation GPU pools must not overlap')
  requireContract(result.evaluation.policy.maxInferenceErrorRate <= 1, 'invalid-error-rate', 'error rate must be in [0,1]')
  const required = result.evaluation.policy.requiredTaskIds
  requireContract(new Set(required).size === required.length && required.every(id => [...result.datasets.dev.tasks, ...result.datasets.heldOut.tasks].some(t => t.id === id)),
    'invalid-required-tasks', 'required tasks must be unique evaluation tasks')
  return result
}

export const parsePolicyLease = (v: unknown): T.PolicyLease => parse(object({ schemaVersion: version, trainingRunId: str, batchId: str,
  policyVersion: str, parentModelVersionId: hash, synchronizedWeightsRef: ref, runtimeInstanceId: str, samplingDigest: hash,
  fencingToken: str, expiresAt: timestamp, state: literal('serving', 'draining', 'closed') }), v, 'PolicyLease')
export function parseTrainingExternalBinding(v: unknown): T.TrainingExternalBinding {
  const binding = parse<T.TrainingExternalBinding>(object({ kind: literal('training-external'), bindingId: str, trainingRunId: str,
    policyLeaseRef: ref, expectedPolicyVersion: str, fencingToken: str, expiresAt: timestamp, endpointRef: str, credentialRef: str,
    generationContractDigest: hash, requiredCapture: literal('exact-policy-tokens-v1'), api: literal('chat-completions'),
    maxOutputTokens: positive, maxEpisodeSteps: positive }), v, 'TrainingExternalBinding')
  requireContract(/^binding_[a-f0-9]{32}$/.test(binding.bindingId) && binding.endpointRef === `hitch-training:${binding.bindingId}`
    && binding.credentialRef === binding.endpointRef && binding.policyLeaseRef.uri === `cas:${binding.policyLeaseRef.digest}`,
  'invalid-training-binding', 'training binding must use its exact private registry and portable policy reference')
  return binding
}
export const parseGenerationReceipt = (v: unknown): T.GenerationReceipt => parse(object({ schemaVersion: version, id: str, runId: str,
  episodeId: str, taskId: str, logicalAttempt: positive, callIndex: integer, requestId: str, policyVersion: str, runtimeInstanceId: str,
  tokenizerDigest: hash, chatTemplateDigest: hash, effectiveSamplingRef: ref, inputTokenIdsRef: ref, outputTokenIdsRef: ref,
  behaviorLogProbsRef: ref, rawRequestRef: ref, rawResponseRef: ref, finishReason: literal('stop', 'tool-call', 'length', 'abort', 'error'), complete: bool }), v, 'GenerationReceipt')
export function parseFeedbackRecord(v: unknown): T.FeedbackRecord {
  const result = parse<T.FeedbackRecord>(object({ schemaVersion: version, id: str, episodeId: str, runId: str, receiptIds: array(str),
    verifierVersion: str, verifierEvidenceRef: ref, outcome: literal('valid', 'invalid'), reward: optional(num), feedbackRef: optional(ref), supersedes: optional(str) }), v, 'FeedbackRecord')
  requireContract(result.outcome !== 'valid' || result.reward !== undefined, 'missing-reward', 'valid feedback requires a finite reward')
  return result
}
export const parseTrainingEpisode = (v: unknown): T.TrainingEpisode => parse(object({ schemaVersion: version, id: str, groupId: str,
  slot: integer, harnessRef: ref, taskRef: ref, environmentRef: ref, policyVersion: str, runId: str, receiptIds: array(str), feedbackId: str,
  termination: literal('terminated', 'truncated', 'aborted', 'infra-error'), eligibility: literal('eligible', 'ineligible'), rejectionReasons: array(str) }), v, 'TrainingEpisode')
export function parseTrainingBatch(v: unknown): T.TrainingBatchManifest {
  const v2 = (v as { schemaVersion?: unknown })?.schemaVersion === 2
  const result = parse<T.TrainingBatchManifest>(object({ schemaVersion: literal(v2 ? 2 : 1), id: hash, trainingRunId: str,
  policyVersion: str, recipeDigest: hash, datasetSplitDigest: hash, groupsRef: ref, samplesRef: ref, sourceEvidenceDigest: hash,
  ...(v2 ? { sourceEvidenceRefs: array(ref) } : {}), state: literal('sealed') }), v, 'TrainingBatchManifest')
  if (v2) requireContract(digestJson(result.sourceEvidenceRefs) === result.sourceEvidenceDigest, 'batch-evidence-drift', 'batch evidence list differs from its sealed digest')
  const { id, ...body } = result
  requireContract(digestJson(body) === id, 'batch-digest-mismatch', 'batch id does not match its sealed manifest')
  return result
}
