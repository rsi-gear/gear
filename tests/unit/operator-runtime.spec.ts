import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { Call, Decision, ModuleSpec } from '../../src/domain/algorithm-wire-v2.js'
import type { AlgorithmDriver, RunSpec } from '../../src/domain/run.js'
import type { OperationProvider, OperationReceipt, OperationRequest } from '../../src/ports/operations.js'
import type { OperatorEffects } from '../../src/ports/operator-effects.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import { RunStore } from '../../src/adapters/storage/run-store.js'
import { pythonObjective } from '../../src/adapters/python/objective.js'
import { builtinPolicy } from '../../src/adapters/python/builtin-policy.js'
import { OperatorRuntime } from '../../src/runtime/operator-runtime.js'
import { DurableRunner } from '../../src/runtime/runner.js'
import type { TargetExecution, OperatorPolicy } from '../../src/domain/operator-run.js'
import { resolveProjectObjective } from '../../src/application/objective.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const component: ModuleSpec = {
  kind: 'module',
  entrypoint: 'fixture:Recipe',
  params: {},
  children: {},
  source_dependencies: [],
  package_dependencies: [],
  resources: [],
  state_schema_version: 3,
}
const reference = { entrypoint: component.entrypoint, configuration_digest: canonicalDigest(component) }
const candidate = { run_id: 'run', candidate_id: 'anchor', digest: canonicalDigest('anchor') }
const signal = () => new AbortController().signal
const meta = (key = 'review'): Call => ({
  key,
  operator_ref: reference,
  output_schema_ref: { digest: canonicalDigest({}), schema: {} },
  effect: {
    kind: 'meta',
    input: {
      candidate,
      task_ids: ['task'],
      sources: [],
      data: null,
      prompt: 'Review the authorized candidate',
      schema: {},
      max_tokens: null,
    },
  },
})
const evaluate = (key: string, mode: 'fresh' | 'ensure' = 'ensure'): Call => ({
  key,
  operator_ref: reference,
  output_schema_ref: { digest: canonicalDigest({}), schema: {} },
  effect: {
    kind: 'execute',
    input: {
      candidate,
      plan: {
        mode,
        plan_id: mode === 'ensure' ? 'fixed' : null,
        evidence_set: null,
        tasks: [{ task_id: 'task', slots: [0] }],
        randomness: 'provider',
        seed: null,
      },
      assets: [],
      parameters: null,
      screening: null,
      mode: 'scored',
      exposure: 'scored',
      metrics: [],
    },
  },
})
const decision = (calls: Call[], step: number): Decision => ({
  state: { version: 3, data: { step } },
  calls,
  reason: 'fixture',
  terminal: calls.length ? null : { kind: 'stop', candidate: null, outcome: null },
  records: [],
})

class Provider implements OperationProvider {
  identity = canonicalDigest('provider')
  capabilities = {
    seeds: false,
    temperature: false,
    subsets: true,
    idempotentSubmission: true,
    inspect: true,
    cancel: true,
    physicalAttemptAccounting: true,
    evidenceProjection: false,
    generationBudget: true,
    hardDollarBudget: false,
    operatorMeta: true,
    blindProjection: false,
  }
  calls: OperationRequest[] = []
  receipts = new Map<string, OperationReceipt>()
  inspectCalls = 0
  lose = false
  unknown = false
  failTarget = false
  privateScore = false
  cancelled = 0
  projections: OperationRequest[] = []
  async submit(request: OperationRequest): Promise<OperationReceipt> {
    this.calls.push(structuredClone(request))
    const failed = this.failTarget && !request.repair
    const receipt: OperationReceipt = {
      result: {
        operation_id: request.operationId,
        kind: request.operation.kind,
        candidate_id: request.operation.candidate_id,
        status: 'complete',
        data: request.operatorCall ? { declined: false, data: { allow: true } } : null,
      },
      candidate: null,
      evidence: request.slots.map((slot) => ({
        candidate_id: request.operation.candidate_id!,
        task_id: slot.taskId,
        repetition: slot.repetition,
        scope: request.operation.scope,
        status: this.privateScore ? 'scoring_failed' : failed ? 'environment_failed' : 'valid',
        score: this.privateScore || failed ? null : 1,
        feedback: this.privateScore ? 'PRIVATE_SCORING_CANARY' : '',
      })),
      physicalAttempts: request.slots.length,
      usage: request.operatorCall ? { model_requests: 1, tokens: 10 } : {},
      provenance: null,
    }
    this.receipts.set(request.operationId, receipt)
    if (this.lose) {
      this.lose = false
      throw new Error('lost acknowledgement')
    }
    return receipt
  }
  async inspect(request: OperationRequest) {
    this.inspectCalls++
    if (this.unknown) return { state: 'unknown' as const }
    const receipt = this.receipts.get(request.operationId)
    return receipt ? { state: 'complete' as const, receipt } : { state: 'not_submitted' as const }
  }
  async cancel() {
    this.cancelled++
  }
  async completeEvidence(request: OperationRequest): Promise<OperationReceipt> {
    this.projections.push(structuredClone(request))
    const evidence = structuredClone(request.evidence)
    for (const cell of evidence)
      for (const id of request.projection!.missing.find(
        (slot) => slot.taskId === cell.task_id && slot.repetition === cell.repetition,
      )!.metrics) {
        const metric = request.metrics!.find((metric) => metric.id === id)!
        cell.raw_metrics = {
          ...cell.raw_metrics,
          [id]: {
            contractDigest: metric.digest,
            unit: metric.unit,
            status: 'available',
            value: 0.75,
            evidenceRefs: [canonicalDigest('sealed provider value')],
          },
        }
      }
    return {
      result: {
        operation_id: request.operationId,
        kind: 'evaluate_seed',
        candidate_id: request.operation.candidate_id,
        status: 'complete',
        data: null,
      },
      candidate: null,
      evidence,
      physicalAttempts: 0,
      usage: { model_requests: 0, tokens: 0, dollars: 0 },
      provenance: { projected: true },
    }
  }
  async captureExecutions(request: OperationRequest): Promise<TargetExecution[]> {
    return request.slots.map((slot) => ({
      taskId: slot.taskId,
      repetition: slot.repetition,
      status: 'succeeded',
      output: { value: { available: true, text: 'target answer' } },
      trajectory: { value: { text: 'target-only conversation' } },
    }))
  }
  async readExecutionArtifact(): Promise<Buffer> {
    throw new Error('No external artifacts in this fixture')
  }
}

async function fixture(
  steps: (view: Parameters<NonNullable<AlgorithmDriver['stepV2']>>[0]) => Decision,
  overrides: Partial<RunSpec> = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'gear-operator-runtime-'))
  roots.push(root)
  const store = new RunStore(root),
    provider = new Provider()
  const effects: OperatorEffects = {
    capabilities: ['artifact_read'],
    validateSchema(schema, value) {
      builtinPolicy('operator_schema', { schema, ...(value !== undefined ? { value } : {}) })
    },
    async materials() {
      return []
    },
    validateLocal() {
      throw new Error('not part of this fixture')
    },
    async execute() {
      throw new Error('not part of this fixture')
    },
  }
  const spec: RunSpec = {
    version: 1,
    kind: 'refine',
    benchmarkDigest: canonicalDigest('benchmark'),
    configDigest: canonicalDigest('config'),
    implementationIdentity: canonicalDigest('source'),
    providerIdentity: provider.identity,
    championRevision: null,
    targetSourceDigest: candidate.digest,
    lineage: null,
    algorithm: { name: component.entrypoint, options: {}, component, protocol_version: 2, requirements: [] },
    validationMode: 'holdout',
    seed: '0',
    seedTasks: [{ id: 'task', family: 'test', estimated_cost: 1 }],
    heldOutTaskIds: ['held-out'],
    anchor: { id: 'anchor', digest: candidate.digest, parent_id: null },
    budget: { rounds: 1, maxEvaluations: 10, maxCandidates: 2, repetitions: 1 },
    acceptance: { minimumGain: 0, maxHeldOutRegression: 0 },
    evaluationRepair: { maxRetries: 1, maxProjections: 0, backoffMs: [0] },
    generationBudget: {
      version: 1,
      total: { model_requests: 10, tokens: 1000 },
      perOperation: { model_requests: 1, tokens: 100 },
    },
    operatorPolicy: {
      version: 2,
      capabilities: ['meta', 'evaluate', 'artifact_read'],
      readBudget: { calls: 20, bytes: 10000 },
      fixedPlan: { name: 'fixed', tasks: [{ task_id: 'task', slots: [0] }] },
    },
    ...overrides,
  }
  await store.create('run', spec)
  let driverCalls = 0
  const operators = new OperatorRuntime(effects, provider)
  const runner = new DurableRunner(
    store,
    {
      async step() {
        throw new Error('v1 must not handle v2')
      },
      async stepV2(view) {
        driverCalls++
        return steps(view)
      },
    },
    provider,
    pythonObjective,
    undefined,
    operators,
  )
  return { runner, store, provider, operators, driverCalls: () => driverCalls }
}

it('commits state and all keys once, and reuses identical calls across steps', async () => {
  const { runner, provider, store } = await fixture((view) =>
    decision(view.step_id < 2 ? [meta()] : [], view.step_id + 1),
  )
  const result = await runner.run('run', signal())
  expect(result.status).toBe('completed')
  expect(result.operators?.state).toEqual({ version: 3, data: { step: 3 } })
  expect(result.operators?.calls).toHaveLength(1)
  expect(result.operators?.decisions[0]?.callIds).toEqual(result.operators?.decisions[1]?.callIds)
  expect(provider.calls).toHaveLength(1)
  expect((await store.read('run')).state).toEqual({ version: 1, data: {} })
})

it('refuses a changed request at an already committed key without changing saved algorithm state', async () => {
  const { runner, provider, store } = await fixture((view) => {
    const call = meta()
    if (view.step_id && call.effect.kind === 'meta') call.effect.input.data = 'different'
    return decision([call], view.step_id + 1)
  })
  await expect(runner.run('run', signal())).rejects.toMatchObject({ code: 'call-key-conflict' })
  expect(provider.calls).toHaveLength(1)
  const journal = await store.read('run')
  expect(journal.operators?.state.data.step).toBe(1)
  expect(journal.operators?.decisions).toHaveLength(1)
})

it('rejects an unaffordable independent batch before committing any state or submitting any effect', async () => {
  const { runner, provider, store } = await fixture(() => decision([meta('a'), meta('b')], 1), {
    generationBudget: { version: 1, total: { model_requests: 1 }, perOperation: { model_requests: 1 } },
  })
  await expect(runner.run('run', signal())).rejects.toMatchObject({ code: 'generation-budget-exhausted' })
  const journal = await store.read('run')
  expect(journal.operators?.calls).toEqual([])
  expect(journal.operators?.state.data).toEqual({})
  expect(provider.calls).toEqual([])
})

it('inspects unknown effects and never re-runs committed author decisions or blindly resubmits', async () => {
  const f = await fixture((view) => decision(view.step_id === 0 ? [meta()] : [], view.step_id + 1))
  f.provider.lose = true
  await expect(f.runner.run('run', signal())).rejects.toThrow('lost acknowledgement')
  f.provider.unknown = true
  await expect(f.runner.run('run', signal())).rejects.toMatchObject({ code: 'operation-needs-recovery' })
  expect(f.driverCalls()).toBe(1)
  expect(f.provider.calls).toHaveLength(1)
  f.provider.unknown = false
  expect((await f.runner.run('run', signal())).status).toBe('completed')
  expect(f.provider.inspectCalls).toBe(2)
  expect(f.provider.calls).toHaveLength(1)
})

it('cancels a committed v2 call without re-entering the algorithm or rewriting its decision', async () => {
  const f = await fixture(() => decision([meta()], 1))
  f.provider.lose = true
  await expect(f.runner.run('run', signal())).rejects.toThrow('lost acknowledgement')
  const before = await f.store.read('run')
  await f.store.cancel('run')
  await expect(f.runner.run('run', signal())).rejects.toMatchObject({ code: 'run-cancelled' })
  const after = await f.store.read('run')
  expect(after.status).toBe('cancelled')
  expect(after.operators).toEqual(before.operators)
  expect(f.provider.cancelled).toBe(1)
  expect(f.provider.calls).toHaveLength(1)
  expect(f.driverCalls()).toBe(1)
})

it('reserves result memory for a complete parallel batch before submitting paid work', async () => {
  const f = await fixture(
    () =>
      decision(
        Array.from({ length: 17 }, (_, i) => meta('call-' + i)),
        1,
      ),
    {
      generationBudget: { version: 1, total: { model_requests: 100 }, perOperation: { model_requests: 1 } },
    },
  )
  await expect(f.runner.run('run', signal())).rejects.toMatchObject({ code: 'operator-result-budget' })
  expect(f.provider.calls).toEqual([])
  expect((await f.store.read('run')).operators!.decisions).toEqual([])
})

it.each(['operator', 'candidate', 'task', 'schema', 'condition'] as const)(
  'rejects unauthorized %s before reservation or provider work',
  async (kind) => {
    const call = kind === 'condition' ? evaluate('eval') : meta()
    if (kind === 'operator')
      call.operator_ref = { ...reference, configuration_digest: canonicalDigest('forged') }
    if (call.effect.kind === 'meta') {
      if (kind === 'candidate') call.effect.input.candidate = { ...candidate, run_id: 'another-run' }
      if (kind === 'task') call.effect.input.task_ids = ['held-out']
      if (kind === 'schema') {
        call.output_schema_ref = { schema: { pattern: '.*' }, digest: canonicalDigest({ pattern: '.*' }) }
        call.effect.input.schema = call.output_schema_ref.schema
      }
    }
    if (kind === 'condition' && call.effect.kind === 'execute') call.effect.input.plan.randomness = 'paired'
    const f = await fixture(() => decision([call], 1))
    await expect(f.runner.run('run', signal())).rejects.toThrow()
    expect(f.provider.calls).toEqual([])
    expect((await f.store.read('run')).operators?.calls).toEqual([])
  },
)

it('keeps retries within their logical sample, reuses fixed samples and creates distinct confirmation plans', async () => {
  const f = await fixture((view) =>
    decision(
      view.step_id < 3 ? [evaluate(`eval/${view.step_id}`, view.step_id === 2 ? 'fresh' : 'ensure')] : [],
      view.step_id + 1,
    ),
  )
  f.provider.failTarget = true
  const result = await f.runner.run('run', signal())
  expect(result.physicalAttempts).toBe(4)
  expect(result.operators?.samples).toHaveLength(2)
  expect(result.operators?.calls[0]?.sampleIds).toEqual(result.operators?.calls[1]?.sampleIds)
  expect(result.operators?.calls[0]?.sampleIds).not.toEqual(result.operators?.calls[2]?.sampleIds)
  expect(result.seedEvidence).toEqual([])
  expect(result.operators?.calls.every((entry) => entry.result?.status === 'succeeded')).toBe(true)
  expect(f.provider.calls.filter((request) => request.repair)).toHaveLength(2)
})

it('projects missing metrics for independent fresh samples and reuses an explicit set without another physical attempt', async () => {
  const objective = resolveProjectObjective({
    metrics: [
      {
        id: 'quality',
        revision: '1',
        unit: 'ratio',
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
  const f = await fixture(
    (view) => {
      if (view.step_id >= 3) return decision([], 4)
      const call = evaluate('eval/' + view.step_id, 'fresh')
      if (view.step_id === 2 && call.effect.kind === 'execute') {
        call.effect.input.plan.mode = 'reuse'
        call.effect.input.plan.evidence_set = (
          view.results[0]!.value as { ref: import('../../src/domain/algorithm-wire-v2.js').ArtifactRef }
        ).ref
      }
      return decision([call], view.step_id + 1)
    },
    {
      objective,
      objectiveIdentity: pythonObjective.identity,
      evaluationRepair: { maxRetries: 0, maxProjections: 1, backoffMs: [0] },
    },
  )
  f.provider.capabilities.evidenceProjection = true
  const journal = await f.runner.run('run', signal())
  expect(journal.physicalAttempts).toBe(2)
  expect(f.provider.calls).toHaveLength(2)
  expect(f.provider.projections).toHaveLength(2)
  expect(journal.operators!.samples).toHaveLength(2)
  expect(journal.operators!.calls[2]!.sampleIds).toEqual(journal.operators!.calls[0]!.sampleIds)
  expect(journal.operators!.calls[0]!.result!.value).toMatchObject({
    records: [{ raw_metrics: { quality: { value: 0.75 } }, attempt_id: f.provider.calls[0]!.operationId }],
  })
  expect(journal.seedEvidence).toEqual([])
})

const blindPolicy: OperatorPolicy = {
  version: 2,
  capabilities: ['meta', 'evaluate', 'blind_projection', 'scored_private', 'task_stream'],
  readBudget: { calls: 20, bytes: 10000 },
  fixedPlan: {
    name: 'fixed',
    tasks: [
      { task_id: 'task', slots: [0] },
      { task_id: 'next', slots: [0] },
    ],
  },
  access: {
    exposure: 'blind',
    rollout_backend: 'scored_private',
    task_order: ['task', 'next'],
    usage_metrics: [],
  },
}
const rollout = (key: string, task = 'task') => {
  const call = evaluate(key)
  if (call.effect.kind !== 'execute') throw new Error('fixture')
  call.effect.input.mode = 'scored_private'
  call.effect.input.exposure = 'blind'
  call.effect.input.plan.tasks = [{ task_id: task, slots: [0] }]
  return call
}

it('keeps private scoring failures out of all operator views and never retries Target because of them', async () => {
  const views: unknown[] = []
  const f = await fixture(
    (view) => {
      views.push(view)
      return decision(view.step_id ? [] : [rollout('blind')], view.step_id + 1)
    },
    {
      operatorPolicy: blindPolicy,
      seedTasks: [
        { id: 'task', family: 'test', estimated_cost: 1 },
        { id: 'next', family: 'PRIVATE_FUTURE_TASK', estimated_cost: 1 },
      ],
    },
  )
  f.provider.capabilities.blindProjection = true
  f.provider.privateScore = true
  const journal = await f.runner.run('run', signal())
  expect(f.provider.calls).toHaveLength(1)
  expect(journal.physicalAttempts).toBe(1)
  expect(journal.operations[0]!.receipt!.evidence[0]!.status).toBe('scoring_failed')
  expect(journal.operators!.calls[0]!.result!.value).toMatchObject({ records: [{ status: 'succeeded' }] })
  expect(journal.operators!.artifacts.some((artifact) => artifact.ref.kind === 'assessment')).toBe(false)
  expect(JSON.stringify(views)).not.toMatch(/PRIVATE_|scoring_failed|feedback|raw_metrics|assertions/)
  expect(journal.operators!.stream!.index).toBe(0)
})

it('reuses an explicit blind execution collection without another physical attempt', async () => {
  const f = await fixture(
    (view) => {
      if (view.step_id > 1) return decision([], view.step_id)
      const call = rollout(view.step_id ? 'reuse' : 'original')
      if (view.step_id && call.effect.kind === 'execute') {
        call.effect.input.plan.mode = 'reuse'
        call.effect.input.plan.plan_id = null
        call.effect.input.plan.evidence_set = view.results[0]!.artifacts[0]!
      }
      return decision([call], view.step_id + 1)
    },
    { operatorPolicy: blindPolicy },
  )
  f.provider.capabilities.blindProjection = true
  f.provider.privateScore = true
  const journal = await f.runner.run('run', signal())
  expect(f.provider.calls).toHaveLength(1)
  expect(journal.operators!.calls[1]!.sampleIds).toEqual(journal.operators!.calls[0]!.sampleIds)
  expect(journal.operators!.calls[1]!.result!.value).toEqual(journal.operators!.calls[0]!.result!.value)
})

it('advances a finite stream atomically once and resumes a lost completion acknowledgement', async () => {
  const tasks = [
    { id: 'task', family: 'test', estimated_cost: 1 },
    { id: 'next', family: 'test', estimated_cost: 1 },
  ]
  const f = await fixture(
    (view) => {
      const progress = view.stream as { current_task: string | null; revision: string; index: number }
      expect(view.tasks.map((task) => task.id)).toEqual(
        tasks.slice(0, progress.index + 1).map((task) => task.id),
      )
      if (progress.current_task === null) return decision([], view.step_id + 1)
      const key = 'rollout/' + progress.current_task
      const result = view.results.find((result) => result.ref.key === key)
      if (!result)
        return {
          ...decision([rollout(key, progress.current_task)], view.step_id + 1),
          state: { version: 3, data: { cursor: 9999 } },
        }
      const record = (
        result.value as {
          records: Array<{
            sample_id: string
            output: import('../../src/domain/algorithm-wire-v2.js').ArtifactRef
          }>
        }
      ).records[0]!
      const complete: Call = {
        ...meta('complete/' + progress.current_task),
        effect: {
          kind: 'stream',
          input: {
            task_id: progress.current_task,
            sample_id: record.sample_id,
            output: record.output,
            expected_revision: progress.revision,
            library_refs: [],
          },
        },
      }
      return decision([complete], view.step_id + 1)
    },
    { operatorPolicy: blindPolicy, seedTasks: tasks },
  )
  f.provider.capabilities.blindProjection = true
  const original = f.store.write.bind(f.store)
  let lost = false
  vi.spyOn(f.store, 'write').mockImplementation(async (journal, options) => {
    await original(journal, options)
    if (!lost && journal.operators?.stream?.index === 1) {
      lost = true
      throw new Error('lost stream receipt')
    }
  })
  await expect(f.runner.run('run', signal())).rejects.toThrow('lost stream receipt')
  const journal = await f.runner.run('run', signal())
  expect(journal.status).toBe('completed')
  expect(journal.operators!.stream!.completed.map((task) => task.task_id)).toEqual(['task', 'next'])
  expect(f.provider.calls).toHaveLength(2)
  expect(new Set(journal.operators!.stream!.completed.map((task) => task.revision)).size).toBe(2)
})

it.each(['future', 'scored', 'batch', 'revision'] as const)(
  'rejects a %s authorization bypass before charging',
  async (kind) => {
    const call =
      kind === 'scored'
        ? evaluate('forbidden')
        : kind === 'future'
          ? rollout('forbidden', 'next')
          : {
              ...meta('complete'),
              effect: {
                kind: 'stream' as const,
                input: {
                  task_id: 'task',
                  sample_id: canonicalDigest('fake'),
                  output: {
                    run_id: 'run',
                    kind: 'task_output',
                    digest: canonicalDigest('fake'),
                    visibility: 'optimization' as const,
                  },
                  expected_revision: canonicalDigest('fake'),
                  library_refs: [],
                },
              },
            }
    const f = await fixture(() => decision(kind === 'batch' ? [call, meta()] : [call], 1), {
      operatorPolicy: blindPolicy,
    })
    f.provider.capabilities.blindProjection = true
    await expect(f.runner.run('run', signal())).rejects.toMatchObject({
      code: {
        future: 'task-not-authorized',
        scored: 'execution-exposure-denied',
        batch: 'task-completion-exclusive',
        revision: 'task-stream-conflict',
      }[kind],
    })
    expect(f.provider.calls).toEqual([])
    expect((await f.store.read('run')).operators!.state.data).toEqual({})
  },
)
