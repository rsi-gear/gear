import { digestJson } from '../state/digest.js'
import type { MetaAgentSpec, MetaSamplingConfig } from '../types.js'
import { validateMetaSampling } from './sampling.js'

const SHA256 = /^sha256:[0-9a-f]{64}$/u

export interface SkillHarnessIdentity {
  runtime: { type: string; version: string; integrity: string }
  preset: { id: string; digest: string }
  model: { provider: string; model: string; maxTokens?: number }
  sampling: MetaSamplingConfig
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const accepted = new Set(allowed)
  const unknown = Object.keys(value).find(key => !accepted.has(key))
  if (unknown !== undefined) throw new TypeError(`${path}.${unknown} is not allowed`)
}

function requiredString(value: Record<string, unknown>, key: string, path: string): string {
  const selected = value[key]
  if (typeof selected !== 'string' || selected.length === 0) throw new TypeError(`${path}.${key} is required`)
  return selected
}

function sha256(value: Record<string, unknown>, key: string, path: string): string {
  const selected = requiredString(value, key, path)
  if (!SHA256.test(selected)) throw new TypeError(`${path}.${key} must be sha256`)
  return selected
}

/** Strictly parse the public, harness-neutral projection used to claim skill work. */
export function parseSkillHarnessIdentity(input: unknown): SkillHarnessIdentity {
  const identity = record(input, 'identity')
  exactKeys(identity, ['runtime', 'preset', 'model', 'sampling'], 'identity')

  const runtime = record(identity.runtime, 'identity.runtime')
  exactKeys(runtime, ['type', 'version', 'integrity'], 'identity.runtime')

  const preset = record(identity.preset, 'identity.preset')
  exactKeys(preset, ['id', 'digest'], 'identity.preset')

  const model = record(identity.model, 'identity.model')
  exactKeys(model, ['provider', 'model', 'maxTokens'], 'identity.model')
  if (model.maxTokens !== undefined && (!Number.isSafeInteger(model.maxTokens) || (model.maxTokens as number) <= 0)) {
    throw new TypeError('identity.model.maxTokens must be a positive safe integer')
  }

  const sampling = record(identity.sampling, 'identity.sampling')
  exactKeys(sampling, ['temperature', 'reasoningEffort'], 'identity.sampling')
  const parsedSampling: MetaSamplingConfig = {
    ...(sampling.temperature === undefined ? {} : { temperature: sampling.temperature as number }),
    ...(sampling.reasoningEffort === undefined ? {} : { reasoningEffort: sampling.reasoningEffort as string }),
  }
  validateMetaSampling(parsedSampling, 'identity.sampling')

  return {
    runtime: {
      type: requiredString(runtime, 'type', 'identity.runtime'),
      version: requiredString(runtime, 'version', 'identity.runtime'),
      integrity: sha256(runtime, 'integrity', 'identity.runtime'),
    },
    preset: {
      id: requiredString(preset, 'id', 'identity.preset'),
      digest: sha256(preset, 'digest', 'identity.preset'),
    },
    model: {
      provider: requiredString(model, 'provider', 'identity.model'),
      model: requiredString(model, 'model', 'identity.model'),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens as number }),
    },
    sampling: parsedSampling,
  }
}

/** Project a sealed Meta spec onto the public identity contract. */
export function skillHarnessIdentity(spec: MetaAgentSpec): SkillHarnessIdentity {
  return parseSkillHarnessIdentity({
    runtime: {
      type: spec.runtime.type,
      version: spec.runtime.version,
      integrity: spec.runtime.integrity,
    },
    preset: { id: spec.preset.id, digest: spec.preset.digest },
    model: {
      provider: spec.model.provider,
      model: spec.model.model,
      ...(spec.model.maxTokens === undefined ? {} : { maxTokens: spec.model.maxTokens }),
    },
    sampling: {
      ...(spec.sampling.temperature === undefined ? {} : { temperature: spec.sampling.temperature }),
      ...(spec.sampling.reasoningEffort === undefined ? {} : { reasoningEffort: spec.sampling.reasoningEffort }),
    },
  })
}

function equalCanonical(left: SkillHarnessIdentity, right: SkillHarnessIdentity): boolean {
  return digestJson(left) === digestJson(right)
}

/** Compare identities after strict parsing so unknown fields cannot be ignored. */
export function skillHarnessIdentitiesEqual(left: unknown, right: unknown): boolean {
  return equalCanonical(parseSkillHarnessIdentity(left), parseSkillHarnessIdentity(right))
}

function firstDifference(left: SkillHarnessIdentity, right: SkillHarnessIdentity): string {
  const fields: Array<[string, unknown, unknown]> = [
    ['identity.runtime.type', left.runtime.type, right.runtime.type],
    ['identity.runtime.version', left.runtime.version, right.runtime.version],
    ['identity.runtime.integrity', left.runtime.integrity, right.runtime.integrity],
    ['identity.preset.id', left.preset.id, right.preset.id],
    ['identity.preset.digest', left.preset.digest, right.preset.digest],
    ['identity.model.provider', left.model.provider, right.model.provider],
    ['identity.model.model', left.model.model, right.model.model],
    ['identity.model.maxTokens', left.model.maxTokens, right.model.maxTokens],
    ['identity.sampling.temperature', left.sampling.temperature, right.sampling.temperature],
    ['identity.sampling.reasoningEffort', left.sampling.reasoningEffort, right.sampling.reasoningEffort],
  ]
  return fields.find(([, actual, expected]) => !Object.is(actual, expected))?.[0] ?? 'identity'
}

/** Assert exact identity equality without exposing either complete identity in an error. */
export function assertSkillHarnessIdentityMatches(
  actualInput: unknown,
  expectedInput: unknown,
  message = 'Meta harness identity does not match',
): SkillHarnessIdentity {
  const actual = parseSkillHarnessIdentity(actualInput)
  const expected = parseSkillHarnessIdentity(expectedInput)
  if (!equalCanonical(actual, expected)) {
    throw new Error(`${message} at ${firstDifference(actual, expected)}`)
  }
  return actual
}
