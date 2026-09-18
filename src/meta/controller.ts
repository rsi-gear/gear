import type {
  CandidateRecord,
  CandidateGenerationBudgetStatus,
  DiagnosisReceipt,
  EvaluationEvidence,
  MetaAttribution,
  MetaAgentSpec,
  MetaCheckpointRef,
  MetaTurnObservation,
  ProposalEvidenceAudit,
  RefinementRound,
} from '../types.js'
import { digestJson } from '../state/digest.js'

/** Opaque session identity owned by a Meta harness adapter. */
export interface MetaAgentSession {
  id: string
}

export interface MetaWakeHandle {
  sessionId: string
  /**
   * Present when the adapter can observe the owned Meta turn reaching idle.
   * Skill-driven adapters omit it because completion happens out of process.
   */
  completion?: Promise<MetaTurnObservation>
}

export interface MetaExecutionBinding {
  executionId: string
  attempt: number
  deadlineAt: number
  generationBudget?: CandidateGenerationBudgetStatus
  signal: AbortSignal
  budget: { maxModelRequests?: number; maxTokens?: number }
  isComplete(): boolean
  /** Called only after old tools and processes have settled. */
  snapshot(): Promise<unknown>
  /** Synchronous permission switch after the durable owner CAS. */
  activate(sourceSessionId: string, successorSessionId: string, generation: number): void | Promise<void>
}

/**
 * New skill profiles omit maxTokens, but a resumed evolution must keep using
 * the value sealed in its immutable spec. Every other identity field remains
 * exact, and an explicitly configured current maxTokens must still match.
 */
export function compatibleSkillMetaAgent(sealed: MetaAgentSpec, current: MetaAgentSpec): boolean {
  const compatibleCurrent = current.model.maxTokens === undefined && sealed.model.maxTokens !== undefined
    ? { ...current, model: { ...current.model, maxTokens: sealed.model.maxTokens } }
    : current
  return digestJson(sealed) === digestJson(compatibleCurrent)
}

/**
 * Harness-neutral contract consumed by the refinement control plane.
 *
 * DSH, a skill-driven external agent, or another harness adapter can own the
 * actual session and context implementation. RefineService only relies on the
 * durable identities and lifecycle operations below.
 */
export interface MetaSessionController {
  /** True only when every proposal request is metered and stopped at the binding's aggregate limits. */
  readonly capabilities?: { aggregateGenerationBudget: boolean }
  agent(): Promise<MetaAgentSession>
  checkpoint(sessionId?: string): Promise<MetaCheckpointRef>
  fork(checkpoint: MetaCheckpointRef): Promise<MetaAgentSession>
  restore?(sessionId: string, executionId?: string): Promise<MetaAgentSession>
  /** Resolve only after the owned execution is quiescent or proven absent; reject if its state is uncertain. */
  cancel(sessionId: string, reason: string): Promise<void>
  release(sessionId: string): Promise<void>
  dispose(): Promise<void>
  wake(round: Readonly<RefinementRound>): Promise<string>
  wakeCandidate(
    round: Readonly<RefinementRound>,
    candidate: Readonly<CandidateRecord> | undefined,
    baseline: EvaluationEvidence | undefined,
    session: MetaAgentSession,
    execution?: MetaExecutionBinding,
  ): Promise<MetaWakeHandle>
  activeRoundId(sessionId: string): string | undefined
  recordEvidenceAccess(
    roundId: string,
    sessionId: string,
    access: {
      summary?: boolean
      refs?: readonly string[]
      diagnosedRunRefs?: readonly string[]
      diagnosisReceipts?: readonly DiagnosisReceipt[]
    },
  ): void
  proposalEvidenceAudit(roundId: string, sessionId: string, citedRefs: readonly string[]): ProposalEvidenceAudit
  proposalAttribution(roundId: string, sessionId: string, mutation: unknown): MetaAttribution | Promise<MetaAttribution>
}
