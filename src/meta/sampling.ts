import type { MetaSamplingConfig } from '../types.js'

/** Validate persistent sampling without assuming a particular provider's effort catalog. */
export function validateMetaSampling(sampling: MetaSamplingConfig, label = 'metaSampling'): void {
  const { temperature, reasoningEffort } = sampling
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    throw new TypeError(`${label}.temperature must be between 0 and 2`)
  }
  // DSH's ReasoningEffortId is an opaque brand, not a validator. Its LLM runtime
  // checks the exact id against the selected model before any provider request.
  if (reasoningEffort !== undefined && (typeof reasoningEffort !== 'string'
    || reasoningEffort.length === 0 || reasoningEffort.trim() !== reasoningEffort)) {
    throw new TypeError(`${label}.reasoningEffort must be a non-empty effort id without surrounding whitespace`)
  }
}

/** An explicit profile effort cannot silently continue an evolution sealed with another effort. */
export function assertMetaReasoningEffortMatches(sealed: MetaSamplingConfig, configured: MetaSamplingConfig): void {
  if (configured.reasoningEffort !== undefined && sealed.reasoningEffort !== configured.reasoningEffort) {
    throw new Error('Meta reasoning effort does not match immutable evolution spec; create a new evolution')
  }
}
