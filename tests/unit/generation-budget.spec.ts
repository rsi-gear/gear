import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { canonicalDigest } from '../../src/domain/canonical.js'
import { generationBudget, type GenerationConfiguration } from '../../src/domain/generation-budget.js'
import { RunStore } from '../../src/adapters/storage/run-store.js'
import { DurableRunner } from '../../src/runtime/runner.js'
import { generationLedger } from '../../src/runtime/generation-budget.js'
import { pythonObjective } from '../../src/adapters/python/objective.js'
import { runReport } from '../../src/application/report.js'
import type { AlgorithmDriver, RunSpec } from '../../src/domain/run.js'
import type { Operation } from '../../src/domain/algorithm-wire.js'
import type { OperationProvider, OperationReceipt, OperationRequest } from '../../src/ports/operations.js'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const operation = (kind: Operation['kind'], candidate = 'anchor'): Operation => ({
  kind, candidate_id: candidate, parent_id: kind === 'generate_candidate' ? 'anchor' : null,
  task_ids: ['seed'], scope: 'global', rationale: 'budget fixture', payload: null,
})
class Provider implements OperationProvider {
  identity = canonicalDigest('generation-budget-provider')
  capabilities = { seeds: true, temperature: true, subsets: true, idempotentSubmission: true,
    inspect: true, cancel: true, physicalAttemptAccounting: true, evidenceProjection: false,
    hardDollarBudget: false, generationBudget: true }
  calls: OperationRequest[] = []
  receipts = new Map<string, OperationReceipt>()
  usage: OperationReceipt['usage'][] = [{ model_requests: 1, tokens: 20 }, { model_requests: 1, tokens: 30 }]
  lost = false
  unknown = false
  cancellations = 0
  async submit(request: OperationRequest) {
    this.calls.push(structuredClone(request))
    const receipt: OperationReceipt = {
      result: { operation_id: request.operationId, kind: request.operation.kind, status: 'complete', candidate_id: request.operation.candidate_id, data: null },
      candidate: request.operation.kind === 'generate_candidate' ? { id: request.operation.candidate_id!, parent_id: 'anchor', digest: canonicalDigest(request.operation) } : null,
      evidence: [], physicalAttempts: 0, usage: this.usage[this.calls.length - 1] ?? { model_requests: 1, tokens: 1 }, provenance: { provider: this.identity },
    }
    this.receipts.set(request.operationId, receipt)
    if (this.lost) { this.lost = false; throw new Error('reply lost') }
    return receipt
  }
  async inspect(request: OperationRequest) {
    if (this.unknown) return { state: 'unknown' as const }
    const receipt = this.receipts.get(request.operationId)
    return receipt ? { state: 'complete' as const, receipt } : { state: 'not_submitted' as const }
  }
  async cancel() { this.cancellations++ }
}
const defaults: GenerationConfiguration = { max_model_requests: 4, max_tokens: 100,
  per_operation: { max_model_requests: 2, max_tokens: 60 } }
async function fixture(config: GenerationConfiguration = defaults, batches: Operation[][] = [
  [operation('diagnose_seed')], [operation('generate_candidate', 'candidate')], [operation('stop')],
]) {
  const root = await mkdtemp(join(tmpdir(), 'gear-generation-budget-')); roots.push(root)
  const store = new RunStore(root), provider = new Provider()
  const spec: RunSpec = { version: 1, kind: 'refine', benchmarkDigest: canonicalDigest('tasks'), configDigest: canonicalDigest('config'),
    implementationIdentity: canonicalDigest('algorithm'), providerIdentity: provider.identity, championRevision: null,
    targetSourceDigest: canonicalDigest('target'), lineage: null, algorithm: { name: 'fixture', options: {} }, validationMode: 'research', seed: '0',
    seedTasks: [{ id: 'seed', family: 'seed', estimated_cost: 1 }], heldOutTaskIds: [],
    anchor: { id: 'anchor', parent_id: null, digest: canonicalDigest('anchor') },
    budget: { rounds: 1, maxCandidates: 3, maxEvaluations: 10, repetitions: 1 }, acceptance: { minimumGain: 0, maxHeldOutRegression: 0 },
    evaluationRepair: { maxRetries: 0, maxProjections: 0, backoffMs: [0] }, generationBudget: generationBudget(config) }
  await store.create('run', spec)
  const views: unknown[] = []
  const driver: AlgorithmDriver = { async step(view, state) {
    views.push(view.budget)
    return { state, reason: 'next budget fixture', operations: batches[view.step_id] ?? [operation('stop')] }
  } }
  return { store, provider, views, runner: new DurableRunner(store, driver, provider, pythonObjective) }
}
const signal = () => new AbortController().signal

it('reserves diagnosis and generation together, refunds only known usage, and exposes the remaining allowance', async () => {
  const { runner, provider, views } = await fixture()
  const result = await runner.run('run', signal())
  expect(provider.calls.map(call => call.generationLimits)).toEqual([
    { model_requests: 2, tokens: 60 }, { model_requests: 2, tokens: 60 },
  ])
  expect(views).toEqual([
    expect.objectContaining({ generation_requests_remaining: 4, generation_tokens_remaining: 100, generation_batch_capacity: 1 }),
    expect.objectContaining({ generation_requests_remaining: 3, generation_tokens_remaining: 80, generation_batch_capacity: 1 }),
    expect.objectContaining({ generation_requests_remaining: 2, generation_tokens_remaining: 50, generation_batch_capacity: 1 }),
  ])
  expect(runReport(result).generation_budget.metrics).toMatchObject({
    model_requests: { accounted_upper_bound: 2, reserved_upper_bound: 0, unknown_operations: 0, remaining: 2 },
    tokens: { accounted_upper_bound: 50, reserved_upper_bound: 0, unknown_operations: 0, remaining: 50 },
  })
})

it('keeps an unknown submission reserved and inspects the same ID before any replay', async () => {
  const { store, provider, runner } = await fixture()
  provider.lost = true; provider.unknown = true
  await expect(runner.run('run', signal())).rejects.toThrow('reply lost')
  const first = await store.read('run')
  expect(generationLedger(first).metrics.tokens).toMatchObject({ accounted_upper_bound: 60, reserved_upper_bound: 60, remaining: 40 })
  await expect(runner.run('run', signal())).rejects.toMatchObject({ code: 'operation-needs-recovery' })
  expect(provider.calls).toHaveLength(1)
  provider.unknown = false
  const complete = await runner.run('run', signal())
  expect(provider.calls).toHaveLength(2)
  expect(complete.operations[0]?.request).toEqual(first.operations[0]?.request)
  expect(generationLedger(complete).metrics.tokens.remaining).toBe(50)
})

it('replays a committed reservation after a lost acknowledgment without enlarging it', async () => {
  const { store, provider, runner } = await fixture()
  const write = store.write.bind(store)
  vi.spyOn(store, 'write').mockImplementation(async journal => {
    await write(journal)
    if (journal.operations.length === 1 && journal.operations[0]!.status === 'reserved') {
      vi.restoreAllMocks()
      throw new Error('lost reservation acknowledgment')
    }
  })
  await expect(runner.run('run', signal())).rejects.toThrow('lost reservation')
  expect(provider.calls).toHaveLength(0)
  const reserved = (await store.read('run')).operations[0]!.request
  await runner.run('run', signal())
  expect(provider.calls[0]).toEqual(reserved)
})

it('never partially submits a batch that exceeds the remaining generation budget', async () => {
  const { runner, provider, store } = await fixture({ max_model_requests: 3, per_operation: { max_model_requests: 2 } }, [
    [operation('diagnose_seed')], [operation('generate_candidate', 'one'), operation('generate_candidate', 'two')],
  ])
  await expect(runner.run('run', signal())).rejects.toMatchObject({ code: 'generation-budget-exhausted' })
  expect(provider.calls).toHaveLength(1)
  expect((await store.read('run')).operations).toHaveLength(1)
})

it('keeps missing and null metering charged at the full allowance, including after restart', async () => {
  const { runner, provider, store } = await fixture({ max_model_requests: 3, max_tokens: 100, per_operation: { max_model_requests: 2, max_tokens: 50 } })
  provider.usage = [{ model_requests: null }, { model_requests: 1, tokens: 20 }]
  const result = await runner.run('run', signal())
  expect(provider.calls[1]?.generationLimits).toEqual({ model_requests: 1, tokens: 50 })
  expect(runReport(result).usage).toMatchObject({ model_requests: null, tokens: null })
  expect(generationLedger(await store.read('run')).metrics).toMatchObject({
    model_requests: { accounted_upper_bound: 3, unknown_operations: 1, remaining: 0 },
    tokens: { accounted_upper_bound: 70, unknown_operations: 1, remaining: 30 },
  })
  await runner.run('run', signal())
  expect(provider.calls).toHaveLength(2)
})

it.each([
  { model_requests: 3, tokens: 20 },
  { model_requests: 1, tokens: 0.5 },
  { model_requests: 1, tokens: 20, input_tokens: 15, output_tokens: 10 },
  { model_requests: 1, tokens: 20, input_tokens: 15, output_tokens: 5, cached_input_tokens: 16 },
  { model_requests: 0, tokens: 20 },
  { model_requests: 1, input_tokens: 61 },
  { model_requests: 1, cached_input_tokens: 61 },
  { model_requests: 1, output_tokens: 61, tokens: null },
  { model_requests: 1, input_tokens: 35, output_tokens: 30 },
  { model_requests: 1, tokens: 20, input_tokens: 25 },
  { model_requests: 1, tokens: 20, cached_input_tokens: 25 },
])('preserves a metering violation and fences all further submissions: %j', async usage => {
  const { runner, provider, store } = await fixture()
  provider.usage = [usage]
  await expect(runner.run('run', signal())).rejects.toMatchObject({ code: 'generation-budget-violation' })
  const saved = await store.read('run')
  expect(saved.completed).toHaveLength(0)
  expect(saved.operations[0]?.generationViolation?.receipt.usage).toEqual(usage)
  expect(runReport(saved).generation_budget.violations[0]?.usage).toEqual(usage)
  expect(runReport(saved).generation_budget).toMatchObject({ batch_capacity: 0,
    metrics: { tokens: { accounted_upper_bound: null, remaining: 0 } } })
  expect(runReport(saved).next_action).toContain('gear cancel run')
  await expect(runner.run('run', signal())).rejects.toMatchObject({ code: 'generation-budget-violation' })
  expect(provider.calls).toHaveLength(1)
  await store.cancel('run')
  await expect(runner.run('run', signal())).rejects.toMatchObject({ code: 'run-cancelled' })
  expect(provider.cancellations).toBe(1)
  expect(runReport(await store.read('run')).next_action).toBe('Inspect provider metering before starting a new run with gear refine')
})

it('rejects a provider without enforcement before any operation, and never restores a missing policy as unlimited', async () => {
  const { runner, provider, store } = await fixture()
  provider.capabilities.generationBudget = false
  await expect(runner.run('run', signal())).rejects.toMatchObject({ code: 'generation-budget-unsupported' })
  expect(provider.calls).toHaveLength(0)
  provider.capabilities.generationBudget = true
  const saved = await store.read('run')
  delete (saved.spec as Partial<RunSpec>).generationBudget
  saved.specDigest = canonicalDigest(saved.spec)
  await store.write(saved)
  await expect(runner.run('run', signal())).rejects.toMatchObject({ code: 'frozen-generation-budget-missing' })
})

it('refuses a reservation outside the frozen allowance before inspecting or submitting', async () => {
  const { runner, provider, store } = await fixture()
  provider.lost = true
  await expect(runner.run('run', signal())).rejects.toThrow('reply lost')
  const saved = await store.read('run')
  saved.operations[0]!.request.generationLimits!.tokens = 999
  await store.write(saved)
  const inspect = vi.spyOn(provider, 'inspect')
  await expect(runner.run('run', signal())).rejects.toMatchObject({ code: 'invalid-generation-reservation' })
  expect(inspect).not.toHaveBeenCalled()
  expect(provider.calls).toHaveLength(1)
})

it('enforces per-operation ceilings independently when no total limit is configured', async () => {
  const { runner, provider } = await fixture({ per_operation: { max_model_requests: 2, max_tokens: 40 } })
  const result = await runner.run('run', signal())
  expect(provider.calls.map(call => call.generationLimits)).toEqual([
    { model_requests: 2, tokens: 40 }, { model_requests: 2, tokens: 40 },
  ])
  expect(generationLedger(result).metrics.tokens.remaining).toBeNull()
  expect(generationLedger(result).metrics.tokens.accounted_upper_bound).toBe(50)
})

it('rejects cumulative reservations above the safe-integer boundary without rounding their sum', async () => {
  const { runner, provider } = await fixture({ max_tokens: Number.MAX_SAFE_INTEGER, per_operation: { max_tokens: Number.MAX_SAFE_INTEGER - 1 } }, [
    [operation('diagnose_seed'), { ...operation('diagnose_seed'), rationale: 'second request' }],
  ])
  await expect(runner.run('run', signal())).rejects.toMatchObject({ code: 'generation-budget-exhausted' })
  expect(provider.calls).toHaveLength(0)
})

it.each([null, { extra: 1 }, { max_tokens: 0 }, { max_model_requests: 1.5 }, { per_operation: { max_tokens: -1 } }, { max_tokens: Number.MAX_SAFE_INTEGER + 1 }])('rejects invalid generation configuration %j', value => {
  expect(() => generationBudget(value)).toThrow()
})
