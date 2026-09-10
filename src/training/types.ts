/** Version 1 of the model-training contract. Harness evolution keeps its own schema. */
export interface ContentRef { uri: string; digest: string; mediaType: string }

export interface ModelVersion {
  schemaVersion: 1
  id: string
  parentModelVersionId?: string
  hfSnapshotRef: ContentRef
  weightsDigest: string
  tokenizerDigest: string
  chatTemplateDigest: string
  architecture: string
  dtype: string
  trainingRunId?: string
  trainerCheckpointRef?: ContentRef
  provenanceRef: ContentRef
}

export interface TrainerCheckpoint {
  schemaVersion: 1
  actorWeightsDigest: string
  hfExportRef: ContentRef
  actorStateRef: ContentRef
  optimizerStateRef: ContentRef
  schedulerAndRngRef: ContentRef
  dataCursorRef: ContentRef
  committedUpdate: number
  compatibilityDigest: string
}

export interface UpdateCommitManifest {
  schemaVersion: 1
  trainingRunId: string
  checkpointRef: ContentRef
  consumedBatchDigest: string
  committedUpdate: number
  rngRef: ContentRef
  dataCursorRef: ContentRef
  previousCommitRef?: ContentRef
  replayOfBatch?: string
}

export interface PolicyLease {
  schemaVersion: 1
  trainingRunId: string
  batchId: string
  policyVersion: string
  parentModelVersionId: string
  synchronizedWeightsRef: ContentRef
  runtimeInstanceId: string
  samplingDigest: string
  fencingToken: string
  expiresAt: string
  state: 'serving' | 'draining' | 'closed'
}

export interface TrainingExternalBinding {
  kind: 'training-external'
  bindingId: string
  trainingRunId: string
  policyLeaseRef: ContentRef
  expectedPolicyVersion: string
  fencingToken: string
  expiresAt: string
  endpointRef: string
  credentialRef: string
  generationContractDigest: string
  requiredCapture: 'exact-policy-tokens-v1'
  api: 'chat-completions'
  maxOutputTokens: number
  maxEpisodeSteps: number
}

export interface GenerationReceipt {
  schemaVersion: 1
  id: string
  runId: string
  episodeId: string
  taskId: string
  logicalAttempt: number
  callIndex: number
  requestId: string
  policyVersion: string
  runtimeInstanceId: string
  tokenizerDigest: string
  chatTemplateDigest: string
  effectiveSamplingRef: ContentRef
  inputTokenIdsRef: ContentRef
  outputTokenIdsRef: ContentRef
  behaviorLogProbsRef: ContentRef
  rawRequestRef: ContentRef
  rawResponseRef: ContentRef
  finishReason: 'stop' | 'tool-call' | 'length' | 'abort' | 'error'
  complete: boolean
}

export interface FeedbackRecord {
  schemaVersion: 1
  id: string
  episodeId: string
  runId: string
  receiptIds: string[]
  verifierVersion: string
  verifierEvidenceRef: ContentRef
  outcome: 'valid' | 'invalid'
  reward?: number
  feedbackRef?: ContentRef
  supersedes?: string
}

export interface TrainingEpisode {
  schemaVersion: 1
  id: string
  groupId: string
  slot: number
  harnessRef: ContentRef
  taskRef: ContentRef
  environmentRef: ContentRef
  policyVersion: string
  runId: string
  receiptIds: string[]
  feedbackId: string
  termination: 'terminated' | 'truncated' | 'aborted' | 'infra-error'
  eligibility: 'eligible' | 'ineligible'
  rejectionReasons: string[]
}

export interface TrainingBatchManifest {
  schemaVersion: 1 | 2
  id: string
  trainingRunId: string
  policyVersion: string
  recipeDigest: string
  datasetSplitDigest: string
  groupsRef: ContentRef
  samplesRef: ContentRef
  sourceEvidenceDigest: string
  /** Required for v2 so collect can preserve the complete exact-evidence graph. */
  sourceEvidenceRefs?: ContentRef[]
  state: 'sealed'
}

export interface DatasetPartition {
  snapshotRef: ContentRef
  tasks: { id: string; family: string; taskRef: ContentRef; environmentRef: ContentRef }[]
  exactDataAuthorized: boolean
}

/** This lock describes a tested assembly, not a mutable image tag. */
export interface TrainingRuntimeLockV1 {
  schemaVersion: 1
  slimeCommit: string
  hitchCommit: string
  imageDigest: string
  pythonVersion: string
  cudaVersion: string
  pytorchVersion: string
  megatronCommit: string
  sglangVersion: string
  bridgeDigest: string
  protocolDigest: string
  patchDigests: string[]
  validation: 'pending-gpu' | 'validated'
  probeEvidenceRefs: ContentRef[]
}

/** Process runtimes pin their Python environment; an outer image is optional. */
export interface TrainingRuntimeLockV2 extends Omit<TrainingRuntimeLockV1, 'schemaVersion' | 'imageDigest'> {
  schemaVersion: 2
  runtime: { kind: 'python-env'; nodeRuntimeDigest: string; outerImageDigest: string | null }
}
export type TrainingRuntimeLock = TrainingRuntimeLockV1 | TrainingRuntimeLockV2

export interface TrainingSampling {
  temperature: 1
  topP: 1
  topK: -1
  repetitionPenalty: 1
  maxNewTokens: number
  maxContextTokens: number
}

export interface ModelTrainingSpecV1 {
  schemaVersion: 1
  kind: 'model-training'
  name: string
  fixedHarness: { commit: string; manifestRef: ContentRef; adapter: string }
  initialModel: ContentRef
  referenceModel: ContentRef
  datasets: { train: DatasetPartition; dev: DatasetPartition; heldOut: DatasetPartition }
  verifier: ContentRef
  trainer: {
    provider: 'slime'
    runtimeLock: TrainingRuntimeLock
    recipe: 'agent-grpo-v1'
    backend: 'megatron'
    /** Defaults to separate GPUs. Colocated alternates rollout/train with CPU offload. */
    placement?: 'separate' | 'colocated'
    hyperparametersRef: ContentRef
    updatesPerCandidate: number
    checkpointEveryUpdate: true
    optimizerResetPolicy: 'initial-cold-start-only'
    rolloutBatchSize: number
    globalBatchSize: number
    dataParallelSize: number
  }
  rollout: {
    provider: 'hitch'
    mode: 'synchronous'
    groupSize: number
    maxPolicyLag: 0
    sampling: TrainingSampling
    episodeFormat: 'linear-token-trajectory-v1'
    capture: 'exact-policy-tokens-v1'
    truncation: 'reject'
    zeroVarianceGroup: 'skip-with-bounded-resampling' | 'keep'
    compaction: false
    subagents: false
    auxiliaryModelCalls: false
  }
  evaluation: {
    provider: 'hitch-managed-local'
    topology: 'local-docker-harbor-dataset'
    samplingProfile: 'baseline'
    common: { runtimeDigest: string; protocolDigest: string; samplingDigest: string; budgetsDigest: string; attempts: number }
    policy: {
      minDevGain: number
      maxHeldOutRegression: number
      maxInferenceErrorRate: number
      requiredTaskIds: string[]
      maxHeldOutEvaluations: number
    }
  }
  resources: { trainingDevices: string[]; evaluationDevices: string[]; mode: 'isolated' | 'sequential' }
  budgets: { totalGpuSeconds: number; maxRolloutTokens: number; maxEpisodeSteps: number; maxGroupResamples: number }
  publication: { mode: 'explicit' }
}

export interface NodeIdentity { nodeId: string; generation: string }
export interface NodeGpu { nodeId: string; gpuUuid: string }
/** Connection paths and tunnel ports are deployment inputs, never experiment identity. */
export interface ModelNodeConnection {
  transport: { type: 'local' } | { type: 'ssh'; host: string }
  workspace: string
  python: string[]
  configPath: string
  gateway: { localPort: number; nodePort: number }
}
export interface TrainingDeploymentConfig {
  schemaVersion: 2
  taskExecution: { placement: 'local' | 'remote'; provider: string }
  modelRuntime: { nodeRef: string; launcher: 'docker' | 'process' }
  gpuScheduling: { actorRollout: 'colocated' | 'disaggregated'; trainEvaluation: 'sequential' | 'isolated' }
  nodes: Record<string, ModelNodeConnection>
}
export interface FrozenExecutionPlacement {
  schemaVersion: 2
  taskExecution: TrainingDeploymentConfig['taskExecution'] & { providerIdentityDigest: string; capabilitiesDigest: string }
  modelRuntime: NodeIdentity & { nodeRef: string; launcher: 'docker' | 'process'; runtimeDigest: string }
  gpuScheduling: TrainingDeploymentConfig['gpuScheduling']
}
export interface ModelTrainingSpecV2 extends Omit<ModelTrainingSpecV1, 'schemaVersion' | 'resources' | 'evaluation'> {
  schemaVersion: 2
  deployment: FrozenExecutionPlacement
  resources: { trainingDevices: NodeGpu[]; evaluationDevices: NodeGpu[] }
  evaluation: Omit<ModelTrainingSpecV1['evaluation'], 'provider' | 'topology'> & { provider: 'hitch-managed'; topology: 'harbor-dataset' }
}
export type ModelTrainingSpec = ModelTrainingSpecV1 | ModelTrainingSpecV2

export interface TrainingCapabilities {
  schemaVersion: 1
  trainingExternalBinding: boolean
  exactPolicyTokens: boolean
  policyFencing: boolean
  durableIdempotency: boolean
  checkpointEveryUpdate: boolean
  immutableHfExport: boolean
  runtimeLockDigest: string
  blockers: string[]
}

/** Deliberately excludes dev and held-out data, thresholds and evaluation evidence. */
export interface TrainingRequestV1 {
  schemaVersion: 1
  trainingRunId: string
  experimentId: string
  parentModel: ModelVersion
  parentModelRef: ContentRef
  referenceModelRef: ContentRef
  resumeCheckpointRef?: ContentRef
  coldStart: boolean
  fixedHarness: ModelTrainingSpec['fixedHarness']
  trainDataset: DatasetPartition
  verifier: ContentRef
  trainer: ModelTrainingSpec['trainer']
  rollout: ModelTrainingSpec['rollout']
  budgets: ModelTrainingSpec['budgets']
  trainingDevices: string[]
  recipeDigest: string
  datasetSplitDigest: string
}
export interface TrainingRequestV2 extends Omit<TrainingRequestV1, 'schemaVersion' | 'trainingDevices'> {
  schemaVersion: 2
  deployment: FrozenExecutionPlacement
  trainingDevices: NodeGpu[]
}
export type TrainingRequest = TrainingRequestV1 | TrainingRequestV2

export type TrainingHandle = { schemaVersion: 1; provider: 'slime'; jobId: string; requestDigest: string }
  | { schemaVersion: 2; provider: 'slime'; jobId: string; requestDigest: string; node: NodeIdentity }
export type TrainingPhase = 'admitted' | 'collecting' | 'batch-sealed' | 'training' | 'checkpointed' | 'exporting' | 'evaluating' | 'accepted' | 'rejected' | 'inconclusive'
export type TrainingExecution = 'running' | 'pausing' | 'paused' | 'interrupted' | 'blocked' | 'failed' | 'completed'
export interface TrainingUsage { gpuSeconds: number; rolloutTokens: number; groupResamples: number }
export interface TrainingStatus {
  schemaVersion: 1
  handle: TrainingHandle
  phase: TrainingPhase
  execution: TrainingExecution
  committedUpdate: number
  usage: TrainingUsage
  resourcesReleased: boolean
  message?: string
  latestCommitRef?: ContentRef
}
export interface TrainingArtifacts {
  schemaVersion: 1
  handle: TrainingHandle
  model: ModelVersion
  checkpointRef: ContentRef
  updateCommitRefs: ContentRef[]
  exportValidationRef: ContentRef
  usage: TrainingUsage
  resourcesReleased: boolean
}
export interface ModelTrainer {
  preflight(spec: TrainingRequest): Promise<TrainingCapabilities>
  submit(request: TrainingRequest, idempotencyKey: string): Promise<TrainingHandle>
  inspect(handle: TrainingHandle): Promise<TrainingStatus>
  cancel(handle: TrainingHandle): Promise<TrainingStatus>
  collect(handle: TrainingHandle): Promise<TrainingArtifacts>
  control?(request: TrainingRequest, idempotencyKey: string, intent: TrainingControlIntent): Promise<TrainingStatus>
}
export interface TrainingControlIntent { schemaVersion: 2; sequence: number; action: 'start' | 'pause' }

export interface EvaluationSubject { harnessRef: ContentRef; modelVersionRef: ContentRef; weightsDigest: string }
export interface ModelEvaluationCondition {
  schemaVersion: 1
  partition: 'dev' | 'held-out'
  datasetDigest: string
  slots: { taskId: string; attempt: number; environmentDigest: string }[]
  verifierDigest: string
  budgetsDigest: string
  samplingDigest: string
  runtimeDigest: string
  protocolDigest: string
  tokenizerDigest: string
  chatTemplateDigest: string
  architecture: string
  dtype: string
  /** Present for v2 experiments; a different execution location needs a new baseline. */
  deploymentDigest?: string
}
export interface ModelEvaluationEvidence {
  schemaVersion: 1
  evalId: string
  subject: EvaluationSubject
  condition: ModelEvaluationCondition
  evidenceKey: string
  hitchModelId: string
  inferenceLockRef: ContentRef
  trials: { taskId: string; attempt: number; runId: string; valid: boolean; reward?: number; inferenceError: boolean }[]
  complete: boolean
  gpuSeconds: number
}
export interface ModelEvaluationRequest {
  schemaVersion: 1
  subject: EvaluationSubject
  model: ModelVersion
  condition: ModelEvaluationCondition
  datasetRef: ContentRef
  harnessCommit: string
  harnessAdapter: string
  datasetTasks: DatasetPartition['tasks']
  verifierRef: ContentRef
  evaluationDevices: string[]
  deployment?: FrozenExecutionPlacement
}
export interface ModelEvaluator {
  evaluate(request: ModelEvaluationRequest, idempotencyKey: string, intent?: TrainingControlIntent): Promise<ModelEvaluationEvidence>
  /** Read-only cumulative cost; null means no local journal yet, never release. */
  observeUsage?(request: ModelEvaluationRequest, idempotencyKey: string): Promise<{ gpuSeconds: number | null }>
  cancel?(request: ModelEvaluationRequest, idempotencyKey: string, intent?: TrainingControlIntent): Promise<{ resourcesReleased: boolean; gpuSeconds: number }>
}

export interface PairedModelReport {
  partition: 'dev' | 'held-out'
  taskDeltas: { taskId: string; baseline: number; candidate: number; delta: number }[]
  meanDelta: number
  standardError: number | null
  inferenceErrorRate: number
}
export interface ModelDecision {
  outcome: 'accepted' | 'rejected' | 'inconclusive' | 'superseded'
  reasons: string[]
  dev?: PairedModelReport
  /** No held-out per-task data is projected into the public run. */
  heldOut?: { meanDelta: number; standardError: number | null; taskCount: number; inferenceErrorRate: number }
}
export interface ModelChampion { modelRef: ContentRef; revision: number; trainingRunId?: string; baselineEvidence: Partial<Record<'dev' | 'held-out', ContentRef>> }
export interface ModelRelease { id: string; modelRef: ContentRef; previousReleaseId?: string; activatedAt: string; activationId: string }
export interface ModelTrainingRun {
  schemaVersion: 1
  id: string
  parent: ModelChampion
  request: TrainingRequest
  idempotencyKey: string
  trainingControl?: TrainingControlIntent
  evaluationControl?: TrainingControlIntent
  handle?: TrainingHandle
  phase: TrainingPhase
  execution: TrainingExecution
  usage: TrainingUsage
  resourcesReleased: boolean
  candidateRef?: ContentRef
  artifactsRef?: ContentRef
  status?: TrainingStatus
  decision?: ModelDecision
  heldOutQueries: number
  evaluationIntents: Record<string, { key: string; evidenceRef?: ContentRef; chargedGpuSeconds?: number }>
  evaluationResourcesReleased: boolean
  error?: string
}
export interface ModelExperimentState {
  schemaVersion: 1
  id: string
  spec: ModelTrainingSpec
  specDigest: string
  champion: ModelChampion
  runs: Record<string, ModelTrainingRun>
  releases: ModelRelease[]
  activeReleaseId?: string
  activationIntent?: { id: string; modelRef: ContentRef; expectedReleaseId: string | null; rollbackReleaseId?: string }
  usage: TrainingUsage
}
