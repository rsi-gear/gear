import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { load, dump } from 'js-yaml'
import { initProject } from '../../src/application/init.js'
import { ProjectApplication, type RefineOptions } from '../../src/application/project-service.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import type { OperationRequest } from '../../src/ports/operations.js'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it.each([
  ['opro', 'from gear.algorithms import OPRO; a=OPRO()', 'allow'],
  ['opro-unchanged', 'from gear.algorithms import OPRO; a=OPRO()', 'allow'],
  ['darwinx', 'from gear.algorithms import DarwinX; a=DarwinX()', 'allow'],
  ['ace', 'from gear.algorithms import ACE; a=ACE()', 'allow'],
  ['rrsi-allow', 'from gear.algorithms import RRSI; a=RRSI()', 'allow'],
  ['rrsi-reject', 'from gear.algorithms import RRSI; a=RRSI()', 'reject'],
  ['rrsi-insufficient', 'from gear.algorithms import RRSI; a=RRSI()', 'insufficient_evidence'],
])(
  'executes the public %s example through the isolated worker and durable executor',
  async (name, expression, verdict) => {
    const python = process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3'
    vi.stubEnv('GEAR_PYTHON', python)
    const root = await mkdtemp(join(tmpdir(), 'gear-example-')),
      project = join(root, 'project')
    roots.push(root)
    await initProject(project, { adapter: 'pi', template: 'text' })
    const config = load(await readFile(join(project, 'gear.yaml'), 'utf8')) as Record<string, unknown>
    config.budget = { max_candidates: 2, rounds: 2, max_evaluations: 80 }
    if (process.env.GEAR_TEST_LINUX_ISOLATION)
      config.sandbox = { linux_isolation: process.env.GEAR_TEST_LINUX_ISOLATION }
    await writeFile(join(project, 'gear.yaml'), dump(config))
    const description = JSON.parse(
      execFileSync(
        python,
        [
          '-c',
          `import json; from gear.project import Project; ${expression}; print(json.dumps(Project._describe_algorithm(a)))`,
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
    const submitted: OperationRequest[] = []
    const app = new ProjectApplication(project, {
      async provider() {
        return {
          identity: canonicalDigest('public-example-provider'),
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
            submitted.push(structuredClone(request))
            const effect = request.operatorCall?.effect
            const critic =
              effect?.kind === 'meta' &&
              (effect.input.schema as { properties?: Record<string, unknown> }).properties?.status
            const data = critic
              ? { status: verdict, reason: 'fixture review' }
              : name === 'opro-unchanged'
                ? {
                    text:
                      (
                        (effect?.kind === 'meta' ? effect.input.data : null) as {
                          current_prompt: string
                        } | null
                      )?.current_prompt ?? '',
                  }
                : name === 'ace'
                  ? {
                      add: [
                        'Verify every requirement before answering. ' +
                          submitted.filter((item) => item.operatorCall).length,
                      ],
                      replace: [],
                      remove: [],
                    }
                  : {
                      text:
                        'Verify every requirement before answering.\n' +
                        submitted.filter((item) => item.operatorCall).length,
                    }
            return {
              result: {
                operation_id: request.operationId,
                kind: request.operation.kind,
                candidate_id: request.operation.candidate_id,
                status: 'complete',
                data: request.operatorCall ? { declined: false, data } : null,
              },
              candidate: null,
              evidence: request.slots.map((slot) => ({
                candidate_id: request.operation.candidate_id!,
                task_id: slot.taskId,
                repetition: slot.repetition,
                scope: request.operation.scope,
                status: 'valid',
                score: request.operation.candidate_id === 'anchor' ? 0 : 1,
                feedback: '',
              })),
              physicalAttempts: request.slots.length,
              usage: request.operatorCall ? { model_requests: 1, tokens: 10 } : {},
              provenance: null,
            }
          },
          async inspect() {
            return { state: 'not_submitted' as const }
          },
          async cancel() {},
        }
      },
    })
    const report = await app.refine(description),
      journal = await app.store.read(await app.store.latest())
    expect(report.status).toBe('completed')
    expect(journal.operators!.calls.every((call) => call.result?.status === 'succeeded')).toBe(true)
    expect(journal.operators!.state.data.round).toBe(2)
    expect(
      journal
        .operators!.decisions.flatMap((item) => item.decision.records)
        .filter((item) => item.kind === 'algorithm_iteration'),
    ).toHaveLength(2)
    if (name === 'opro-unchanged') {
      expect(journal.candidates).toHaveLength(1)
      expect(submitted.filter((request) => request.operatorCall)).toHaveLength(2)
      expect(submitted.filter((request) => request.operatorSamples)).toHaveLength(1)
    } else if (verdict === 'allow') {
      expect(report.gate.status).toBe('accepted')
      const executions = journal.operators!.calls.filter((call) => call.call.effect.kind === 'execute')
      expect(executions).toHaveLength(name === 'darwinx' ? 5 : 3)
      if (name === 'darwinx') {
        expect(executions[2]!.sampleIds).not.toEqual(executions[0]!.sampleIds)
        expect(executions[3]!.sampleIds).not.toEqual(executions[1]!.sampleIds)
      }
    } else {
      expect(journal.nomineeId).toBeNull()
      expect(submitted.filter((request) => request.operatorCall)).toHaveLength(4)
      // Rejected proposals never submit target work; only the baseline ran.
      expect(submitted.filter((request) => request.operatorSamples)).toHaveLength(1)
    }
  },
  60_000,
)
