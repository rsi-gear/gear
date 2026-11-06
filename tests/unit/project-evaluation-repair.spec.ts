import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { RunStore } from '../../src/adapters/storage/run-store.js'
import { pythonObjective } from '../../src/adapters/python/objective.js'
import { runReport } from '../../src/application/report.js'
import { resolveProject } from '../../src/application/project-config.js'
import { resolveProjectObjective } from '../../src/application/objective.js'
import { initProject } from '../../src/application/init.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import type { Evidence, SearchView } from '../../src/domain/algorithm-wire.js'
import type { RunSpec } from '../../src/domain/run.js'
import type { OperationProvider, OperationReceipt, OperationRequest } from '../../src/ports/operations.js'
import { DurableRunner } from '../../src/runtime/runner.js'
import { validateDecision } from '../../src/runtime/decision-validation.js'

vi.mock('node:timers/promises', async (load) => {
  const timers = await load<typeof import('node:timers/promises')>()
  return { ...timers, setTimeout: vi.fn(timers.setTimeout) }
})

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
class Provider implements OperationProvider {
  identity = canonicalDigest('repair-provider')
  capabilities = {
    seeds: true,
    temperature: true,
    subsets: true,
    idempotentSubmission: true,
    inspect: true,
    cancel: true,
    physicalAttemptAccounting: true,
    evidenceProjection: false,
    generationBudget: false, hardDollarBudget: false,
  }
  calls: OperationRequest[] = []
  receipts = new Map<string, OperationReceipt>()
  unknown = false
  loseRepair = false
  cancelled = 0
  observe: (
    request: OperationRequest,
    slot: OperationRequest['slots'][number],
  ) => Pick<Evidence, 'score' | 'status'> = (request, slot) =>
    !request.repair && slot.taskId === 'b' && slot.repetition === 1
      ? { score: null, status: 'environment_failed' }
      : { score: 0, status: 'task_failed' }
  async submit(request: OperationRequest): Promise<OperationReceipt> {
    this.calls.push(structuredClone(request))
    const receipt: OperationReceipt = {
      result: {
        operation_id: request.operationId,
        kind: request.operation.kind,
        candidate_id: request.operation.candidate_id,
        status: 'complete',
        data: null,
      },
      evidence: request.slots.map((slot) => ({
        candidate_id: request.operation.candidate_id!,
        task_id: slot.taskId,
        repetition: slot.repetition,
        scope: request.operation.scope,
        feedback: '',
        ...this.observe(request, slot),
      })),
      candidate: null,
      physicalAttempts: request.slots.length,
      usage: {},
      provenance: { original: request.operationId },
    }
    this.receipts.set(request.operationId, structuredClone(receipt))
    if (request.repair && this.loseRepair) {
      this.loseRepair = false
      throw new Error('repair reply lost')
    }
    return receipt
  }
  projections: OperationRequest[] = []
  leaveMissing = false
  loseProjection = false
  mutateProjection?: (receipt: OperationReceipt) => void
  async completeEvidence(request: OperationRequest): Promise<OperationReceipt> {
    this.projections.push(structuredClone(request))
    const evidence = structuredClone(request.evidence)
    if (!this.leaveMissing)
      for (const cell of evidence) {
        const slot = request.projection!.missing.find(
          (slot) => slot.taskId === cell.task_id && slot.repetition === cell.repetition,
        )!
        for (const id of slot.assertions ?? []) {
          const contract = request.assertions!.find((item) => item.id === id)!
          cell.assertions = [
            ...(cell.assertions ?? []).filter((item) => item.id !== id),
            {
              id,
              schemaDigest: contract.digest,
              status: 'passed',
              evidenceRefs: [canonicalDigest('original-assertion')],
            },
          ]
        }
        for (const id of slot.metrics) {
          const contract = request.metrics!.find((metric) => metric.id === id)!
          cell.raw_metrics = {
            ...cell.raw_metrics,
            [id]: {
              status: 'available',
              contractDigest: contract.digest,
              unit: contract.unit,
              value: 0,
              evidenceRefs: [canonicalDigest('original-artifact')],
            },
          }
        }
      }
    const receipt: OperationReceipt = {
      result: {
        operation_id: request.operationId,
        kind: 'evaluate_seed',
        candidate_id: request.operation.candidate_id,
        status: 'complete',
        data: null,
      },
      evidence,
      candidate: null,
      physicalAttempts: 0,
      usage: { model_requests: 0 },
      provenance: { source: request.projection!.sourceReceiptDigest },
    }
    this.mutateProjection?.(receipt)
    this.receipts.set(request.operationId, structuredClone(receipt))
    if (this.loseProjection) {
      this.loseProjection = false
      throw new Error('projection reply lost')
    }
    return receipt
  }
  async inspect(request: OperationRequest) {
    if (this.unknown) return { state: 'unknown' as const }
    const receipt = this.receipts.get(request.operationId)
    return receipt ? { state: 'complete' as const, receipt } : { state: 'not_submitted' as const }
  }
  async cancel() {
    this.cancelled++
  }
}
async function fixture(overrides: Partial<RunSpec> = {}, partition: 'seed' | 'held_out' = 'seed') {
  const root = await mkdtemp(join(tmpdir(), 'gear-repair-'))
  roots.push(root)
  const store = new RunStore(root),
    provider = new Provider()
  const spec: RunSpec = {
    version: 1,
    kind: 'evaluate',
    benchmarkDigest: canonicalDigest('benchmark'),
    configDigest: canonicalDigest('config'),
    implementationIdentity: canonicalDigest('operator-evaluate'),
    providerIdentity: provider.identity,
    championRevision: null,
    targetSourceDigest: canonicalDigest('target'),
    lineage: null,
    algorithm: { name: 'operator-evaluate', options: {} },
    validationMode: 'holdout',
    seed: '0',
    seedTasks: ['a', 'b'].map((id) => ({ id, family: id, estimated_cost: 1 })),
    heldOutTaskIds: ['private'],
    anchor: { id: 'anchor', parent_id: null, digest: canonicalDigest('anchor') },
    budget: { rounds: 1, maxEvaluations: 20, maxCandidates: 1, repetitions: 2 },
    acceptance: { minimumGain: 0, maxHeldOutRegression: 0 },
    generationBudget: { version: 1, total: {}, perOperation: {} }, evaluationRepair: { maxRetries: 2, maxProjections: 2, backoffMs: [0] },
    ...overrides,
  }
  const slots = (partition === 'seed' ? ['a', 'b'] : ['private']).flatMap((taskId) =>
    [0, 1].map((repetition) => ({ taskId, repetition })),
  )
  await store.create('run', spec, [
    {
      request: {
        operationId: canonicalDigest('initial'),
        runId: 'run',
        generation: 1,
        operation: {
          kind: 'evaluate_seed',
          candidate_id: 'anchor',
          parent_id: null,
          task_ids: [...new Set(slots.map((slot) => slot.taskId))],
          scope: partition,
          rationale: 'operator evaluation',
          payload: null,
        },
        partition,
        repetitions: 2,
        slots,
        evidence: [],
        ...(spec.objective
          ? {
              metrics: spec.objective.metrics,
              ...(spec.objective.assertions ? { assertions: spec.objective.assertions } : {}),
            }
          : {}),
      },
      status: 'reserved',
      reservedAttempts: slots.length,
    },
  ])
  const runner = new DurableRunner(
    store,
    {
      async step() {
        throw new Error('evaluate must not call algorithm')
      },
    },
    provider,
    pythonObjective,
  )
  return { store, provider, runner }
}
const signal = () => new AbortController().signal

it.each(['environment_failed', 'scoring_failed'] as const)(
  'repairs only %s slots and preserves valid zero and original receipts',
  async (status) => {
    const { store, provider, runner } = await fixture()
    provider.observe = (request, slot) =>
      !request.repair && slot.taskId === 'b' && slot.repetition === 1
        ? { status, score: null }
        : { status: 'task_failed', score: 0 }
    const result = await runner.run('run', signal())
    expect(provider.calls.map((request) => request.slots.length)).toEqual([4, 1])
    expect(provider.calls[1]!.slots).toEqual([{ taskId: 'b', repetition: 1 }])
    expect(result.seedEvidence).toHaveLength(4)
    expect(result.seedEvidence.every((cell) => cell.score === 0)).toBe(true)
    expect(result.operations[0]!.receipt!.evidence[3]!.status).toBe(status)
    expect(result.operations[1]!.request.repair).toEqual({
      rootOperationId: result.operations[0]!.request.operationId,
      previousOperationId: result.operations[0]!.request.operationId,
      attempt: 1,
    })
    expect(runReport(result)).toMatchObject({
      coverage: { logical_slots: 4, valid_zero: 4, physical_attempts: 5, invalid: 0 },
      evaluation_repairs: { attempts: 1, physical_attempts: 1, blocked: [] },
    })
    const calls = provider.calls.length
    expect((await runner.run('run', signal())).digest).toBe((await store.read('run')).digest)
    expect(provider.calls).toHaveLength(calls)
  },
)

it('keeps repeated failure bounded and metered without selecting the best attempt', async () => {
  const { provider, runner } = await fixture()
  provider.observe = () => ({ score: null, status: 'environment_failed' })
  const result = await runner.run('run', signal())
  expect(provider.calls).toHaveLength(3)
  expect(result.physicalAttempts).toBe(12)
  expect(result.seedEvidence).toHaveLength(4)
  expect(result.seedEvidence.every((cell) => cell.score === null)).toBe(true)
  expect(result.operations.at(-1)!.repairBlocked).toBe('attempts-exhausted')
  expect(provider.calls.map((request) => request.repair?.attempt ?? 0)).toEqual([0, 1, 2])
})

it.each([0, 2])(
  'records disabled or unaffordable repair before new submission (maxRetries=%s)',
  async (maxRetries) => {
    const { runner, provider } = await fixture({
      generationBudget: { version: 1, total: {}, perOperation: {} }, evaluationRepair: { maxRetries, maxProjections: 2, backoffMs: [0] },
      budget: { rounds: 1, maxCandidates: 1, maxEvaluations: 4, repetitions: 2 },
    })
    const result = await runner.run('run', signal())
    expect(provider.calls).toHaveLength(1)
    expect(result.physicalAttempts).toBe(4)
    expect(result.seedEvidence[3]!.score).toBeNull()
    expect(result.operations[0]!.repairBlocked).toBe(maxRetries ? 'budget-exhausted' : 'retries-disabled')
  },
)

it('does not start a partial repair batch when only part of its slots fit the remaining budget', async () => {
  const { runner, provider } = await fixture({
    budget: { rounds: 1, maxCandidates: 1, maxEvaluations: 5, repetitions: 2 },
  })
  provider.observe = (_request, slot) =>
    slot.taskId === 'b' ? { score: null, status: 'scoring_failed' } : { score: 0, status: 'valid' }
  const result = await runner.run('run', signal())
  expect(provider.calls).toHaveLength(1)
  expect(runReport(result).evaluation_repairs.blocked).toEqual([
    { operation_id: canonicalDigest('initial'), reason: 'budget-exhausted' },
  ])
})

it('inspects a lost repair reply without resetting the budget or creating another attempt', async () => {
  const { store, runner, provider } = await fixture()
  provider.loseRepair = true
  await expect(runner.run('run', signal())).rejects.toThrow('repair reply lost')
  const saved = await store.read('run'),
    repair = saved.operations[1]!
  expect(repair.status).toBe('submitted')
  expect(runReport(saved).coverage).toMatchObject({ physical_attempts: 4, reserved_attempts: 1 })
  provider.unknown = true
  await expect(runner.run('run', signal())).rejects.toMatchObject({ code: 'operation-needs-recovery' })
  expect(provider.calls).toHaveLength(2)
  provider.unknown = false
  const completed = await runner.run('run', signal())
  expect(provider.calls).toHaveLength(2)
  expect(completed.operations[1]!.request).toEqual(repair.request)
  expect(completed.physicalAttempts).toBe(5)
})

it('reuses the frozen repair reservation and due time after interruption before submission', async () => {
  const { store, runner, provider } = await fixture({
    generationBudget: { version: 1, total: {}, perOperation: {} }, evaluationRepair: { maxRetries: 2, maxProjections: 2, backoffMs: [60_000] },
  })
  const abort = new AbortController(),
    write = store.write.bind(store)
  vi.spyOn(store, 'write').mockImplementation(async (journal) => {
    await write(journal)
    if (journal.operations.some((operation) => operation.request.repair && operation.status === 'reserved'))
      abort.abort(new Error('interrupted before repair'))
  })
  await expect(runner.run('run', abort.signal)).rejects.toThrow('interrupted before repair')
  const saved = await store.read('run'),
    reservation = saved.operations[1]!
  expect(reservation.status).toBe('reserved')
  expect(provider.calls).toHaveLength(1)
  vi.spyOn(Date, 'now').mockReturnValue(reservation.notBefore! + 1)
  const result = await runner.run('run', signal())
  expect(result.operations[1]!.request).toEqual(reservation.request)
  expect(result.operations[1]!.notBefore).toBe(reservation.notBefore)
  expect(provider.calls).toHaveLength(2)
})

it('cancels during persisted backoff without submitting or cancelling an unsubmitted repair', async () => {
  const { store, runner, provider } = await fixture({
    generationBudget: { version: 1, total: {}, perOperation: {} }, evaluationRepair: { maxRetries: 2, maxProjections: 2, backoffMs: [60_000] },
  })
  const work = runner.run('run', signal()),
    rejection = expect(work).rejects.toMatchObject({ code: 'run-cancelled' })
  await expect.poll(async () => (await store.read('run')).operations.length).toBe(2)
  await store.cancel('run')
  await rejection
  expect((await store.read('run')).status).toBe('cancelled')
  expect(provider.calls).toHaveLength(1)
  expect(provider.cancelled).toBe(0)
})

it('does not schedule a negative delay when a repair becomes due during the ownership check', async () => {
  const { store, runner, provider } = await fixture({
    evaluationRepair: { maxRetries: 2, maxProjections: 2, backoffMs: [100] },
  })
  const write = store.write.bind(store)
  const priorWaits = vi.mocked(delay).mock.calls.length
  let due: number | undefined
  vi.spyOn(store, 'write').mockImplementation(async (journal) => {
    await write(journal)
    const repair = journal.operations.find((operation) => operation.request.repair)
    if (due === undefined && repair?.status === 'reserved') {
      due = repair.notBefore!
      // The loop sees a future due time, then ownership I/O crosses it before scheduling.
      vi.spyOn(Date, 'now').mockReturnValue(due + 9).mockReturnValueOnce(due - 1)
    }
  })
  const warnings: Error[] = []
  const record = (warning: Error) => warnings.push(warning)
  process.on('warning', record)
  try {
    const result = await runner.run('run', signal())
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(due).toBeDefined()
    expect(result.operations[1]!.notBefore).toBe(due)
    expect(provider.calls).toHaveLength(2)
    expect(vi.mocked(delay).mock.calls.slice(priorWaits)).toEqual([])
    expect(warnings.filter((warning) => warning.name === 'TimeoutNegativeWarning')).toEqual([])
  } finally { process.removeListener('warning', record) }
})

it('repairs held-out slots without exposing original or repaired observations to seed history', async () => {
  const { runner, provider } = await fixture({}, 'held_out')
  provider.observe = (request) =>
    request.repair ? { score: 1, status: 'valid' } : { score: null, status: 'scoring_failed' }
  const result = await runner.run('run', signal())
  expect(result.seedEvidence).toEqual([])
  expect(result.completed).toEqual([])
  expect(result.heldOutEvidence).toHaveLength(2)
  expect(result.heldOutEvidence.every((cell) => cell.score === 1)).toBe(true)
  expect(
    provider.calls.every((request) => request.partition === 'held_out' && request.evidence.length === 0),
  ).toBe(true)
})

it('does not rerun valid outcomes to obtain a missing selected raw metric', async () => {
  const objective = resolveProjectObjective({
    metrics: [
      {
        id: 'quality',
        revision: '1',
        unit: 'points',
        direction: 'maximize',
        source: { path: 'originalResult.quality', extractor: 'number-v1' },
        granularity: 'trial',
        repetitionReducer: 'mean',
        taskReducer: 'weighted-mean',
        comparisonPrecision: 1e-9,
      },
    ],
    objective: { terms: [{ metric: 'quality', weight: 1 }] },
  })
  const { runner, provider } = await fixture({ objective, objectiveIdentity: pythonObjective.identity })
  provider.observe = () => ({ score: 0, status: 'valid' })
  const result = await runner.run('run', signal())
  expect(provider.calls).toHaveLength(1)
  expect(runReport(result).scores.initial.seed.complete).toBe(false)
  expect(runReport(result).coverage.valid_zero).toBe(4)
  expect(runReport(result).evidence_projections).toMatchObject({
    attempts: 0,
    blocked: [{ reason: 'provider-unsupported' }],
  })
})

it('rejects overlapping algorithm evaluation requests before reserving duplicate physical attempts', () => {
  const view = {
    run_id: 'run',
    tasks: [{ id: 'a' }],
    candidates: [{ id: 'anchor' }],
    budget: { candidates_remaining: 1 },
  } as SearchView
  const operation = {
    kind: 'evaluate_seed' as const,
    candidate_id: 'anchor',
    parent_id: null,
    task_ids: ['a'],
    scope: 'local',
    rationale: 'evaluate',
    payload: null,
  }
  expect(() =>
    validateDecision(view, {
      state: { version: 1, data: {} },
      reason: 'overlap',
      operations: [operation, { ...operation, scope: 'global' }],
    }),
  ).toThrow('overlap')
})

it('resolves repair defaults and rejects unknown or invalid advanced settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-repair-config-'))
  roots.push(root)
  const project = join(root, 'project')
  await initProject(project, { adapter: 'dsh', template: 'text' })
  const defaults = await resolveProject(project)
  expect(defaults.config.evaluation).toEqual({
    repair: { max_retries: 2, max_projections: 2, backoff_ms: [15000, 60000] },
  })
  const original = defaults.config
  await writeFile(
    join(project, 'gear.yaml'),
    JSON.stringify({ ...original, evaluation: { repair: { max_retries: 1, backoff_ms: [0] } } }),
  )
  const resolved = await resolveProject(project)
  expect(resolved.origins['evaluation.repair.max_retries']).toBe('gear.yaml')
  expect(resolved.origins['evaluation.repair.max_projections']).toBe('template default')
  for (const repair of [
    { max_retries: -1 },
    { max_retries: null },
    { max_projections: -1 },
    { max_projections: null },
    { max_projections: 0.5 },
    { backoff_ms: [] },
    { backoff_ms: [-1] },
    { typo: 1 },
  ]) {
    await writeFile(join(project, 'gear.yaml'), JSON.stringify({ ...original, evaluation: { repair } }))
    await expect(resolveProject(project)).rejects.toThrow()
  }
})

it('rejects a recovered repair widened to include a valid zero before contacting the provider', async () => {
  const { store, runner, provider } = await fixture()
  const originalWrite = store.write.bind(store)
  let crash = true
  vi.spyOn(store, 'write').mockImplementation(async (journal) => {
    await originalWrite(journal)
    if (crash && journal.operations.some((operation) => operation.request.repair)) {
      crash = false
      throw new Error('crash after repair reservation')
    }
  })
  await expect(runner.run('run', signal())).rejects.toThrow('crash after repair reservation')
  const saved = await store.read('run'),
    repair = saved.operations[1]!
  repair.request.slots.push({ taskId: 'a', repetition: 0 })
  repair.request.operation.task_ids.push('a')
  repair.reservedAttempts++
  repair.request.operationId = canonicalDigest([
    saved.id,
    'evaluation-repair',
    repair.request.repair,
    repair.request.slots,
  ])
  await store.write(saved)
  await expect(runner.run('run', signal())).rejects.toMatchObject({ code: 'invalid-repair-reservation' })
  expect(provider.calls).toHaveLength(1)
  expect((await store.read('run')).seedEvidence[0]!.score).toBe(0)
})

it('recovers a crash after repair settlement without overwriting history or charging twice', async () => {
  const { store, runner, provider } = await fixture()
  const originalWrite = store.write.bind(store)
  let crash = true
  vi.spyOn(store, 'write').mockImplementation(async (journal) => {
    await originalWrite(journal)
    if (
      crash &&
      journal.operations.some((operation) => operation.request.repair && operation.status === 'complete')
    ) {
      crash = false
      throw new Error('crash after repair settlement')
    }
  })
  await expect(runner.run('run', signal())).rejects.toThrow('crash after repair settlement')
  const saved = await store.read('run')
  const result = await runner.run('run', signal())
  expect(result.physicalAttempts).toBe(5)
  expect(result.operations).toEqual(saved.operations)
  expect(provider.calls).toHaveLength(2)
  expect(result.seedEvidence).toHaveLength(4)
})

const projectedObjective = () =>
  resolveProjectObjective({
    metrics: [
      {
        id: 'quality',
        revision: '1',
        unit: 'points',
        direction: 'maximize',
        source: { path: 'originalResult.quality', extractor: 'number-v1' },
        granularity: 'trial',
        repetitionReducer: 'mean',
        taskReducer: 'weighted-mean',
        comparisonPrecision: 1e-9,
      },
    ],
    objective: { terms: [{ metric: 'quality', weight: 1 }] },
  })
async function projectionFixture(partition: 'seed' | 'held_out' = 'seed', maxProjections = 2) {
  const f = await fixture(
    {
      objective: projectedObjective(),
      objectiveIdentity: pythonObjective.identity,
      generationBudget: { version: 1, total: {}, perOperation: {} }, evaluationRepair: { maxRetries: 2, maxProjections, backoffMs: [0] },
    },
    partition,
  )
  f.provider.capabilities.evidenceProjection = true
  f.provider.observe = () => ({ score: 0, status: 'valid' })
  return f
}

it('fills only missing raw metrics from original evidence without charging or rerunning a valid zero', async () => {
  const { runner, provider } = await projectionFixture()
  const result = await runner.run('run', signal())
  expect(provider.calls).toHaveLength(1)
  expect(provider.projections).toHaveLength(1)
  expect(result.physicalAttempts).toBe(4)
  expect(result.seedEvidence).toHaveLength(4)
  expect(
    result.seedEvidence.every((cell) => cell.score === 0 && cell.raw_metrics!.quality!.value === 0),
  ).toBe(true)
  expect(result.operations[0]!.receipt!.evidence.every((cell) => !cell.raw_metrics!.quality)).toBe(true)
  expect(runReport(result)).toMatchObject({
    scores: { initial: { seed: { complete: true, score: 0 } } },
    evidence_projections: { attempts: 1, blocked: [] },
  })
})

it('keeps unchanged projections bounded instead of resetting the attempt counter to an older receipt', async () => {
  const { runner, provider } = await projectionFixture()
  provider.leaveMissing = true
  const result = await runner.run('run', signal())
  expect(provider.projections.map((request) => request.projection!.attempt)).toEqual([1, 2])
  expect(provider.calls).toHaveLength(1)
  expect(result.operations.at(-1)!.projectionBlocked).toBe('attempts-exhausted')
  expect(runReport(result).scores.initial.seed.complete).toBe(false)
})

it('allows projection and execution repair on different slots of one original receipt', async () => {
  const { runner, provider } = await projectionFixture()
  provider.observe = (request, slot) =>
    !request.repair && slot.taskId === 'b' && slot.repetition === 1
      ? { score: null, status: 'environment_failed' }
      : { score: 0, status: 'valid' }
  const result = await runner.run('run', signal())
  expect(provider.calls.map((request) => request.slots.length)).toEqual([4, 1])
  expect(provider.projections.map((request) => request.slots.length)).toEqual([3, 1])
  expect(result.physicalAttempts).toBe(5)
  expect(runReport(result).scores.initial.seed.complete).toBe(true)
})

it('inspects unknown projection submissions and retains the original operation and metric sources', async () => {
  const { runner, provider, store } = await projectionFixture()
  provider.loseProjection = true
  await expect(runner.run('run', signal())).rejects.toThrow('projection reply lost')
  const source = await store.read('run')
  provider.unknown = true
  await expect(runner.run('run', signal())).rejects.toMatchObject({ code: 'operation-needs-recovery' })
  expect(provider.projections).toHaveLength(1)
  provider.unknown = false
  const result = await runner.run('run', signal())
  expect(provider.projections).toHaveLength(1)
  expect(result.operations[1]!.request).toEqual(source.operations[1]!.request)
  expect(result.physicalAttempts).toBe(4)
})

it.each(['score', 'available-metric', 'unselected-metric', 'model-request', 'physical-attempt'] as const)(
  'rejects a projection that changes %s',
  async (mutation) => {
    const { runner, provider, store } = await projectionFixture()
    provider.mutateProjection = (receipt) => {
      if (mutation === 'score') receipt.evidence[0]!.score = 1
      if (mutation === 'available-metric') receipt.evidence[0]!.raw_metrics!.pass_rate!.value = 1
      if (mutation === 'unselected-metric')
        receipt.evidence[0]!.raw_metrics!.extra = receipt.evidence[0]!.raw_metrics!.quality!
      if (mutation === 'model-request') receipt.usage.model_requests = 1
      if (mutation === 'physical-attempt') receipt.physicalAttempts = 1
    }
    await expect(runner.run('run', signal())).rejects.toThrow()
    const saved = await store.read('run')
    expect(saved.seedEvidence[0]!.score).toBe(0)
    expect(saved.seedEvidence[0]!.raw_metrics!.quality).toBeUndefined()
    expect(saved.physicalAttempts).toBe(4)
  },
)

it('does not expose mutable journal references to a projection provider', async () => {
  const { runner, provider, store } = await projectionFixture()
  const project = provider.completeEvidence.bind(provider)
  provider.completeEvidence = async (request) => {
    request.evidence[0]!.score = 1
    return project(request)
  }
  await expect(runner.run('run', signal())).rejects.toMatchObject({ code: 'immutable-projection-evidence' })
  expect((await store.read('run')).seedEvidence.every((cell) => cell.score === 0)).toBe(true)
})

it('keeps held-out projections and their source artifacts out of seed feedback', async () => {
  const { runner, provider } = await projectionFixture('held_out')
  const result = await runner.run('run', signal())
  expect(result.seedEvidence).toEqual([])
  expect(result.completed).toEqual([])
  expect(result.heldOutEvidence.every((cell) => cell.raw_metrics!.quality!.value === 0)).toBe(true)
  expect(provider.projections[0]!.partition).toBe('held_out')
})

it('reports disabled projections without a hidden execution fallback', async () => {
  const { runner, provider } = await projectionFixture('seed', 0)
  const result = await runner.run('run', signal())
  expect(provider.projections).toHaveLength(0)
  expect(provider.calls).toHaveLength(1)
  expect(result.operations[0]!.projectionBlocked).toBe('projections-disabled')
})

it.each(['reserved', 'complete'] as const)(
  'recovers a crash after projection %s without changing the source or double counting',
  async (status) => {
    const { runner, provider, store } = await projectionFixture()
    const write = store.write.bind(store)
    let crash = true
    vi.spyOn(store, 'write').mockImplementation(async (journal) => {
      await write(journal)
      if (crash && journal.operations.some((op) => op.request.projection && op.status === status)) {
        crash = false
        throw new Error(`projection crash: ${status}`)
      }
    })
    await expect(runner.run('run', signal())).rejects.toThrow(`projection crash: ${status}`)
    const saved = await store.read('run')
    const result = await runner.run('run', signal())
    expect(result.operations[1]!.request).toEqual(saved.operations[1]!.request)
    expect(result.operations[1]!.notBefore).toBe(saved.operations[1]!.notBefore)
    expect(result.operations[0]!.receipt).toEqual(saved.operations[0]!.receipt)
    expect(provider.projections).toHaveLength(1)
    expect(provider.calls).toHaveLength(1)
    expect(result.physicalAttempts).toBe(4)
    expect(runReport(result).scores.initial.seed.complete).toBe(true)
  },
)

it('rejects a recovered projection widened to rewrite an existing available metric', async () => {
  const { runner, provider, store } = await projectionFixture()
  const write = store.write.bind(store)
  let crash = true
  vi.spyOn(store, 'write').mockImplementation(async (journal) => {
    await write(journal)
    if (crash && journal.operations.some((op) => op.request.projection)) {
      crash = false
      throw new Error('projection reservation crash')
    }
  })
  await expect(runner.run('run', signal())).rejects.toThrow('projection reservation crash')
  const saved = await store.read('run')
  const request = saved.operations[1]!.request
  request.projection!.missing[0]!.metrics.push('pass_rate')
  request.operationId = canonicalDigest([saved.id, 'evidence-projection', request.projection, request.slots])
  await store.write(saved)
  await expect(runner.run('run', signal())).rejects.toMatchObject({ code: 'invalid-projection-reservation' })
  expect(provider.projections).toHaveLength(0)
  expect(provider.calls).toHaveLength(1)
})

it('stops projection when the provider explicitly declares a required channel unsupported', async () => {
  const { runner, provider } = await projectionFixture()
  provider.mutateProjection = (receipt) => {
    for (const cell of receipt.evidence) {
      cell.raw_metrics!.quality = {
        ...cell.raw_metrics!.quality!,
        status: 'unsupported',
        reason: 'No original channel',
      }
      delete cell.raw_metrics!.quality.value
    }
  }
  const result = await runner.run('run', signal())
  expect(provider.projections).toHaveLength(1)
  expect(provider.calls).toHaveLength(1)
  expect(runReport(result).evidence_projections.blocked).toEqual([
    { operation_id: result.operations[1]!.request.operationId, reason: 'metric-unsupported' },
  ])
  expect(runReport(result).scores.initial.seed.complete).toBe(false)
})

async function assertionFixture(partition: 'seed' | 'held_out' = 'seed') {
  const objective = resolveProjectObjective({
    objective: { metric: 'pass_rate' },
    assertions: [
      {
        id: 'independent',
        revision: '1',
        source: { path: 'originalResult.verifier.independent', extractor: 'assertion-status-v1' },
      },
    ],
    assertion_protection: [
      {
        task_id: partition === 'seed' ? 'a' : 'private',
        partition,
        assertion_id: 'independent',
        rule: 'must_pass',
      },
    ],
  })
  const f = await fixture({ objective, objectiveIdentity: pythonObjective.identity }, partition)
  f.provider.capabilities.evidenceProjection = true
  f.provider.observe = () => ({ score: 0, status: 'valid' })
  return { ...f, contract: objective.assertions![0]! }
}

it.each(['seed', 'held_out'] as const)(
  'recovers an assertion-only %s projection without rerunning or replacing valid zeros',
  async (partition) => {
    const { provider, runner, store } = await assertionFixture(partition)
    provider.loseProjection = true
    await expect(runner.run('run', signal())).rejects.toThrow('projection reply lost')
    const result = await runner.run('run', signal())
    expect(provider.calls).toHaveLength(1)
    expect(provider.projections).toHaveLength(1)
    expect(
      provider.projections[0]!.projection!.missing.every(
        (slot) => !slot.metrics.length && slot.assertions?.[0] === 'independent',
      ),
    ).toBe(true)
    expect(result.physicalAttempts).toBe(partition === 'seed' ? 4 : 2)
    const cells = partition === 'seed' ? result.seedEvidence : result.heldOutEvidence
    expect(cells.every((cell) => cell.score === 0)).toBe(true)
    expect(cells.filter((cell) => cell.assertions?.length)).toHaveLength(2)
    expect(result.operations[0]!.receipt!.evidence.every((cell) => !cell.assertions)).toBe(true)
    expect(runReport(result).scores.initial[partition].assertion_protection).toEqual([
      expect.objectContaining({ repetition: 0, status: 'passed' }),
      expect.objectContaining({ repetition: 1, status: 'passed' }),
    ])
    if (partition === 'held_out') expect((await store.read('run')).seedEvidence).toEqual([])
  },
)

it.each(['passed', 'failed', 'excluded'] as const)(
  'never requests replacement of an existing %s assertion',
  async (status) => {
    const { provider, runner, contract } = await assertionFixture()
    provider.observe = () => ({
      score: 0,
      status: 'valid',
      assertions: [
        { id: contract.id, schemaDigest: contract.digest, status, evidenceRefs: [canonicalDigest(status)] },
      ],
    })
    const result = await runner.run('run', signal())
    expect(provider.calls).toHaveLength(1)
    expect(provider.projections).toHaveLength(0)
    expect(runReport(result).scores.initial.seed.assertion_protection?.map((item) => item.status)).toEqual([
      status === 'passed' ? 'passed' : 'failed',
      status === 'passed' ? 'passed' : 'failed',
    ])
  },
)

it('rejects a forged assertion schema before saving a projection', async () => {
  const { provider, runner } = await assertionFixture()
  provider.mutateProjection = (receipt) => {
    receipt.evidence[0]!.assertions![0]!.schemaDigest = canonicalDigest('different-schema')
  }
  await expect(runner.run('run', signal())).rejects.toMatchObject({ code: 'assertion-contract-mismatch' })
})

it('rejects assertion projection scope drift before calling a provider after restart', async () => {
  const { provider, runner, store } = await assertionFixture()
  const write = store.write.bind(store)
  let crash = true
  vi.spyOn(store, 'write').mockImplementation(async (journal) => {
    await write(journal)
    if (crash && journal.operations.some((item) => item.request.projection)) {
      crash = false
      throw new Error('reserved assertion projection')
    }
  })
  await expect(runner.run('run', signal())).rejects.toThrow('reserved assertion projection')
  const saved = await store.read('run'),
    request = saved.operations[1]!.request
  request.projection!.missing[0]!.assertions!.push('unrequested')
  request.operationId = canonicalDigest([saved.id, 'evidence-projection', request.projection, request.slots])
  await write(saved)
  await expect(runner.run('run', signal())).rejects.toMatchObject({ code: 'invalid-projection-reservation' })
  expect(provider.projections).toHaveLength(0)
})

it('cannot rewrite an available assertion while completing a different assertion', async () => {
  const objective = resolveProjectObjective({
    objective: { metric: 'pass_rate' },
    assertions: ['existing', 'pending'].map((id) => ({
      id,
      revision: '1',
      source: { path: `originalResult.${id}`, extractor: 'assertion-status-v1' },
    })),
    assertion_protection: ['existing', 'pending'].map((assertion_id) => ({
      task_id: 'a',
      partition: 'seed',
      assertion_id,
      rule: 'must_pass',
    })),
  })
  const { provider, runner } = await fixture({ objective, objectiveIdentity: pythonObjective.identity })
  provider.capabilities.evidenceProjection = true
  provider.observe = () => ({
    score: 0,
    status: 'valid',
    assertions: [
      {
        id: 'existing',
        schemaDigest: objective.assertions![0]!.digest,
        status: 'passed',
        evidenceRefs: [canonicalDigest('existing')],
      },
    ],
  })
  provider.mutateProjection = (receipt) => {
    receipt.evidence[0]!.assertions!.find((value) => value.id === 'existing')!.status = 'failed'
  }
  await expect(runner.run('run', signal())).rejects.toMatchObject({ code: 'immutable-projection-evidence' })
  expect(provider.calls).toHaveLength(1)
  expect(provider.projections[0]!.projection!.missing[0]!.assertions).toEqual(['pending'])
})

it('keeps unsupported assertion evidence incomplete without repeatedly projecting it', async () => {
  const { provider, runner } = await assertionFixture()
  provider.mutateProjection = (receipt) => {
    for (const cell of receipt.evidence) cell.assertions![0]!.status = 'unsupported'
  }
  const result = await runner.run('run', signal())
  expect(provider.calls).toHaveLength(1)
  expect(provider.projections).toHaveLength(1)
  expect(runReport(result).scores.initial.seed.complete).toBe(false)
  expect(runReport(result).evidence_projections.blocked[0]?.reason).toBe('assertion-unsupported')
})

it.each(['outside', 'duplicate', 'missing-digest', 'available-reason'])(
  'rejects %s trajectory artifacts before accepting provider observations', async (mode) => {
    const { provider, runner, store } = await fixture()
    const submit = provider.submit.bind(provider)
    vi.spyOn(provider, 'submit').mockImplementation(async request => {
      const receipt = await submit(request)
      const artifact = { kind: 'trajectory' as const, format: 'test', task_id: mode === 'outside' ? 'private' : 'a', repetition: 0,
        status: 'available' as const, content_digest: mode === 'missing-digest' ? null : canonicalDigest('trace'), locator: { run_id: 'source' }, reason: mode === 'available-reason' ? 'failed' : null }
      receipt.artifacts = mode === 'duplicate' ? [artifact, artifact] : [artifact]
      return receipt
    })
    await expect(runner.run('run', signal())).rejects.toMatchObject({ code: 'invalid-trial-artifact' })
    expect((await store.read('run')).seedEvidence).toHaveLength(0)
  },
)
