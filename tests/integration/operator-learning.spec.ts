import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { load, dump } from 'js-yaml'
import { initProject } from '../../src/application/init.js'
import { ProjectApplication, type RefineOptions } from '../../src/application/project-service.js'
import { LibraryStore } from '../../src/adapters/storage/libraries.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import type { OperationReceipt, OperationRequest } from '../../src/ports/operations.js'
import type { TargetExecution } from '../../src/domain/operator-run.js'
import type { RunJournal } from '../../src/domain/run.js'
import { planMetaRecovery } from '../../src/runtime/operator-recovery.js'
import { generationLedger } from '../../src/runtime/generation-budget.js'
import { ProjectController } from '../../src/application/project-controller.js'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(options: { failMeta?: number; cancelError?: boolean; inspectMismatch?: boolean } = {}) {
  const python = process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3'
  vi.stubEnv('GEAR_PYTHON', python)
  const root = await mkdtemp(join(tmpdir(), 'gear-blind-learning-')),
    project = join(root, 'project')
  roots.push(root)
  await initProject(project, { adapter: 'pi', template: 'text' })
  const config = load(await readFile(join(project, 'gear.yaml'), 'utf8')) as Record<string, unknown>
  config.budget = { ...(config.budget as Record<string, unknown>), rounds: 2 }
  config.generation = { max_model_requests: 20, max_tokens: 100, per_operation: { max_model_requests: 4, max_tokens: 12 } }
  if (process.env.GEAR_TEST_LINUX_ISOLATION) {
    config.sandbox = { linux_isolation: process.env.GEAR_TEST_LINUX_ISOLATION }
  }
  await writeFile(join(project, 'gear.yaml'), dump(config))
  const description = JSON.parse(
    execFileSync(
      python,
      [
        '-c',
        'import json; from gear.project import Project; from gear.core import AccessPolicy; from gear.algorithms import Harness2; d=Project._describe_algorithm(Harness2()); d["access"]=AccessPolicy(exposure="blind", rollout_backend="scored_private", task_order=("sum-01","sum-02")).to_dict(); print(json.dumps(d))',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PYTHONPATH: resolve('python'),
        },
      },
    ),
  ) as RefineOptions
  const requests: OperationRequest[] = [],
    actualFiles: string[] = [],
    receipts = new Map<string, OperationReceipt>()
  const app = new ProjectApplication(project, {
    async provider(context) {
      return {
        identity: canonicalDigest('learning-fixture'),
        capabilities: {
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
          blindProjection: true,
          targetAssets: true,
        },
        async submit(request) {
          requests.push(structuredClone(request))
          if (request.operatorSamples)
            actualFiles.push(
              await readFile(
                join(
                  context.stateRoot,
                  'runs',
                  context.runId,
                  'targets',
                  request.executionTarget?.id ?? request.operation.candidate_id!,
                  'AGENTS.md',
                ),
                'utf8',
              ),
            )
          if (request.operatorCall) expect(JSON.stringify(request)).not.toContain('PRIVATE_')
          const failed = !!request.operatorCall && requests.filter((item) => item.operatorCall).length === options.failMeta
          const receipt: OperationReceipt = {
            result: {
              operation_id: request.operationId,
              kind: request.operation.kind,
              candidate_id: request.operation.candidate_id,
              status: failed ? 'failed' : 'complete',
              data: failed ? { error: 'generation-budget-exhausted' } : request.operatorCall
                ? {
                    declined: false,
                    data: { text: 'Learned instruction for ' + request.operation.task_ids[0] },
                  }
                : null,
            },
            candidate: null,
            evidence: request.slots.map((slot) => ({
              candidate_id: request.operation.candidate_id!,
              task_id: slot.taskId,
              repetition: slot.repetition,
              scope: request.operation.scope,
              score: null,
              status: 'scoring_failed',
              feedback: 'PRIVATE_SCORER_CANARY',
            })),
            physicalAttempts: request.slots.length,
            usage: request.operatorCall ? { model_requests: 1, tokens: 8 } : {},
            provenance: { private_diagnostics: 'PRIVATE_RECEIPT_CANARY' },
          }
          receipts.set(request.operationId, receipt)
          return receipt
        },
        async inspect(request) {
          const receipt = receipts.get(request.operationId)
          if (receipt && options.inspectMismatch) return { state: 'complete' as const, receipt: { ...receipt, usage: { model_requests: 1, tokens: 7 } } }
          return receipt ? { state: 'complete' as const, receipt } : { state: 'not_submitted' as const }
        },
        async cancel() { if (options.cancelError) throw new Error('stop unconfirmed') },
        async captureExecutions(request): Promise<TargetExecution[]> {
          return request.slots.map((slot) => ({
            taskId: slot.taskId,
            repetition: slot.repetition,
            status: 'succeeded',
            output: { value: { available: true, answer: 'target answer ' + slot.taskId } },
            trajectory: { value: { messages: ['target reasoning'] } },
          }))
        },
        async readExecutionArtifact(): Promise<Buffer> {
          throw new Error('fixture has inline artifacts')
        },
      }
    },
  })
  return { app, project, requests, actualFiles, description }
}

it('runs blind learning through the public Python API, seals effective library files and recovers publication after another publisher advances the head', async () => {
  const { app, project, requests, actualFiles, description } = await fixture()
  const publish = LibraryStore.prototype.publish
  let lost = false
  vi.spyOn(LibraryStore.prototype, 'publish').mockImplementation(async function (
    this: LibraryStore,
    request,
  ) {
    const receipt = await publish.call(this, request)
    if (!lost) {
      lost = true
      throw new Error('lost library receipt')
    }
    return receipt
  })
  await expect(app.refine(description)).rejects.toThrow('lost library receipt')
  const id = await app.store.latest(),
    libraries = new LibraryStore(join(project, '.gear', 'libraries'))
  const first = (await libraries.head('learned-skills'))!
  const intervening = await libraries.publish({
    commit_id: canonicalDigest('other-publisher'),
    name: 'learned-skills',
    snapshot: first.snapshot,
    expected_revision: first.revision,
  })
  const report = await app.resume(id)
  const journal = await app.store.read(id)
  expect(report.status).toBe('completed')
  expect(report.retained).toBe('anchor')
  expect(report.gate.status).toBe('not_run')
  expect(journal.physicalAttempts).toBe(4)
  expect(requests.filter((request) => request.operatorCall)).toHaveLength(4)
  expect(actualFiles).toHaveLength(4)
  expect(actualFiles[0]).not.toBe(actualFiles[1])
  expect(actualFiles[1]).toBe('Learned instruction for sum-01')
  const targets = requests.filter((request) => request.operatorSamples)
  expect(targets[1]!.executionTarget?.assets).toHaveLength(1)
  expect(targets[1]!.executionTarget?.digest).not.toBe(journal.spec.anchor.digest)
  expect(journal.operators!.stream!.completed.map((task) => task.task_id)).toEqual(['sum-01', 'sum-02'])
  expect(journal.operators!.state.data.publication_status).toBe('conflict')
  expect((await libraries.head('learned-skills'))!.revision).toBe(intervening.revision)
  expect(
    journal.operators!.calls.find((entry) => entry.call.key === 'sum-01/round-0/publish')!.result!.value,
  ).toMatchObject({ status: 'published', revision: first.revision })
  expect(JSON.stringify(journal.operators)).not.toContain('PRIVATE_')
  const research = await app.store.researchStore(id).load(journal)
  expect(JSON.stringify(research)).not.toContain('PRIVATE_')
  expect(research.objects.some((object) => object.kind === 'event')).toBe(true)
  expect(report.operators?.task_stream?.index).toBe(2)
  expect(report.operators?.library_publications).toHaveLength(4)
  expect(journal.operators!.state.data.iterations).toBe(4)
}, 60_000)

it('continues the failed reflection with a new attempt, retaining targets, state, published learning and all historical usage', async () => {
  const options = { failMeta: 3, cancelError: false, inspectMismatch: false }
  const { app, project, requests, actualFiles, description } = await fixture(options)
  const failed = await app.refine(description)
  const id = failed.run_id, before = await app.store.read(id)
  const source = before.operations.find((operation) => operation.receipt?.result.status === 'failed')!
  const path = join(project, '.gear', 'runs', id, 'journal.json')
  const original = await readFile(path)
  expect(before.status).toBe('completed')
  expect(before.physicalAttempts).toBe(3)
  expect(before.operators!.state.data.iterations).toBe(2)
  const recovery = { retry_operation: source.request.operationId, generation: { max_tokens: 200, per_operation: { max_tokens: 20 } } }
  const planned = planMetaRecovery(before, recovery)
  expect(planned.journal.operators!.state).toEqual(before.operators!.state)
  expect(planned.journal.operators!.stream).toEqual(before.operators!.stream)
  expect(planned.journal.operators!.artifacts).toEqual(before.operators!.artifacts)
  expect(planned.journal.operations.slice(0, -1)).toEqual(before.operations)
  expect(planned.journal.operations.at(-1)!.request.generationLimits).toEqual({ model_requests: 4, tokens: 20 })
  for (const mutate of [
    (j: RunJournal) => { j.operations.find((op) => op.request.operationId === source.request.operationId)!.receipt!.usage.tokens = null },
    (j: RunJournal) => { j.operations[0]!.status = 'submitted' },
    (j: RunJournal) => { j.operators!.state.data.iterations = 3 },
    (j: RunJournal) => { j.status = 'cancelled' },
    (j: RunJournal) => { j.operations.find((op) => op.request.operationId === source.request.operationId)!.receipt!.result.status = 'complete' },
  ]) {
    const changed = structuredClone(before)
    mutate(changed)
    expect(() => planMetaRecovery(changed, recovery)).toThrow()
  }
  expect(() => planMetaRecovery(before, { ...recovery, generation: { max_tokens: 99 } })).toThrow('cannot lower')
  options.cancelError = true
  await expect(app.resume(id, undefined, recovery)).rejects.toThrow('stop unconfirmed')
  options.cancelError = false
  options.inspectMismatch = true
  await expect(app.resume(id, undefined, recovery)).rejects.toThrow('differs from the committed failure')
  options.inspectMismatch = false
  expect(await readFile(path)).toEqual(original)
  expect(requests.filter((r) => r.operatorCall)).toHaveLength(3)

  // Simulate a process ending immediately after recovery admission, before submitting the retry.
  const write = app.store.write.bind(app.store)
  const interrupted = vi.spyOn(app.store, 'write').mockImplementationOnce(async (journal) => {
    await write(journal)
    throw new Error('interrupted after recovery admission')
  })
  await expect(app.resume(id, undefined, recovery)).rejects.toThrow('interrupted after recovery admission')
  interrupted.mockRestore()
  const admitted = await app.store.read(id)
  const checkpoint = join(project, '.gear', 'runs', id, 'recoveries', admitted.metaRecoveries![0]!.id, 'journal.json')
  expect(await readFile(checkpoint)).toEqual(original)
  await writeFile(checkpoint, '{}')
  await expect(app.resume(id)).rejects.toThrow('checkpoint failed verification')
  await writeFile(checkpoint, original)
  const controller = new ProjectController(app)
  const report = await controller.invoke('run.resume', { run_id: id, ...recovery }) as typeof failed
  const journal = await app.store.read(id)
  expect(report.status).toBe('completed')
  expect(journal.physicalAttempts).toBe(4)
  expect(actualFiles).toHaveLength(4)
  expect(requests.filter((r) => r.operatorSamples).map((r) => r.operation.task_ids)).toEqual([
    ['sum-01'], ['sum-01'], ['sum-02'], ['sum-02'],
  ])
  const meta = requests.filter((r) => r.operatorCall)
  expect(meta).toHaveLength(5)
  expect(new Set(meta.map((r) => r.operationId)).size).toBe(5)
  expect(meta[3]!.operatorCall).toEqual(meta[2]!.operatorCall)
  expect(journal.operations.find((op) => op.request.operationId === source.request.operationId)).toEqual(source)
  expect(journal.specDigest).toBe(before.specDigest)
  expect(journal.operators!.decisions.slice(0, before.operators!.decisions.length)).toEqual(before.operators!.decisions)
  expect(journal.operators!.state.data.iterations).toBe(4)
  expect(journal.operators!.stream!.completed.map((task) => task.task_id)).toEqual(['sum-01', 'sum-02'])
  expect(report.operators!.library_publications).toHaveLength(4)
  expect(report.recovered_operation_ids).toEqual([source.request.operationId])
  expect(generationLedger(journal).metrics.tokens).toMatchObject({ accounted_upper_bound: 40, limit: 200, remaining: 160 })
  await app.resume(id, undefined, recovery)
  expect(requests.filter((r) => r.operatorCall)).toHaveLength(5)
  expect(await readFile(checkpoint)).toEqual(original)
  await expect(app.resume(id, undefined, { ...recovery, generation: { max_tokens: 300 } })).rejects.toThrow('different recovery options')
}, 60_000)
