import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { PythonAlgorithmWorker } from '../../src/adapters/python/worker.js'
import { freezeAlgorithmSource } from '../../src/adapters/python/source.js'
import { resolvePythonExecutable } from '../../src/adapters/python/interpreter.js'
import { pythonObjective } from '../../src/adapters/python/objective.js'
import { PiHarnessAdapter } from '../../src/adapters/pi/harness.js'
import { TargetStore } from '../../src/adapters/storage/targets.js'
import { RunStore } from '../../src/adapters/storage/run-store.js'
import { sealedProvider } from '../../src/application/sealed-provider.js'
import { DurableRunner } from '../../src/runtime/runner.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import type { RunSpec } from '../../src/domain/run.js'
import type { OperationProvider, OperationReceipt } from '../../src/ports/operations.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it.each([
  ['clean', 'Improve retry handling.\n', true],
  ['credential', 'api_key = "fixture-only-value"\n', false],
  ['task hint', 'task_id = "seed"\n', false],
  ['grader logic', 'grader.read(task)\n', false],
  ['omitted large patch', 'x'.repeat(70_000), false],
] as const)('PR #99: Python controls evaluation of %s from sealed changes, including recovery', async (_, content, accepted) => {
  const root = await mkdtemp(join(tmpdir(), 'gear-python-screen-')); roots.push(root)
  const store = new RunStore(join(root, '.gear')), runRoot = join(root, '.gear/runs/run')
  const targets = new TargetStore(runRoot, new PiHarnessAdapter(), canonicalDigest('provider'))
  await targets.adapter.prepare(targets.path('anchor'))
  // Removing an old task-specific hint should not cause a clean change to be rejected.
  await writeFile(join(targets.path('anchor'), 'AGENTS.md'), 'task_id = "old-task"\n')
  const anchor = { id: 'anchor', parent_id: null, digest: (await targets.seal('anchor', 'test')).digest }
  const source = join(root, 'source'), scratch = join(root, 'scratch')
  await mkdir(scratch)
  const identity = await freezeAlgorithmSource(source, [{ path: 'pr_cases.py', source: resolve('tests/fixtures/python-algorithm-boundaries.py') }])
  const worker = new PythonAlgorithmWorker({ python: resolvePythonExecutable(), sourceRoot: source, scratch, implementationIdentity: identity,
    ...(process.env.GEAR_TEST_LINUX_ISOLATION ? { linuxIsolation: process.env.GEAR_TEST_LINUX_ISOLATION as 'seccomp' | 'bubblewrap-only' } : {}) })
  const spec: RunSpec = {
    version: 1, kind: 'refine', benchmarkDigest: canonicalDigest('tasks'), configDigest: canonicalDigest('config'),
    implementationIdentity: identity, providerIdentity: targets.runtimeIdentity, championRevision: null,
    targetSourceDigest: anchor.digest, lineage: null, algorithm: { name: 'pr_cases:ScreenBeforeEvaluation', options: {} },
    validationMode: 'holdout', seed: 'fixed', seedTasks: [{ id: 'seed', family: 'format', estimated_cost: 1 }],
    heldOutTaskIds: ['private-held-out'], anchor,
    budget: { rounds: 1, maxEvaluations: 2, maxCandidates: 1, repetitions: 1 },
    acceptance: { minimumGain: 0, maxHeldOutRegression: 0 }, objectiveIdentity: pythonObjective.identity,
    generationBudget: { version: 1, total: {}, perOperation: {} }, evaluationRepair: { maxRetries: 0, maxProjections: 0, backoffMs: [0] },
  }
  await store.create('run', spec)
  let generations = 0, evaluations = 0
  const receipts = new Map<string, OperationReceipt>()
  const provider: OperationProvider = {
    identity: targets.runtimeIdentity,
    capabilities: { seeds: true, temperature: true, subsets: true, idempotentSubmission: true, inspect: true, cancel: true,
      physicalAttemptAccounting: true, hardDollarBudget: false, generationBudget: false, evidenceProjection: false },
    async submit(request) {
      const operation = request.operation
      const value: OperationReceipt = {
        result: { operation_id: request.operationId, kind: operation.kind, candidate_id: operation.candidate_id,
          status: 'complete', data: { candidate_diff: 'model says clean' }, candidate_change: { files: [], omitted_patches: 0 } },
        candidate: null, evidence: [], physicalAttempts: 0, usage: {}, provenance: null,
      }
      if (operation.kind === 'generate_candidate') {
        generations++
        await targets.adapter.prepare(targets.path('candidate'))
        await writeFile(join(targets.path('candidate'), 'AGENTS.md'), content)
        value.candidate = { id: 'candidate', parent_id: 'anchor', digest: canonicalDigest('untrusted provider digest') }
        receipts.set(request.operationId, value)
        throw new Error('response lost after generation')
      }
      evaluations++
      value.evidence = request.slots.map(slot => ({ candidate_id: operation.candidate_id!, task_id: slot.taskId,
        repetition: slot.repetition, score: 1, status: 'valid', scope: operation.scope, feedback: 'passed' }))
      value.physicalAttempts = value.evidence.length
      receipts.set(request.operationId, value)
      return value
    },
    async inspect(request) { const receipt = receipts.get(request.operationId); return receipt ? { state: 'complete', receipt } : { state: 'not_submitted' } },
    async cancel() {},
  }
  const wrapped = sealedProvider(provider, targets)
  const run = () => new DurableRunner(store, worker, wrapped, pythonObjective).run('run', new AbortController().signal)
  try {
    await worker.start(new AbortController().signal)
    await expect(run()).rejects.toThrow('response lost')
    const result = await run()
    expect(result.status).toBe('completed')
    expect(generations).toBe(1)
    expect(evaluations).toBe(accepted ? 1 : 0)
    expect(result.physicalAttempts).toBe(accepted ? 1 : 0)
    expect(result.seedEvidence).toHaveLength(accepted ? 1 : 0)
    expect(result.heldOutEvidence).toEqual([])
    const generated = result.operations[0]!, receipt = generated.receipt!
    expect(receipt.result.data).toEqual({ candidate_diff: 'model says clean' })
    expect(receipt.result.candidate_change).toMatchObject({ from: { id: anchor.id, digest: anchor.digest },
      to: { id: receipt.candidate!.id, digest: receipt.candidate!.digest },
      omitted_patches: content.length > 64 * 1024 ? 1 : 0 })
    const inspection = await wrapped.inspect(generated.request, new AbortController().signal)
    expect(inspection).toEqual({ state: 'complete', receipt })
    if (accepted) expect(result.completed[1]!.candidate_change).toBeUndefined()
    else expect(result.state.data.rejected).toBeTruthy()
    expect(result.seedEvidence.some(cell => cell.status === 'environment_failed')).toBe(false)
  } finally { await worker.dispose() }
}, 30_000)
