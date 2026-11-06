import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseRunOutputManifest, parseRunOutputExport } from '../../src/adapters/hitch/run-artifacts.js'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(value)
}
const run = `run_${'a'.repeat(32)}`, sha = `sha256:${'b'.repeat(64)}`, commit = 'c'.repeat(40)
function fixture(path = 'output/predictions.csv') {
  const body = { schema_version: '1', kind: 'run-output-artifacts', run_id: run, eval_id: `eval_${'d'.repeat(32)}`,
    task_id: 'titanic-finalize', task_digest: sha, attempt: 1, harness_commit: commit,
    entries: [{ name: 'predictions', path, bytes: 20, sha256: sha, media_type: 'text/csv' }] }
  return { ...body, digest: `sha256:${createHash('sha256').update(canonical(body)).digest('hex')}` }
}
describe('Hitch public run output contract', () => {
  it('accepts the identical cross-repository run-output-artifacts@1 golden manifest', async () => {
    const golden = JSON.parse(await readFile(new URL('../../test-contracts/run-output-artifacts-v1.json', import.meta.url), 'utf8'))
    expect(parseRunOutputManifest(golden, { runId: golden.run_id, evalId: golden.eval_id, harnessCommit: golden.harness_commit, taskDigest: golden.task_digest })).toEqual(golden)
  })
  it('binds immutable outputs to run, task and exact candidate', () => {
    const manifest = parseRunOutputManifest(fixture(), { runId: run, harnessCommit: commit, taskDigest: sha, taskId: 'titanic-finalize' })
    expect(manifest.entries[0]!.path).toBe('output/predictions.csv')
    expect(() => parseRunOutputManifest(fixture(), { runId: run, harnessCommit: 'e'.repeat(40) })).toThrow('provenance')
    expect(() => parseRunOutputManifest({ ...fixture(), entries: [] }, { runId: run })).toThrow('digest')
  })
  it.each(['../secret', '/absolute', 'output//predictions', 'output/./predictions', 'output\\predictions'])('rejects unsafe exported paths %s', path => {
    expect(() => parseRunOutputManifest(fixture(path), { runId: run })).toThrow('entry')
  })
  it('rejects duplicate files, missing identities, and receipts for a different destination', () => {
    const duplicate = fixture(); duplicate.entries.push(duplicate.entries[0]!)
    expect(() => parseRunOutputManifest(duplicate, { runId: run })).toThrow('entry')
    expect(() => parseRunOutputManifest({ ...fixture(), attempt: 0 }, { runId: run })).toThrow('manifest')
    const manifest = parseRunOutputManifest(fixture(), { runId: run })
    const receipt = { schema_version: '1', kind: 'run-output-artifacts-export', run_id: run, manifest_digest: manifest.digest, destination: '/tmp/export' }
    expect(parseRunOutputExport(receipt, manifest, '/tmp/export')).toEqual(receipt)
    expect(() => parseRunOutputExport(receipt, manifest, '/tmp/elsewhere')).toThrow('mismatch')
  })
})
