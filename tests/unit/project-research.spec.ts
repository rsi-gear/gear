import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { RunStore } from '../../src/adapters/storage/run-store.js'
import { pythonObjective } from '../../src/adapters/python/objective.js'
import { projectResearch } from '../../src/application/research.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import { researchArchive } from '../../src/domain/research.js'
import type { RunSpec } from '../../src/domain/run.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gear-research-')); roots.push(root)
  const store = new RunStore(join(root, '.gear'))
  const spec: RunSpec = {
    version: 1, kind: 'refine', benchmarkDigest: canonicalDigest('tasks'), configDigest: canonicalDigest('config'),
    implementationIdentity: canonicalDigest('algorithm'), providerIdentity: canonicalDigest('provider'),
    championRevision: null, targetSourceDigest: canonicalDigest('target'), lineage: null,
    algorithm: { name: 'gepa', options: {} }, validationMode: 'holdout', seed: 'fixed',
    seedTasks: [{ id: 'seed', family: 'test', estimated_cost: 1 }], heldOutTaskIds: ['HELD_OUT_CANARY'],
    anchor: { id: 'anchor', digest: canonicalDigest('anchor'), parent_id: null },
    budget: { rounds: 1, maxEvaluations: 10, maxCandidates: 1, repetitions: 1 },
    acceptance: { minimumGain: 0, maxHeldOutRegression: 0 }, objectiveIdentity: pythonObjective.identity,
    generationBudget: { version: 1, total: {}, perOperation: {} },
    evaluationRepair: { maxRetries: 1, maxProjections: 1, backoffMs: [0] },
  }
  const journal = await store.create('run', spec)
  journal.seedEvidence.push({ candidate_id: 'anchor', task_id: 'seed', repetition: 0, score: 0, status: 'valid', scope: 'global', feedback: 'real zero' })
  await store.write(journal)
  return { root, store, journal }
}

it('keeps the seed archive independent from held-out evidence, gate and champion state', async () => {
  const { store, journal } = await fixture()
  const before = await store.researchStore('run').load(journal)
  journal.heldOutEvidence.push({ candidate_id: 'anchor', task_id: 'HELD_OUT_CANARY', repetition: 0, score: 0, status: 'valid', scope: 'held_out', feedback: 'PRIVATE_FEEDBACK' })
  journal.status = 'completed'; journal.gate = { status: 'rejected', reason: 'PRIVATE_REASON' }; journal.nomineeId = 'anchor'
  journal.physicalAttempts = 5
  await store.write(journal)
  const after = await store.researchStore('run').load(journal)
  expect(after).toEqual(before)
  expect(JSON.stringify(after)).not.toMatch(/HELD_OUT_CANARY|PRIVATE_/)
  expect(after.objects.find(item => item.kind === 'evidence')?.value).toMatchObject({ score: 0, status: 'valid' })
})

it('ignores an uncommitted snapshot and preserves the previous immutable revision', async () => {
  const { store, journal } = await fixture()
  const prior = await store.researchStore('run').load(journal)
  const advanced = structuredClone(journal)
  advanced.candidates.push({ id: 'specialist', digest: canonicalDigest('specialist'), parent_id: 'anchor' })
  const orphan = await store.researchStore('run').capture(advanced)
  expect(orphan.digest).not.toBe(prior.archive.digest)
  expect(await store.researchStore('run').load(await store.read('run'))).toEqual(prior)
  await store.write(advanced)
  expect((await store.researchStore('run').load(await store.read('run'))).archive).toEqual(orphan)
  expect(await store.researchStore('run').load(journal)).toEqual(prior)
})

it('references rejected unadmitted provider receipts without exposing their evidence as seed research', async () => {
  const { store, journal } = await fixture()
  const operationId = canonicalDigest('generation')
  const receipt = {
    result: { operation_id: operationId, kind: 'generate_candidate' as const, candidate_id: 'proposed', status: 'complete' as const, data: null },
    candidate: null, physicalAttempts: 0, usage: { tokens: -1 }, provenance: null,
    evidence: [{ candidate_id: 'proposed', task_id: 'HELD_OUT_CANARY', repetition: 0, score: 0, status: 'valid' as const, scope: 'injected', feedback: 'unadmitted' }],
  }
  journal.operations.push({ status: 'submitted', reservedAttempts: 0, request: {
    operationId, runId: journal.id, generation: 0, partition: 'seed', repetitions: 1, slots: [], evidence: [],
    operation: { kind: 'generate_candidate', candidate_id: 'proposed', parent_id: 'anchor', task_ids: ['seed'], scope: 'global', rationale: 'generation', payload: null },
  }, generationViolation: { reason: 'invalid usage', receipt } })
  await store.write(journal)
  const bundle = await store.researchStore('run').load(journal)
  expect(JSON.stringify(bundle)).not.toContain('HELD_OUT_CANARY')
  expect(bundle.objects.find(item => item.kind === 'operation')?.value).toMatchObject({ receipt: null,
    generation_violation: { reason: 'invalid usage', receipt_digest: canonicalDigest(receipt) } })
  expect((await store.read('run')).operations[0]?.generationViolation?.receipt).toEqual(receipt)
})

it('does not overwrite tampered content-addressed objects', async () => {
  const { store, journal } = await fixture()
  const { packs } = researchArchive(journal)
  const record = packs.find(item => item.objects[0]?.kind === 'evidence')!
  const path = join(store.researchStore('run').root, 'packs', record.digest.slice(7) + '.json')
  const original = await readFile(path, 'utf8')
  await writeFile(path, original.replace('real zero', 'tampered'))
  await expect(store.researchStore('run').load(journal)).rejects.toMatchObject({ code: 'research-identity-mismatch' })
  await expect(store.write(journal)).rejects.toMatchObject({ code: 'research-identity-mismatch' })
  expect(await readFile(path, 'utf8')).toContain('tampered')
  expect((await store.read('run')).seedEvidence[0]?.feedback).toBe('real zero')
})

it('rejects seed evidence or annotations that refer outside the admitted cohort', async () => {
  const { journal } = await fixture()
  journal.seedEvidence[0]!.task_id = 'HELD_OUT_CANARY'
  expect(() => researchArchive(journal)).toThrow('admitted seed slots')
  journal.seedEvidence[0]!.task_id = 'seed'
  journal.decisions.push({ stepId: 0, inputDigest: 'input', operationIds: [], decision: {
    state: journal.state, reason: 'stop', operations: [], research: [{ kind: 'scope', scope: 'global',
      candidate_ids: ['unknown'], task_ids: ['seed'], data: { weights: { seed: 1 } } }],
  } })
  expect(() => researchArchive(journal)).toThrow('seed cohort')
})

it('cannot use a cancellation-only write to change evidence or bypass the cancellation request', async () => {
  const { store, journal } = await fixture()
  journal.status = 'cancelled'
  await expect(store.write(journal, { cancellationOnly: true })).rejects.toMatchObject({ code: 'invalid-cancellation-write' })
  await store.cancel('run')
  journal.seedEvidence[0]!.score = 1
  await expect(store.write(journal, { cancellationOnly: true })).rejects.toMatchObject({ code: 'invalid-cancellation-write' })
  expect((await store.read('run')).seedEvidence[0]?.score).toBe(0)
})

it('uses Python for scope projections and leaves raw archives readable across implementation changes', async () => {
  const { root, store, journal } = await fixture()
  const projected = await projectResearch(root, journal)
  expect(projected.projection).toMatchObject({ status: 'available', source_digest: projected.archive.digest,
    value: { partition: 'seed', scopes: [{ profiles: [{ candidate_id: 'anchor', score: 0, complete: true }] }] } })
  journal.spec.objectiveIdentity = canonicalDigest('other implementation')
  journal.specDigest = canonicalDigest(journal.spec)
  await store.write(journal)
  expect((await projectResearch(root, journal)).projection).toEqual({ status: 'unavailable', reason: 'projection-identity-mismatch' })
})

it('returns a complete raw archive when its descriptive Python projection exceeds the work limit', async () => {
  const { root, store, journal } = await fixture()
  journal.spec.budget.repetitions = 10001
  journal.specDigest = canonicalDigest(journal.spec)
  await store.write(journal)
  const bundle = await projectResearch(root, journal)
  expect(bundle.projection).toMatchObject({ status: 'unavailable', reason: 'projection-failed', message: expect.stringContaining('10000 scoped slots') })
  expect(bundle.objects).toEqual((await store.researchStore('run').load(journal)).objects)
})
