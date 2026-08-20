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
  dshRevision: string
  toolchainRef: string
  sandboxProfileRef: SandboxProfileRef
  artifacts: HarnessArtifact[]
  digest: string
}

export interface ChampionState {
  ref: HarnessRef
  digest: string
  artifactPath: string
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
  | 'candidate-running'
  | 'promoting'
  | 'accepted'
  | 'rejected'
  | 'failed'

export interface ScoreSummary {
  total: number
  passed: number
  failed: number
  score: number
  metrics?: Record<string, number>
}

export interface EvaluationEvidence {
  ref: EvidenceRef
  summary: ScoreSummary
  trajectoryRefs: EvidenceRef[]
  runtimeFingerprint: string
}

export interface CandidateEvaluation {
  baseline: ScoreSummary
  candidate: ScoreSummary
  heldOutDelta: number
  requiredRegressions: number
  infrastructureOk: boolean
  parityFingerprint: string
  evidenceRefs: EvidenceRef[]
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
  schemaVersion: 1
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
  baseline?: EvaluationEvidence
  mutation?: HarnessMutation | null
  candidateRef?: HarnessRef
  candidateDigest?: string
  candidateArtifactPath?: string
  evaluation?: CandidateEvaluation
  meta?: MetaAttribution
  decision?: 'accepted' | 'rejected' | 'no-change'
  failure?: { phase: string; message: string }
}

export interface AdmissionResult {
  roundId: string
  status: 'queued'
}

export interface PublicRoundStatus {
  roundId: string
  status: RoundStatus
  decision?: 'accepted' | 'rejected' | 'no-change'
  seedSummary?: ScoreSummary
  failure?: string
}

export interface PromotionPolicy {
  minimumCandidateScore: number
  minimumAbsoluteGain: number
  requireNoRegression: boolean
  maxHeldOutRegression: number
  maxRequiredRegressions: number
}

export interface RefineEvaluator {
  evaluateBaseline(round: Readonly<RefinementRound>, signal: AbortSignal): Promise<EvaluationEvidence>
  evaluateCandidate(
    round: Readonly<RefinementRound>,
    candidate: Readonly<PreparedHarness>,
    signal: AbortSignal,
  ): Promise<CandidateEvaluation>
}

export interface PreparedHarness {
  ref: HarnessRef
  digest: string
  artifactPath: string
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
