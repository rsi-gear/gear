import { canonicalDigest } from '../domain/canonical.js'
import { GearError } from '../domain/errors.js'
import type { AssertionContract, AssertionDefinition, ProtectedAssertion } from '../domain/assertions.js'

export function resolveAssertions(input: {
  assertions?: AssertionDefinition[]
  assertion_protection?: ProtectedAssertion[]
}): {
  assertions: AssertionContract[]
  assertion_protection: ProtectedAssertion[]
} {
  if (input.assertions !== undefined && !Array.isArray(input.assertions))
    throw new GearError('invalid-assertions', 'assertions must be an array')
  const seen = new Set<string>()
  const assertions = (input.assertions ?? []).map((value) => {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      typeof value.id !== 'string' ||
      !value.id.trim() ||
      seen.has(value.id) ||
      typeof value.revision !== 'string' ||
      !value.revision.trim() ||
      Object.keys(value).some((key) => !['id', 'revision', 'source'].includes(key)) ||
      !value.source ||
      typeof value.source !== 'object' ||
      Array.isArray(value.source) ||
      Object.keys(value.source).some((key) => !['path', 'extractor'].includes(key)) ||
      typeof value.source.path !== 'string' ||
      !/^(scores|rewards|originalResult|verifier)(\.[a-zA-Z0-9_-]+)+$/u.test(value.source.path) ||
      value.source.path.split('.').some((part) => ['__proto__', 'prototype', 'constructor'].includes(part)) ||
      !['boolean-v1', 'assertion-status-v1'].includes(value.source.extractor)
    )
      throw new GearError(
        'invalid-assertions',
        'Each assertion needs a unique id, revision and explicit observation source',
      )
    seen.add(value.id)
    const body = { ...structuredClone(value), schemaVersion: 1 as const }
    return { ...body, digest: canonicalDigest(body) }
  })
  if (input.assertion_protection !== undefined && !Array.isArray(input.assertion_protection))
    throw new GearError('invalid-assertion-protection', 'assertion_protection must be an array')
  const guards = new Set<string>()
  const assertion_protection = (input.assertion_protection ?? []).map((rule) => {
    if (
      !rule ||
      typeof rule !== 'object' ||
      Array.isArray(rule) ||
      typeof rule.task_id !== 'string' ||
      !rule.task_id.trim() ||
      !['seed', 'held_out'].includes(rule.partition) ||
      !seen.has(rule.assertion_id) ||
      !['must_pass', 'no_new_violation'].includes(rule.rule) ||
      Object.keys(rule).some((key) => !['task_id', 'partition', 'assertion_id', 'rule'].includes(key))
    )
      throw new GearError(
        'invalid-assertion-protection',
        'Protection needs a declared assertion and an explicit per-task rule',
      )
    const key = JSON.stringify([rule.task_id, rule.partition, rule.assertion_id])
    if (guards.has(key))
      throw new GearError('duplicate-assertion-protection', 'A task assertion may have one protection rule')
    guards.add(key)
    return structuredClone(rule)
  })
  return { assertions, assertion_protection }
}
