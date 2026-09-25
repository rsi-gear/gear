import type { resolveSizing } from './contracts.js'
import type { ScopeEpochPreparation } from './epochs.js'
import type { profile } from './evidence.js'
import type { RemainingBudget } from './store.js'
import type { BridgeSelectionDecision, CandidateWorkPlan, EvaluationStageDecision, GateDecision, ParentSelectionDecision, ResearchArchive, ResearchFinding, Snapshot } from './types.js'

export interface SearchEvolutionIdentity {
  protocolVersion?: 2
  evolutionId: string
  settingsDigest: string
  maxCandidates: number
  seedUniverseDigest: string
  heldOutUniverseDigest: string
  providerIntegrity: string
  diagnosisIntegrity: string
  sanitizationPolicyDigest: string
  algorithmIntegrity: string
  parentPolicy?: import('../types.js').ComponentRef<unknown>
  digest: string
}
export class SearchEvidencePending extends Error {
  constructor(readonly planDigest: string) { super(`search stage needs evidence repair: ${planDigest}`); this.name = 'SearchEvidencePending' }
}
export interface SearchRoundOutcome {
  schemaVersion: 2
  roundId: string
  /** Seed research artifact; an unsuccessful bootstrap is not installed as the parent archive. */
  archiveDigest: string
  championAnchorDigest: string
  nomineeId?: string
  promotion?: GateDecision
  championChanged: boolean
  advisory: boolean
  /** Preserves evidence provenance when research champion updates are authorized. */
  validationMode?: 'independent-held-out' | 'shared-set-research'
  reasonCodes: string[]
  findings: ResearchFinding[]
  research: {
    sizing: ReturnType<typeof resolveSizing>
    parents: ParentSelectionDecision
    workplans: CandidateWorkPlan[]
    scopeViews: ResearchArchive['scopeViews']
    parentProbabilities: Record<string, number>
    bridge: BridgeSelectionDecision & { digest: string }
    scopePreparation: ScopeEpochPreparation
    stageDecisions: EvaluationStageDecision[]
    candidates: Array<{ candidateId: string; scopeDigest: string; profile: ReturnType<typeof profile>; expansion: 'global-nominee' | 'not-selected-for-expansion' | 'requires-broader-evaluation' }>
    remainingBudget: RemainingBudget
  }
  digest: string
}
export interface CommitIntent {
  expectedArchiveDigest: string
  nextArchiveDigest: string
  expectedChampionRevisionDigest: string
  nextChampion?: Snapshot
  outcome: SearchRoundOutcome
  digest: string
}
