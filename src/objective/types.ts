/** Raw metric semantics are independent of an evolution's optimization preferences. */
export interface RawMetricDefinition {
  id: string
  revision: string
  unit: string
  direction: 'maximize' | 'minimize'
  source: {
    /** Paths address the immutable, imported trial, never Gear controller state. */
    path: string
    extractor: 'number-v1' | 'boolean-v1' | 'equals-v1'
    equals?: number | boolean | string
  }
  range?: { min: number; max: number }
  granularity: 'trial' | 'dataset-aggregate'
  repetitionReducer: 'mean'
  taskReducer: 'weighted-mean'
  comparisonPrecision: number
  /** Required for usage metrics; describes all calls, retries and pricing, not just the main model. */
  measurement?: {
    kind: 'actual' | 'api-equivalent' | 'counter' | 'wall-clock'
    scope: string
    providerModels: string[]
    priceSnapshot?: string
    tokenAccounting: string
    timeBoundary: string
    retryAccounting: string
  }
}
export interface RawMetricContract extends RawMetricDefinition { schemaVersion: 1; digest: string }
export interface ObjectiveDefinition {
  terms: Array<{ metric: string; weight: number; scale?: number }>
  constraints?: Array<
    | { metric: string; rule: 'minimum'; value: number }
    | { metric: string; rule: 'no_regression'; reference: 'initial_baseline'; tolerance?: number }
  >
}
export type ResolvedMetricConstraint = NonNullable<ObjectiveDefinition['constraints']>[number] & {
  metricContractDigest: string
  direction: 'maximize' | 'minimize'
  comparisonPrecision: number
  digest: string
}
export interface ResolvedObjective {
  schemaVersion: 1
  direction: 'maximize'
  terms: Array<{ metric: string; weight: number; scale: number; metricContractDigest: string }>
  constraints: ResolvedMetricConstraint[]
  scorerVersion: 'linear-raw-v1'
  comparisonPrecision: number
  digest: string
}
export interface RawMetricValue {
  contractDigest: string
  unit: string
  status: 'available' | 'missing' | 'invalid' | 'unsupported'
  value?: number
  reason?: string
  evidenceRefs: string[]
}
export interface RawTrialMetrics {
  schemaVersion: 1
  kind: 'raw-metrics'
  taskId: string
  repetition: number
  runId: string
  attempt: number
  harnessCommit: string
  conditionDigest: string
  originalArtifactRefs: string[]
  metrics: Record<string, RawMetricValue>
  digest: string
}
export interface RawMetricAggregate extends RawMetricValue {
  /** Physical ledger total; scoring uses value, the task macro mean. */
  observationTotal?: number
  /** Retained when the physical ledger exceeds the finite JSON number range. */
  observationTotalExact?: { numerator: string; denominator: string }
}
export interface ObjectiveScoreEvidence {
  schemaVersion: 1
  kind: 'refine-objective-score'
  objective: ResolvedObjective
  objectiveDigest: string
  projectorDigest: string
  status: 'available' | 'missing' | 'invalid'
  score?: number
  scopeDigest: string
  rawMetricsRefs: string[]
  inputs: Array<{ metric: string; contractDigest: string; rawInputRefs: string[]; value?: number }>
  contributions: Array<{ metric: string; weight: number; scale: number; scaledValue?: number; contribution?: number }>
  constraintResults: Array<{ constraintDigest: string; referenceDigest?: string; status: 'passed' | 'failed' | 'unavailable'; evidenceRefs: string[] }>
  digest: string
}
