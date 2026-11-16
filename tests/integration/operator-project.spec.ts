import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { load, dump } from 'js-yaml'
import { ProjectApplication, type RefineOptions } from '../../src/application/project-service.js'
import { initProject } from '../../src/application/init.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import type { OperationReceipt, OperationRequest } from '../../src/ports/operations.js'

const roots: string[] = []
const python = process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3'
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('runs v2 through Project.refine and resumes a lost Meta receipt without repeating edits, model calls or samples', async () => {
  vi.stubEnv('GEAR_PYTHON', python)
  const root = await mkdtemp(join(tmpdir(), 'gear-operator-project-'))
  roots.push(root)
  const project = join(root, 'project')
  await initProject(project, { adapter: 'pi', template: 'text' })
  const config = load(await readFile(join(project, 'gear.yaml'), 'utf8')) as Record<string, unknown>
  config.budget = { max_candidates: 2, rounds: 1, max_evaluations: 60 }
  config.generation = {
    max_model_requests: 3,
    max_tokens: 100,
    per_operation: { max_model_requests: 1, max_tokens: 40 },
  }
  if (process.env.GEAR_TEST_LINUX_ISOLATION)
    config.sandbox = { linux_isolation: process.env.GEAR_TEST_LINUX_ISOLATION }
  await writeFile(join(project, 'gear.yaml'), dump(config))
  const description = JSON.parse(
    execFileSync(
      python,
      [
        '-c',
        'import json; from gear.project import Project; from gear.ops import ScreeningPolicy; from operator_flow import OperatorFlow; a=OperatorFlow(); d=Project._describe_algorithm(a); d["screening"]=ScreeningPolicy(a.critic,a.edit_check,a.predicate).to_dict(); print(json.dumps(d))',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, PYTHONPATH: [resolve('python'), resolve('tests/fixtures')].join(':') },
      },
    ),
  ) as RefineOptions
  const requests: OperationRequest[] = [],
    inspected: string[] = [],
    receipts = new Map<string, OperationReceipt>()
  let lost = false
  const app = new ProjectApplication(project, {
    async provider() {
      return {
        identity: canonicalDigest('operator-fixture'),
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
        },
        async submit(request) {
          requests.push(structuredClone(request))
          const op = request.operation
          const receipt: OperationReceipt = {
            result: {
              operation_id: request.operationId,
              kind: op.kind,
              candidate_id: op.candidate_id,
              status: 'complete',
              data: op.kind === 'diagnose_seed' ? { declined: false, data: { approved: true } } : null,
            },
            candidate: null,
            evidence: request.slots.map((slot) => ({
              candidate_id: op.candidate_id!,
              task_id: slot.taskId,
              repetition: slot.repetition,
              scope: op.scope,
              status: 'valid',
              score: op.candidate_id === 'anchor' ? 0 : 1,
              feedback: '',
            })),
            physicalAttempts: request.slots.length,
            usage:
              op.kind === 'diagnose_seed'
                ? { model_requests: 1, tokens: 12, input_tokens: 8, output_tokens: 4 }
                : { model_requests: 0, tokens: 0 },
            provenance: { fixture: true },
          }
          receipts.set(request.operationId, receipt)
          if (op.kind === 'diagnose_seed' && !lost) {
            lost = true
            throw new Error('lost Meta acknowledgement')
          }
          return receipt
        },
        async inspect(request) {
          inspected.push(request.operationId)
          const receipt = receipts.get(request.operationId)
          return receipt ? { state: 'complete' as const, receipt } : { state: 'not_submitted' as const }
        },
        async cancel() {},
      }
    },
  })
  let interruptedError: unknown
  try {
    await app.refine(description)
  } catch (error) {
    interruptedError = error
  }
  if (!(interruptedError instanceof Error) || interruptedError.message !== 'lost Meta acknowledgement')
    throw interruptedError ?? new Error('Expected interrupted Meta submission')
  const id = await app.store.latest(),
    interrupted = await app.store.read(id)
  expect(interrupted.status).toBe('needs_recovery')
  expect(interrupted.operators?.decisions).toHaveLength(3)
  expect(interrupted.operators?.state.data.phase).toBe(3)
  expect(interrupted.operators?.calls.map((item) => item.status)).toEqual([
    'complete',
    'complete',
    'reserved',
  ])
  expect(interrupted.operations[0]?.status).toBe('submitted')
  const edit = interrupted.candidates.find((candidate) => candidate.id !== 'anchor')!
  const report = await app.resume(id, new AbortController().signal)
  expect(report.status).toBe('completed')
  expect(report.gate.status).toBe('accepted')
  expect(report.retained).toBe(edit.id)
  const journal = await app.store.read(id)
  expect(requests.filter((item) => item.operatorCall)).toHaveLength(1)
  expect(inspected).toEqual([requests[0]!.operationId])
  expect(journal.candidates).toHaveLength(2)
  expect(journal.operators?.calls).toHaveLength(6)
  expect(journal.operators?.calls.every((item) => item.status === 'complete')).toBe(true)
  expect(
    journal.operators?.calls
      .filter((item) => item.call.effect.kind === 'execute')
      .every((item) => item.screening?.verdict.status === 'allow'),
  ).toBe(true)
  expect(journal.operators?.samples).toHaveLength(journal.spec.seedTasks.length + 1)
  const evaluations = requests.filter((item) => item.operatorSamples)
  expect(evaluations).toHaveLength(2)
  expect(evaluations[0]!.operationId).not.toBe(evaluations[1]!.operationId)
  expect(requests[0]!.generationLimits?.tokens).toBe(32)
  expect(requests[0]!.operatorCall?.materials).toHaveLength(2)
  expect(journal.operators?.calls.find((item) => item.call.key === 'critic')?.result?.usage?.tokens).toBe(12)
  expect(journal.seedEvidence).toHaveLength(2 * journal.spec.seedTasks.length)
  expect(journal.operations.filter((item) => item.request.partition === 'held_out')).toHaveLength(2)
}, 60_000)

it('enforces frozen screening in a fresh process even when the proposing algorithm changes predicate globals', async () => {
  vi.stubEnv('GEAR_PYTHON', python)
  const root = await mkdtemp(join(tmpdir(), 'gear-independent-screening-'))
  roots.push(root)
  const project = join(root, 'project')
  await initProject(project, { adapter: 'pi', template: 'text' })
  if (process.env.GEAR_TEST_LINUX_ISOLATION) {
    const config = load(await readFile(join(project, 'gear.yaml'), 'utf8')) as Record<string, unknown>
    config.sandbox = { linux_isolation: process.env.GEAR_TEST_LINUX_ISOLATION }
    await writeFile(join(project, 'gear.yaml'), dump(config))
  }
  const description = JSON.parse(
    execFileSync(
      python,
      [
        '-c',
        'import json; from gear.project import Project; from gear.ops import ScreeningPolicy; from operator_screening import BypassScreening; a=BypassScreening(); d=Project._describe_algorithm(a); d["screening"]=ScreeningPolicy(a.critic,a.edit_check,a.predicate).to_dict(); print(json.dumps(d))',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, PYTHONPATH: [resolve('python'), resolve('tests/fixtures')].join(':') },
      },
    ),
  ) as RefineOptions
  const submitted: OperationRequest[] = []
  const app = new ProjectApplication(project, {
    async provider() {
      return {
        identity: canonicalDigest('independent-screening-fixture'),
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
        },
        async submit(request) {
          submitted.push(request)
          if (!request.operatorCall) throw new Error('Rejected screening must never execute a benchmark')
          return {
            result: {
              operation_id: request.operationId,
              kind: request.operation.kind,
              candidate_id: request.operation.candidate_id,
              status: 'complete',
              data: { declined: false, data: { approved: false } },
            },
            candidate: null,
            evidence: [],
            physicalAttempts: 0,
            usage: { model_requests: 1, tokens: 10 },
            provenance: null,
          }
        },
        async inspect() {
          return { state: 'not_submitted' }
        },
        async cancel() {},
      }
    },
  })
  const report = await app.refine(description)
  const journal = await app.store.read(await app.store.latest())
  expect(report.status).toBe('completed')
  expect(journal.operators?.calls[1]).toMatchObject({
    status: 'complete',
    operationIds: [],
    screening: { verdict: { status: 'reject' } },
    result: { status: 'failed', error: { code: 'screening-rejected' } },
  })
  expect(submitted).toHaveLength(1)
  expect(journal.physicalAttempts).toBe(0)
  expect(journal.operators?.decisions).toHaveLength(3)
  expect(journal.operators?.state.data.allowed).toBe(true)
}, 60_000)
