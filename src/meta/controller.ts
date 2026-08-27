import type {
  CandidateRecord,
  EvaluationEvidence,
  MetaAttribution,
  MetaCheckpointRef,
  ProposalEvidenceAudit,
  RefinementRound,
} from '../types.js'

/** Opaque session identity owned by a Meta harness adapter. */
export interface MetaAgentSession {
  id: string
}

/**
 * Harness-neutral contract consumed by the refinement control plane.
 *
 * DSH, a skill-driven external agent, or another harness adapter can own the
 * actual session and context implementation. RefineService only relies on the
 * durable identities and lifecycle operations below.
 */
export interface MetaSessionController {
  agent(): Promise<MetaAgentSession>
  checkpoint(sessionId?: string): Promise<MetaCheckpointRef>
  fork(checkpoint: MetaCheckpointRef): Promise<MetaAgentSession>
  cancel(sessionId: string, reason: string): Promise<void>
  release(sessionId: string): Promise<void>
  dispose(): Promise<void>
  wake(round: Readonly<RefinementRound>): Promise<string>
  wakeCandidate(
    round: Readonly<RefinementRound>,
    candidate: Readonly<CandidateRecord> | undefined,
    baseline: EvaluationEvidence | undefined,
    session: MetaAgentSession,
  ): Promise<string>
  activeRoundId(sessionId: string): string | undefined
  recordEvidenceAccess(
    roundId: string,
    sessionId: string,
    access: { summary?: boolean; refs?: readonly string[]; diagnosedRunRefs?: readonly string[] },
  ): void
  proposalEvidenceAudit(roundId: string, sessionId: string, citedRefs: readonly string[]): ProposalEvidenceAudit
  proposalAttribution(roundId: string, sessionId: string, mutation: unknown): MetaAttribution | Promise<MetaAttribution>
}
