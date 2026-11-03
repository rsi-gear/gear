import { chmod, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { pythonObjective } from '../../src/adapters/python/objective.js'
import { resolveProjectObjective } from '../../src/application/objective.js'
import { bindRawMetrics } from '../../src/domain/objective-evidence.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import { ProjectApplication } from '../../src/application/project-service.js'
import { initProject } from '../../src/application/init.js'
import type { Evidence } from '../../src/domain/algorithm-wire.js'
import type { RawMetricDefinition } from '../../src/domain/objective.js'
import type { NativeScoreDefinition } from '../../src/domain/project.js'
import type { OperationProvider, OperationReceipt, OperationRequest } from '../../src/ports/operations.js'
import type { RunSpec } from '../../src/domain/run.js'
import { RunStore } from '../../src/adapters/storage/run-store.js'
import { DurableRunner } from '../../src/runtime/runner.js'
import { runReport } from '../../src/application/report.js'

const quality: RawMetricDefinition = {
  id: 'process_score',
  revision: '1',
  unit: 'points',
  direction: 'maximize',
  source: { path: 'originalResult.process_score', extractor: 'number-v1' },
  range: { min: 0, max: 100 },
  granularity: 'trial',
  repetitionReducer: 'mean',
  taskReducer: 'weighted-mean',
  comparisonPrecision: 1e-9,
}
const objective = resolveProjectObjective({
  metrics: [quality],
  objective: {
    terms: [
      { metric: 'pass_rate', weight: 0.5 },
      { metric: 'process_score', weight: 0.5, scale: 100 },
    ],
  },
})
const qualityContract = objective.metrics.find((metric) => metric.id === 'process_score')!
const cell = (candidate_id: string, task_id: string, score: number, value: number): Evidence => ({
  candidate_id,
  task_id,
  repetition: 0,
  score,
  status: 'valid',
  scope: 'global',
  feedback: '',
  raw_metrics: {
    process_score: {
      contractDigest: qualityContract.digest,
      unit: quality.unit,
      status: 'available',
      value,
      evidenceRefs: [canonicalDigest([candidate_id, task_id, value])],
    },
  },
})
const input = {
  task_ids: ['a', 'b'],
  repetitions: 1,
  candidate_id: 'candidate',
  anchor_id: 'anchor',
  partition: 'seed' as const,
  objective,
}
const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('reprojects weighted raw metrics without changing observations or denominators', () => {
  const evidence = [
    cell('anchor', 'a', 1, 20),
    cell('anchor', 'b', 1, 20),
    cell('candidate', 'a', 1, 80),
    cell('candidate', 'b', 0, 80),
  ]
  const before = structuredClone(evidence)
  const projected = pythonObjective.project({ ...input, evidence })
  expect(projected).toMatchObject({
    score: 0.65,
    complete: true,
    constraints_passed: true,
    observed: 2,
    expected: 2,
  })
  expect(projected.metrics.process_score).toMatchObject({ value: 80, observationTotal: 160 })
  expect(pythonObjective.compare({ ...input, evidence })).toMatchObject({
    gain: 0.05,
    constraints_passed: true,
  })
  const changed = resolveProjectObjective({ metrics: [quality], objective: { metric: 'pass_rate' } })
  expect(pythonObjective.project({ ...input, evidence, objective: changed }).score).toBe(0.5)
  expect(pythonObjective.project({ ...input, evidence: evidence.slice(0, -1) })).toMatchObject({
    score: null,
    complete: false,
    observed: 1,
    expected: 2,
  })
  expect(evidence).toEqual(before)
})

it('does not let an aggregate improvement hide a protected task regression', () => {
  const evidence = [
    cell('anchor', 'a', 1, 0),
    cell('anchor', 'b', 0, 0),
    cell('candidate', 'a', 0, 100),
    cell('candidate', 'b', 1, 100),
  ]
  const protectedObjective = {
    ...objective,
    protection: [
      { task_id: 'a', partition: 'seed' as const, metric: 'pass_rate', rule: 'no_new_violation' as const },
    ],
  }
  expect(pythonObjective.compare({ ...input, evidence, objective: protectedObjective })).toEqual({
    gain: 0.5,
    complete: true,
    constraints_passed: false,
  })
  expect(
    pythonObjective.project({ ...input, evidence, objective: protectedObjective }).protection[0]?.status,
  ).toBe('failed')
})

it('preserves valid zero and fails closed on selected missing or uncertified metrics', () => {
  const evidence = [
    cell('anchor', 'a', 1, 20),
    cell('anchor', 'b', 1, 20),
    cell('candidate', 'a', 0, 0),
    cell('candidate', 'b', 0, 0),
  ]
  expect(pythonObjective.project({ ...input, evidence })).toMatchObject({ score: 0, complete: true })
  delete evidence[3]!.raw_metrics!.process_score
  expect(pythonObjective.project({ ...input, evidence })).toMatchObject({ score: null, complete: false })
  const spec = {
    objective,
    benchmarkDigest: canonicalDigest('benchmark'),
    providerIdentity: canonicalDigest('provider'),
  } as RunSpec
  expect(() =>
    bindRawMetrics(
      { ...cell('candidate', 'a', 1, 80), status: 'scoring_failed', score: null },
      spec,
      canonicalDigest('candidate'),
    ),
  ).toThrow('invalid trial')
})

it('keeps raw metric references independent of objective weights and binds conditions', () => {
  const spec = {
    objective,
    benchmarkDigest: canonicalDigest('benchmark'),
    providerIdentity: canonicalDigest('provider'),
  } as RunSpec
  const raw = cell('anchor', 'a', 1, 80),
    candidate = canonicalDigest('candidate')
  const first = bindRawMetrics(raw, spec, candidate)
  const reweighted = {
    ...spec,
    objective: resolveProjectObjective({
      metrics: [quality],
      objective: { terms: [{ metric: 'process_score', weight: 1 }] },
    }),
  }
  expect(bindRawMetrics(raw, reweighted, candidate)).toEqual(first)
  expect(
    bindRawMetrics(raw, { ...spec, providerIdentity: canonicalDigest('different provider') }, candidate)
      .raw_metrics!.pass_rate!.evidenceRefs,
  ).not.toEqual(first.raw_metrics!.pass_rate!.evidenceRefs)
})

it('requires explicit measurement/protection contracts', () => {
  expect(() => resolveProjectObjective({ objective: { terms: [{ metric: 'unknown', weight: 1 }] } })).toThrow(
    'unknown',
  )
  expect(() =>
    resolveProjectObjective({
      metrics: [quality],
      objective: { metric: 'pass_rate' },
      protection: [{ task_id: 'a', partition: 'seed', metric: 'process_score', rule: 'no_new_violation' }],
    }),
  ).toThrow('Protection')
  expect(() =>
    resolveProjectObjective({
      metrics: [{ ...quality, id: 'total_tokens' }],
      objective: { metric: 'pass_rate' },
    }),
  ).toThrow('measurement')
})

it.each(['seed', 'held_out'] as const)(
  'enforces %s protection even if a custom algorithm nominates a regression',
  async (partition) => {
    const root = await mkdtemp(join(tmpdir(), 'gear-objective-gate-'))
    roots.push(root)
    const store = new RunStore(root)
    const provider: OperationProvider = {
      identity: canonicalDigest('gate-fixture'),
      capabilities: {
        seeds: false,
        temperature: false,
        subsets: true,
        idempotentSubmission: true,
        inspect: true,
        cancel: true,
        physicalAttemptAccounting: true,
        evidenceProjection: false,
        generationBudget: false, hardDollarBudget: false,
      },
      async submit(request) {
        const candidate = request.operation.candidate_id!
        return {
          result: {
            operation_id: request.operationId,
            kind: request.operation.kind,
            status: 'complete',
            candidate_id: candidate,
            data: null,
          },
          candidate: null,
          evidence: request.slots.map((slot) => ({
            ...cell(
              candidate,
              slot.taskId,
              Number((candidate === 'anchor') === (slot.taskId === 'private-a')),
              candidate === 'anchor' ? 0 : 100,
            ),
            repetition: slot.repetition,
            scope: 'held_out',
          })),
          physicalAttempts: request.slots.length,
          usage: {},
          provenance: null,
        }
      },
      async inspect() {
        return { state: 'not_submitted' }
      },
      async cancel() {},
    }
    const spec: RunSpec = {
      version: 1,
      kind: 'refine',
      benchmarkDigest: canonicalDigest('gate-tasks'),
      configDigest: canonicalDigest('gate-config'),
      implementationIdentity: canonicalDigest('custom-nominator'),
      providerIdentity: provider.identity,
      objectiveIdentity: pythonObjective.identity,
      objective: {
        ...objective,
        protection: [
          {
            partition,
            task_id: partition === 'seed' ? 'a' : 'private-a',
            metric: 'pass_rate',
            rule: 'no_new_violation',
          },
        ],
      },
      championRevision: null,
      targetSourceDigest: canonicalDigest('gate-target'),
      lineage: null,
      algorithm: { name: 'custom', options: {} },
      validationMode: 'holdout',
      seed: '0',
      seedTasks: ['a', 'b'].map((id) => ({ id, family: id, estimated_cost: 1 })),
      heldOutTaskIds: ['private-a', 'private-b'],
      anchor: { id: 'anchor', parent_id: null, digest: canonicalDigest('anchor') },
      budget: { rounds: 1, maxCandidates: 1, maxEvaluations: 20, repetitions: 1 },
      acceptance: { minimumGain: 0, maxHeldOutRegression: 0 },
      generationBudget: { version: 1, total: {}, perOperation: {} }, evaluationRepair: { maxRetries: 2, maxProjections: 2, backoffMs: [0] },
    }
    const journal = await store.create('run', spec)
    journal.candidates.push({ id: 'candidate', parent_id: 'anchor', digest: canonicalDigest('candidate') })
    journal.nomineeId = 'candidate'
    journal.seedEvidence = [
      cell('anchor', 'a', 1, 0),
      cell('anchor', 'b', 0, 0),
      cell('candidate', 'a', 0, 100),
      cell('candidate', 'b', 1, 100),
    ]
    await store.write(journal)
    const runner = new DurableRunner(
      store,
      {
        async step() {
          throw new Error('nomination is already committed')
        },
      },
      provider,
      pythonObjective,
    )
    const result = await runner.run('run', new AbortController().signal)
    expect(result.gate).toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining(partition === 'seed' ? 'seed' : 'held-out'),
    })
    expect(result.championId).toBe('anchor')
    expect(await store.champion()).toBeNull()
    expect(result.physicalAttempts).toBe(partition === 'seed' ? 0 : 4)
    expect(runReport(result).scores.nominee![partition].protection).toEqual([
      expect.objectContaining({ status: 'failed' }),
    ])
    const changed = structuredClone(result)
    changed.spec.objectiveIdentity = canonicalDigest('changed scoring implementation')
    expect(() => runReport(changed)).toThrow('Frozen objective implementation changed')
    changed.status = 'needs_recovery'
    changed.specDigest = canonicalDigest(changed.spec)
    await store.write(changed)
    await expect(runner.run('run', new AbortController().signal)).rejects.toThrow(
      'Frozen objective implementation changed',
    )
  },
)

it('runs a weighted GEPA round with the real isolated Python worker even after all tasks pass', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-objective-project-'))
  roots.push(root)
  const project = join(root, 'project')
  vi.stubEnv('GEAR_PYTHON', process.env.GEAR_TRAINING_TEST_PYTHON ?? resolve('.venv/bin/python'))
  await initProject(project, { adapter: 'pi', template: 'text' })
  const { load, dump } = await import('js-yaml')
  const config = load(await readFile(join(project, 'gear.yaml'), 'utf8')) as Record<string, unknown>
  if (process.env.GEAR_TEST_LINUX_ISOLATION)
    config.sandbox = { linux_isolation: process.env.GEAR_TEST_LINUX_ISOLATION }
  config.metrics = [quality]
  config.budget = { max_candidates: 1, rounds: 1, max_evaluations: 40 }
  config.objective = {
    terms: [
      { metric: 'pass_rate', weight: 0.5 },
      { metric: 'process_score', weight: 0.5, scale: 100 },
    ],
  }
  await writeFile(join(project, 'gear.yaml'), dump(config))
  const receipts = new Map<string, OperationReceipt>()
  const app = new ProjectApplication(project, {
    async provider(context) {
      const targets = join(context.stateRoot, 'runs', context.runId, 'targets')
      return {
        identity: canonicalDigest('weighted-fixture'),
        capabilities: {
          seeds: false,
          temperature: false,
          subsets: true,
          idempotentSubmission: true,
          inspect: true,
          cancel: true,
          physicalAttemptAccounting: true,
          evidenceProjection: false,
          generationBudget: false, hardDollarBudget: false,
        },
        async submit(request: OperationRequest) {
          const op = request.operation
          if (op.kind === 'generate_candidate') {
            await cp(join(targets, op.parent_id!), join(targets, op.candidate_id!), { recursive: true })
            await chmod(join(targets, op.candidate_id!, 'AGENTS.md'), 0o600)
            await writeFile(join(targets, op.candidate_id!, 'AGENTS.md'), 'Use a more effective method.\n')
          }
          const receipt: OperationReceipt = {
            result: {
              operation_id: request.operationId,
              kind: op.kind,
              status: 'complete',
              candidate_id: op.candidate_id,
              data:
                op.kind === 'diagnose_seed'
                  ? { hypotheses: ['Improve process quality without changing correctness'] }
                  : null,
            },
            candidate:
              op.kind === 'generate_candidate'
                ? { id: op.candidate_id!, parent_id: op.parent_id, digest: canonicalDigest(op) }
                : null,
            evidence: request.slots.map((slot) => ({
              ...cell(op.candidate_id!, slot.taskId, 1, op.candidate_id === 'anchor' ? 20 : 80),
              repetition: slot.repetition,
              scope: op.scope,
            })),
            physicalAttempts: request.slots.length,
            usage: { model_requests: 0 },
            provenance: null,
          }
          receipts.set(request.operationId, receipt)
          return receipt
        },
        async inspect(request) {
          const receipt = receipts.get(request.operationId)
          return receipt ? { state: 'complete' as const, receipt } : { state: 'not_submitted' as const }
        },
        async cancel() {},
      }
    },
  })
  const report = await app.refine({ rounds: 1 })
  expect(report.status).toBe('completed')
  expect(report.retained).not.toBe('anchor')
  expect(report.scores.initial.seed.score).toBe(0.6)
  expect(report.scores.retained.seed.score).toBe(0.9)
  expect(report.gate.status).toBe('accepted')
}, 30_000)

it('freezes independent assertion semantics and refuses undeclared or ambiguous protection', () => {
  const assertion = {
    id: 'independent',
    revision: '1',
    source: { path: 'originalResult.assertions.independent', extractor: 'assertion-status-v1' as const },
  }
  const guard = {
    task_id: 'a',
    partition: 'seed' as const,
    assertion_id: assertion.id,
    rule: 'must_pass' as const,
  }
  const config = {
    objective: { metric: 'pass_rate' as const },
    assertions: [assertion],
    assertion_protection: [guard],
  }
  const frozen = resolveProjectObjective(config)
  expect(frozen.assertions![0]!.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
  expect(
    resolveProjectObjective({ ...config, assertions: [{ ...assertion, revision: '2' }] }).assertions![0]!
      .digest,
  ).not.toBe(frozen.assertions![0]!.digest)
  expect(() => resolveProjectObjective({ ...config, assertion_protection: [guard, guard] })).toThrow(
    'one protection rule',
  )
  expect(() => resolveProjectObjective({ ...config, assertions: [] })).toThrow('declared assertion')
  expect(() =>
    resolveProjectObjective({
      ...config,
      assertions: [
        { ...assertion, source: { ...assertion.source, path: 'originalResult.__proto__.status' } },
      ],
    }),
  ).toThrow('explicit observation source')
  const observed = {
    ...cell('candidate', 'a', 1, 0),
    raw_metrics: null,
    assertions: [
      {
        id: assertion.id,
        schemaDigest: frozen.assertions![0]!.digest,
        status: 'failed' as const,
        evidenceRefs: [canonicalDigest('raw assertion')],
      },
    ],
  }
  const spec = {
    objective: frozen,
    benchmarkDigest: canonicalDigest('data'),
    providerIdentity: canonicalDigest('provider'),
  } as RunSpec
  expect(bindRawMetrics(observed, spec, canonicalDigest('candidate')).assertions?.[0]?.status).toBe('failed')
  const report = pythonObjective.project({
    ...input,
    task_ids: ['a'],
    evidence: [observed],
    objective: { ...frozen, assertion_protection: [] },
  })
  expect(report.assertions?.[0]?.values[0]?.status).toBe('failed')
  expect(() =>
    bindRawMetrics(
      { ...observed, assertions: [...observed.assertions, ...observed.assertions] },
      spec,
      canonicalDigest('candidate'),
    ),
  ).toThrow('frozen contract')
})

it('freezes the multi-signal seed rule for the default objective from the native manifest', () => {
  const score = (direction: 'maximize' | 'minimize'): NativeScoreDefinition => ({
    source_metric: 'partial_credit',
    direction,
    range: [0, 10],
    reducer: 'task-macro-mean',
  })
  const manifest = (process?: NativeScoreDefinition) => ({
    adapter: { id: 'fixture', revision: 'r1' },
    scoring: {
      total_score: { ...score('maximize'), source_metric: 'correct' },
      ...(process ? { process_score: process } : {}),
    },
  })
  const standard = resolveProjectObjective({ objective: { metric: 'pass_rate' } }, manifest(score('minimize')))
  expect(standard.seed_rule).toEqual({ rule: 'multisignal-v1', outcome: 'pass_rate', process: ['process_score'] })
  expect(standard.metrics.find((metric) => metric.id === 'process_score')).toMatchObject({
    revision: 'r1',
    direction: 'minimize',
    range: { min: 0, max: 10 },
    source: { path: 'verifier.scores.process_score', extractor: 'number-v1' },
    granularity: 'trial',
  })
  // Without a declared process channel the rule reduces to a strict pass-rate gain.
  for (const total of [manifest(), null, undefined]) {
    const objective = resolveProjectObjective({ objective: { metric: 'pass_rate' } }, total)
    expect(objective.seed_rule?.process).toEqual([])
    expect(objective.metrics.map((metric) => metric.id)).toEqual(['pass_rate'])
  }
  // A project's own process_score declaration keeps its semantics.
  const declared = resolveProjectObjective(
    { objective: { metric: 'pass_rate' }, metrics: [quality] },
    manifest(score('maximize')),
  )
  expect(declared.seed_rule?.process).toEqual(['process_score'])
  expect(declared.metrics.find((metric) => metric.id === 'process_score')).toMatchObject({ unit: 'points' })
  // Explicit objectives keep their configured gain and register no standard channel.
  const custom = resolveProjectObjective(
    { objective: { terms: [{ metric: 'pass_rate', weight: 1 }] } },
    manifest(score('maximize')),
  )
  expect(custom.seed_rule).toBeUndefined()
  expect(custom.metrics.map((metric) => metric.id)).toEqual(['pass_rate'])
})
