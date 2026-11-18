import type { Candidate, Evidence, Json } from './algorithm-wire.js'
import type {
  AlgorithmState,
  ArtifactRef,
  Call,
  CallResult,
  Decision,
  SourceRef,
  OperatorRef,
  CandidateRef,
} from './algorithm-wire-v2.js'
import type { AlgorithmConfig } from './run.js'

export interface ScreeningPolicy {
  critic: OperatorRef
  edit_check: OperatorRef
  predicate: OperatorRef
}
export interface ScreeningProjection {
  algorithm: AlgorithmConfig
  policy: ScreeningPolicy
  candidate: CandidateRef
  before: NonNullable<OperatorMaterial['files']>
  after: NonNullable<OperatorMaterial['files']>
  critic: Json
}
export interface ScreeningVerdict {
  status: 'allow' | 'reject' | 'insufficient_evidence'
  reason: string
}

export interface OperatorAccessPolicy {
  exposure: 'scored' | 'blind'
  rollout_backend: 'scored_private' | null
  task_order: string[] | null
  usage_metrics: string[]
}
export interface SourceImport {
  name: string
  ref: SourceRef
  purpose: 'material' | 'evidence'
}
export interface SourceImportBinding extends SourceImport {
  /** Candidates are copied into this run; the original remains an explicit read-only donor. */
  candidate?: Candidate
}
export interface CapturedImports {
  bindings: SourceImportBinding[]
  candidates: Array<{ candidate: Candidate; files: NonNullable<OperatorMaterial['files']> }>
  artifacts: OperatorArtifact[]
}

export interface TaskStreamProgress {
  revision: string
  index: number
  completed: Array<{
    call_id: string
    task_id: string
    sample_id: string
    output: ArtifactRef
    library_refs: ArtifactRef[]
    previous_revision: string
    revision: string
  }>
}

/** Frozen authority for the v2 interpreter. It is not author algorithm state. */
export const operatorStorageLimits = Object.freeze({
  version: 1,
  callBytes: 2 * 1024 * 1024,
  resultsBytes: 32 * 1024 * 1024,
  journalBytes: 128 * 1024 * 1024,
  calls: 4096,
})

export interface OperatorPolicy {
  version: 2
  capabilities: string[]
  readBudget: { calls: number; bytes: number }
  fixedPlan: { name: 'fixed'; tasks: Array<{ task_id: string; slots: number[] }> }
  screening?: ScreeningPolicy
  access?: OperatorAccessPolicy
  taskInputs?: Record<string, Json>
  imports?: SourceImportBinding[]
  storageLimits?: typeof operatorStorageLimits
}

export interface OperatorMaterial {
  ref: SourceRef
  files?: Record<string, { content: string; encoding: 'base64'; executable: boolean }>
  value?: Json
}
export interface ExecutionTarget {
  id: string
  digest: string
  base: CandidateRef
  assets: ArtifactRef[]
  files: NonNullable<OperatorMaterial['files']>
}

export interface OperatorArtifact {
  ref: ArtifactRef
  value: Json
  /** Actual material access, not a claim of causal contribution. */
  sources: SourceRef[]
  /** Adapter-only locator. Never serialized into the author result or Meta materials. */
  external?: { format: string; locator: Json }
}

export interface TargetExecution {
  taskId: string
  repetition: number
  status: 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'unavailable'
  output: { value: Json; external?: OperatorArtifact['external'] }
  trajectory: { value: Json; external?: OperatorArtifact['external'] } | null
}

export interface OperatorCallEntry {
  id: string
  requestDigest: string
  call: Call
  status: 'reserved' | 'submitted' | 'complete'
  operationIds: string[]
  sampleIds?: string[]
  candidateId: string | null
  materials: OperatorMaterial[]
  reservedReadBytes: number
  result?: CallResult
  screening?: { inputDigest: string; verdict: ScreeningVerdict }
}

export interface OperatorSample {
  id: string
  planId: string
  executionIdentity: string
  exposure?: 'scored' | 'blind'
  candidateId: string
  taskId: string
  slot: number
  operationId: string
}

export interface OperatorJournal {
  version: 2
  state: AlgorithmState
  decisions: Array<{ stepId: number; inputDigest: string; decision: Decision; callIds: string[] }>
  calls: OperatorCallEntry[]
  samples: OperatorSample[]
  artifacts: OperatorArtifact[]
  history: ArtifactRef | null
  stream?: TaskStreamProgress
}

export interface LocalEffectReceipt {
  value: Json
  artifacts: OperatorArtifact[]
  candidate?: Candidate
  error?: { code: string; message: string }
}

export interface OperatorAssessment {
  sample: OperatorSample
  evidence: Evidence
  attemptIds: string[]
}
