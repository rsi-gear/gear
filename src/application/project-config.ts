import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { load } from 'js-yaml'
import { GearError } from '../domain/errors.js'
import type { ProjectConfig } from '../domain/project.js'
import { evaluationRepairPolicy } from '../domain/evaluation.js'
import { resolveProjectObjective } from './objective.js'
import { generationBudget } from '../domain/generation-budget.js'

export const projectDefaults = {
  algorithm: 'gepa',
  objective: { metric: 'pass_rate' },
  validation: { mode: 'holdout' },
  budget: { rounds: 1, max_evaluations: 40, max_candidates: 2, repetitions: 1 },
} as const
function object(value: unknown, keys: string[], location: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new GearError('invalid-config', `Expected an object at ${location}`)
  for (const key of Object.keys(value))
    if (!keys.includes(key)) throw new GearError('unknown-config-field', `Unknown field ${location}.${key}`)
  return value as Record<string, unknown>
}
function string(value: unknown, location: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new GearError('invalid-config', `Expected a nonempty string at ${location}`)
  return value
}
export async function resolveProject(
  root: string,
  overrides: Partial<ProjectConfig['budget']> = {},
): Promise<{ root: string; config: ProjectConfig; origins: Record<string, string> }> {
  root = resolve(root)
  const raw = object(
    load(await readFile(resolve(root, 'gear.yaml'), 'utf8')),
    [
      'version',
      'benchmark',
      'target',
      'meta',
      'sandbox',
      'generation',
      'algorithm',
      'objective',
      'metrics',
      'protection',
      'assertions',
      'assertion_protection',
      'validation',
      'evaluation',
      'budget',
    ],
    'gear.yaml',
  )
  if (raw.version !== 1) throw new GearError('unsupported-config-version', 'gear.yaml version must be 1')
  const target = object(raw.target, ['adapter', 'path', 'profile'], 'target'),
    meta = object(raw.meta, ['profile'], 'meta')
  const sandbox = raw.sandbox === undefined ? undefined : object(raw.sandbox, ['linux_isolation'], 'sandbox')
  if (sandbox && !['seccomp', 'bubblewrap-only'].includes(String(sandbox.linux_isolation)))
    throw new GearError('invalid-config', 'sandbox.linux_isolation must be seccomp or bubblewrap-only')
  if (!['dsh', 'pi'].includes(String(target.adapter)))
    throw new GearError('unknown-target-adapter', 'Target adapter must be dsh or pi')
  const budgetInput = raw.budget
    ? object(raw.budget, ['rounds', 'max_evaluations', 'max_candidates', 'repetitions'], 'budget')
    : {}
  const budget = { ...projectDefaults.budget, ...budgetInput, ...overrides } as ProjectConfig['budget']
  if (Object.values(budget).some((value) => !Number.isSafeInteger(value) || value <= 0))
    throw new GearError('invalid-budget', 'Budget values must be positive safe integers')
  const validation = raw.validation
    ? object(raw.validation, ['mode'], 'validation')
    : projectDefaults.validation
  if (!['holdout', 'research'].includes(String(validation.mode)))
    throw new GearError('invalid-validation-mode', 'validation.mode must be holdout or research')
  const objective = raw.objective
    ? object(raw.objective, ['metric', 'terms', 'constraints'], 'objective')
    : projectDefaults.objective
  if ('metric' in objective && (objective.metric !== 'pass_rate' || Object.keys(objective).length !== 1))
    throw new GearError(
      'unsupported-objective',
      'Use metric: pass_rate or explicit weighted terms and constraints',
    )
  const algorithm = raw.algorithm ?? projectDefaults.algorithm
  if (typeof algorithm !== 'string') {
    const fields = object(algorithm, ['name', 'options'], 'algorithm')
    string(fields.name, 'algorithm.name')
    if (!fields.options || typeof fields.options !== 'object' || Array.isArray(fields.options))
      throw new GearError('invalid-algorithm-options', 'Algorithm options must be an object')
  }
  const evaluation = raw.evaluation === undefined ? {} : object(raw.evaluation, ['repair'], 'evaluation')
  const repairInput =
    evaluation.repair === undefined
      ? {}
      : object(evaluation.repair, ['max_retries', 'max_projections', 'backoff_ms'], 'evaluation.repair')
  const defaults = evaluationRepairPolicy()
  const repair = evaluationRepairPolicy({
    maxProjections: (repairInput.max_projections === undefined
      ? defaults.maxProjections
      : repairInput.max_projections) as number,
    maxRetries: (repairInput.max_retries === undefined
      ? defaults.maxRetries
      : repairInput.max_retries) as number,
    backoffMs: (repairInput.backoff_ms === undefined
      ? defaults.backoffMs
      : repairInput.backoff_ms) as number[],
  })
  const config: ProjectConfig = {
    version: 1,
    evaluation: {
      repair: {
        max_retries: repair.maxRetries,
        max_projections: repair.maxProjections,
        backoff_ms: repair.backoffMs,
      },
    },
    benchmark: string(raw.benchmark, 'benchmark'),
    target: {
      adapter: target.adapter as 'dsh' | 'pi',
      path: string(target.path, 'target.path'),
      profile: string(target.profile, 'target.profile'),
    },
    meta: { profile: string(meta.profile, 'meta.profile') },
    ...(sandbox
      ? { sandbox: { linux_isolation: sandbox.linux_isolation as 'seccomp' | 'bubblewrap-only' } }
      : {}),
    ...(raw.generation === undefined
      ? {}
      : { generation: raw.generation as NonNullable<ProjectConfig['generation']> }),
    algorithm: algorithm as ProjectConfig['algorithm'],
    objective: objective as ProjectConfig['objective'],
    ...(raw.metrics === undefined ? {} : { metrics: raw.metrics as NonNullable<ProjectConfig['metrics']> }),
    ...(raw.protection === undefined
      ? {}
      : { protection: raw.protection as NonNullable<ProjectConfig['protection']> }),
    ...(raw.assertions === undefined
      ? {}
      : { assertions: raw.assertions as NonNullable<ProjectConfig['assertions']> }),
    ...(raw.assertion_protection === undefined
      ? {}
      : {
          assertion_protection: raw.assertion_protection as NonNullable<
            ProjectConfig['assertion_protection']
          >,
        }),
    validation: { mode: validation.mode as 'holdout' | 'research' },
    budget,
  }
  resolveProjectObjective(config)
  generationBudget(raw.generation)
  const origins = Object.fromEntries(
    Object.keys(budget).map((key) => [
      `budget.${key}`,
      key in overrides ? 'explicit override' : key in budgetInput ? 'gear.yaml' : 'template default',
    ]),
  )
  for (const key of ['max_retries', 'max_projections', 'backoff_ms'])
    origins[`evaluation.repair.${key}`] = key in repairInput ? 'gear.yaml' : 'template default'
  origins['sandbox.linux_isolation'] = sandbox ? 'gear.yaml' : 'template default'
  if (config.generation) {
    for (const key of ['max_model_requests', 'max_tokens'] as const) {
      if (config.generation[key] !== undefined) origins[`generation.${key}`] = 'gear.yaml'
      if (config.generation.per_operation?.[key] !== undefined)
        origins[`generation.per_operation.${key}`] = 'gear.yaml'
    }
  }
  return { root, config, origins }
}
