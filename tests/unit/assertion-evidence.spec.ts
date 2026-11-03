import { describe, expect, it } from 'vitest'
import type { Evidence } from '../../src/domain/algorithm-wire.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import { validateAssertionEvidence } from '../../src/domain/assertion-evidence.js'
import type { AssertionContract } from '../../src/domain/assertions.js'

const assertionContract = (id: string): AssertionContract => ({
  id,
  revision: '1',
  source: { path: `originalResult.assertions.${id}`, extractor: 'assertion-status-v1' },
  schemaVersion: 1,
  digest: canonicalDigest({ id, revision: '1', source: `originalResult.assertions.${id}` }),
})

const cell = (overrides: Partial<Evidence> = {}): Evidence => ({
  candidate_id: 'candidate',
  task_id: 'task-a',
  repetition: 0,
  score: 0,
  status: 'valid',
  scope: 'seed',
  feedback: '',
  assertions: [
    {
      id: 'independent',
      schemaDigest: assertionContract('independent').digest,
      status: 'passed',
      evidenceRefs: [canonicalDigest('assertion-proof')],
    },
  ],
  ...overrides,
})

describe('validateAssertionEvidence', () => {
  it('accepts a valid frozen assertion tied to a valid trial result', () => {
    const contract = assertionContract('independent')

    expect(() => validateAssertionEvidence(cell(), [contract])).not.toThrow()
  })

  it('rejects duplicate, missing, or mismatched assertion bindings', () => {
    const contract = assertionContract('independent')
    const valid = cell()

    expect(() =>
      validateAssertionEvidence(
        {
          ...valid,
          assertions: [
            valid.assertions![0]!,
            { ...valid.assertions![0]!, id: 'independent' },
          ],
        },
        [contract],
      ),
    ).toThrow('Assertion identity or provenance does not match its frozen contract')

    expect(() =>
      validateAssertionEvidence(
        {
          ...valid,
          assertions: [{ ...valid.assertions![0]!, id: 'missing-contract' }],
        },
        [contract],
      ),
    ).toThrow('Assertion identity or provenance does not match its frozen contract')

    expect(() =>
      validateAssertionEvidence(
        {
          ...valid,
          assertions: [{ ...valid.assertions![0]!, schemaDigest: 'sha256:deadbeef' }],
        },
        [contract],
      ),
    ).toThrow('Assertion identity or provenance does not match its frozen contract')
  })

  it('rejects malformed evidence refs and requires proof for concrete assertion outcomes', () => {
    const contract = assertionContract('independent')
    const valid = cell()

    expect(() =>
      validateAssertionEvidence(
        {
          ...valid,
          assertions: [{ ...valid.assertions![0]!, evidenceRefs: ['not-a-sha256'] }],
        },
        [contract],
      ),
    ).toThrow('Assertion identity or provenance does not match its frozen contract')

    expect(() =>
      validateAssertionEvidence(
        {
          ...valid,
          status: 'environment_failed',
          assertions: [{ ...valid.assertions![0]!, status: 'passed' }],
        },
        [contract],
      ),
    ).toThrow('Assertion identity or provenance does not match its frozen contract')

    expect(() =>
      validateAssertionEvidence(
        {
          ...valid,
          assertions: [{ ...valid.assertions![0]!, status: 'passed', evidenceRefs: [] }],
        },
        [contract],
      ),
    ).toThrow('Assertion identity or provenance does not match its frozen contract')

    expect(() =>
      validateAssertionEvidence(
        {
          ...valid,
          assertions: [{ ...valid.assertions![0]!, status: 'missing', evidenceRefs: [] }],
        },
        [contract],
      ),
    ).not.toThrow()
  })
})
