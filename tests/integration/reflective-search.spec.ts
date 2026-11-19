import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { dump, load } from 'js-yaml'
import { initProject } from '../../src/application/init.js'
import { ProjectApplication, type RefineOptions } from '../../src/application/project-service.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import type { OperationReceipt, OperationRequest } from '../../src/ports/operations.js'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it.each(['off', 'improve', 'tie'] as const)(
  'repairs and resumes formal search with training gate %s',
  async (gate) => {
    const python = process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3'
    vi.stubEnv('GEAR_PYTHON', python)
    const root = await mkdtemp(join(tmpdir(), 'gear-reflective-search-'))
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
          [
            'import json',
            'from gear.project import Project',
            'from gear.algorithms.reflective_search import ReflectiveSearch',
            'from gear.search.constraints import PromptConstraints',
            `algorithm=ReflectiveSearch(("sum-01",), ("sum-02",), constraints=PromptConstraints(40), target_characters=20, max_repairs=1, nominate=False, training_gate=${gate === 'off' ? 'False' : 'True'})`,
            'print(json.dumps(Project._describe_algorithm(algorithm)))',
          ].join('; '),
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, PYTHONPATH: resolve('python') },
        },
      ),
    ) as RefineOptions
    const requests: OperationRequest[] = [],
      inspected: string[] = []
    const receipts = new Map<string, OperationReceipt>()
    let lost = false
    const app = new ProjectApplication(project, {
      async provider() {
        return {
          identity: canonicalDigest('reflective-search-fixture'),
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
            const effect = request.operatorCall?.effect
            const revising =
              effect?.kind === 'meta' &&
              (effect.input.data as Record<string, unknown> | null)?.proposed_text !== undefined
            const receipt: OperationReceipt = {
              result: {
                operation_id: request.operationId,
                kind: request.operation.kind,
                candidate_id: request.operation.candidate_id,
                status: 'complete',
                data: request.operatorCall
                  ? {
                      declined: false,
                      data: { text: revising ? 'Check every input.' : 'x'.repeat(50) },
                    }
                  : null,
              },
              candidate: null,
              evidence: request.slots.map((slot) => ({
                candidate_id: request.operation.candidate_id!,
                task_id: slot.taskId,
                repetition: slot.repetition,
                scope: request.operation.scope,
                status: 'valid',
                score:
                  request.operation.candidate_id === 'anchor' || (gate === 'tie' && slot.taskId === 'sum-01')
                    ? 0
                    : 1,
                feedback: slot.taskId === 'sum-01' ? 'TRAIN_ONLY_EVIDENCE' : 'DO_NOT_REFLECT_DEV',
              })),
              physicalAttempts: request.slots.length,
              usage: request.operatorCall ? { model_requests: 1, tokens: 12 } : {},
              provenance: { test_fixture: true },
            }
            receipts.set(request.operationId, receipt)
            if (revising && !lost) {
              lost = true
              throw new Error('lost repair acknowledgement')
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
    await expect(app.refine(description)).rejects.toThrow('lost repair acknowledgement')
    const id = await app.store.latest()
    const interrupted = await app.store.read(id)
    expect(interrupted.status).toBe('needs_recovery')
    expect(interrupted.operators!.state.data.phase).toBe('revise')
    const result = await app.resume(id, new AbortController().signal)
    expect(result.status).toBe('completed')
    const journal = await app.store.read(id)
    expect(journal.nomineeId).toBeNull()
    expect(journal.candidates).toHaveLength(2)
    const meta = requests.filter((request) => request.operatorCall)
    expect(meta).toHaveLength(2)
    expect(inspected).toEqual([meta[1]!.operationId])
    for (const request of meta) {
      expect(request.operation.task_ids).toEqual(['sum-01'])
      expect(JSON.stringify(request.operatorCall!.materials)).not.toContain('DO_NOT_REFLECT_DEV')
      expect(request.evidence).toEqual([])
    }
    expect(JSON.stringify(meta[0]!.operatorCall!.materials)).toContain('TRAIN_ONLY_EVIDENCE')
    expect(requests.some((request) => request.partition === 'held_out')).toBe(false)
    const records = journal.operators!.decisions.flatMap((row) => row.decision.records)
    expect(
      records.filter((record) => record.kind === 'prompt_constraints').map((record) => record.status),
    ).toEqual(['reject', 'allow'])
    expect(records.find((record) => record.kind === 'algorithm_iteration')!.accepted).toBe(gate !== 'tie')
    if (gate !== 'off')
      expect(records.find((record) => record.kind === 'training_acceptance')!.accepted).toBe(
        gate === 'improve',
      )
    expect(journal.operators!.calls.every((call) => call.status === 'complete')).toBe(true)
    expect(
      requests.filter((request) => request.operatorSamples).map((request) => request.operation.task_ids),
    ).toEqual(
      gate === 'off'
        ? [['sum-02'], ['sum-01'], ['sum-02']]
        : gate === 'tie'
          ? [['sum-02'], ['sum-01'], ['sum-01']]
          : [['sum-02'], ['sum-01'], ['sum-01'], ['sum-02']],
    )
  },
  60_000,
)
