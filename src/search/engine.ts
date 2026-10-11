/** Public FailureClusterSearch entry. Completed legacy rounds remain readable; active legacy
 * runs require their original sealed runtime and dependency closure. */
export { CampaignFailureClusterSearch, CampaignFailureClusterSearch as FailureClusterSearch } from './campaign-engine.js'
export { SearchEvidencePending } from './outcomes.js'
export type { SearchEvolutionIdentity, SearchRoundOutcome, CommitIntent } from './outcomes.js'
export type { GeneratedCandidate, SearchAdmission, SearchExecutionHooks } from './runtime.js'
