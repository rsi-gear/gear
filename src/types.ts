import type { JsonValue } from '@deepseek-ai/dsh-session'

export type HarnessRef = string
export type MetaHarnessRef = string
export type SandboxProfileRef = string
export type EvidenceRef = string
export type EvolutionId = string
export type GitObjectId = string

export type SemanticTarget =
  | 'context'
  | 'pre_action'
  | 'routing'
  | 'post_action'
  | 'action_verifier'
  | 'skill'
  | 'tool'
  | 'workflow'
  | 'compaction'

export interface HarnessArtifact {
  path: string
  digest: string
  bytes: number
}

export interface HarnessManifest {
  schemaVersion: 1
  parentRef?: HarnessRef
  dshBaseRef: string
  toolchainRef: string
  sandboxProfileRef: SandboxProfileRef
  artifacts: HarnessArtifact[]
  digest: string
}

export interface ChampionState {
  schemaVersion: 2
  ref: HarnessRef
  manifestDigest: string
  updatedAt: string
  roundId?: string
}

export interface MetaSessionState {
  evolutionId: EvolutionId
  sessionId: string
  metaHarnessRef: MetaHarnessRef
  specDigest: string
  checkpoint?: MetaCheckpointRef
}

export interface MetaCheckpointRef {
  sourceSessionId: string
  eventCount: number
  prefixDigest: string
}

export interface ArtifactRef {
  ref: string
  digest: string
}

export type ComponentKind =
  | 'candidate-generator'
  | 'task-sampler'
  | 'rollout-provider'
  | 'judge'
  | 'candidate-assessor'
  | 'candidate-selector'
  | 'promotion-policy'

export interface ComponentRef<C = JsonValue> {
  kind: ComponentKind
  id: string
  apiVersion: 1
  implementation: {
    package: string
    version: string
    integrity: string
  }
  config: C
  configDigest: string
}

export interface MetaSamplingConfig {
  temperature?: number
  /** Adapter-owned effort id (for example, medium), sealed into the evolution spec. */
  reasoningEffort?: string
}

export interface RolloutSamplingConfig {
  temperature?: number
}

export interface ResolvedDshPresetResource {
  logicalPath: string
  kind: 'composition' | 'system-prompt' | 'skill' | 'workflow' | 'document' | 'plugin'
  digest: string
}

export interface ResolvedDshPresetRef {
  id: string
  digest: string
  resources: ResolvedDshPresetResource[]
}

export interface DshMetaAgentSpec {
  runtime: {
    type: 'dsh'
    version: string
    integrity: string
  }
  preset: ResolvedDshPresetRef
  model: {
    provider: string
    model: string
    maxTokens?: number
  }
  sampling: MetaSamplingConfig
  contextOffloading?: DshContextOffloadingPolicy
}

/** Sealed with the evolution; absence preserves legacy session behavior. */
export interface DshContextOffloadingPolicy {
  schemaVersion: 1
  mode: 'proactive' | 'overflow-only'
  contextWindow?: number
  triggerRatio: number
  bootstrapRatio: number
  reserveTokens: number
  summaryMaxTokens: number
  maxToolResultTokens: number
  maxStepToolResultTokens: number
  summaryPromptVersion: string
}

export interface GenericMetaAgentSpec {
  contextOffloading?: DshContextOffloadingPolicy
  runtime: {
    type: string
    version: string
    integrity: string
  }
  preset: {
    id: string
    digest: string
    resources: Array<{ logicalPath: string; kind: string; digest: string }>
  }
  model: {
    provider: string
    model: string
    maxTokens?: number
  }
  sampling: MetaSamplingConfig
}

export type MetaAgentSpec = DshMetaAgentSpec | GenericMetaAgentSpec

export interface CandidateGenerationSpec {
  strategy: ComponentRef<unknown>
  maxCandidates: number
  budget: {
    maxModelRequests?: number
    maxTokens?: number
    /** Legacy round-wide timeout retained for immutable EvolutionSpec compatibility. */
    timeoutMs?: number
    attemptTimeoutMs?: number
    maxAttemptsPerCandidate?: number
    roundTimeoutMs?: number
  }
}

export interface RolloutSpec {
  provider: ComponentRef<unknown>
  /**
   * Digest of the provider implementation and result-affecting rollout settings.
   * Machine paths, credentials, concurrency, and output/logging limits are excluded.
   * Optional only for reading EvolutionSpecs created before this field existed.
   */
  providerSemanticDigest?: string
  taskSampler: ComponentRef<unknown>
  repetitions: number
  seeds?: number[]
  model: string
  sampling: RolloutSamplingConfig
  agentConfig: JsonValue
}

export interface EvolutionSpec {
  evolutionId: EvolutionId
  createdAt: string

  initialHarness: ArtifactRef
  datasets: {
    seed: ArtifactRef
    heldOut: ArtifactRef
  }
  metaAgent: MetaAgentSpec
  candidateGeneration: CandidateGenerationSpec
  rollout: RolloutSpec
  evaluation: {
    judges: ComponentRef<unknown>[]
    primaryMetric: string
  }
  selection: {
    assessor: ComponentRef<unknown>
    strategy: ComponentRef<unknown>
    survivors: number
    timeoutMs: number
  }
  promotion: {
    policy: ComponentRef<PromotionPolicy>
  }
  taskBudgetMs: number
  toolchainRef: string
  sandboxProfileRef: SandboxProfileRef
}

export interface EvolutionRegistryEntry {
  evolutionId: EvolutionId
  name?: string
  specDigest: string
  status: 'active' | 'archived'
  createdAt: string
  updatedAt: string
  lastBatchId?: string
  lastRoundId?: string
}

export interface EvolutionRegistryState {
  schemaVersion: 1
  evolutions: EvolutionRegistryEntry[]
}

export interface PublishedHarnessState {
  schemaVersion: 1
  ref: HarnessRef
  manifestDigest: string
  publishedAt: string
  sourceEvolutionId?: EvolutionId
  roundId?: string
}

export type RoundStatus =
  | 'queued'
  | 'baseline-running'
  | 'preparing-candidate'
  | 'candidate-editing'
  | 'building-candidate'
  | 'candidate-seed-running'
  | 'selection-running'
  | 'held-out-running'
  | 'repairing-evaluation'
  | 'promoting'
  | 'accepted'
  | 'rejected'
  | 'rejected-for-substrate'
  | 'failed'

export interface ScoreSummary {
  total: number
  passed: number
  failed: number
  score: number
  metrics?: Record<string, number>
  process?: { score: number }
}

export interface EvaluationTrialScores {
  totalScore: number
  processScore?: number
  normalization: 'standard' | 'legacy-reward'
}

export interface EvaluationTrialSummary {
  taskName: string
  trialName?: string
  runId?: string
  attempt?: number
  status: 'completed' | 'errored'
  rewards: Record<string, number>
  scores?: EvaluationTrialScores
}

export type HitchTrialSummary = EvaluationTrialSummary

export interface InvalidEvaluationTrialSummary {
  taskName: string
  trialName: string
  runId: string
  attempt: number
  status: 'errored'
  invalidReason: string
}

export interface HitchCapabilities {
  schemaVersion: 1
  trajectoryAnalysis: 1
  trajectoryEventsPage: 1
  verifierEvidence?: 1
}

export interface HitchTrajectoryContentExcerpt {
  preview: string
  tail?: string
  bytes: number
  sha256: string
  truncated: boolean
  source: { runId: string; seq: number; field: string }
}

export type HitchSurfaceOperation = 'append' | { op: 'replace'; start: number; end: number }

export interface HitchTrajectorySurfaceNode {
  seq: number
  eventType: 'user/message' | 'assistant/message' | 'tool/result'
  surfaceOp: HitchSurfaceOperation
  message: JsonValue
}

export interface HitchTrajectoryRequestBoundary {
  turn: number
  step: number
  /** Zero-based model request attempt within the DSH step. */
  attempt: number
  retryId?: JsonValue
  boundarySeq: number
  surfaceRevision: number
  requestHeaderSeq?: number
}

export type TrajectoryPartialEvidence<TContent> = {
  status: 'incomplete'
  sourceSeqCount: number
} & ({
  content: TContent
  streams?: never
} | {
  content?: never
  streams: Array<{
    blockIndex: number
    blockStartSeq: number
    kind: 'text' | 'reasoning' | 'tool_arguments'
    content: TContent
    sourceSeqCount: number
  }>
})

export interface HitchTrajectoryChunkSummary {
  turn: number
  step: number
  /** Zero-based model request attempt within the DSH step. */
  attempt: number
  retryId?: JsonValue
  firstSeq: number
  lastSeq: number
  count: number
  types: Record<string, number>
  modelBoundarySeq: number
  usage?: JsonValue
  finishReason?: JsonValue
  partial?: TrajectoryPartialEvidence<HitchTrajectoryContentExcerpt>
}

export interface HitchTrajectoryAnalysis {
  schemaVersion: 1
  kind: 'trajectory-analysis'
  runId: string
  source: {
    fidelity: 'provider_native' | 'normalized' | 'minimal'
    provider?: string
    sessionId: string
    canonicalSha256: string
    canonicalBytes: number
    eventCount: number
    eventTypes: Record<string, number>
  }
  header: JsonValue
  surface: {
    fidelity: 'exact' | 'normalized' | 'partial'
    nodes: HitchTrajectorySurfaceNode[]
    currentNodeSeqs: number[]
    replacements: Array<{ seq: number; start: number; end: number; shadowedSeqs: number[] }>
    requestBoundaries: HitchTrajectoryRequestBoundary[]
    requestHeaders: Array<{ seq: number; header: JsonValue }>
  }
  events: JsonValue[]
  chunkSummaries: HitchTrajectoryChunkSummary[]
  omittedEventTypes: Record<string, number>
  coverage: {
    surface: 'complete' | 'partial'
    chunks: 'coalesced' | 'omitted' | 'partial'
    content: 'complete' | 'excerpted' | 'partial'
    childSessions: 'complete' | 'partial' | 'none' | 'unavailable'
  }
  redactions?: Array<{ ruleId: string; count: number }>
}

export interface HitchTrajectoryEventsQuery {
  eventTypes?: string[]
  seqStart?: number
  seqEnd?: number
  field?: string
  canonicalSha256?: string
  cursor?: string
  limit?: number
  /** Internal response budget forwarded to Hitch; not exposed as a Meta-controlled argument. */
  maxBytes?: number
}

export interface HitchTrajectoryEventsPage {
  schemaVersion: 1
  kind: 'trajectory-events-page'
  runId: string
  canonicalSha256: string
  filter: {
    eventTypes?: string[]
    seqStart?: number
    seqEnd?: number
    field?: string
  }
  events: JsonValue[]
  totalMatches: number
  nextCursor?: string
  eof: boolean
  redactions?: Array<{ ruleId: string; count: number }>
}

export interface HitchTrajectoryReader {
  inspectCapabilities(signal: AbortSignal): Promise<HitchCapabilities>
  inspectTrajectoryAnalysis(runId: string, signal: AbortSignal): Promise<HitchTrajectoryAnalysis>
  inspectTrajectoryEvents(
    runId: string,
    query: Readonly<HitchTrajectoryEventsQuery>,
    signal: AbortSignal,
  ): Promise<HitchTrajectoryEventsPage>
  inspectVerifierEvidence?(runId: string, signal: AbortSignal): Promise<HitchVerifierEvidence>
}

export interface HitchVerifierEvidence {
  runId: string
  parent?: {
    evalId: string
    trialId: string
    attempt: number
  }
  observation?: {
    status: 'valid' | 'invalid'
    reward?: number
    invalidReason?: string
    verifierResultRef?: string
  }
  verifier: {
    status: 'complete' | 'result_only' | 'missing' | 'corrupt' | 'unavailable'
    result?: JsonValue
    resultSha256?: string
    scores?: EvaluationTrialScores
    process?: VerifierProcessEvidence
    feedback?: VerifierFeedback
    structuredArtifacts?: {
      process?: VerifierStructuredArtifact
      feedback?: VerifierStructuredArtifact
    }
    diagnostics?: JsonValue
    issues?: string[]
  }
  redactions?: Array<{
    ruleId: string
    count: number
  }>
}

export interface VerifierTrajectoryRef {
  runId: string
  seqStart?: number
  seqEnd?: number
}

export interface VerifierProcessComponent {
  id: string
  category: string
  status: 'passed' | 'failed' | 'excluded'
  weight: number
  code?: string
  publicDetails?: Record<string, JsonValue>
  privateDetailsRef?: string
  trajectoryRefs?: VerifierTrajectoryRef[]
}

export interface VerifierProcessEvidence {
  schemaVersion: 1
  metric: string
  score: number
  detailStatus: 'components' | 'aggregate-only'
  passed?: number
  total?: number
  excluded?: number
  components?: VerifierProcessComponent[]
}

export interface VerifierFeedback {
  schemaVersion: 1
  items: Array<{
    code: string
    severity: 'info' | 'warning' | 'error'
    message: string
    componentIds?: string[]
    trajectoryRefs?: VerifierTrajectoryRef[]
  }>
}

export interface VerifierStructuredArtifact {
  ref: 'verifier/process.json' | 'verifier/feedback.json'
  bytes: number
  sha256: string
}

export interface ContentExcerpt {
  preview: string
  tail?: string
  bytes: number
  sha256: string
  truncated: boolean
  source: { runId: string; seq?: number; field: string }
}

export interface TrajectoryMessageEvidence {
  seq: number
  eventType: string
  role: string
  message: ContentExcerpt
  sourceEventSeqs?: { count: number; first: number; last: number }
}

export interface TrajectoryToolAction {
  callId: string
  name: string
  callSeq: number
  resultSeq?: number
  arguments: ContentExcerpt
  result?: ContentExcerpt
  error?: { name: string; code: string }
  status: 'completed' | 'errored' | 'open' | 'unknown'
}

export interface TrajectoryModelRequestEvidence {
  contextEpochId?: string
  attempt: number
  retryId?: JsonValue
  firstSeq: number
  lastSeq: number
  chunkCount: number
  chunkTypes: Record<string, number>
  usage?: JsonValue
  finishReason?: JsonValue
  partial?: TrajectoryPartialEvidence<ContentExcerpt>
}

export interface TrajectorySemanticStep {
  id: string
  turn: number
  step: number
  seqStart: number
  seqEnd: number
  contextEpochId?: string
  contextEpochIds?: string[]
  assistantMessages: TrajectoryMessageEvidence[]
  toolActions: TrajectoryToolAction[]
  modelRequests?: TrajectoryModelRequestEvidence[]
  omittedAssistantMessageCount?: number
  omittedToolActionCount?: number
  omittedModelRequestCount?: number
  terminalReason?: JsonValue
  terminalReasonExcerpt?: ContentExcerpt
}

export interface TrajectoryContextEpoch {
  id: string
  boundarySeq: number
  requestSeq?: number
  turn?: number
  step?: number
  attempt: number
  retryId?: JsonValue
  header: {
    config?: JsonValue
    adapterDefaults?: JsonValue
    configExcerpt?: ContentExcerpt
    adapterDefaultsExcerpt?: ContentExcerpt
    system?: ContentExcerpt
    tools?: ContentExcerpt
  }
  surfaceMessageSeqs: number[]
  omittedSurfaceMessageSeqCount?: number
  replacementGeneration: number
}

export interface TrajectoryProjection {
  schemaVersion: 1
  runId: string
  trajectoryDigest: string
  fidelity: 'exact-surface' | 'normalized-surface' | 'minimal' | 'unavailable'
  rawEventCount: number
  eventTypes: Record<string, number>
  omittedEventTypes: Record<string, number>
  contextEpochs: TrajectoryContextEpoch[]
  messages: TrajectoryMessageEvidence[]
  semanticSteps: TrajectorySemanticStep[]
  finalAnswer?: TrajectoryMessageEvidence
  pathsObservedThroughTools: string[]
  replacements: Array<{ seq: number; start: number; end: number; shadowedSeqs: number[] }>
  errors: Array<{ seq?: number; type: string; excerpt: string }>
  coverage: HitchTrajectoryAnalysis['coverage']
  redactions?: Array<{ ruleId: string; count: number }>
}

export interface MetaFailureCard {
  task: string
  runId: string
  outcome: {
    status: 'completed' | 'errored'
    reward?: number
    invalidReason?: string
  }
  prompt?: MetaEvidenceText
  verifier: {
    status: 'complete' | 'result_only' | 'missing' | 'unavailable'
    summary: string
    scores?: EvaluationTrialScores
    process?: Omit<VerifierProcessEvidence, 'components'> & {
      components?: Array<Omit<VerifierProcessComponent, 'privateDetailsRef'> & { publicDetailsPreview?: string }>
      /** This view contains previews; detailRef retains the complete public evidence. */
      truncated?: true
    }
    feedback?: VerifierFeedback & { truncated?: true }
    failures?: Array<{ name: string; detail: MetaEvidenceText }>
    detailRef?: string
    needsDetail?: true
  }
  transcript: {
    text: string
    earlierRef?: string
  }
}

export interface MetaEvidenceText {
  text: string
  truncated?: true
  detailRef?: string
}

export interface DiagnosisReceipt {
  runId: string
  bundleDigest: string
  trajectoryDigest: string
  projectionVersion: 1
  verifierStatus: 'complete' | 'result_only' | 'explicitly-missing' | 'unavailable'
  compatibility?: 'allow-unavailable-verifier'
  sanitizationPolicyDigest: string
  inspectedAt: string
}

export interface MissingDiagnosis {
  taskName: string
  runId: string
  trialName?: string
  attempt?: number
  reward?: number
}

export interface CapabilityAction {
  actionId: string
  tool: 'trajectory_query' | 'candidate_check' | 'finalize_candidate' | 'decline_candidate'
  arguments: JsonValue
  reason: string
  coversRunIds?: string[]
}

export interface FinalizationReadiness {
  ready: boolean
  summaryAccessed: boolean
  baselineEvalId: string
  failedRunCount: number
  diagnosedRunCount: number
  remainingRunCount: number
  missing: MissingDiagnosis[]
  verifierBlockedRunIds: string[]
  trajectoryBlockedRuns: TrajectoryEvidenceBlocker[]
  unaccessedCitedRefs: string[]
  blockers: Array<{
    code: 'BASELINE_SUMMARY_REQUIRED' | 'MISSING_BASELINE_DIAGNOSIS' | 'EVIDENCE_REF_NOT_ACCESSED' | 'VERIFIER_EVIDENCE_UNAVAILABLE' | 'TRAJECTORY_EVIDENCE_UNAVAILABLE'
    message: string
  }>
  nextActions: CapabilityAction[]
}

export interface MetaRecoveryRequired {
  schemaVersion: 1
  accepted: false
  recoverable: true
  code: 'BASELINE_SUMMARY_REQUIRED' | 'MISSING_BASELINE_DIAGNOSIS' | 'EVIDENCE_REF_NOT_ACCESSED'
  failedOperation: 'candidate.finalize' | 'candidate.decline'
  message: string
  readiness: FinalizationReadiness
  nextAction: CapabilityAction
  remainingActions: CapabilityAction[]
  retry: {
    tool: 'finalize_candidate' | 'decline_candidate'
    reusePreviousArguments: true
  }
}

export interface MetaPrerequisiteBlocked {
  schemaVersion: 1
  accepted: false
  recoverable: false
  code: 'VERIFIER_EVIDENCE_UNAVAILABLE' | 'TRAJECTORY_EVIDENCE_UNAVAILABLE'
  failedOperation: 'candidate.finalize' | 'candidate.decline'
  message: string
  readiness: FinalizationReadiness
  operatorAction: {
    upgrade: string
    compatibilityConfig?: 'hitch.allowUnavailableVerifierDiagnosis=true'
    runIds?: string[]
    reason?: string
  }
  retry: {
    tool: 'finalize_candidate' | 'decline_candidate'
    reusePreviousArguments: true
    afterPrerequisite: true
  }
}

export interface TrajectoryEvidenceBlocker {
  runId: string
  code: string
  message: string
}

export interface LocalSourceTransportSummary {
  kind: 'local-git-commit'
  resolutionIdentity: string
  commit: HarnessRef
  tree: string
  payloadSha256: string
  payloadBytes: number
}

export interface EvaluationEvidence {
  provider: string
  conditionId: string
  /** Path- and credential-independent semantic rollout configuration identity. */
  effectiveConfigDigest: string
  evalId: string
  dataset: string
  requestedCommit: HarnessRef
  actualCommit: HarnessRef
  revisionIdentity: string
  /** Diagnostic execution fingerprint; differences do not make evidence semantically incomparable. */
  invocationFingerprint?: string
  /** Frozen dataset/scoring identity reported by the evaluator, when available. */
  benchmark?: {
    id: string
    revision: string
  }
  completeness: 'complete' | 'partial'
  plannedTrialCount: number
  primaryReward: number
  processScore?: number
  summary: ScoreSummary
  trials: EvaluationTrialSummary[]
  invalidTrials: InvalidEvaluationTrialSummary[]
  localSourceTransport?: LocalSourceTransportSummary
  metadata?: JsonValue
}

export interface HitchEvaluationEvidence extends EvaluationEvidence {
  invocationFingerprint: string
  localSourceTransport: LocalSourceTransportSummary
}

export type EvaluationPhase = 'seed-baseline' | 'seed-candidate' | 'held-out-baseline' | 'held-out-candidate'

export interface FailedEvaluationTrialSummary {
  taskName: string
  trialName: string
  runId: string
  attempt: number
  status: 'completed' | 'errored'
  invalidReason?: string
}

/** Complete run membership from an evaluation that was rejected for scoring. */
export interface FailedEvaluationEvidence {
  provider: string
  conditionId: string
  effectiveConfigDigest: string
  evalId: string
  dataset: string
  requestedCommit: HarnessRef
  actualCommit: HarnessRef
  revisionIdentity: string
  invocationFingerprint?: string
  runSetComplete: true
  trials: FailedEvaluationTrialSummary[]
  localSourceTransport?: LocalSourceTransportSummary
}

export interface FailedEvaluationRecord {
  phase: EvaluationPhase
  owner: {
    candidateId: string
    harnessRef: HarnessRef
    role: 'baseline' | 'candidate'
  }
  evidence: FailedEvaluationEvidence
  failure: { code: string; message: string }
}

export interface EvaluationRequest {
  phase: EvaluationPhase
  dataset: string
  harnessRef: HarnessRef
  condition: EvaluationCondition
}

export interface EvaluationReservation {
  provider: string
  evalId: string
}

/** Prepared without side effects; persisted before a remote submission can start. */
export interface EvaluationSubmissionIntent {
  provider: string
  idempotencyKey: string
  parameters: JsonValue
}

export interface EvaluationFailure {
  code: string
  message: string
}

/** Remains durable until the remote evaluation finishes or accepts cancellation. */
export interface PendingEvaluationSubmission {
  intent: EvaluationSubmissionIntent
  request: EvaluationRequest
  owner: RoundEvaluationAttempt['owner']
  startedAt: string
  reservation?: EvaluationReservation
  cleanupFailure?: EvaluationFailure
}

export type EvaluationRerunSelector =
  | { mode: 'invalid' }
  | { mode: 'tasks'; taskNames: string[] }

/** Client-chosen operation identity, persisted before a daemon rerun starts. */
export interface EvaluationRerunReservation extends EvaluationReservation {
  rerunId: string
  parameters: JsonValue
}

export interface PendingEvaluationRerun {
  reservation: EvaluationRerunReservation
  cleanupFailure?: EvaluationFailure
}

export interface EvaluationTrialSlot {
  taskId: string
  attempt: number
}

export interface EvaluationRerunResult {
  provider: string
  evalId: string
  selectedTasks: string[]
  repairedTasks: string[]
  remainingInvalidTasks: string[]
  selectedTrials?: EvaluationTrialSlot[]
  repairedTrials?: EvaluationTrialSlot[]
  remainingInvalidTrials?: EvaluationTrialSlot[]
  evalStatus: 'succeeded' | 'failed'
  evidence?: EvaluationEvidence
}

export interface RoundEvaluationAttempt {
  provider: string
  evalId: string
  phase: EvaluationPhase
  owner: {
    candidateId: string
    role: 'baseline' | 'candidate'
    harnessRef: HarnessRef
  }
  conditionId: string
  dataset: string
  requestedModelId: string
  requestedCommit: HarnessRef
  status: 'running' | 'rerunning' | 'repair-completed' | 'settled' | 'failed' | 'cancelled'
  startedAt: string
  completedAt?: string
  failure?: { code: string; message: string }
  /** A settled baseline imported from an earlier round instead of rerun. */
  reusedFromRoundId?: string
  cleanupFailure?: EvaluationFailure
  submissionIntent?: EvaluationSubmissionIntent
  /** Diagnostic provenance for a reuse decision; it does not determine semantic compatibility. */
  reuseAudit?: {
    sourceInvocationFingerprint: string
    currentInvocationFingerprint: string
    invocationFingerprintChanged: boolean
  }
}

export interface EvaluationRepairResumeIntent {
  provider: string
  evalId: string
  completedAt: string
}

export interface EvaluationCondition {
  conditionId: string
  partition: 'seed' | 'held-out'
  dataset: ArtifactRef
  repetitions: number
  seeds?: number[]
  model: string
  sampling: RolloutSamplingConfig
  timeoutMs: number
  rolloutProviderDigest: string
}

export interface ResolvedRoundPlan {
  planId: string
  digest: string
  taskSampler: ComponentRef<unknown>
  seed: EvaluationCondition
  heldOut: EvaluationCondition
}

export interface PairedTrial {
  conditionId: string
  trialKey: string
  taskName: string
  baselineTrialName?: string
  candidateTrialName?: string
  attempt?: number
  baselineRunId?: string
  candidateRunId?: string
  baselineReward: number
  candidateReward: number
  rewardDelta: number
  baselineProcessScore?: number
  candidateProcessScore?: number
  processScoreDelta?: number
}

export interface PairingAudit {
  planned: number
  paired: number
  excluded: number
  baselineInvalid: number
  candidateInvalid: number
}

export interface RoundEvaluation {
  seedBaseline: EvaluationEvidence
  seedCandidate: EvaluationEvidence
  seedPairedTrials: PairedTrial[]
  seedPairing: PairingAudit
  heldOutBaseline?: EvaluationEvidence
  heldOutCandidate?: EvaluationEvidence
  heldOutPairedTrials?: PairedTrial[]
  heldOutPairing?: PairingAudit
  promotionMetrics?: MetricSet
  scoreDelta: number
  processScoreDelta?: number
  heldOutScoreDelta?: number
  heldOutProcessScoreDelta?: number
  requiredRegressions: number
}

export interface MetaAttribution {
  executionId?: string
  generation?: number
  handoffRefs?: string[]
  evolutionId: EvolutionId
  sessionId: string
  requestHeaderSeq?: number
  proposalEventSeq?: number
  source?:
    | { kind: 'dsh-events'; requestHeaderSeq: number; proposalEventSeq: number }
    | { kind: 'skill-lease'; harness: string; clientId: string; leaseId: string }
  provider?: string
  model?: string
  maxTokens?: number
  sampling?: JsonValue
}

export interface ProposalEvidenceAudit {
  evolutionId: EvolutionId
  roundId: string
  candidateId?: string
  baselineEvalId: string
  summaryAccessed: boolean
  accessedRefs: string[]
  diagnosedRunRefs: string[]
  diagnosisReceipts?: DiagnosisReceipt[]
  citedRefs: string[]
}

export interface CandidateFinalization {
  rationale: string
  evidenceRefs: EvidenceRef[]
  expectedOutcome: string
  semanticTargets?: SemanticTarget[]
}

export interface CandidateDecline {
  rationale: string
  evidenceRefs: EvidenceRef[]
}

export interface CandidateDiffFile {
  path: string
  change: 'created' | 'modified' | 'deleted'
  additions?: number
  deletions?: number
  bytesBefore?: number
  bytesAfter?: number
}

export interface CandidateDiffSummary {
  parentRef: HarnessRef
  files: CandidateDiffFile[]
  totalBytes: number
  patchDigest: string
  source?: 'git-native' | 'legacy-mutation'
}

export interface SealedCandidateVersion {
  commitOid: GitObjectId
  treeOid: GitObjectId
  manifestDigest: string
  patchDigest: string
  immutableRef: string
}

export interface CandidateGenerationAttempt {
  attempt: number
  status: 'running' | 'succeeded' | 'failed'
  startedAt: string
  completedAt?: string
  workspaceId?: string
  metaSessionId?: string
  metaTurn?: MetaTurnObservation
  failure?: { phase: string; message: string }
}

export interface MetaTurnObservation {
  reason: string
  error?: { message: string; code?: string }
  turn?: number
  durationMs?: number
  effectiveMaxTokens?: number
  usage?: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
  }
}

export interface CandidateRecord {
  candidateId: string
  roundId: string
  parentHarnessRef: HarnessRef
  parentCandidateIds: string[]
  metaSessionId?: string
  parentCheckpoint?: MetaCheckpointRef
  resultCheckpoint?: MetaCheckpointRef
  workspaceId?: string
  sealedVersion?: SealedCandidateVersion
  proposal?: CandidateFinalization
  decline?: CandidateDecline
  diff?: CandidateDiffSummary
  meta?: MetaAttribution
  proposalEvidence?: ProposalEvidenceAudit
  seedEvaluation?: EvaluationEvidence
  seedComparison?: CandidateSeedComparison
  heldOutEvaluation?: EvaluationEvidence
  metrics?: MetricSet
  generationAttempts?: CandidateGenerationAttempt[]
  failure?: { phase: string; message: string }
  status: 'generating' | 'ready' | 'evaluating' | 'selected' | 'discarded' | 'failed'
}

export interface CandidateSeedComparison {
  parentBaselineEvalId: string
  pairedTrials: PairedTrial[]
  pairing: PairingAudit
  scoreDelta: number
  processScoreDelta?: number
  requiredRegressions: number
}

/** The complete seed-only projection visible to selection components. */
export interface CandidateSelectionInput {
  candidateId: string
  parentHarnessRef: HarnessRef
  parentCandidateIds: string[]
  sealedVersion: SealedCandidateVersion
  seedEvaluation: EvaluationEvidence
  seedComparison: CandidateSeedComparison
  metrics: MetricSet
}

export interface CandidateAssessmentRequest {
  evolutionId: EvolutionId
  roundId: string
  candidates: readonly CandidateSelectionInput[]
}

export interface CandidateAssessmentContext {
  trajectoryReader?: HitchTrajectoryReader
}

export interface CandidateAssessmentUsage {
  modelRequests: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
  reasoningTokens?: number
}

export interface CandidateAssessmentResult {
  candidateMetrics: Record<string, MetricSet>
  rankingCandidateIds?: string[]
  reason: string
  evidence: JsonValue
  usage?: CandidateAssessmentUsage
}

export interface CandidateAssessment extends CandidateAssessmentResult {
  component: ComponentRef<unknown>
  digest: string
}

export interface CandidateSelectionRequest {
  candidates: readonly CandidateSelectionInput[]
  survivors: number
  assessment: CandidateAssessment
}

export interface SelectionDecision {
  selectedCandidateIds: string[]
  promotionCandidateId: string
  reason: string
  component: ComponentRef<unknown>
  assessmentDigest: string
  metrics: Record<string, number>
}

export interface MetricSet {
  quality: number
  taskSuccessRate: number
  cost?: number
  latency?: number
  safety?: number
  trajectoryDiversity?: number
  descriptors?: Record<string, string | number>
}

export interface PopulationMember {
  candidateId: string
  harnessRef: HarnessRef
  harnessDigest: string
  parentCandidateIds: string[]
  lineageRootId: string
  metaSessionId?: string
  metaCheckpoint?: MetaCheckpointRef
  metrics: MetricSet
  selectedAt: string
}

export interface ParentAllocation {
  candidateId: string
  parentCandidateId: string
  parentHarnessRef: HarnessRef
  parentHarnessDigest: string
}

export interface ParentSeedBaseline {
  parentCandidateId: string
  parentHarnessRef: HarnessRef
  evidence: EvaluationEvidence
}

export interface RoundCommitIntent {
  expectedPopulationDigest: string
  nextPopulation: PopulationState
  expectedChampionRef: HarnessRef
  nextChampion?: ChampionState
  decision: 'accepted' | 'rejected'
  promotionCandidateId: string
  phase: 'prepared' | 'population-committed' | 'champion-committed'
}

export interface PopulationState {
  evolutionId: EvolutionId
  generation: number
  members: PopulationMember[]
  digest: string
}

export interface RefinementRound {
  candidateGenerationDeadlineAt?: number
  evolutionId: EvolutionId
  roundId: string
  workspaceRoot: string
  status: RoundStatus
  source: 'command' | 'target' | 'api' | 'skill'
  createdAt: string
  updatedAt: string
  metaHarnessRef: MetaHarnessRef
  targetHarnessRef: HarnessRef
  targetHarnessDigest: string
  sandboxProfileRef: SandboxProfileRef
  seedTaskRef: string
  heldOutRef: string
  taskBudgetMs: number
  promotionPolicy: PromotionPolicy
  batchId: string
  roundIndex: number
  roundCount: number
  advisoryFocus?: SemanticTarget[]
  plan: ResolvedRoundPlan
  parentPopulationDigest?: string
  parentAllocations?: ParentAllocation[]
  parentBaselines?: ParentSeedBaseline[]
  baseline?: EvaluationEvidence
  failedEvaluations?: FailedEvaluationRecord[]
  finalization?: CandidateFinalization | null
  decline?: CandidateDecline
  candidatePool: CandidateRecord[]
  selectionAssessment?: CandidateAssessment
  selection?: SelectionDecision
  promotionCandidateId?: string
  promotedCandidateId?: string
  evaluation?: RoundEvaluation
  evaluationAttempts?: RoundEvaluationAttempt[]
  pendingEvaluationSubmissions?: PendingEvaluationSubmission[]
  pendingEvaluationRerun?: PendingEvaluationRerun
  evaluationRepairResume?: EvaluationRepairResumeIntent
  commitIntent?: RoundCommitIntent
  meta?: MetaAttribution
  proposalEvidence?: ProposalEvidenceAudit
  decision?: 'accepted' | 'rejected' | 'rejected-for-substrate' | 'no-change'
  failure?: { phase: string; message: string }
}

export interface AdmissionResult {
  evolutionId: EvolutionId
  batchId: string
  roundId: string
  status: 'queued'
}

export interface PublicRoundStatus {
  evolutionId: EvolutionId
  batchId: string
  roundId: string
  status: RoundStatus
  decision?: 'accepted' | 'rejected' | 'rejected-for-substrate' | 'no-change'
  seedSummary?: ScoreSummary
  seedBaseline?: PublicSeedEvidence
  seedCandidate?: PublicSeedEvidence
  failure?: string
  evaluationCleanupFailures?: Array<{ provider: string; evalId?: string; rerunId?: string; code: string }>
  candidateGeneration?: Array<{
    candidateId: string
    status: CandidateRecord['status']
    attempts: Array<Pick<CandidateGenerationAttempt,
      'attempt' | 'status' | 'startedAt' | 'completedAt' | 'metaSessionId' | 'metaTurn' | 'failure'>>
  }>
  repairableEvaluations?: Array<{
    provider: string
    evalId: string
    phase: EvaluationPhase
    candidateId: string
    repetitions: number
  }>
}

export interface PublicSeedEvidence {
  evalId: string
  completeness: 'complete' | 'partial'
  plannedTrialCount: number
  primaryReward: number
  processScore?: number
  summary: ScoreSummary
  trials: Array<{
    taskName: string
    trialName?: string
    runId?: string
    attempt?: number
    status: 'completed' | 'errored'
    reward?: number
    scores?: EvaluationTrialScores
    invalidReason?: string
  }>
}

export interface PromotionPolicy {
  minimumCandidateScore: number
  minimumAbsoluteGain: number
  requireNoRegression: boolean
  maxHeldOutRegression: number
  maxRequiredRegressions: number
  requiredTaskIds?: string[]
}

export interface RefineEvaluator {
  preflight?(): Promise<void>

  /** Resolve semantic evaluation identity plus diagnostic invocation provenance, or return undefined when not known yet. */
  evaluationIdentity?(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
    signal?: AbortSignal,
  ): {
    provider: string
    effectiveConfigDigest: string
    invocationFingerprint?: string
  } | undefined | Promise<{
    provider: string
    effectiveConfigDigest: string
    invocationFingerprint?: string
  } | undefined>

  prepareSubmission?(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
  ): EvaluationSubmissionIntent | undefined

  reserve?(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
    signal?: AbortSignal,
    intent?: Readonly<EvaluationSubmissionIntent>,
  ): Promise<EvaluationReservation>

  /** Resolves once remote cancellation is durably accepted (or the eval is terminal). */
  cancelReservation?(
    reservation: Readonly<EvaluationReservation>,
    intent?: Readonly<EvaluationSubmissionIntent>,
  ): Promise<void>

  recoverReservation?(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
    signal: AbortSignal,
    intent: Readonly<EvaluationSubmissionIntent>,
  ): Promise<EvaluationReservation>

  evaluate(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
    signal: AbortSignal,
    reservation?: Readonly<EvaluationReservation>,
  ): Promise<EvaluationEvidence>

  prepareRerun?(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
    attempt: Readonly<RoundEvaluationAttempt>,
    selector: Readonly<EvaluationRerunSelector>,
  ): EvaluationRerunReservation | undefined

  /** Resolves only when the rerun has stopped, including remote resource cleanup. */
  cancelRerun?(reservation: Readonly<EvaluationRerunReservation>): Promise<void>

  rerun?(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
    attempt: Readonly<RoundEvaluationAttempt>,
    selector: Readonly<EvaluationRerunSelector>,
    signal: AbortSignal,
    reservation?: Readonly<EvaluationRerunReservation>,
  ): Promise<EvaluationRerunResult>
}

export interface PreparedHarness {
  ref: HarnessRef
  digest: string
  treeOid: GitObjectId
  immutableRef: string
  repositoryPath: string
  manifest: HarnessManifest
}

export interface RefineBridgeRequestMap {
  'harness.current': Record<string, never>
  'harness.read': { ref: string; path: string; offset?: number; limit?: number }
  'seed_tasks.load': { partition?: 'seed' }
  'trajectory.query': {
    refs?: string[]
    detailRef?: string
    find?: string
  }
  'hitch.status': { roundId: string }
  'candidate.diff': { maxBytes?: number }
  'candidate.check': { check?: string }
  'candidate.finalize': CandidateFinalization
  'candidate.decline': { rationale: string; evidenceRefs: EvidenceRef[] }
  'refine.run': { reason?: string }
  'refine.status': { evolutionId: string; roundId?: string }
}

export type SessionRole = 'refine-meta' | 'target' | 'rollout'

export function isExactGitCommit(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)
}
