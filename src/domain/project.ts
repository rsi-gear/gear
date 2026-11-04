import type { AssertionDefinition, ProtectedAssertion } from './assertions.js'
import type { Json } from './algorithm-wire.js'
import type { AlgorithmConfig } from './run.js'
import type { ObjectiveDefinition, ProtectedMetric, RawMetricDefinition } from './objective.js'
import type { GenerationConfiguration } from './generation-budget.js'
export interface ProjectConfig {
  version: 1
  benchmark: string
  target: { adapter: 'dsh' | 'pi'; path: string; profile: string }
  meta: { profile: string; roles?: Record<string, string> }
  sandbox?: { linux_isolation: 'seccomp' | 'bubblewrap-only' }
  generation?: GenerationConfiguration
  research_data?: {
    train: string[]
    dev: string[]
    allow_derived_inputs?: boolean
    include_train_labels?: boolean
    report_only?: boolean
  }
  algorithm: string | AlgorithmConfig
  objective: { metric: 'pass_rate' } | ObjectiveDefinition
  metrics?: RawMetricDefinition[]
  assertions?: AssertionDefinition[]
  assertion_protection?: ProtectedAssertion[]
  protection?: ProtectedMetric[]
  evaluation?: { repair: { max_retries: number; max_projections: number; backoff_ms: number[] } }
  validation: { mode: 'holdout' | 'research' }
  budget: { rounds: number; max_evaluations: number; max_candidates: number; repetitions: number }
}
export interface NativeScoreDefinition {
  source_metric: string
  direction: 'maximize' | 'minimize'
  range: [number, number]
  reducer: 'task-macro-mean'
}
export interface CompiledBenchmark {
  version: 1
  digest: string
  tasks: Array<{
    id: string
    instruction: string
    family: string
    digest: string
    resources: Array<{ path: string; digest: string; content_base64: string }>
    environment: string
  }>
  verifiers: Record<
    string,
    {
      expected: Json
      rule: Record<string, Json>
      fixtures: unknown[]
      digest: string
      native_files?: Array<{ path: string; digest: string; size: number; executable: boolean }>
      native_directories?: string[]
    }
  >
  native_blobs?: Record<string, string>
  /** A native benchmark's validated benchmark.adapter.json, or null when it has none. */
  adapter_manifest?: {
    adapter: { id: string; revision: string }
    scoring: { total_score: NativeScoreDefinition; process_score?: NativeScoreDefinition }
  } | null
  splits: { seed: string[]; held_out: string[] }
  checks: { static: string; verifier_fixtures: string; environment: string }
  scorer_metadata?: Record<string, Json>
  /** Native omissions remain null: runtime defaults must not be guessed. */
  execution_timeouts?: Record<
    string,
    {
      agent_seconds: number | null
      verifier_seconds: number | null
      environment_build_seconds: number | null
      verifier_build_seconds: number | null
    }
  >
}
