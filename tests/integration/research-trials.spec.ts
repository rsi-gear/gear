import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { fixtureRuntime } from '../helpers/hitch-runtime-fixture.js'
import { HitchOperationProvider } from '../../src/adapters/hitch/provider.js'
import { DshHarnessAdapter } from '../../src/adapters/dsh/harness.js'
import { RunStore } from '../../src/adapters/storage/run-store.js'
import { TargetStore } from '../../src/adapters/storage/targets.js'
import { freezeAlgorithmSource } from '../../src/adapters/python/source.js'
import { PythonAlgorithmWorker } from '../../src/adapters/python/worker.js'
import { resolvePythonExecutable } from '../../src/adapters/python/interpreter.js'
import { pythonObjective } from '../../src/adapters/python/objective.js'
import { pythonJson } from '../../src/application/python.js'
import { sealedProvider } from '../../src/application/sealed-provider.js'
import { DurableRunner } from '../../src/runtime/runner.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import { runReport } from '../../src/application/report.js'
import { researchDataPolicy, trialPlan, trialSlots } from '../../src/domain/research-trials.js'
import type { CompiledBenchmark } from '../../src/domain/project.js'
import type { Operation } from '../../src/domain/algorithm-wire.js'
import type { RunSpec } from '../../src/domain/run.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const signal = () => new AbortController().signal
const baseImage = 'python@sha256:' + '1'.repeat(64)

it.each([false, true])(
  'runs research trials through the worker and Hitch with report_only=%s',
  async (reportOnly) => {
    const root = await mkdtemp(join(tmpdir(), 'gear-research-trials-'))
    roots.push(root)
    await writeFile(
      join(root, 'tasks.csv'),
      'id,instruction,expected,family,split\na,Original task,answer,train,seed\nb,Second original task,other,train,seed\n',
    )
    const benchmark = (await pythonJson(['benchmark', 'compile', '--root', root], {
      version: 1,
      source: 'tasks.csv',
      template: 'text',
    })) as CompiledBenchmark
    const executable = join(root, 'hitch.mjs')
    await writeFile(
      executable,
      `#!${process.execPath}\nimport {runOrderedHitchFixture} from ${JSON.stringify(new URL('../fixtures/ordered-hitch.mjs', import.meta.url).href)};\nrunOrderedHitchFixture('${canonicalDigest('runtime')}');\n`,
      { mode: 0o700 },
    )
    await writeFile(join(root, 'remote.json'), JSON.stringify({ loseSubmitReply: true }))
    const directory = join(root, '.gear/runs/run'),
      targets = join(directory, 'targets'),
      adapter = new DshHarnessAdapter()
    await adapter.prepare(join(targets, 'anchor'))
    const compile = (destination: string, taskIds: string[], inputs?: Record<string, string>) =>
      pythonJson(['benchmark', 'harbor', '--output', destination], {
        benchmark,
        task_ids: taskIds,
        base_image: baseImage,
        ...(inputs ? { task_inputs: inputs } : {}),
      })
    const provider = await HitchOperationProvider.connect(
      {
        kind: 'hitch',
        executable,
        root,
        harnessRef: 'deepseek@version:0.1.1-rc.2',
        model: 'fixture',
        baseImage,
        passEnv: [],
        timeoutMs: 3000,
      },
      {
        directory: join(directory, 'provider'),
        targets,
        adapter,
        taskIds: ['a'],
        runtime: fixtureRuntime,
        implementationIdentity: canonicalDigest('compiler'),
        compile: (destination, taskIds) => compile(destination, taskIds),
        compileInputs: (destination, taskIds, _baseImage, inputs) => compile(destination, taskIds, inputs),
        seal: (destination, taskIds) =>
          pythonJson(['benchmark', 'seal-harbor'], { benchmark, destination, task_ids: taskIds }),
      },
    )
    const targetStore = new TargetStore(directory, adapter, provider.identity)
    const anchor = {
      id: 'anchor',
      parent_id: null,
      digest: (await targetStore.seal('anchor', 'fixture')).digest,
    }
    const source = join(root, 'source'),
      scratch = join(root, 'scratch')
    await mkdir(scratch)
    await writeFile(
      join(root, 'research_case.py'),
      `from gear.algorithms import WorkflowAlgorithm, TaskInstance\nclass Research(WorkflowAlgorithm):\n    def __init__(self, short=False): self.short = short\n    async def run(self, ctx):\n        if not self.short:\n            await ctx.evaluate(ctx.inputs.anchor, tasks=['a'], key='canonical')\n        first = await ctx.measure(ctx.inputs.anchor, tasks=ctx.data.train, group='initial', key='first')\n        if self.short:\n            return ctx.result(selected=ctx.inputs.anchor, candidates=[ctx.inputs.anchor], data={'score': first.observations[0].evidence.score})\n        retry = await ctx.measure(ctx.inputs.anchor, tasks=[ctx.data.derive('a', 'Use the reflection then solve the original task', id='retry')], key='retry')\n        reused = await ctx.measure(ctx.inputs.anchor, tasks=ctx.data.train, group='initial', key='reuse')\n        fresh = await ctx.measure(ctx.inputs.anchor, tasks=[TaskInstance('one','a'), TaskInstance('two','a','Another derived question')], repetitions=2, key='fresh')\n        assert first.ok and retry.ok and reused.ok and fresh.ok\n        assert first.observations[0].id == reused.observations[0].id\n        assert first.observations[0].usage is None\n        assert retry.observations[0].input_digest != first.observations[0].input_digest\n        assert [(v.instance_id,v.repetition) for v in fresh.observations] == [('one',0),('one',1),('two',0),('two',1)]\n        return ctx.result(reason='research complete')\n`,
    )
    const implementationIdentity = await freezeAlgorithmSource(
      source,
      [{ path: 'research_case.py', source: join(root, 'research_case.py') }],
      [],
    )
    const policy = researchDataPolicy(
      { train: ['a'], dev: ['b'], allow_derived_inputs: true, report_only: reportOnly },
      benchmark,
    )!
    const spec: RunSpec = {
      version: 1,
      kind: 'refine',
      benchmarkDigest: benchmark.digest,
      configDigest: canonicalDigest('project'),
      implementationIdentity,
      providerIdentity: provider.identity,
      championRevision: null,
      targetSourceDigest: anchor.digest,
      lineage: null,
      algorithm: { name: 'research_case:Research', options: { short: reportOnly } },
      validationMode: reportOnly ? 'holdout' : 'research',
      seed: 'fixed',
      seedTasks: [
        { id: 'a', family: 'train', estimated_cost: 1 },
        { id: 'b', family: 'train', estimated_cost: 1 },
      ],
      heldOutTaskIds: [],
      researchData: policy,
      anchor,
      budget: { rounds: 1, maxEvaluations: reportOnly ? 1 : 10, maxCandidates: 1, repetitions: 1 },
      acceptance: { minimumGain: 0, maxHeldOutRegression: 0 },
      generationBudget: { version: 1, total: {}, perOperation: {} },
      evaluationRepair: { maxRetries: 0, maxProjections: 0, backoffMs: [0] },
    }
    const store = new RunStore(join(root, '.gear'))
    await store.create('run', spec)
    const worker = () =>
      new PythonAlgorithmWorker({
        python: resolvePythonExecutable(true),
        sourceRoot: source,
        scratch,
        implementationIdentity,
        ...(process.env.GEAR_TEST_LINUX_ISOLATION
          ? { linuxIsolation: process.env.GEAR_TEST_LINUX_ISOLATION as 'seccomp' | 'bubblewrap-only' }
          : {}),
      })
    let driver = worker()
    try {
      await driver.start(signal())
      await expect(
        new DurableRunner(store, driver, sealedProvider(provider, targetStore), pythonObjective).run(
          'run',
          signal(),
        ),
      ).rejects.toThrow()
      await driver.dispose()
      driver = worker()
      await driver.start(signal())
      const result = await new DurableRunner(
        store,
        driver,
        sealedProvider(provider, targetStore),
        pythonObjective,
      ).run('run', signal())
      expect(result.status).toBe('completed')
      expect(runReport(result).research_trials).toMatchObject({
        observations: reportOnly ? 1 : 6,
        physical_attempts: reportOnly ? 1 : 6,
        reserved_attempts: 0,
      })
      expect(result.seedEvidence).toHaveLength(reportOnly ? 0 : 1)
      expect(result.gate.status).toBe('not_run')
      if (reportOnly) {
        expect(runReport(result).algorithm_result).toEqual({
          authority: 'algorithm-reported',
          value: { selected: 'anchor', candidates: ['anchor'], data: { score: 0 } },
        })
        expect(runReport(result).plan!.baseline.new_physical_trials).toBe(0)
      }
      expect(result.researchTrials).toHaveLength(reportOnly ? 1 : 6)
      expect(new Set(result.researchTrials!.map((v) => v.id)).size).toBe(reportOnly ? 1 : 6)
      expect(result.physicalAttempts).toBe(reportOnly ? 1 : 7)
      const state = JSON.parse(await readFile(join(root, 'remote.json'), 'utf8'))
      expect(state.jobs).toBe(reportOnly ? 1 : 7)
      if (reportOnly) return
      const retry = result.operations.find((op) => op.request.trials?.group === 'retry')!
      const task = join(directory, 'provider', retry.request.operationId.slice(7), 'dataset-0', 'a')
      expect(await readFile(join(task, 'instruction.md'), 'utf8')).toContain('Use the reflection')
      expect(JSON.parse(await readFile(join(task, 'tests/expected.json'), 'utf8')).expected).toBe('answer')
      expect(JSON.stringify(result.researchTrials)).not.toContain('answer')
    } finally {
      await driver.dispose()
    }
  },
  60000,
)

it('enforces disjoint adaptive data and preserves ordered duplicate instances', () => {
  const benchmark = {
    splits: { seed: ['a', 'b'], held_out: ['secret'] },
    tasks: [
      { id: 'a', instruction: 'A', digest: canonicalDigest('A'), family: 'x' },
      { id: 'b', instruction: 'B', digest: canonicalDigest('B'), family: 'y' },
    ],
    verifiers: { a: { expected: 'private train' }, b: { expected: 'private dev' } },
  } as unknown as CompiledBenchmark
  expect(() => researchDataPolicy({ train: ['a'], dev: ['a'] }, benchmark)).toThrow('disjoint')
  expect(() => researchDataPolicy({ train: ['a'], dev: ['secret'] }, benchmark)).toThrow('disjoint')
  const policy = researchDataPolicy({ train: ['a'], dev: ['b'], include_train_labels: true }, benchmark)!
  expect(policy.tasks[0]!.expected).toBe('private train')
  expect(policy.tasks[1]!.expected).toBeUndefined()
  const operation = {
    kind: 'evaluate_seed',
    candidate_id: 'anchor',
    task_ids: ['a'],
    payload: {
      gear_trials_v1: {
        group: 'test',
        repetitions: 2,
        instances: [
          { id: 'x', task_id: 'a' },
          { id: 'y', task_id: 'a', question: 'different' },
        ],
      },
    },
  } as unknown as Operation
  expect(
    trialSlots(trialPlan(operation)!).map((slot) => [slot.instance.id, slot.repetition, slot.sample]),
  ).toEqual([
    ['x', 0, 0],
    ['x', 1, 1],
    ['y', 2, 0],
    ['y', 3, 1],
  ])
})
