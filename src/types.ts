import type { JsonValue } from '@deepseek-ai/dsh-session'

export type HarnessRef = string
export type MetaHarnessRef = string
export type SandboxProfileRef = string
export type EvidenceRef = string

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

export type ArtifactOp =
  | { type: 'create'; path: string; content: string; expect: 'absent' }
  | { type: 'patch'; path: string; patch: string; expectedDigest: string }
  | { type: 'delete'; path: string; expectedDigest: string }

export interface HarnessMutation {
  parentRef: HarnessRef
  parentDigest: string
  target: SemanticTarget
  ops: ArtifactOp[]
  rationale: string
  evidenceRefs: EvidenceRef[]
  expectedOutcome: string
}

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
  sessionId: string
  metaHarnessRef: MetaHarnessRef
}

export type RoundStatus =
  | 'queued'
  | 'baseline-running'
  | 'waiting-proposal'
  | 'building-candidate'
  | 'candidate-seed-running'
  | 'held-out-running'
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

export interface HitchTrialSummary {
  taskName: string
  trialName?: string
  runId?: string
  attempt?: number
  status: 'completed' | 'errored'
  rewards: Record<string, number>
}

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

export interface HitchEvaluationEvidence {
  evalId: string
  dataset: string
  requestedCommit: HarnessRef
  actualCommit: HarnessRef
  revisionIdentity: string
  invocationFingerprint: string
  primaryReward: number
  summary: ScoreSummary
  trials: HitchTrialSummary[]
  localSourceTransport: LocalSourceTransportSummary
}

export type EvaluationPhase = 'seed-baseline' | 'seed-candidate' | 'held-out-baseline' | 'held-out-candidate'

export interface EvaluationRequest {
  phase: EvaluationPhase
  dataset: string
  harnessRef: HarnessRef
}

export interface RoundEvaluation {
  seedBaseline: HitchEvaluationEvidence
  seedCandidate: HitchEvaluationEvidence
  heldOutBaseline?: HitchEvaluationEvidence
  heldOutCandidate?: HitchEvaluationEvidence
  scoreDelta: number
  heldOutScoreDelta?: number
  requiredRegressions: number
}

export interface MetaAttribution {
  sessionId: string
  requestHeaderSeq: number
  proposalEventSeq: number
  provider?: string
  model?: string
  maxTokens?: number
  sampling?: JsonValue
}

export interface RefinementRound {
  schemaVersion: 2
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
  requestedTarget?: SemanticTarget
  baseline?: HitchEvaluationEvidence
  mutation?: HarnessMutation | null
  candidateRef?: HarnessRef
  candidateDigest?: string
  evaluation?: RoundEvaluation
  meta?: MetaAttribution
  decision?: 'accepted' | 'rejected' | 'rejected-for-substrate' | 'no-change'
  failure?: { phase: string; message: string }
}

export interface AdmissionResult {
  roundId: string
  status: 'queued'
}

export interface PublicRoundStatus {
  roundId: string
  status: RoundStatus
  decision?: 'accepted' | 'rejected' | 'rejected-for-substrate' | 'no-change'
  seedSummary?: ScoreSummary
  failure?: string
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
  evaluate(
    round: Readonly<RefinementRound>,
    request: Readonly<EvaluationRequest>,
    signal: AbortSignal,
  ): Promise<HitchEvaluationEvidence>
}

export interface PreparedHarness {
  ref: HarnessRef
  digest: string
  repositoryPath: string
  manifest: HarnessManifest
}

export interface RefineBridgeRequestMap {
  'harness.current': Record<string, never>
  'harness.read': { ref: string; path: string; offset?: number; limit?: number }
  'seed_tasks.load': { partition?: 'seed' }
  'trajectory.query': { refs?: string[]; offset?: number; limit?: number }
  'hitch.status': { roundId: string }
  'submit_refinement_proposal': { roundId: string; mutation: HarnessMutation | null }
  'refine.run': { reason?: string }
  'refine.status': { roundId: string }
}

export type SessionRole = 'refine-meta' | 'target' | 'rollout'

export function isExactGitCommit(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)
}
