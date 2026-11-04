import { execFileSync } from 'node:child_process'
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
import type { AlgorithmConfig, RunSpec } from '../../src/domain/run.js'
import type { OperationProvider, OperationReceipt, OperationRequest } from '../../src/ports/operations.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it.each(['diagnose_seed', 'generate_candidate', 'evaluate_seed'] as const)(
  'runs the public async workflow through a fresh frozen worker after a lost %s reply',
  async (loseKind) => {
    const root = await mkdtemp(join(tmpdir(), 'gear-python-workflow-')); roots.push(root)
    const python = resolvePythonExecutable(true)
    const description = JSON.parse(execFileSync(python, ['-c',
      'import json;from gear import Project;from async_workflow import ReflectAndEdit;print(json.dumps(Project._describe_algorithm(ReflectAndEdit())))',
    ], { env: { ...process.env, PYTHONPATH: [resolve('python'), resolve('examples/algorithms')].join(':') }, encoding: 'utf8' })) as {
      algorithm: AlgorithmConfig; sources: Array<{ path: string; source: string }>; dependencies: []
    }
    expect(description.algorithm.name).toBe('async_workflow:ReflectAndEdit')
    expect(description.sources.map(item => item.path)).toEqual(['async_workflow.py'])
    const source = join(root, 'source'), scratch = join(root, 'scratch')
    await mkdir(scratch)
    const identity = await freezeAlgorithmSource(source, description.sources, description.dependencies)
    const newWorker = () => new PythonAlgorithmWorker({ python, sourceRoot: source, scratch, implementationIdentity: identity,
      ...(process.env.GEAR_TEST_LINUX_ISOLATION ? { linuxIsolation: process.env.GEAR_TEST_LINUX_ISOLATION as 'seccomp' | 'bubblewrap-only' } : {}) })
    const store = new RunStore(join(root, '.gear'))
    const targets = new TargetStore(join(root, '.gear/runs/run'), new PiHarnessAdapter(), canonicalDigest('provider'))
    await targets.adapter.prepare(targets.path('anchor'))
    await writeFile(join(targets.path('anchor'), 'AGENTS.md'), 'Original instructions.\n')
    const anchor = { id: 'anchor', parent_id: null, digest: (await targets.seal('anchor', 'test')).digest }
    const spec: RunSpec = {
      version: 1, kind: 'refine', benchmarkDigest: canonicalDigest('tasks'), configDigest: canonicalDigest('config'),
      implementationIdentity: identity, providerIdentity: targets.runtimeIdentity, championRevision: null,
      targetSourceDigest: anchor.digest, lineage: null, algorithm: description.algorithm, validationMode: 'holdout',
      seed: 'fixed', seedTasks: [{ id: 'seed', family: 'format', estimated_cost: 1 }], heldOutTaskIds: ['private-held-out'], anchor,
      budget: { rounds: 1, maxEvaluations: 4, maxCandidates: 1, repetitions: 1 },
      acceptance: { minimumGain: 0, maxHeldOutRegression: 0 }, objectiveIdentity: pythonObjective.identity,
      generationBudget: { version: 1, total: { model_requests: 2 }, perOperation: { model_requests: 1 } },
      evaluationRepair: { maxRetries: 0, maxProjections: 0, backoffMs: [0] },
    }
    await store.create('run', spec)
    const receipts = new Map<string, OperationReceipt>(), calls: OperationRequest[] = []
    let lost = false
    const provider: OperationProvider = {
      identity: targets.runtimeIdentity,
      capabilities: { seeds: true, temperature: true, subsets: true, idempotentSubmission: true, inspect: true, cancel: true,
        physicalAttemptAccounting: true, hardDollarBudget: false, generationBudget: true, evidenceProjection: false },
      async submit(request) {
        calls.push(structuredClone(request))
        const operation = request.operation
        const receipt: OperationReceipt = {
          result: { operation_id: request.operationId, kind: operation.kind, candidate_id: operation.candidate_id,
            status: 'complete', data: { declined: false, data: 'Preserve the output format when retrying.' } },
          candidate: null, evidence: [], physicalAttempts: 0,
          usage: { model_requests: operation.kind === 'evaluate_seed' ? 0 : 1 }, provenance: null,
        }
        if (operation.kind === 'generate_candidate') {
          await targets.adapter.prepare(targets.path(operation.candidate_id!))
          await writeFile(join(targets.path(operation.candidate_id!), 'AGENTS.md'), 'Preserve output format when retrying.\n')
          receipt.candidate = { id: operation.candidate_id!, parent_id: operation.parent_id, digest: canonicalDigest('provider digest') }
        } else if (operation.kind === 'evaluate_seed') {
          receipt.evidence = request.slots.map(slot => ({ candidate_id: operation.candidate_id!, task_id: slot.taskId,
            repetition: slot.repetition, score: operation.candidate_id === 'anchor' ? 0 : 1,
            status: 'valid', scope: operation.scope, feedback: 'fixture score' }))
          receipt.physicalAttempts = receipt.evidence.length
        }
        receipts.set(request.operationId, receipt)
        if (!lost && operation.kind === loseKind) { lost = true; throw new Error('reply lost after submission') }
        return receipt
      },
      async inspect(request) { const receipt = receipts.get(request.operationId); return receipt ? { state: 'complete', receipt } : { state: 'not_submitted' } },
      async cancel() {},
    }
    const sealed = sealedProvider(provider, targets)
    let worker = newWorker()
    try {
      await worker.start(new AbortController().signal)
      await expect(new DurableRunner(store, worker, sealed, pythonObjective).run('run', new AbortController().signal)).rejects.toThrow('reply lost')
      await worker.dispose()
      worker = newWorker()
      await worker.start(new AbortController().signal)
      const runner = new DurableRunner(store, worker, sealed, pythonObjective)
      const result = await runner.run('run', new AbortController().signal)
      expect(result.status).toBe('completed')
      expect(result.gate.status).toBe('accepted')
      expect(result.championId).not.toBe(anchor.id)
      expect(result.candidates).toHaveLength(2)
      expect(result.physicalAttempts).toBe(4)
      expect(calls.filter(call => call.operation.kind === 'diagnose_seed')).toHaveLength(1)
      expect(calls.filter(call => call.operation.kind === 'generate_candidate')).toHaveLength(1)
      expect(calls.filter(call => call.operation.kind === 'evaluate_seed')).toHaveLength(4)
      expect(result.operations.reduce((n, op) => n + (op.receipt?.usage.model_requests ?? 0), 0)).toBe(2)
      const meta = calls.filter(call => call.operation.kind !== 'evaluate_seed')
      expect(meta.every(call => call.generationLimits?.model_requests === 1)).toBe(true)
      expect(meta.every(call => !JSON.stringify(call).includes('private-held-out'))).toBe(true)
      const count = calls.length
      expect((await runner.run('run', new AbortController().signal)).digest).toBe(result.digest)
      expect(calls).toHaveLength(count)
    } finally { await worker.dispose() }
  }, 30_000,
)
