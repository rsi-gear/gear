import type { AssertionContract } from '../domain/assertions.js'
import type { RawMetricContract } from '../domain/objective.js'
import type { Evidence, Operation, OperationReceipt, Json } from '../domain/algorithm-wire.js'
import type { GenerationLimits } from '../domain/generation-budget.js'
import type { ExperienceContext } from '../domain/experience.js'
import type { ArtifactReaderDescriptor } from '../domain/trajectory.js'
import type { CandidateEffect, MetaEffect } from '../domain/algorithm-wire-v2.js'
import type {
  ExecutionTarget,
  OperatorArtifact,
  OperatorMaterial,
  TargetExecution,
} from '../domain/operator-run.js'
export type { OperationReceipt } from '../domain/algorithm-wire.js'

export interface TimeoutLimit {
  name: string
  scope: 'provider-call' | 'evaluation' | 'meta-operation'
  milliseconds: number
}
export interface ProviderTimeouts {
  taskRuntime?: 'harbor' | 'provider-defined'
  target: TimeoutLimit[] | null
  meta: TimeoutLimit[] | null
}

export interface ProviderCapabilities {
  seeds: boolean
  temperature: boolean
  subsets: boolean
  idempotentSubmission: boolean
  inspect: boolean
  cancel: boolean
  physicalAttemptAccounting: boolean
  hardDollarBudget: boolean
  /** Enforces request/token reservations across all calls, retries and summaries in one Meta operation. */
  generationBudget: boolean
  evidenceProjection: boolean
  /** Understands the v2 author-owned Meta prompt/schema and read-only source manifest. */
  operatorMeta?: boolean
  /** Target status and artifacts are projected independently of verifier outcomes. */
  blindProjection?: boolean
  targetAssets?: boolean
}
export interface OperationRequest {
  operationId: string
  runId: string
  generation: number
  operation: Operation
  partition: 'seed' | 'held_out'
  repetitions: number
  slots: Array<{ taskId: string; repetition: number }>
  /** Seed feedback for Meta, or original observations for a target-only projection. */
  evidence: Evidence[]
  metrics?: RawMetricContract[]
  assertions?: AssertionContract[]
  /** Core-owned Meta allowance, persisted before submission; never supplied by an algorithm. */
  generationLimits?: GenerationLimits
  /** Frozen core-owned seed memory. Bound before submission; not an algorithm payload. */
  experience?: ExperienceContext
  /** Bound by v2 runtime, never inferred from arbitrary legacy payloads. */
  operatorCall?: {
    version: 2
    callId: string
    effect: MetaEffect | CandidateEffect
    materials: OperatorMaterial[]
  }
  /** Separates explicit author samples from the independently frozen final gate. */
  operatorSamples?: {
    callId: string
    sampleIds: string[]
    executionIdentity: string
    exposure?: 'scored' | 'blind'
  }
  /** Core-sealed runnable overlay; providers must execute this target when present. */
  executionTarget?: ExecutionTarget
  /** Core-owned execution repair; never an instruction supplied by an algorithm. */
  repair?: { rootOperationId: string; previousOperationId: string; attempt: number }
  projection?: {
    rootOperationId: string
    rootRequestDigest: string
    rootProvenanceDigest: string
    sourceOperationId: string
    sourceReceiptDigest: string
    attempt: number
    missing: Array<{ taskId: string; repetition: number; metrics: string[]; assertions?: string[] }>
  }
}
export type OperationInspection =
  | { state: 'complete'; receipt: OperationReceipt }
  | { state: 'not_submitted' }
  /** Some groups completed; replay is safe with the original idempotent reservation. */
  | { state: 'resumable' }
  | { state: 'running' | 'unknown' }
export interface ExecutionIdentity {
  provider: string
  evaluation: string
}
export interface EnvironmentBindingRecovery {
  version: 1
  from: ExecutionIdentity
  to: ExecutionIdentity
  previousBinding: Json
  currentBinding: Json
  invariantDigest: string
}
/** Evaluation/generation adapters own external side effects, never the run journal. */
export interface OperationProvider {
  readonly identity: string
  /** Private durable connection data used only to stop admitted work after a restart. */
  readonly cancellation?: Json
  /** Initialize private operation control once, before persisting a new run; never on resume. */
  prepareAdmission?(): Promise<void>
  readonly artifactReader?: ArtifactReaderDescriptor | undefined
  /** Target execution conditions; independent of the Meta profile used in a refinement. */
  readonly evaluationIdentity?: string
  /** Operator metadata for the exact connected configuration; null means unreported. */
  readonly timeouts?: ProviderTimeouts
  readonly capabilities: ProviderCapabilities
  /** Prove that only a host environment binding changed; never relax code/model/task identities. */
  recoverEnvironmentBinding?(
    previous: ExecutionIdentity,
    binding: Json,
    signal: AbortSignal,
  ): Promise<EnvironmentBindingRecovery>
  submit(request: OperationRequest, signal: AbortSignal): Promise<OperationReceipt>
  /** Read existing artifacts only. Must not execute targets or issue model requests. */
  completeEvidence?(request: OperationRequest, signal: AbortSignal): Promise<OperationReceipt>
  /** Reads immutable target records; never exposes scoring fields or starts execution. */
  captureExecutions?(
    request: OperationRequest,
    receipt: OperationReceipt,
    signal: AbortSignal,
  ): Promise<TargetExecution[]>
  readExecutionArtifact?(
    artifact: OperatorArtifact,
    path: string | null,
    signal: AbortSignal,
  ): Promise<Buffer>
  inspect(request: OperationRequest, signal: AbortSignal): Promise<OperationInspection>
  /** Resolve only after work has stopped or a durable fence prevents its start.
   * Throw while cancellation or resource termination remains unconfirmed. */
  cancel(request: OperationRequest): Promise<void>
}

/** A recovery connection has no submission, preparation or algorithm authority. */
export type OperationCancellation = Pick<OperationProvider, 'cancel'>
