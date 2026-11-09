import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { RunStore } from '../../src/adapters/storage/run-store.js'
import { pythonObjective } from '../../src/adapters/python/objective.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import type { JournalOperation, RunSpec } from '../../src/domain/run.js'
import type { OperationProvider, OperationReceipt, OperationRequest } from '../../src/ports/operations.js'
import { DurableRunner } from '../../src/runtime/runner.js'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

class Provider implements OperationProvider {
  identity = canonicalDigest('parallel-evaluation-fixture')
  capabilities = {
    seeds: true,
    temperature: true,
    subsets: true,
    idempotentSubmission: true,
    inspect: true,
    cancel: true,
    physicalAttemptAccounting: true,
    evidenceProjection: false,
    hardDollarBudget: false,
    generationBudget: false,
  }
  calls: OperationRequest[] = []
  release = new Map<string, () => void>()
  receipts = new Map<string, OperationReceipt>()
  loseReply = new Set<string>()
  activeSlots = 0
  maximumSlots = 0
  async submit(request: OperationRequest): Promise<OperationReceipt> {
    this.calls.push(structuredClone(request))
    this.activeSlots += request.slots.length
    this.maximumSlots = Math.max(this.maximumSlots, this.activeSlots)
    const id = request.operation.candidate_id!
    await new Promise<void>((resolve) => this.release.set(id, resolve))
    this.activeSlots -= request.slots.length
    const receipt: OperationReceipt = {
      result: {
        operation_id: request.operationId,
        kind: 'evaluate_seed',
        candidate_id: id,
        status: 'complete',
        data: null,
      },
      candidate: null,
      evidence: request.slots.map((slot) => ({
        candidate_id: id,
        task_id: slot.taskId,
        repetition: slot.repetition,
        scope: request.operation.scope,
        score: 0.5,
        status: 'valid',
        feedback: '',
      })),
      physicalAttempts: request.slots.length,
      usage: {},
      provenance: { provider: this.identity },
    }
    this.receipts.set(request.operationId, receipt)
    if (this.loseReply.has(id)) throw new Error(`lost acknowledgement: ${id}`)
    return receipt
  }
  async inspect(request: OperationRequest) {
    const receipt = this.receipts.get(request.operationId)
    return receipt ? { state: 'complete' as const, receipt } : { state: 'not_submitted' as const }
  }
  async cancel() {}
}

async function fixture(count = 4, repetitions = 2) {
  const root = await mkdtemp(join(tmpdir(), 'gear-evaluation-concurrency-'))
  roots.push(root)
  const store = new RunStore(root),
    provider = new Provider()
  const candidates = Array.from({ length: count }, (_, index) => ({
    id: index === 0 ? 'anchor' : `candidate-${index}`,
    parent_id: index === 0 ? null : 'anchor',
    digest: canonicalDigest(['candidate', index]),
  }))
  const spec: RunSpec = {
    version: 1,
    kind: 'evaluate',
    benchmarkDigest: canonicalDigest('tasks'),
    configDigest: canonicalDigest('config'),
    implementationIdentity: canonicalDigest('algorithm'),
    providerIdentity: provider.identity,
    championRevision: null,
    targetSourceDigest: canonicalDigest('target'),
    lineage: null,
    algorithm: { name: 'fixture', options: {} },
    validationMode: 'research',
    seed: '0',
    seedTasks: [{ id: 'seed', family: 'seed', estimated_cost: 1 }],
    heldOutTaskIds: [],
    anchor: candidates[0]!,
    budget: { rounds: 1, maxCandidates: count, maxEvaluations: count * repetitions, repetitions },
    acceptance: { minimumGain: 0, maxHeldOutRegression: 0 },
    evaluationRepair: { maxRetries: 0, maxProjections: 0, backoffMs: [0] },
    generationBudget: { version: 1, total: {}, perOperation: {} },
  }
  const operations: JournalOperation[] = candidates.map((candidate) => ({
    request: {
      operationId: canonicalDigest(candidate.id),
      runId: 'run',
      generation: 1,
      operation: {
        kind: 'evaluate_seed',
        candidate_id: candidate.id,
        parent_id: null,
        task_ids: ['seed'],
        scope: 'global',
        rationale: 'parallel fixture',
        payload: null,
      },
      partition: 'seed',
      repetitions,
      slots: Array.from({ length: repetitions }, (_, repetition) => ({ taskId: 'seed', repetition })),
      evidence: [],
    },
    status: 'reserved',
    reservedAttempts: repetitions,
  }))
  await store.create('run', spec, operations)
  const journal = await store.read('run')
  journal.candidates = candidates
  await store.write(journal)
  const runner = new DurableRunner(
    store,
    {
      async step() {
        throw new Error('no algorithm in evaluate')
      },
    },
    provider,
    pythonObjective,
  )
  return { store, provider, runner }
}

it('starts two candidates with two repetitions together, persists intents first and caps a wave at four slots', async () => {
  const { runner, provider, store } = await fixture()
  let writing = false
  const write = store.write.bind(store)
  vi.spyOn(store, 'write').mockImplementation(async (journal) => {
    expect(writing).toBe(false)
    writing = true
    try {
      await write(journal)
    } finally {
      writing = false
    }
  })
  const done = runner.run('run', new AbortController().signal)
  await vi.waitFor(() => expect(provider.calls).toHaveLength(2))
  expect((await store.read('run')).operations.map((item) => item.status)).toEqual([
    'submitted',
    'submitted',
    'reserved',
    'reserved',
  ])
  expect(provider.activeSlots).toBe(4)
  provider.release.get('candidate-1')!()
  provider.release.get('anchor')!()
  await vi.waitFor(() => expect(provider.calls).toHaveLength(4))
  provider.release.get('candidate-3')!()
  provider.release.get('candidate-2')!()
  const result = await done
  expect(provider.maximumSlots).toBe(4)
  expect(result.status).toBe('completed')
  expect(result.physicalAttempts).toBe(8)
  expect(result.seedEvidence).toHaveLength(8)
})

it('keeps a successful sibling receipt after a lost acknowledgement and resumes without duplicate experiments', async () => {
  const { runner, provider, store } = await fixture(2)
  provider.loseReply.add('anchor')
  const rejected = expect(runner.run('run', new AbortController().signal)).rejects.toThrow(
    'lost acknowledgement',
  )
  await vi.waitFor(() => expect(provider.calls).toHaveLength(2))
  provider.release.get('anchor')!()
  provider.release.get('candidate-1')!()
  await rejected
  expect((await store.read('run')).operations.map((item) => item.status)).toEqual(['submitted', 'complete'])
  expect((await store.read('run')).physicalAttempts).toBe(2)
  const complete = await runner.run('run', new AbortController().signal)
  expect(provider.calls).toHaveLength(2)
  expect(complete.physicalAttempts).toBe(4)
  expect(complete.seedEvidence).toHaveLength(4)
})

it('does not overlap evaluation operations whose combined slot reservations exceed four', async () => {
  const { runner, provider } = await fixture(2, 3)
  const done = runner.run('run', new AbortController().signal)
  await vi.waitFor(() => expect(provider.calls).toHaveLength(1))
  expect(provider.activeSlots).toBe(3)
  provider.release.get('anchor')!()
  await vi.waitFor(() => expect(provider.calls).toHaveLength(2))
  provider.release.get('candidate-1')!()
  expect((await done).physicalAttempts).toBe(6)
  expect(provider.maximumSlots).toBe(3)
})
