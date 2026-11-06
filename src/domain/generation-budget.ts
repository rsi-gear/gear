import { GearError } from './errors.js'

export const generationMetrics = ['model_requests', 'tokens'] as const
export type GenerationMetric = (typeof generationMetrics)[number]
export type GenerationLimits = Partial<Record<GenerationMetric, number>>
export interface GenerationBudget {
  version: 1
  total: GenerationLimits
  perOperation: GenerationLimits
}
export interface GenerationConfiguration {
  max_model_requests?: number
  max_tokens?: number
  per_operation?: { max_model_requests?: number; max_tokens?: number }
}

function limits(value: unknown, location: string): GenerationLimits {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new GearError('invalid-generation-budget', `Expected limits at ${location}`)
  for (const [key, limit] of Object.entries(value))
    if (!generationMetrics.includes(key as GenerationMetric) || !Number.isSafeInteger(limit) || limit < 1)
      throw new GearError(
        'invalid-generation-budget',
        `Expected a positive safe integer at ${location}.${key}`,
      )
  return { ...value }
}

export function validateGenerationBudget(value: GenerationBudget): void {
  if (
    !value ||
    value.version !== 1 ||
    Object.keys(value).some((key) => !['version', 'total', 'perOperation'].includes(key))
  )
    throw new GearError(
      'frozen-generation-budget-missing',
      'Create a new run with a frozen generation budget',
    )
  limits(value.total, 'generation.total')
  limits(value.perOperation, 'generation.perOperation')
}

/** Normalize user configuration once, then freeze this policy with the run. */
export function generationBudget(value: unknown = {}): GenerationBudget {
  const object = (input: unknown, keys: string[], location: string): Record<string, unknown> => {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !keys.includes(key))
    )
      throw new GearError('invalid-generation-budget', `Unknown or invalid field at ${location}`)
    return input as Record<string, unknown>
  }
  const config = object(value, ['max_model_requests', 'max_tokens', 'per_operation'], 'generation')
  const operation =
    config.per_operation === undefined
      ? {}
      : object(config.per_operation, ['max_model_requests', 'max_tokens'], 'generation.per_operation')
  const read = (input: Record<string, unknown>, location: string) =>
    limits(
      Object.fromEntries(
        generationMetrics
          .filter((metric) => `max_${metric}` in input)
          .map((metric) => [metric, input[`max_${metric}`]]),
      ),
      location,
    )
  return {
    version: 1,
    total: read(config, 'generation'),
    perOperation: read(operation, 'generation.per_operation'),
  }
}

export function requireGenerationCapability(policy: GenerationBudget, supported: boolean): void {
  validateGenerationBudget(policy)
  if ((Object.keys(policy.total).length || Object.keys(policy.perOperation).length) && !supported)
    throw new GearError(
      'generation-budget-unsupported',
      'Meta provider cannot enforce aggregate token/request limits before each model call',
      {
        next_action: 'Select a provider with generationBudget capability or remove the unsupported limits',
      },
    )
}
