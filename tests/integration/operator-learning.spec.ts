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

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('runs blind learning through the public Python API, seals effective library files and recovers publication after another publisher advances the head', async () => {
  const python = process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3'
  vi.stubEnv('GEAR_PYTHON', python)
  const root = await mkdtemp(join(tmpdir(), 'gear-blind-learning-')),
    project = join(root, 'project')
  roots.push(root)
  await initProject(project, { adapter: 'pi', template: 'text' })
  const config = load(await readFile(join(project, 'gear.yaml'), 'utf8')) as Record<string, unknown>
  config.budget = { ...(config.budget as Record<string, unknown>), rounds: 2 }
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
          const receipt: OperationReceipt = {
            result: {
              operation_id: request.operationId,
              kind: request.operation.kind,
              candidate_id: request.operation.candidate_id,
              status: 'complete',
              data: request.operatorCall
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
          return receipt ? { state: 'complete' as const, receipt } : { state: 'not_submitted' as const }
        },
        async cancel() {},
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
