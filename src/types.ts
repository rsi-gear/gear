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
}

export interface CandidateGenerationSpec {
  strategy: ComponentRef<unknown>
  maxCandidates: number
  budget: {
    maxModelRequests?: number
    maxTokens?: number
    timeoutMs: number
  }
}

export interface RolloutSpec {
  provider: ComponentRef<unknown>
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
  metaAgent: DshMetaAgentSpec
  candidateGeneration: CandidateGenerationSpec
  rollout: RolloutSpec
  evaluation: {
    judges: ComponentRef<unknown>[]
    primaryMetric: string
  }
  selection: {
    strategy: ComponentRef<unknown>
    survivors: number
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
}

export interface EvaluationTrialSummary {
  taskName: string
  trialName?: string
  runId?: string
  attempt?: number
  status: 'completed' | 'errored'
  rewards: Record<string, number>
}

export type HitchTrialSummary = EvaluationTrialSummary

export interface HitchTrajectoryPage {
  runId: string
  fidelity: 'provider_native' | 'normalized' | 'minimal'
  provider?: string
  sessionId: string
  header: JsonValue
  events: JsonValue[]
  offset: number
  limit: number
  total: number
  eof: boolean
  diagnostics: TrajectoryDiagnostics
}

export interface TrajectoryDiagnostics {
  totalEvents: number
  eventTypes: Record<string, number>
  toolCalls: number
  toolResults: number
  toolErrors: number
  errorExcerpts: Array<{ seq?: number; type: string; excerpt: string }>
  finalAssistantExcerpts: Array<{ seq?: number; excerpt: string }>
}

export interface HitchTrajectoryReader {
  inspectTrajectory(runId: string, offset: number, limit: number, signal: AbortSignal): Promise<HitchTrajectoryPage>
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
  effectiveConfigDigest: string
  evalId: string
  dataset: string
  requestedCommit: HarnessRef
  actualCommit: HarnessRef
  revisionIdentity: string
  invocationFingerprint?: string
  primaryReward: number
  summary: ScoreSummary
  trials: EvaluationTrialSummary[]
  localSourceTransport?: LocalSourceTransportSummary
  metadata?: JsonValue
}

export interface HitchEvaluationEvidence extends EvaluationEvidence {
  invocationFingerprint: string
  localSourceTransport: LocalSourceTransportSummary
}

export type EvaluationPhase = 'seed-baseline' | 'seed-candidate' | 'held-out-baseline' | 'held-out-candidate'

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

export type EvaluationRerunSelector =
  | { mode: 'invalid' }
  | { mode: 'tasks'; taskNames: string[] }

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
}

export interface RoundEvaluation {
  seedBaseline: EvaluationEvidence
  seedCandidate: EvaluationEvidence
  seedPairedTrials: PairedTrial[]
  heldOutBaseline?: EvaluationEvidence
  heldOutCandidate?: EvaluationEvidence
  heldOutPairedTrials?: PairedTrial[]
  promotionMetrics?: MetricSet
  scoreDelta: number
  heldOutScoreDelta?: number
  requiredRegressions: number
}

export interface MetaAttribution {
  evolutionId: EvolutionId
  sessionId: string
  requestHeaderSeq: number
  proposalEventSeq: number
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
  failure?: { phase: string; message: string }
  status: 'generating' | 'ready' | 'evaluating' | 'selected' | 'discarded' | 'failed'
}

export interface CandidateSeedComparison {
  parentBaselineEvalId: string
  pairedTrials: PairedTrial[]
  scoreDelta: number
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

export interface SelectionDecision {
  selectedCandidateIds: string[]
  promotionCandidateId: string
  reason: string
  component: ComponentRef<unknown>
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
  evolutionId: EvolutionId
  roundId: string
  workspaceRoot: string
  status: RoundStatus
  source: 'command' | 'target' | 'api'
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
  finalization?: CandidateFinalization | null
  decline?: CandidateDecline
  candidatePool: CandidateRecord[]
  selection?: SelectionDecision
  promotionCandidateId?: string
  promotedCandidateId?: string
  evaluation?: RoundEvaluation
  evaluationAttempts?: RoundEvaluationAttempt[]
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
  primaryReward: number
  summary: ScoreSummary
  trials: Array<{
    taskName: string
    trialName?: string
    runId?: string
    attempt?: number
    status: 'completed' | 'errored'
    reward?: number
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

  reserve?(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
  ): Promise<EvaluationReservation>

  evaluate(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
    signal: AbortSignal,
    reservation?: Readonly<EvaluationReservation>,
  ): Promise<EvaluationEvidence>

  rerun?(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
    attempt: Readonly<RoundEvaluationAttempt>,
    selector: Readonly<EvaluationRerunSelector>,
    signal: AbortSignal,
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
  'trajectory.query': { roundId?: string; refs?: string[]; offset?: number; limit?: number }
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
