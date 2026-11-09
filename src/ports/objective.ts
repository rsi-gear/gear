import type { ProtectedAssertion } from '../domain/assertions.js'
import type { Evidence, AssertionEvidence, Json } from '../domain/algorithm-wire.js'
import type { ObjectiveConfiguration, RawMetricAggregate, ProtectedMetric } from '../domain/objective.js'

export interface ProjectedScore {
  score: number | null
  observed: number
  expected: number
  complete: boolean
  constraints_passed: boolean
  verifier?: Json
  metrics: Record<string, RawMetricAggregate>
  protection: Array<ProtectedMetric & { status: 'passed' | 'failed' | 'unavailable' }>
  assertions?: Array<{
    task_id: string
    repetition: number
    trial_status: string | null
    values: AssertionEvidence[]
  }>
  assertion_protection?: Array<
    ProtectedAssertion & {
      repetition: number
      schemaDigest: string
      status: 'passed' | 'failed' | 'unavailable'
      baseline_status: string | null
      candidate_status: string | null
    }
  >
  objective?: {
    status: 'available' | 'missing' | 'invalid'
    score?: number
    contributions: Array<{
      metric: string
      weight: number
      scale: number
      scaledValue?: number
      contribution?: number
    }>
    constraintResults: Array<{ constraintDigest: string; status: 'passed' | 'failed' | 'unavailable' }>
  }
}
export interface ObjectiveProjector {
  readonly identity: string
  project(input: {
    evidence: Evidence[]
    task_ids: string[]
    repetitions: number
    candidate_id: string
    anchor_id: string
    partition: 'seed' | 'held_out'
    objective: ObjectiveConfiguration | null
  }): ProjectedScore
  compare(input: Parameters<ObjectiveProjector['project']>[0]): {
    gain: number | null
    complete: boolean
    constraints_passed: boolean
    /** Present only under a frozen seed rule: seed promotion and held-out validation verdicts. */
    improved?: boolean
    regressed?: boolean
    signals?: Array<{ metric: string; gain: number }>
  }
}
