import { expect, it, vi } from 'vitest'
import { evaluateWithCritic, screenEvaluation } from '../../src/runtime/evaluation-screen.js'
import type { OperationRequest, OperationReceipt } from '../../src/ports/operations.js'

const request = (diff: string): OperationRequest => ({
  operationId: 'operation',
  runId: 'run',
  generation: 1,
  partition: 'seed',
  repetitions: 1,
  slots: [{ taskId: 'task', repetition: 0 }],
  evidence: [],
  operation: {
    kind: 'evaluate_seed',
    candidate_id: 'candidate',
    parent_id: 'anchor',
    task_ids: ['task'],
    scope: 'global',
    rationale: 'test',
    payload: { rrsi: { enabled: true, candidate_diff: diff } },
  },
})

const accepted: OperationReceipt = {
  result: {
    operation_id: 'operation',
    kind: 'evaluate_seed',
    status: 'complete',
    candidate_id: 'candidate',
    data: null,
  },
  evidence: [],
  candidate: null,
  physicalAttempts: 0,
  usage: {},
  provenance: null,
}

it('rejects a leaking candidate before provider submission', async () => {
  const submit = vi.fn(async () => accepted)
  const receipt = await evaluateWithCritic(request('api_key = "secret-value"'), submit)

  expect(submit).not.toHaveBeenCalled()
  expect(receipt.physicalAttempts).toBe(0)
  expect(receipt.evidence[0]).toMatchObject({
    status: 'environment_failed',
    score: null,
  })
  expect(receipt.provenance).toMatchObject({ critic: { verdict: 'reject' } })
})

it('screens candidate diffs carried beside the RRSI directive', () => {
  const candidate = request('clean')
  candidate.operation.payload = {
    rrsi: { enabled: true },
    candidate_diff: 'grader.read(task_id)',
  }

  expect(screenEvaluation(candidate)).not.toBeNull()
})

it('submits a screened candidate that passes the critic', async () => {
  const submit = vi.fn(async () => accepted)
  const clean = request('Improve retry handling without task-specific logic.')

  expect(screenEvaluation(clean)).toBeNull()
  await expect(evaluateWithCritic(clean, submit)).resolves.toBe(accepted)
  expect(submit).toHaveBeenCalledOnce()
})
