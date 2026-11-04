import { createHash } from 'node:crypto'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { PiHarnessAdapter } from '../../src/adapters/pi/harness.js'
import { TargetStore, snapshotTarget } from '../../src/adapters/storage/targets.js'
import { WorkspaceStore } from '../../src/adapters/storage/workspaces.js'
import { workspaceCommand } from '../../src/domain/workspaces.js'
import { RunStore } from '../../src/adapters/storage/run-store.js'
import { PythonAlgorithmWorker } from '../../src/adapters/python/worker.js'
import { freezeAlgorithmSource } from '../../src/adapters/python/source.js'
import { resolvePythonExecutable } from '../../src/adapters/python/interpreter.js'
import { pythonObjective } from '../../src/adapters/python/objective.js'
import { HitchArtifactReader, HITCH_TRAJECTORY } from '../../src/adapters/hitch/trajectory.js'
import { sealedProvider } from '../../src/application/sealed-provider.js'
import { DurableRunner } from '../../src/runtime/runner.js'
import { researchDataPolicy } from '../../src/domain/research-trials.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import type { OperationProvider, OperationReceipt, OperationRequest } from '../../src/ports/operations.js'
import type { RunSpec } from '../../src/domain/run.js'
import type { CompiledBenchmark } from '../../src/domain/project.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const signal = () => new AbortController().signal
it.each(['ACEExample', 'DarwinXExample', 'RRSIMechanismExample'] as const)(
  'executes %s through the frozen worker, actual drafts, sealed candidates and pinned trajectory reader',
  async (name) => {
    const root = await mkdtemp(join(tmpdir(), 'gear-research-mechanism-'))
    roots.push(root)
    const directory = join(root, '.gear/runs/run'),
      store = new RunStore(join(root, '.gear'))
    const targets = new TargetStore(directory, new PiHarnessAdapter(), canonicalDigest('external-fixture'))
    await targets.adapter.prepare(targets.path('anchor'))
    await writeFile(join(targets.path('anchor'), 'AGENTS.md'), 'seed')
    const anchor = { id: 'anchor', parent_id: null, digest: (await targets.seal('anchor', 'fixture')).digest }
    const workspaces = new WorkspaceStore(directory),
      source = join(root, 'source'),
      scratch = join(root, 'scratch')
    await mkdir(scratch)
    const implementationIdentity = await freezeAlgorithmSource(
      source,
      [{ path: 'research_workflows.py', source: resolve('examples/algorithms/research_workflows.py') }],
      [],
    )
    const executable = join(root, 'trajectory.mjs')
    await writeFile(
      executable,
      `#!${process.execPath}\nimport {trajectoryFixture} from ${JSON.stringify(new URL('../fixtures/trajectory-hitch.mjs', import.meta.url).href)};await trajectoryFixture();\n`,
      { mode: 0o700 },
    )
    const reader = new HitchArtifactReader(executable, root)
    const tasks = ['a', 'b'].map((id) => ({
      id,
      instruction: 'Original question ' + id,
      digest: canonicalDigest(id),
      family: id,
    }))
    const policy = researchDataPolicy(
      { train: ['a'], dev: ['b'], allow_derived_inputs: true, report_only: true },
      {
        tasks,
        splits: { seed: ['a', 'b'], held_out: [] },
        verifiers: { a: { expected: 'private label' }, b: { expected: 'private dev' } },
      } as unknown as CompiledBenchmark,
    )!
    const spec: RunSpec = {
      version: 1,
      kind: 'refine',
      benchmarkDigest: canonicalDigest('benchmark'),
      configDigest: canonicalDigest('project'),
      implementationIdentity,
      providerIdentity: targets.runtimeIdentity,
      championRevision: null,
      targetSourceDigest: anchor.digest,
      lineage: null,
      algorithm: {
        name: 'research_workflows:' + name,
        options: name === 'ACEExample' ? { max_steps: 1 } : {},
      },
      validationMode: 'research',
      seed: 'fixed',
      seedTasks: tasks.map((task) => ({ id: task.id, family: task.family, estimated_cost: 1 })),
      heldOutTaskIds: [],
      researchData: policy,
      artifactReader: reader.descriptor,
      anchor,
      budget: { rounds: 1, maxEvaluations: 50, maxCandidates: 6, repetitions: 1 },
      acceptance: { minimumGain: 0, maxHeldOutRegression: 0 },
      generationBudget: { version: 1, total: {}, perOperation: {} },
      evaluationRepair: { maxRetries: 0, maxProjections: 0, backoffMs: [0] },
    }
    await store.create('run', spec)
    const calls: OperationRequest[] = [],
      receipts = new Map<string, OperationReceipt>()
    let critic = 0,
      lost = false,
      generated = 0
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
        hardDollarBudget: false,
        generationBudget: false,
        evidenceProjection: false,
        researchTrials: true,
        derivedInputs: true,
        workspaces: true,
        candidateReferences: true,
      },
      async submit(request) {
        calls.push(structuredClone(request))
        const op = request.operation
        const receipt: OperationReceipt = {
          result: {
            operation_id: request.operationId,
            kind: op.kind,
            status: 'complete',
            candidate_id: op.candidate_id,
            data: null,
          },
          candidate: null,
          evidence: [],
          physicalAttempts: 0,
          usage: {},
          provenance: null,
        }
        if (op.kind === 'evaluate_seed') {
          const text = await readFile(join(targets.path(op.candidate_id!), 'AGENTS.md'), 'utf8')
          receipt.evidence = request.slots.map((slot) => ({
            candidate_id: op.candidate_id!,
            task_id: slot.taskId,
            repetition: slot.repetition,
            scope: op.scope,
            status: 'valid',
            score:
              name === 'ACEExample'
                ? request.trials?.instances.some((value) => value.question)
                  ? 1
                  : 0
                : name === 'DarwinXExample'
                  ? text === 'merged'
                    ? 1
                    : 0.5
                  : 0.5,
            feedback: 'completed fixture attempt',
            raw_metrics: {
              quality: {
                contractDigest: canonicalDigest('quality'),
                unit: 'ratio',
                status: 'available',
                value: 0.9,
                evidenceRefs: [canonicalDigest('target-result')],
              },
            },
          }))
          receipt.physicalAttempts = receipt.evidence.length
          receipt.trial_details = request.slots.map((slot) => ({
            task_id: slot.taskId,
            repetition: slot.repetition,
            output: 'actual target result',
            execution_status: 'finished',
            usage: { complete: true, total_tokens: op.candidate_id === 'anchor' ? 20 : 10 },
          }))
          receipt.artifacts = []
          for (const slot of request.slots) {
            const run =
                'run_' +
                createHash('sha256')
                  .update(request.operationId + slot.repetition + slot.taskId)
                  .digest('hex')
                  .slice(0, 32),
              raw = JSON.stringify([
                {
                  seq: 0,
                  type: 'assistant/message',
                  data: { message: { content: [{ type: 'text', text: 'reported observation' }] } },
                },
              ])
            await writeFile(join(root, run + '.json'), raw)
            receipt.artifacts.push({
              kind: 'trajectory',
              format: HITCH_TRAJECTORY,
              task_id: slot.taskId,
              repetition: slot.repetition,
              status: 'available',
              content_digest: 'sha256:' + createHash('sha256').update(raw).digest('hex'),
              locator: { run_id: run, native_manifest_digest: null },
              reason: null,
            })
          }
        } else if (op.kind === 'generate_candidate') {
          await targets.adapter.prepare(targets.path(op.candidate_id!))
          const text = op.rationale === 'recombiner' ? 'merged' : 'parent-' + ++generated
          if (op.rationale === 'recombiner') {
            const refs = (op.payload as Record<string, any>).gear_candidate_references_v1
            expect(await readFile(join(targets.path(refs.ancestor.candidate_id), 'AGENTS.md'), 'utf8')).toBe(
              'seed',
            )
            expect(await readFile(join(targets.path(refs.donor.candidate_id), 'AGENTS.md'), 'utf8')).toBe(
              'parent-2',
            )
          }
          await writeFile(join(targets.path(op.candidate_id!), 'AGENTS.md'), text)
          receipt.candidate = {
            id: op.candidate_id!,
            parent_id: op.parent_id,
            digest: canonicalDigest('claimed'),
          }
          receipt.result.data = { declined: false, data: 'edited' }
          receipt.usage = { model_requests: 1 }
        } else if (op.kind === 'workspace_edit') {
          const command = workspaceCommand(op),
            path = join(root, command.output_id!)
          await snapshotTarget(workspaces.files(command.source!), path)
          await chmod(join(path, 'AGENTS.md'), 0o600)
          const before = await readFile(join(path, 'AGENTS.md'), 'utf8')
          if (critic === 1) expect(before).toContain('edit-0')
          await writeFile(join(path, 'AGENTS.md'), before + ' edit-' + critic)
          const revision = await workspaces.save(request, path)
          receipt.result.data = { workspace: revision as never, declined: false, data: 'edited' }
          receipt.usage = { model_requests: 1 }
        } else if (op.kind === 'diagnose_seed') {
          const value =
            op.rationale === 'critic'
              ? { accept: ++critic > 1 }
              : op.rationale === 'digester'
                ? { quote: 'reported observation' }
                : 'Use the reflection'
          if (op.rationale === 'digester') {
            expect(JSON.stringify((op.payload as Record<string, unknown>).inputs)).toContain(
              'reported observation',
            )
            expect(JSON.stringify(op.payload)).not.toContain('PRIVATE_CANARY')
          }
          receipt.result.data = { declined: false, data: value }
          receipt.usage = { model_requests: 1 }
        } else throw new Error('Unexpected external operation ' + op.kind)
        receipts.set(request.operationId, receipt)
        if (!lost && op.kind === (name === 'RRSIMechanismExample' ? 'workspace_edit' : 'evaluate_seed')) {
          lost = true
          throw new Error('lost external reply')
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
      ).rejects.toThrow('lost external reply')
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
      expect(result.seedEvidence).toEqual([])
      expect(result.championId).toBe('anchor')
      const reported = (result.decisions.at(-1)!.decision.operations[0]!.payload as Record<string, any>)
        .gear_result_v1
      expect(reported).toBeTruthy()
      if (name === 'ACEExample') expect(reported.data.online_score).toBe(0)
      if (name === 'DarwinXExample') {
        expect(await readFile(join(targets.path(reported.selected), 'AGENTS.md'), 'utf8')).toBe('merged')
        expect(calls.filter((call) => call.trials).map((call) => call.trials!.repetitions)).toEqual([
          1, 1, 1, 2, 2, 2,
        ])
      }
      if (name === 'RRSIMechanismExample') {
        expect(reported.data.accepted).toBe(true)
        expect(reported.data.trace_quote).toBe('reported observation')
        expect(critic).toBe(2)
        expect(result.candidates).toHaveLength(2)
        expect(JSON.stringify(result.researchTrials)).not.toContain('run_id')
        expect(
          JSON.parse(
            await readFile(join(root, 'calls.jsonl'), 'utf8').then((text) => text.trim().split('\n')[0]!),
          ),
        ).toMatchObject({ run: expect.stringMatching(/^run_/) })
        expect(await readFile(join(targets.path(reported.selected), 'AGENTS.md'), 'utf8')).toBe(
          'seed edit-0 edit-1',
        )
      }
      expect(new Set(calls.map((call) => call.operationId)).size).toBe(calls.length)
    } finally {
      await driver.dispose()
    }
  },
  60000,
)
