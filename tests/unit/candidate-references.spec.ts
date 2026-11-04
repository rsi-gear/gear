import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { canonicalDigest } from '../../src/domain/canonical.js'
import { candidateReferences } from '../../src/domain/candidate-references.js'
import type { Decision, Operation, SearchView } from '../../src/domain/algorithm-wire.js'
import { validateDecision } from '../../src/runtime/decision-validation.js'
import { stageCandidateReferences } from '../../src/adapters/codex/references.js'
import { TargetStore, targetResources } from '../../src/adapters/storage/targets.js'
import { PiHarnessAdapter } from '../../src/adapters/pi/harness.js'
import type { CodexJob } from '../../src/adapters/codex/contracts.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gear-references-'))
  roots.push(root)
  const adapter = new PiHarnessAdapter(), store = new TargetStore(root, adapter, canonicalDigest('runtime'))
  await adapter.prepare(store.path('donor'))
  const donor = await store.seal('donor', 'base')
  const operation: Operation = {
    kind: 'generate_candidate', candidate_id: 'child', parent_id: 'donor', task_ids: ['seed'],
    scope: 'global', rationale: 'cross candidate',
    payload: { gear_candidate_references_v1: { donor: { candidate_id: 'donor', digest: donor.digest } } },
  }
  const job = { input: { context: { targets: join(root, 'targets') }, request: { operation } } } as unknown as CodexJob
  return { root, store, donor, operation, job }
}
it('validates references against admitted candidate identities, preserving unrelated legacy payloads', async () => {
  const { donor, operation } = await fixture()
  const view = {
    run_id: 'run', tasks: [{ id: 'seed', family: 'x', estimated_cost: 1 }],
    candidates: [{ id: 'donor', digest: donor.digest, parent_id: null }],
    budget: { candidates_remaining: 1 },
  } as SearchView
  const decide = (op: Operation): Decision => ({ state: { version: 1, data: {} }, operations: [op], reason: 'test' })
  expect(() => validateDecision(view, decide(operation))).not.toThrow()
  const refs = (name: string, id = 'donor', digest = donor.digest) => ({ gear_candidate_references_v1: { [name]: { candidate_id: id, digest } } })
  expect(() => validateDecision(view, decide({ ...operation, payload: refs('../escape') }))).toThrow('safe names')
  expect(() => validateDecision(view, decide({ ...operation, payload: refs('other', 'missing') }))).toThrow('existing candidates')
  expect(() => validateDecision(view, decide({ ...operation, payload: refs('other', 'donor', canonicalDigest('wrong')) }))).toThrow('frozen digest')
  expect(() => candidateReferences({ ...operation, kind: 'diagnose_seed', payload: { references: ['legacy', 'algorithm-data'] } })).not.toThrow()
  expect(() => candidateReferences({ ...operation, kind: 'diagnose_seed', payload: refs('donor') })).toThrow('on an edit')
  expect(() => candidateReferences({ ...operation, payload: { gear_candidate_references_v1: Object.fromEntries(Array.from({ length: 129 }, (_, i) => ['r'+i, { candidate_id: 'donor', digest: donor.digest }])) } })).toThrow('128')
})
it('stages exact sibling resources, excludes references from the child and detects tampering', async () => {
  const { root, job } = await fixture()
  const sandbox = join(root, 'sandbox'), candidate = join(sandbox, 'candidate')
  await mkdir(candidate, { recursive: true })
  await writeFile(join(candidate, 'AGENTS.md'), 'child text')
  const staged = await stageCandidateReferences(job, sandbox)
  expect(staged.index.donor!.directory).toBe('../references/donor')
  expect(await readFile(join(candidate, staged.index.donor!.directory, 'AGENTS.md'), 'utf8')).toContain('Follow the task')
  expect((await targetResources(candidate)).map(x => x.path)).toEqual(['AGENTS.md'])
  await staged.verify()
  const path = join(sandbox, 'references/donor/AGENTS.md')
  await chmod(path, 0o600)
  await writeFile(path, 'changed')
  await expect(staged.verify()).rejects.toThrow('reference was modified')
})
it('rejects missing or changed sources and resource links before staging an edit', async () => {
  const { root, store, job } = await fixture()
  await chmod(join(store.path('donor'), 'AGENTS.md'), 0o600)
  await writeFile(join(store.path('donor'), 'AGENTS.md'), 'tampered')
  await expect(stageCandidateReferences(job, join(root, 'changed'))).rejects.toThrow('resources changed')
  await rm(join(store.path('donor'), 'AGENTS.md'))
  await symlink('/etc/hosts', join(store.path('donor'), 'AGENTS.md'))
  await expect(stageCandidateReferences(job, join(root, 'link'))).rejects.toThrow('links')
  await rm(join(root, 'target-manifests/donor.json'))
  await expect(stageCandidateReferences(job, join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('preserves an alias named __proto__ as a plain index entry', async () => {
  const { root, job, donor } = await fixture()
  job.input.request.operation.payload = { gear_candidate_references_v1: JSON.parse(JSON.stringify({ ['__proto__']: { candidate_id: 'donor', digest: donor.digest } })) }
  const staged = await stageCandidateReferences(job, join(root, 'prototype'))
  expect(Object.keys(staged.index)).toEqual(['__proto__'])
  expect(staged.index.__proto__!.directory).toBe('../references/__proto__')
})

it('can stage the full default Meta-Harness history beyond eight aliases within aggregate limits', async () => {
  const { root, job, donor } = await fixture()
  job.input.request.operation.payload = { gear_candidate_references_v1: Object.fromEntries(Array.from({ length: 21 }, (_, i) =>
    ['version'+i, { candidate_id: 'donor', digest: donor.digest }])) }
  const staged = await stageCandidateReferences(job, join(root, 'history'))
  expect(Object.keys(staged.index)).toHaveLength(21)
  await staged.verify()
})
