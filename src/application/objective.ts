import { resolveAssertions } from './assertions.js'
import type { CompiledBenchmark, ProjectConfig } from '../domain/project.js'
import type { ObjectiveConfiguration, ProtectedMetric } from '../domain/objective.js'
import { GearError } from '../domain/errors.js'
import { resolveMetric, resolveObjective } from '../objective/contracts.js'

export function resolveProjectObjective(
  config: Pick<ProjectConfig, 'objective' | 'metrics' | 'protection' | 'assertions' | 'assertion_protection'>,
  manifest?: CompiledBenchmark['adapter_manifest'],
): ObjectiveConfiguration {
  const pass = resolveMetric({
    id: 'pass_rate',
    revision: '1',
    unit: 'ratio',
    direction: 'maximize',
    source: { path: 'scores.passed', extractor: 'boolean-v1' },
    range: { min: 0, max: 1 },
    granularity: 'trial',
    repetitionReducer: 'mean',
    taskReducer: 'weighted-mean',
    comparisonPrecision: 1e-9,
  })
  if (config.metrics !== undefined && !Array.isArray(config.metrics))
    throw new GearError('invalid-metrics', 'metrics must be an array')
  // The default objective promotes by the paper's multi-signal SeedGate. Its process
  // group is the native manifest's standard process_score channel, when declared.
  const multisignal = 'metric' in config.objective
  const process = multisignal ? manifest?.scoring.process_score : undefined
  const declared = (config.metrics ?? []).some((metric) => metric?.id === 'process_score')
  const metrics = [
    pass,
    ...(config.metrics ?? []).map(resolveMetric),
    ...(process && !declared
      ? [
          resolveMetric({
            id: 'process_score',
            revision: manifest!.adapter.revision,
            unit: 'score',
            direction: process.direction,
            source: { path: 'verifier.scores.process_score', extractor: 'number-v1' },
            range: { min: process.range[0], max: process.range[1] },
            granularity: 'trial',
            repetitionReducer: 'mean',
            taskReducer: 'weighted-mean',
            comparisonPrecision: 1e-9,
          }),
        ]
      : []),
  ]
  const definition = resolveObjective(
    'metric' in config.objective
      ? { terms: [{ metric: config.objective.metric, weight: 1 }] }
      : config.objective,
    metrics,
  )
  if (config.protection !== undefined && !Array.isArray(config.protection))
    throw new GearError('invalid-protection', 'protection must be an array')
  const protection = (config.protection ?? []).map((rule: ProtectedMetric) => {
    const contract = metrics.find((item) => item.id === rule?.metric)
    if (
      !rule ||
      typeof rule !== 'object' ||
      Array.isArray(rule) ||
      typeof rule.task_id !== 'string' ||
      !rule.task_id ||
      !['seed', 'held_out'].includes(rule.partition) ||
      !contract ||
      contract.granularity !== 'trial' ||
      !['minimum', 'no_regression', 'no_new_violation'].includes(rule.rule) ||
      Object.keys(rule).some(
        (key) =>
          ![
            'task_id',
            'partition',
            'metric',
            'rule',
            ...(rule.rule === 'minimum' ? ['value'] : rule.rule === 'no_regression' ? ['tolerance'] : []),
          ].includes(key),
      ) ||
      (rule.rule === 'minimum' && (typeof rule.value !== 'number' || !Number.isFinite(rule.value))) ||
      (rule.rule === 'no_regression' &&
        rule.tolerance !== undefined &&
        (!Number.isFinite(rule.tolerance) || rule.tolerance < 0)) ||
      (rule.rule === 'no_new_violation' &&
        (contract.direction !== 'maximize' ||
          !['boolean-v1', 'equals-v1'].includes(contract.source.extractor)))
    )
      throw new GearError(
        'invalid-protection',
        'Protection requires a declared per-trial metric and an explicit rule',
      )
    return structuredClone(rule)
  })
  const assertions = resolveAssertions(config)
  return {
    definition,
    metrics,
    protection,
    ...(assertions.assertions.length || assertions.assertion_protection.length ? assertions : {}),
    ...(multisignal
      ? {
          seed_rule: {
            rule: 'multisignal-v1' as const,
            outcome: 'pass_rate',
            process: process ? ['process_score'] : [],
          },
        }
      : {}),
  }
}
