import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { PythonAlgorithmWorker } from '../../src/adapters/python/worker.js'
import { freezeAlgorithmSource } from '../../src/adapters/python/source.js'
import { resolvePythonExecutable } from '../../src/adapters/python/interpreter.js'
import { pythonObjective } from '../../src/adapters/python/objective.js'
import { PiHarnessAdapter } from '../../src/adapters/pi/harness.js'
import { TargetStore, snapshotTarget, targetResources } from '../../src/adapters/storage/targets.js'
import { WorkspaceStore } from '../../src/adapters/storage/workspaces.js'
import { workspaceCommand } from '../../src/domain/workspaces.js'
import { checkEditPaths } from '../../src/domain/edit-scope.js'
import { RunStore } from '../../src/adapters/storage/run-store.js'
import { sealedProvider } from '../../src/application/sealed-provider.js'
import { DurableRunner } from '../../src/runtime/runner.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import { researchDataPolicy } from '../../src/domain/research-trials.js'
import { stageCandidateReferences } from '../../src/adapters/codex/references.js'
import { stageMaterials } from '../../src/adapters/codex/materials.js'
import { HitchArtifactReader } from '../../src/adapters/hitch/trajectory.js'
import type { CodexJob } from '../../src/adapters/codex/contracts.js'
import type { RunSpec } from '../../src/domain/run.js'
import type { CompiledBenchmark } from '../../src/domain/project.js'
import type { Json } from '../../src/domain/algorithm-wire.js'
import type { OperationProvider, OperationReceipt, OperationRequest } from '../../src/ports/operations.js'
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const signal = () => new AbortController().signal
const cases = [
  ['ADAS', { max_steps: 4, num_reflections: 2 }, 'adas'],
  ['AHE', { max_steps: 2, use_debugger: true }, 'ahe'],
  ['EvoHarness', { batch_size: 2 }, 'evo'],
  ['EvoHarness', { batch_size: 2, general_min_tasks: 3 }, 'evo-short-general'],
  ['MetaHarness', { max_steps: 2 }, 'meta'],
  ['ModularRSI', { modules: { prompt: ['AGENTS.md'], skill: ['.pi/skills'] }, iterations: 1 }, 'modular'],
] as const
it.each(cases)(
  'runs %s on real immutable resources with independent role decisions',
  async (name, options, mode) => {
    const root = await mkdtemp(join(tmpdir(), 'gear-harness-flow-'))
    roots.push(root)
    const runRoot = join(root, '.gear/runs/run'),
      store = new RunStore(join(root, '.gear'))
    const targets = new TargetStore(
      runRoot,
      new PiHarnessAdapter(),
      canonicalDigest('controlled-harness-provider'),
    )
    await targets.adapter.prepare(targets.path('anchor'))
    await writeFile(join(targets.path('anchor'), 'AGENTS.md'), 'seed prompt')
    const anchor = { id: 'anchor', parent_id: null, digest: (await targets.seal('anchor', 'base')).digest }
    const source = join(root, 'source'),
      scratch = join(root, 'scratch')
    await mkdir(scratch)
    const implementationIdentity = await freezeAlgorithmSource(source, [
      { path: 'harness_workflows.py', source: resolve('examples/algorithms/harness_workflows.py') },
    ])
    const tasks = ['train-a', 'train-b', 'dev'].map((id) => ({
      id,
      instruction: 'Question ' + id,
      digest: canonicalDigest(id),
      family: id.startsWith('train') ? 'train' : 'dev',
    }))
    const research = researchDataPolicy({ train: ['train-a', 'train-b'], dev: ['dev'], report_only: true }, {
      tasks,
      splits: { seed: tasks.map((t) => t.id), held_out: [] },
      verifiers: Object.fromEntries(tasks.map((t) => [t.id, { expected: 'answer' }])),
    } as unknown as CompiledBenchmark)!
    const providerRoot = join(root, 'native'),
      executable = join(root, 'hitch.mjs')
    await mkdir(providerRoot)
    await writeFile(
      executable,
      `#!${process.execPath}\nimport {trajectoryFixture} from ${JSON.stringify(new URL('../fixtures/trajectory-hitch.mjs', import.meta.url).href)};await trajectoryFixture();`,
      { mode: 0o700 },
    )
    const reader = new HitchArtifactReader(executable, providerRoot)
    const spec: RunSpec = {
      version: 1,
      kind: 'refine',
      benchmarkDigest: canonicalDigest('tasks'),
      configDigest: canonicalDigest('config'),
      implementationIdentity,
      providerIdentity: targets.runtimeIdentity,
      championRevision: null,
      targetSourceDigest: anchor.digest,
      lineage: null,
      algorithm: {
        name: name === 'ADAS' ? 'gear.algorithms.adas:ADAS' : `harness_workflows:${name}`,
        options: options as unknown as Record<string, Json>,
      },
      validationMode: 'research',
      seed: 'fixed',
      seedTasks: tasks.map((t) => ({ id: t.id, family: t.family, estimated_cost: 1 })),
      heldOutTaskIds: [],
      anchor,
      budget: { rounds: 10, maxEvaluations: 80, maxCandidates: 10, repetitions: 1 },
      acceptance: { minimumGain: 0, maxHeldOutRegression: 0 },
      generationBudget: { version: 1, total: {}, perOperation: {} },
      evaluationRepair: { maxRetries: 0, maxProjections: 0, backoffMs: [0] },
      researchData: research,
      artifactReader: reader.descriptor,
      objectiveIdentity: pythonObjective.identity,
    }
    await store.create('run', spec)
    const calls: OperationRequest[] = [],
      receipts = new Map<string, OperationReceipt>(),
      workspaces = new WorkspaceStore(runRoot)
    const counters: Record<string, number> = {}
    let lost = false
    const provider: OperationProvider = {
      identity: targets.runtimeIdentity,
      artifactReader: reader.descriptor,
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
        workspaces: true,
        candidateReferences: true,
        readOnlyMaterials: true,
      },
      async submit(request) {
        calls.push(structuredClone(request))
        const op = request.operation
        const receipt: OperationReceipt = {
          result: {
            operation_id: request.operationId,
            kind: op.kind,
            candidate_id: op.candidate_id,
            status: 'complete',
            data: null,
          },
          candidate: null,
          evidence: [],
          physicalAttempts: 0,
          usage: {},
          provenance: null,
        }
        const payload = op.payload as Record<string, any> | null,
          role = payload?.gear_role_v1 as string | undefined,
          inputs = payload?.inputs as any
        if (op.kind === 'evaluate_seed') {
          const text = await readFile(join(targets.path(op.candidate_id!), 'AGENTS.md'), 'utf8')
          let score = 0.8
          if (mode === 'adas') {
            const step = Number(text.match(/design-(\d+)/u)?.[1] ?? -1)
            score = step < 0 ? 0.8 : ([0.2, 0.8, 0.9][step] ?? 0.9)
          }
          if (mode === 'ahe') score = text.includes('regression') ? 0.2 : 0.8
          if (mode.startsWith('evo')) score = 0
          if (mode === 'meta') score = text.includes('meta-1') ? 0.9 : text.includes('meta-0') ? 0.2 : 0.8
          if (mode === 'modular') score = 0 // execution completion must pass even at zero reward
          receipt.evidence = request.slots.map((slot) => ({
            candidate_id: op.candidate_id!,
            task_id: slot.taskId,
            repetition: slot.repetition,
            score,
            status: 'valid',
            scope: op.scope,
            feedback: 'observed score',
          }))
          receipt.physicalAttempts = request.slots.length
          receipt.trial_details = request.slots.map((slot) => ({
            task_id: slot.taskId,
            repetition: slot.repetition,
            output: 'actual output ' + text,
            execution_status: 'finished',
            usage: { tokens: 20 },
          }))
          if (mode === 'meta') {
            const run = 'run_' + request.operationId.slice(7, 39)
            await writeFile(
              join(providerRoot, run + '.json'),
              JSON.stringify(
                Array.from({ length: 65 }, (_, seq) => ({
                  type: 'assistant/message',
                  seq,
                  data: `${text} event ${seq}`,
                })),
              ),
            )
            receipt.artifacts = await Promise.all(
              request.slots.map((slot) => reader.capture(run, slot.taskId, slot.repetition, signal())),
            )
          }
        } else if (op.kind === 'workspace_edit' || op.kind === 'generate_candidate') {
          counters[role!] = (counters[role!] ?? 0) + 1
          const path = join(root, 'edit-' + calls.length)
          let sourcePath: string
          if (op.kind === 'workspace_edit') {
            const ref = workspaceCommand(op).source!
            await workspaces.assertOpen(ref, request)
            sourcePath = workspaces.files(ref)
          } else sourcePath = targets.path(op.parent_id!)
          await snapshotTarget(sourcePath, path)
          const staged = join(root, 'staged-' + calls.length)
          await mkdir(staged)
          const job = {
            input: { context: { targets: join(runRoot, 'targets') }, request },
          } as unknown as CodexJob
          const references = await stageCandidateReferences(job, staged),
            materials = await stageMaterials(job, staged)
          const account = 'design account ' + calls.length
          let data: any = account,
            declined = false
          if (mode === 'adas') {
            if (inputs.step === 3 && inputs.edit === 1) declined = true
            else {
              const prior = await readFile(join(path, 'AGENTS.md'), 'utf8')
              if (inputs.edit > 0) expect(prior).toContain('edit-' + (inputs.edit - 1))
              await chmod(join(path, 'AGENTS.md'), 0o600)
              await writeFile(join(path, 'AGENTS.md'), `design-${inputs.step} ${prior} edit-${inputs.edit}`)
            }
            if (inputs.step === 2 && inputs.edit === 0)
              expect(inputs.archive.map((row: any) => row.score)).toEqual([0.8, 0.2, 0.8])
          }
          if (mode === 'ahe') {
            await chmod(join(path, 'AGENTS.md'), 0o600)
            await writeFile(join(path, 'AGENTS.md'), 'regression ' + calls.length)
            data = {
              root_cause: 'root',
              targeted_fix: 'fix',
              failure_evidence: ['trace'],
              changes: [
                {
                  path: counters.evolve === 1 ? 'undeclared.md' : 'AGENTS.md',
                  predicted_fix_tasks: ['train-a'],
                  risk_tasks: [],
                },
              ],
            }
          }
          if (mode.startsWith('evo')) {
            expect(inputs.level).toBe(counters.curator === 1 ? 'topic' : 'general')
            const file = join(path, `.pi/skills/${inputs.level}/SKILL.md`)
            await mkdir(join(file, '..'), { recursive: true })
            await writeFile(
              file,
              '---\n' +
                JSON.stringify({
                  name: inputs.level,
                  description: 'learned procedure',
                  gear: {
                    algorithm: 'evo_harness',
                    level: inputs.level,
                    source_task_ids: ['train-a', 'train-b'],
                  },
                }) +
                '\n---\nA reusable skill.',
            )
          }
          if (mode === 'meta') {
            const history = JSON.parse(
              await readFile(join(staged, 'candidate', materials.index.history!.file), 'utf8'),
            )
            if (counters.meta === 2) {
              expect(history[1].score).toBe(0.2)
              expect(history[1].trajectories[0].pages[1].items[0].seq).toBe(50)
              const older = references.index.version1!
              expect(await readFile(join(staged, 'candidate', older.directory, 'AGENTS.md'), 'utf8')).toBe(
                'meta-0',
              )
            }
            await chmod(join(path, 'AGENTS.md'), 0o600)
            await writeFile(join(path, 'AGENTS.md'), 'meta-' + (counters.meta! - 1))
          }
          if (mode === 'modular') {
            if (inputs.module === 'integration')
              expect(Object.keys(references.index)).toEqual(['prompt', 'skill'])
            const file = inputs.module === 'skill' ? '.pi/skills/branch/SKILL.md' : 'AGENTS.md'
            await mkdir(join(path, file, '..'), { recursive: true })
            if (file === 'AGENTS.md') await chmod(join(path, file), 0o600)
            await writeFile(join(path, file), 'module ' + inputs.module)
          }
          checkEditPaths(
            op,
            targets.adapter.mutationPolicy,
            await targetResources(sourcePath),
            await targetResources(path),
          )
          if (declined) {
            receipt.result.status = 'failed'
            receipt.result.data = { declined: true, data: 'declined reflection' }
          } else if (op.kind === 'workspace_edit')
            receipt.result.data = {
              declined: false,
              data,
              workspace: (await workspaces.save(request, path)) as unknown as Json,
            }
          else {
            await snapshotTarget(path, targets.path(op.candidate_id!))
            receipt.candidate = {
              id: op.candidate_id!,
              parent_id: op.parent_id,
              digest: canonicalDigest('claimed'),
            }
            receipt.result.data = { declined: false, data }
          }
          receipt.usage = { tokens: 10, model_requests: 1 }
        } else if (op.kind === 'diagnose_seed') {
          let data: Json = 'grounded diagnosis'
          if (role === 'reflect')
            data = { lesson: 'lesson', trigger: 'trigger', evidence: 'observed failure', scope_hint: 'topic' }
          if (role === 'analyst') data = { findings: ['compare success/failure'] }
          if (role === 'reviewer') {
            expect(inputs.omitted_patches).toBe(0)
            expect(inputs.files.length).toBeGreaterThan(0)
            data = { accept: true, reason: 'reviewed complete diff' }
          }
          receipt.result.data = { declined: false, data }
          receipt.usage = { tokens: 5, model_requests: 1 }
        } else throw new Error('unexpected provider operation ' + op.kind)
        receipts.set(request.operationId, receipt)
        if (!lost && ['workspace_edit', 'generate_candidate'].includes(op.kind)) {
          lost = true
          throw new Error('lost draft edit receipt')
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
        python: resolvePythonExecutable(),
        sourceRoot: source,
        scratch,
        implementationIdentity,
      })
    let driver = worker()
    try {
      await driver.start(signal())
      await expect(
        new DurableRunner(store, driver, sealedProvider(provider, targets), pythonObjective).run(
          'run',
          signal(),
        ),
      ).rejects.toThrow('lost draft edit receipt')
      await driver.dispose()
      driver = worker()
      await driver.start(signal())
      const result = await new DurableRunner(
        store,
        driver,
        sealedProvider(provider, targets),
        pythonObjective,
      ).run('run', signal())
      expect(result.status).toBe('completed')
      expect(result.championId).toBe('anchor')
      const choice = (result.decisions.at(-1)!.decision.operations[0]!.payload as any).gear_result_v1
      const selected = await readFile(join(targets.path(choice.selected), 'AGENTS.md'), 'utf8')
      if (mode === 'adas') {
        expect(choice.data.archive.map((row: any) => row.score)).toEqual([0.8, 0.2, 0.8, 0.9])
        expect(choice.data.declined).toHaveLength(1)
        expect(selected).toContain('design-2')
        expect(result.candidates).toHaveLength(4)
      }
      if (mode === 'ahe') {
        expect(selected).toContain('regression')
        expect(choice.data.declined).toHaveLength(1)
        Object.values(choice.data.previous.task_delta).forEach((value) => expect(value).toBeCloseTo(-0.6))
      }
      if (mode.startsWith('evo')) {
        expect(choice.data.online_score).toBe(0)
        expect(counters.curator).toBe(2)
        if (mode === 'evo')
          expect(
            await readFile(join(targets.path(choice.selected), '.pi/skills/general/SKILL.md'), 'utf8'),
          ).toContain('source_task_ids')
        else {
          expect(choice.data.declined).toHaveLength(1)
          await expect(
            readFile(join(targets.path(choice.selected), '.pi/skills/general/SKILL.md')),
          ).rejects.toMatchObject({ code: 'ENOENT' })
        }
      }
      if (mode === 'meta') {
        expect(selected).toBe('meta-1')
        expect(choice.data.history.map((row: any) => row.score)).toEqual([0.8, 0.2, 0.9])
        expect(
          (await readFile(join(providerRoot, 'calls.jsonl'), 'utf8')).split('\n').length,
        ).toBeGreaterThan(6)
      }
      if (mode === 'modular') {
        expect(selected).toBe('module integration')
        expect(choice.data.integration[0].finished).toBe(true)
        expect(Object.keys(choice.data.branches)).toEqual(['prompt', 'skill'])
      }
      expect(new Set(calls.map((call) => call.operationId)).size).toBe(calls.length)
    } finally {
      await driver.dispose()
    }
  },
  60000,
)
