import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { PythonAlgorithmWorker } from '../../src/adapters/python/worker.js'
import { freezeAlgorithmSource } from '../../src/adapters/python/source.js'
import { resolvePythonExecutable } from '../../src/adapters/python/interpreter.js'
import { pythonObjective } from '../../src/adapters/python/objective.js'
import { DshHarnessAdapter } from '../../src/adapters/dsh/harness.js'
import { PiHarnessAdapter } from '../../src/adapters/pi/harness.js'
import { TargetStore } from '../../src/adapters/storage/targets.js'
import { RunStore } from '../../src/adapters/storage/run-store.js'
import { sealedProvider } from '../../src/application/sealed-provider.js'
import { DurableRunner } from '../../src/runtime/runner.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import { researchDataPolicy } from '../../src/domain/research-trials.js'
import type { RunSpec } from '../../src/domain/run.js'
import type { CompiledBenchmark } from '../../src/domain/project.js'
import type { OperationProvider, OperationReceipt, OperationRequest } from '../../src/ports/operations.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const signal = () => new AbortController().signal
const cases = [
  ['EvoPrompt', 'ga', 'pi'],
  ['EvoPrompt', 'de', 'pi'],
  ['OPRO', '', 'pi'],
  ['Arbor', '', 'pi'],
  ['TrainDevGEPA', '', 'pi'],
  ['SkillOpt', '', 'pi'],
  ['EvoPrompt', 'ga', 'dsh'],
  ['EvoPrompt', 'de', 'dsh'],
] as const
it.each(cases)(
  'executes %s %s on %s through storage, trials and worker recovery',
  async (name, variation, adapter) => {
    const root = await mkdtemp(join(tmpdir(), 'gear-prompt-workflow-'))
    roots.push(root)
    const directory = join(root, '.gear/runs/run')
    const store = new RunStore(join(root, '.gear'))
    const harness = adapter === 'pi' ? new PiHarnessAdapter() : new DshHarnessAdapter()
    const instruction = harness.describe().instructionFile!
    const targets = new TargetStore(directory, harness, canonicalDigest('fixture-provider'))
    await targets.adapter.prepare(targets.path('anchor'))
    await writeFile(join(targets.path('anchor'), instruction), 'KEEP seed')
    const anchor = { id: 'anchor', parent_id: null, digest: (await targets.seal('anchor', 'fixture')).digest }
    const source = join(root, 'source'),
      scratch = join(root, 'scratch')
    await mkdir(scratch)
    const implementationIdentity = await freezeAlgorithmSource(source, [
      { path: 'prompt_workflows.py', source: resolve('tests/fixtures/prompt_workflows.py') },
    ])
    const tasks = ['train-a', 'train-b', 'dev'].map((id) => ({
      id,
      instruction: `Question ${id}`,
      digest: canonicalDigest(id),
      family: id.startsWith('train') ? 'train' : 'dev',
    }))
    const benchmark = {
      tasks,
      splits: { seed: tasks.map((task) => task.id), held_out: ['private-test'] },
      verifiers: Object.fromEntries(tasks.map((task) => [task.id, { expected: `answer-${task.id}` }])),
    } as unknown as CompiledBenchmark
    const policy = researchDataPolicy(
      { train: ['train-a', 'train-b'], dev: ['dev'], include_train_labels: true, report_only: true },
      benchmark,
    )!
    const spec: RunSpec = {
      version: 1,
      kind: 'refine',
      benchmarkDigest: canonicalDigest('benchmark'),
      configDigest: canonicalDigest('config'),
      implementationIdentity,
      providerIdentity: targets.runtimeIdentity,
      championRevision: null,
      targetSourceDigest: anchor.digest,
      lineage: null,
      algorithm: { name: `prompt_workflows:${name}`, options: variation ? { variation } : {} },
      validationMode: 'research',
      seed: 'fixed',
      seedTasks: tasks.map((task) => ({ id: task.id, family: task.family, estimated_cost: 1 })),
      heldOutTaskIds: ['private-test'],
      researchData: policy,
      anchor,
      budget: { rounds: 1, maxEvaluations: 50, maxCandidates: 10, repetitions: 1 },
      acceptance: { minimumGain: 0, maxHeldOutRegression: 0 },
      generationBudget: { version: 1, total: {}, perOperation: {} },
      evaluationRepair: { maxRetries: 0, maxProjections: 0, backoffMs: [0] },
    }
    await store.create('run', spec)
    const receipts = new Map<string, OperationReceipt>(),
      calls: OperationRequest[] = []
    const counts: Record<string, number> = Object.create(null)
    let lost = false
    const provider: OperationProvider = {
      identity: targets.runtimeIdentity,
      capabilities: {
        seeds: true,
        temperature: true,
        subsets: true,
        idempotentSubmission: true,
        inspect: true,
        cancel: true,
        physicalAttemptAccounting: true,
        generationBudget: false,
        hardDollarBudget: false,
        evidenceProjection: false,
        researchTrials: true,
      },
      async submit(request) {
        calls.push(structuredClone(request))
        const operation = request.operation
        const receipt: OperationReceipt = {
          result: {
            operation_id: request.operationId,
            kind: operation.kind,
            candidate_id: operation.candidate_id,
            status: 'complete',
            data: null,
          },
          candidate: null,
          evidence: [],
          physicalAttempts: 0,
          usage: {},
          provenance: null,
        }
        if (operation.kind === 'evaluate_seed') {
          expect(JSON.stringify(request)).not.toContain('answer-train')
          const text = await readFile(join(targets.path(operation.candidate_id!), instruction), 'utf8')
          const value = (task: string) => {
            if (name === 'Arbor')
              return text === 'arbor-regress'
                ? 0.2
                : text === 'arbor-tie'
                  ? task === 'dev'
                    ? 0.5
                    : 0.8
                  : text === 'arbor-winner'
                    ? 0.9
                    : 0.5
            if (name === 'SkillOpt')
              return text.includes('skill-win')
                ? 1
                : task === 'dev'
                  ? 0.5
                  : task === 'train-a' && text === 'KEEP seed'
                    ? 0.2
                    : 0.8
            return text === 'KEEP seed' ? 0.5 : 0.9
          }
          receipt.evidence = request.slots.map((slot) => ({
            candidate_id: operation.candidate_id!,
            task_id: slot.taskId,
            repetition: slot.repetition,
            score: value(slot.taskId),
            status: 'valid',
            scope: operation.scope,
            feedback: 'fixture feedback',
          }))
          receipt.physicalAttempts = receipt.evidence.length
          receipt.trial_details = request.slots.map((slot) => ({
            task_id: slot.taskId,
            repetition: slot.repetition,
            output: `actual output for ${slot.taskId} using ${text}`,
            execution_status: 'finished',
            usage: { total_tokens: 11 },
          }))
        } else {
          const payload = operation.payload as Record<string, unknown>,
            role = payload.gear_role_v1 as string
          const count = counts[role] ?? 0
          counts[role] = count + 1
          const inputs = payload.inputs as Record<string, unknown>
          let data: unknown
          if (role === 'crossover') {
            expect((inputs.prompts as string[]).length).toBe(variation === 'ga' ? 2 : 4)
            data = count === 0 ? 'KEEP seed' : `evolved-${variation}`
          } else if (role === 'optimizer') {
            expect(inputs.history).toEqual([{ text: 'KEEP seed', score: 0.5 }])
            expect(JSON.stringify(inputs.examples)).toContain('actual output')
            data = count === 0 ? 'KEEP seed' : 'opro-improved'
          } else if (role === 'coordinator') {
            data =
              count === 0
                ? { action: 'prune', node: 'pruned' }
                : { action: 'run', node: ['regress', 'tie', 'winner'][count - 1] }
          } else if (role === 'implement') {
            expect(inputs.conceptual_parent).toBe('idea')
            expect(operation.candidate_id).toBe('anchor')
            data = `arbor-${inputs.node}`
          } else if (role === 'summarize') data = `ancestor lesson: ${inputs.result}`
          else if (role === 'reflector') {
            expect(inputs).toMatchObject({ expected: 'answer-train-a', parent_score: 0.5 })
            expect(String(inputs.output)).toContain('actual output')
            data = 'gepa-improved'
          } else if (role === 'reflect_success' || role === 'reflect_failure') {
            expect(inputs.tasks).toEqual([role === 'reflect_success' ? 'train-b' : 'train-a'])
            data = { source: role }
          } else if (role === 'consolidate')
            data =
              count === 0
                ? { [instruction]: 'invalid removes protected segment' }
                : {
                    [instruction]: count === 1 ? 'KEEP skill-tie' : 'KEEP skill-win',
                    '.pi/skills/example/SKILL.md': '# General procedure\n',
                  }
          else throw new Error(`Unexpected role ${role}`)
          receipt.result.data = { declined: false, data: data as never }
          receipt.usage = { model_requests: 1 }
        }
        receipts.set(request.operationId, receipt)
        if (!lost) {
          lost = true
          throw new Error('lost first provider reply')
        }
        return receipt
      },
      async inspect(request) {
        const receipt = receipts.get(request.operationId)
        return receipt ? { state: 'complete', receipt } : { state: 'not_submitted' }
      },
      async cancel() {},
    }
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
        new DurableRunner(store, driver, sealedProvider(provider, targets), pythonObjective).run(
          'run',
          signal(),
        ),
      ).rejects.toThrow('lost first')
      await driver.dispose()
      driver = worker()
      await driver.start(signal())
      const runner = new DurableRunner(store, driver, sealedProvider(provider, targets), pythonObjective)
      const result = await runner.run('run', signal())
      expect(result.status).toBe('completed')
      expect(result.championId).toBe('anchor')
      expect(result.seedEvidence).toEqual([])
      const selected = (
        result.decisions.at(-1)!.decision.operations[0]!.payload as {
          gear_result_v1: { selected: string; data: Record<string, unknown> }
        }
      ).gear_result_v1
      const text = await readFile(join(targets.path(selected.selected), instruction), 'utf8')
      if (name === 'EvoPrompt') {
        expect(text).toBe(`evolved-${variation}`)
        expect(selected.data.duplicates).toBe(1)
        expect(result.candidates).toHaveLength(5)
      }
      if (name === 'OPRO') {
        expect(text).toBe('opro-improved')
        expect(result.candidates).toHaveLength(2)
      }
      if (name === 'Arbor') {
        expect(text).toBe('arbor-winner')
        expect(selected.data.dev_calls).toBe(2)
        expect(counts.summarize).toBe(3)
      }
      if (name === 'TrainDevGEPA') {
        expect(text).toBe('gepa-improved')
        expect(calls.filter((call) => call.trials?.group === 'minibatch/parent')).toHaveLength(1)
      }
      if (name === 'SkillOpt') {
        expect(text).toBe('KEEP skill-win')
        expect(selected.data).toEqual({ rejected: 1, tied: 1 })
        expect(result.candidates).toHaveLength(3)
      }
      expect(new Set(calls.map((call) => call.operationId)).size).toBe(calls.length)
      const before = calls.length
      expect((await runner.run('run', signal())).digest).toBe(result.digest)
      expect(calls).toHaveLength(before)
    } finally {
      await driver.dispose()
    }
  },
  60_000,
)
