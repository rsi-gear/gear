import type {
  AlgorithmState,
  Json,
  Candidate,
  Decision,
  Evidence,
  OperationResult,
  SearchView,
  Task,
} from './algorithm-wire.js'
export interface AlgorithmConfig {
  name: string
  options: Record<string, Json>
  /** Recursive author component tree. Older frozen runs retain name/options only. */
  component?: Record<string, Json>
  protocol_version?: 1 | 2
  requirements?: string[]
}
import type {
  OperationReceipt,
  OperationRequest,
  EnvironmentBindingRecovery,
  ProviderCapabilities,
  ProviderTimeouts,
} from '../ports/operations.js'
import type { CompiledBenchmark } from './project.js'
import type { ObjectiveConfiguration } from './objective.js'
import type { EvaluationRepairPolicy } from './evaluation.js'
import type { GenerationBudget, GenerationConfiguration } from './generation-budget.js'
import type { BaselineReuse } from './baseline.js'
import type { ArtifactReaderDescriptor } from './trajectory.js'
import type { OperatorJournal, OperatorPolicy } from './operator-run.js'
import type * as V2 from './algorithm-wire-v2.js'

export interface RunSpec {
  version: 1
  kind: 'evaluate' | 'refine'
  benchmarkDigest: string
  configDigest: string
  implementationIdentity: string
  providerIdentity: string
  cancellationIdentity?: string
  evaluationIdentity?: string
  artifactReader?: ArtifactReaderDescriptor
  baseline?: BaselineReuse
  providerCapabilities?: ProviderCapabilities
  providerTimeouts?: ProviderTimeouts
  taskTimeouts?: CompiledBenchmark['execution_timeouts']
  /** Admission observes one global revision; content equality alone is not a CAS token. */
  championRevision: string | null
  targetSourceDigest: string
  lineage: { runId: string; candidateId: string } | null
  algorithm: AlgorithmConfig
  validationMode: 'holdout' | 'research'
  seed: string
  seedTasks: Task[]
  heldOutTaskIds: string[]
  anchor: Candidate
  budget: { rounds: number; maxEvaluations: number; maxCandidates: number; repetitions: number }
  acceptance: { minimumGain: number; maxHeldOutRegression: number }
  objective?: ObjectiveConfiguration
  objectiveIdentity?: string
  evaluationRepair: EvaluationRepairPolicy
  generationBudget: GenerationBudget
  operatorPolicy?: OperatorPolicy
}
export interface JournalOperation {
  request: OperationRequest
  status: 'reserved' | 'submitted' | 'complete'
  reservedAttempts: number
  receipt?: OperationReceipt
  /** A bound receipt that violated metering limits; never enters algorithm evidence. */
  generationViolation?: { reason: string; receipt: OperationReceipt }
  /** Persisted before any backoff wait so a restart never resets the delay. */
  notBefore?: number
  repairBlocked?: 'retries-disabled' | 'attempts-exhausted' | 'budget-exhausted'
  projectionBlocked?:
    | 'provider-unsupported'
    | 'projections-disabled'
    | 'attempts-exhausted'
    | 'metric-unsupported'
    | 'assertion-unsupported'
}
export interface JournalDecision {
  stepId: number
  inputDigest: string
  decision: Decision
  operationIds: string[]
}
export interface ResumeOptions {
  /** Retry this settled, failed read-only Meta attempt with a new operation ID. */
  retry_operation?: string
  /** Explicit increases to the run's cumulative and per-operation limits. */
  generation?: GenerationConfiguration
  /** Original public environment binding; the provider must prove all other inputs unchanged. */
  environment_binding?: Json
}
export interface MetaRecovery {
  version: 1
  id: string
  createdAt: string
  requestDigest: string
  generationUpdate: GenerationBudget
  environmentBinding?: Json
  execution?: EnvironmentBindingRecovery
  cancellationIdentity?: string
  sourceJournalDigest: string
  sourceOperationId: string
  sourceReceiptDigest: string
  operationId: string
  callId: string
  previousResult: V2.CallResult
  stateDigest: string
  terminalStepId: number | null
  generationBudget: GenerationBudget
  stopped: true
}
export interface RunJournal {
  version: 1
  id: string
  createdAt: string
  spec: RunSpec
  specDigest: string
  generation: number
  status: 'ready' | 'running' | 'needs_recovery' | 'cancelled' | 'completed'
  state: AlgorithmState
  decisions: JournalDecision[]
  operations: JournalOperation[]
  candidates: Candidate[]
  seedEvidence: Evidence[]
  heldOutEvidence: Evidence[]
  completed: OperationResult[]
  nomineeId: string | null
  championId: string
  gate: { status: 'accepted' | 'rejected' | 'incomplete' | 'not_run'; reason: string }
  physicalAttempts: number
  operators?: OperatorJournal
  /** Explicit recoveries preserve failed attempts and never reset their usage. */
  metaRecoveries?: MetaRecovery[]
  failure?: { code: string; message: string; retryable: boolean }
  digest: string
}
export interface AlgorithmDriver {
  stepV2?(
    view: V2.SearchView,
    state: V2.AlgorithmState,
    algorithm: AlgorithmConfig,
    signal: AbortSignal,
  ): Promise<V2.Decision>
  step(
    view: SearchView,
    state: AlgorithmState,
    algorithm: AlgorithmConfig,
    signal: AbortSignal,
  ): Promise<Decision>
}
