import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { SeedTrajectoryArchive } from '../../src/application/trajectory.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import { admitTrials, collectTrials } from '../../src/domain/research-trials.js'
import type { Operation } from '../../src/domain/algorithm-wire.js'
import type { RunJournal } from '../../src/domain/run.js'
import type { OperationReceipt, OperationRequest } from '../../src/ports/operations.js'
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
it.each([0, 1])(
  'keeps canonical trajectory when independent same-slot observation has score %s',
  async (independentScore) => {
    const root = await mkdtemp(join(tmpdir(), 'gear-research-isolation-'))
    roots.push(root)
    const cell = {
      candidate_id: 'anchor',
      task_id: 'a',
      repetition: 0,
      scope: 'global',
      score: 0,
      status: 'valid',
      feedback: '',
    } as const
    const request = {
      runId: 'run',
      operationId: canonicalDigest('canonical'),
      generation: 1,
      partition: 'seed',
      repetitions: 1,
      slots: [{ taskId: 'a', repetition: 0 }],
      evidence: [],
      operation: {
        kind: 'evaluate_seed',
        candidate_id: 'anchor',
        parent_id: null,
        task_ids: ['a'],
        scope: 'global',
        rationale: '',
        payload: null,
      },
    } as OperationRequest
    const artifact = {
      kind: 'trajectory',
      format: 'fixture',
      task_id: 'a',
      repetition: 0,
      status: 'available',
      content_digest: canonicalDigest('canonical-trace'),
      locator: { private: 'canonical' },
      reason: null,
    } as const
    const receipt = {
      result: {
        operation_id: request.operationId,
        kind: 'evaluate_seed',
        candidate_id: 'anchor',
        status: 'complete',
        data: null,
      },
      candidate: null,
      evidence: [cell],
      artifacts: [artifact],
      physicalAttempts: 1,
      usage: { tokens: 10 },
      provenance: null,
    } as OperationReceipt
    const independent = {
      ...request,
      operationId: canonicalDigest('independent'),
      trials: {
        group: 'retry',
        repetitions: 1,
        instances: [{ id: 'a', task_id: 'a', question: 'changed question' }],
      },
    }
    const other = {
      ...receipt,
      result: { ...receipt.result, operation_id: independent.operationId },
      evidence: [{ ...cell, score: independentScore }],
      usage: { tokens: 1000 },
      artifacts: [
        {
          ...artifact,
          content_digest: canonicalDigest('independent-trace'),
          locator: { private: 'independent' },
        },
      ],
    }
    const journal = {
      id: 'run',
      spec: {
        artifactReader: {
          format: 'fixture',
          implementation_identity: canonicalDigest('reader'),
          configuration: null,
        },
      },
      seedEvidence: [cell],
      operations: [
        { request, status: 'complete', receipt },
        { request: independent, status: 'complete', receipt: other },
      ],
    } as unknown as RunJournal
    const references = await new SeedTrajectoryArchive(root, journal).references(['anchor'], ['a'])
    expect(references).toHaveLength(1)
    expect(references[0]!.content_digest).toBe(artifact.content_digest)
  },
)
it('rejects unadmitted or forbidden derived inputs before execution and makes private trial locators opaque', () => {
  const operation: Operation = {
    kind: 'evaluate_seed',
    candidate_id: 'anchor',
    parent_id: null,
    task_ids: ['a'],
    scope: 'global',
    rationale: '',
    payload: null,
  }
  const plan = { group: 'retry', repetitions: 1, instances: [{ id: 'a', task_id: 'a', question: 'changed' }] }
  const journal = {
    id: 'run',
    spec: {
      researchData: {
        train: ['a'],
        dev: [],
        allowDerivedInputs: false,
        tasks: [{ id: 'a', instruction: 'original', digest: canonicalDigest('task') }],
      },
    },
    operations: [],
  } as unknown as RunJournal
  expect(() => admitTrials(journal, operation, plan)).toThrow('disabled')
  const request = { operationId: canonicalDigest('op'), operation, trials: plan } as OperationRequest
  const cell = {
    candidate_id: 'anchor',
    task_id: 'a',
    repetition: 0,
    scope: 'global',
    score: 1,
    status: 'valid',
    feedback: '',
  } as const
  const receipt = {
    evidence: [cell],
    artifacts: [
      {
        kind: 'trajectory',
        format: 'fixture',
        task_id: 'a',
        repetition: 0,
        status: 'available',
        content_digest: canonicalDigest('trace'),
        locator: { secret_path: '/private/provider/session' },
        reason: null,
      },
    ],
  } as unknown as OperationReceipt
  const trials = collectTrials(journal, request, receipt)
  expect(JSON.stringify(trials)).not.toContain('secret_path')
  expect(trials[0]!.artifacts[0]!.locator).toEqual({ trial_id: trials[0]!.id })
  expect(trials[0]!.usage).toBeNull()
})
