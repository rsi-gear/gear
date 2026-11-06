import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonical, canonicalDigest } from '../../src/domain/canonical.js'
import { validateAlgorithmWire } from '../../src/domain/algorithm-schema.js'

describe('shared canonical identity contract', () => {
  it('matches frozen binary64/Unicode vectors in Python and TypeScript', () => {
    const vectors = JSON.parse(readFileSync(resolve('contracts/canonical-v1-vectors.json'), 'utf8')) as Array<{ value: unknown; canonical: string; digest: string }>
    for (const vector of vectors) {
      expect(canonical(vector.value)).toBe(vector.canonical)
      expect(canonicalDigest(vector.value)).toBe(vector.digest)
    }
    const actual = JSON.parse(execFileSync(process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3', ['-c',
      'import sys,json;from gear.canonical import canonical,digest;print(json.dumps([{ "canonical":canonical(v["value"]),"digest":digest(v["value"])} for v in json.load(sys.stdin)]))'],
    { input: JSON.stringify(vectors), encoding: 'utf8', env: { ...process.env, PYTHONPATH: resolve('python') } }))
    expect(actual).toEqual(vectors.map(({ canonical, digest }) => ({ canonical, digest })))
  })
  it('rejects unsafe numbers, sparse arrays and malformed Unicode', () => {
    for (const value of [NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined, [, 1], '\ud800', { key: undefined }, new Date()]) {
      expect(() => canonical(value)).toThrow()
    }
  })
  it('rejects malformed provider receipts before evidence can enter a journal', () => {
    const receipt = { result: { operation_id: 'id', kind: 'evaluate_seed', status: 'complete', candidate_id: 'c', data: null },
      evidence: [], candidate: null, physicalAttempts: 1, usage: { input_tokens: null }, provenance: null }
    expect(() => validateAlgorithmWire('OperationReceipt', receipt)).not.toThrow()
    for (const value of [{ ...receipt, physicalAttempts: -1 }, { ...receipt, usage: { dollars: -1 } }, { ...receipt, unknown: true },
      { ...receipt, result: { ...receipt.result, status: 'maybe' } }]) expect(() => validateAlgorithmWire('OperationReceipt', value)).toThrow()
  })
})
