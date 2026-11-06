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

export type TrainingRecipe = 'agent-grpo-v1' | 'agent-gspo-v1' | 'agent-cispo-v1'
  | 'agent-reinforce-plus-plus-v1' | 'agent-reinforce-plus-plus-baseline-v1' | 'offline-sft-v1'
export interface OfflineTraining {
  datasetRef: ContentRef
  shuffleSeed: number
  maxEpochs: number
  maxSequenceTokens: number
  maskContract: 'assistant-token-mask-v1'
}
export interface OfflineSftRecord {
  schemaVersion: 1
  id: string
  source: { taskId: string; family: string; taskDigest: string }
  tokens: number[]
  lossMask: number[]
  tokenRoles: ('system' | 'user' | 'assistant' | 'tool')[]
}
export interface OfflineSftDataset {
  schemaVersion: 1
  kind: 'offline-sft-dataset'
  tokenizerDigest: string
  chatTemplateDigest: string
  maskContract: 'assistant-token-mask-v1'
  records: ContentRef[]
}
export interface OfflineSftBatchManifest {
  schemaVersion: 3
  kind: 'offline-sft-batch'
  id: string
  trainingRunId: string
  recipeDigest: string
  datasetSplitDigest: string
  datasetRef: ContentRef
  samplesRef: ContentRef
  recordRefs: ContentRef[]
  cursorBefore: { position: number }
  cursorAfter: { position: number }
  state: 'sealed'
}
export type ConsumedTrainingBatch = TrainingBatchManifest | OfflineSftBatchManifest
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

export interface AgentStageConfig {
  runner: string; options: Record<string, unknown>
  instructionsRef: ContentRef; maxRepairs: number; timeoutSeconds: number
}
export interface TrainingStages {
  taskSource?: AgentStageConfig
  datasetBuilder?: AgentStageConfig
}

/** Frozen, declared alternatives. None may reset a trained champion's optimizer. */
export interface TrainingProposal {
  id: string
  sourceRef: ContentRef
  trainTaskIds?: string[]
  updatesPerCandidate?: number
  rolloutSampling?: TrainingSampling
}
export interface ModelIterationPolicy {
  schemaVersion: 1
  maxRounds: number
  maxWallClockSeconds: number
  maxConsecutiveRejected: number
  onRejected: 'next-declared-proposal-or-stop'
  onInconclusive: 'bounded-repair-or-stop'
  autoPublish: false
  recovery: { maxRunRecoveries: number; maxEvaluationAttempts: number }
  proposals: TrainingProposal[]
}
export interface ManagedEndpointAuthorization {
  mode: 'managed-native'
  /** Authorizes this exact private profile, not arbitrary controller edits. */
  profileDigest: string
}

export interface ModelTrainingSpecV1 {
  schemaVersion: 1
  kind: 'model-training'
  name: string
  fixedHarness: { commit: string; manifestRef: ContentRef; adapter: string }
  initialModel: ContentRef
  stages?: TrainingStages
  referenceModel: ContentRef
  datasets: { train: DatasetPartition; dev: DatasetPartition; heldOut: DatasetPartition }
  verifier: ContentRef
  trainer: {
    provider: 'slime'
    runtimeLock: TrainingRuntimeLock
    recipe: TrainingRecipe
    backend: 'megatron'
    /** Defaults to separate GPUs. Colocated alternates rollout/train with CPU offload. */
    placement?: 'separate' | 'colocated'
    /** Frozen four-stage factory loaded by the native runtime. */
    script?: { entrypoint: string; sourceRef: ContentRef }
    scriptConfig?: Record<string, unknown>
    hyperparametersRef: ContentRef
    updatesPerCandidate: number
    checkpointEveryUpdate: true
    optimizerResetPolicy: 'initial-cold-start-only'
    rolloutBatchSize: number
    globalBatchSize: number
    dataParallelSize: number
  }
  offlineTraining?: OfflineTraining
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
    provider: 'hitch-endpoint'
    topology: 'harbor-dataset'
    common: { runtimeDigest: string; protocolDigest: string; samplingDigest: string; budgetsDigest: string; attempts: number }
    policy: {
      minDevGain: number
      maxHeldOutRegression: number
      maxInferenceErrorRate: number
      requiredTaskIds: string[]
      maxHeldOutEvaluations: number
    }
  }
  resources: { trainingDevices: string[] }
  budgets: { gpuSecondsScope: 'training' | 'total'; totalGpuSeconds: number; maxRolloutTokens: number; maxEpisodeSteps: number; maxGroupResamples: number }
  publication: { mode: 'explicit' }
  /** Absent in historical experiments: no implicit upgrade or auto-admission. */
  iteration?: ModelIterationPolicy
  endpointPreparation?: ManagedEndpointAuthorization
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
  resources: { trainingDevices: NodeGpu[] }
  evaluation: ModelTrainingSpecV1['evaluation']
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
  stages?: TrainingStages
  generatedTaskExclusionRef?: ContentRef
  behaviorPolicyRef?: ContentRef
  updateStart?: { mode: 'cold-start' | 'resume'; modelRef: ContentRef; checkpointRef?: ContentRef }
  referenceModelRef: ContentRef
  resumeCheckpointRef?: ContentRef
  coldStart: boolean
  fixedHarness: ModelTrainingSpec['fixedHarness']
  trainDataset: DatasetPartition
  offlineTraining?: OfflineTraining
  verifier: ContentRef
  trainer: ModelTrainingSpec['trainer']
  rollout: ModelTrainingSpec['rollout']
  budgets: Omit<ModelTrainingSpec['budgets'], 'gpuSecondsScope'> & { gpuSecondsScope?: 'training' | 'total' }
  trainingDevices: string[]
  recipeDigest: string
  datasetSplitDigest: string
  /** Absolute experiment deadline; native supervision enforces it across restarts. */
  deadlineAt?: string
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
  schemaVersion: 1 | 2
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
  inferencePoolDigest?: string
  /** Ordinary endpoint protocol; historical conditions retain their original shape. */
  taskExecutionDigest?: string
  endpointApi?: 'responses' | 'chat-completions'
}
export interface LegacyModelEvaluationEvidence {
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
export interface EndpointDeploymentReceipt {
  schema_version: '1'
  /** Immutable HF snapshot digest, attested by the trusted deployment owner. */
  model_digest: string
  wire_model: string
  deployment_ref: string
  source: string
  service_config: Record<string, unknown>
}
export interface EvaluationEndpointBinding {
  schema_version: '1'
  kind: 'external-endpoint'
  endpoint_ref: string
  endpoint_revision: string
  api: 'responses' | 'chat-completions'
  wire_model: string
  capabilities: { streaming: boolean; tool_calls: boolean; parallel_tool_calls: boolean; input_modalities: ['text'] }
  generation: { max_output_tokens: number; temperature?: number; top_p?: number; top_k?: number; min_p?: number; repetition_penalty?: number; seed?: number }
  deployment_receipt: EndpointDeploymentReceipt
}
export interface ReadyEvaluationEndpointBinding extends EvaluationEndpointBinding {
  connection: { base_url: string; auth: { kind: 'none' } | { kind: 'env'; name: string } }
}
export interface EvaluationUsage {
  gpuSeconds: number | null
  gpuSecondsSource: string | null
  usageSource?: string
  inputTokens?: number
  outputTokens?: number
  requests?: number
  elapsedSeconds?: number
}
export interface EndpointModelEvaluationEvidence extends Omit<LegacyModelEvaluationEvidence, 'schemaVersion' | 'hitchModelId' | 'inferenceLockRef' | 'gpuSeconds'>, EvaluationUsage {
  schemaVersion: 2
  endpointBinding: EvaluationEndpointBinding
  endpointAttempts?: { id: string; parentId?: string; evalId: string; binding: EvaluationEndpointBinding; trials: string[] }[]
}
/** V1 is read-only historical evidence; new evaluation always produces V2. */
export type ModelEvaluationEvidence = LegacyModelEvaluationEvidence | EndpointModelEvaluationEvidence
export interface ModelEvaluationRequest {
  schemaVersion: 2
  subject: EvaluationSubject
  model: ModelVersion
  condition: ModelEvaluationCondition
  endpointBinding: ReadyEvaluationEndpointBinding
  datasetRef: ContentRef
  harnessCommit: string
  harnessAdapter: string
  datasetTasks: DatasetPartition['tasks']
  verifierRef: ContentRef
}
export interface ModelEndpointPreparer {
  /** Frozen deployment configuration, excluding model-specific endpoint revisions. */
  configurationDigest: string
  trustedReceiptSources: string[]
  mode?: 'external-file' | 'managed-native'
  /** External mode waits; managed mode requires frozen profile authorization. */
  prepare(model: ModelVersion, modelRef: ContentRef, context?: EndpointPreparationContext): Promise<ReadyEvaluationEndpointBinding | undefined>
  observe?(binding: ReadyEvaluationEndpointBinding, context: EndpointPreparationContext): Promise<ReadyEvaluationEndpointBinding | undefined>
  acquireConsumer?(binding: ReadyEvaluationEndpointBinding, consumer: EndpointConsumer, context: EndpointPreparationContext): Promise<void>
  releaseConsumer?(binding: ReadyEvaluationEndpointBinding, consumerId: string, context: EndpointPreparationContext): Promise<void>
  retire?(binding: ReadyEvaluationEndpointBinding, context: EndpointPreparationContext): Promise<{ status: 'draining' | 'released' | 'blocked'; reason?: string }>
  /** Persist the newer experiment-wide command before any remote side effect. */
  fence?(context: EndpointPreparationContext): Promise<void>
  maxRuntimeSeconds?: number
  retireOwned?(context: EndpointPreparationContext): Promise<{ status: 'draining' | 'released' | 'blocked'; reason?: string }>
  releaseOwnership?(context: EndpointPreparationContext): Promise<{ released: boolean; reason?: string }>
}
export interface EndpointPreparationContext {
  experimentId: string
  controllerDirectory: string
  runId?: string
  controlSequence: number
  action: 'start' | 'pause'
  deadlineAt: string
}
export interface EndpointConsumer { id: string; experimentId: string; runId: string; evaluationKey: string }
export interface ModelEndpointPreparation {
  schemaVersion: 1
  intentDigest: string
  modelRef: ContentRef
  status: 'waiting' | 'ready' | 'released' | 'blocked'
  bindingRef?: ContentRef
}
export interface ModelEvaluator {
  evaluate(request: ModelEvaluationRequest, idempotencyKey: string, intent?: TrainingControlIntent, attempt?: { id: string; parentId?: string }): Promise<ModelEvaluationEvidence>
  /** Read-only terminal task evidence; never submits, repairs or replays requests. */
  reconcileEvidence?(request: ModelEvaluationRequest, idempotencyKey: string): Promise<ModelEvaluationEvidence | undefined>
  /** Read-only cumulative task usage; unknown shared GPU time remains null. */
  observeUsage?(request: ModelEvaluationRequest, idempotencyKey: string): Promise<EvaluationUsage>
  /** Task/request termination says nothing about external service or GPU release. */
  cancel?(request: ModelEvaluationRequest, idempotencyKey: string, intent?: TrainingControlIntent): Promise<EvaluationUsage & { tasksCompleted: boolean }>
}
export interface ModelEvaluationAttempt {
  id: string
  parentId?: string
  bindingRef: ContentRef
  status: 'active' | 'terminal'
  evidenceRef?: ContentRef
  /** Each terminal task repair registers a fresh durable consumer admission. */
  consumerGeneration?: number
}
export interface ModelEvaluationIntent {
  key: string
  evidenceRef?: ContentRef
  chargedGpuSeconds?: number
  gpuSecondsSource?: string
  observedUsage?: EvaluationUsage
  attempts?: ModelEvaluationAttempt[]
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
  evaluationIntents: Record<string, ModelEvaluationIntent>
  evaluationTasksCompleted: boolean
  inferenceResourcesReleased?: boolean
  inferenceCleanupError?: string
  error?: string
  iterationRound?: { roundIndex: number; proposalIndex: number; proposalId: string; inputsDigest: string }
}
export interface ModelIterationState {
  schemaVersion: 1
  status: 'running' | 'pausing' | 'paused' | 'completed' | 'failed'
  control: { sequence: number; action: 'start' | 'pause' }
  startedAt: string
  deadlineAt: string
  rounds: Record<string, { runId: string; proposalIndex: number; outcome?: ModelDecision['outcome']; recoveries: number }>
  activeRoundIndex?: number
  nextProposalIndex: number
  consecutiveRejected: number
  recovery?: { roundIndex: number; phase: 'pausing' | 'resuming' }
  stopOutcome?: 'completed' | 'failed'
  stopReason?: string
  error?: string
  failureReason?: string
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
  evaluationUsage?: EvaluationUsage
  endpointPreparations?: Record<string, ModelEndpointPreparation>
  iteration?: ModelIterationState
  /** Managed single-run operations also use an experiment-wide ordered fence. */
  endpointControl?: { sequence: number; action: 'start' | 'pause'; deadlineAt: string }
}
