import { afterEach, describe, expect, it, vi } from 'vitest'
import { builtinPolicy } from '../../src/adapters/python/builtin-policy.js'

const workers = vi.hoisted(() => ({ started: 0, pid: undefined as Int32Array | undefined }))
vi.mock('node:worker_threads', async (original) => {
  const actual = await original<typeof import('node:worker_threads')>()
  return { ...actual, Worker: class extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args)
      workers.started++
      workers.pid = new Int32Array(args[1]!.workerData.pid)
    }
  } }
})
afterEach(() => { vi.unstubAllEnvs(); workers.started = 0 })

function pairs(reward: number) {
  return { partition: 'dev', pairs: [{ taskId: 'policy', baselineReward: 0, candidateReward: reward }],
    slot_count: 1, inference_errors: 0 }
}
function report(reward: number) {
  return { partition: 'dev', taskDeltas: [{ taskId: 'policy', baseline: 0, candidate: reward, delta: reward }],
    meanDelta: reward, standardError: null, inferenceErrorRate: 0 }
}

describe('packaged Python policy transport', () => {
  it('reuses pure decisions without sharing mutable results or conflating inputs', () => {
    const input = pairs(1)
    const first = builtinPolicy<ReturnType<typeof report>>('training_pair', input)
    first.taskDeltas[0]!.taskId = 'caller mutation'
    expect(builtinPolicy('training_pair', input)).toEqual(report(1))
    expect(workers.started).toBe(1)
    expect(builtinPolicy('training_pair', pairs(0.5))).toEqual(report(0.5))
    expect(workers.started).toBe(1)
  })

  it('keeps the worker usable after a policy rejects its input', () => {
    for (let index = 0; index < 2; index++)
      expect(() => builtinPolicy('training_pair', { ...pairs(0), slot_count: 0 })).toThrow(TypeError)
    expect(builtinPolicy('training_pair', pairs(0.2))).toEqual(report(0.2))
    expect(workers.started).toBe(0)
  })

  it('reports a dead Python process and starts a fresh worker for the next decision', () => {
    process.kill(Atomics.load(workers.pid!, 0), 'SIGKILL')
    const input = pairs(0.625)
    expect(() => builtinPolicy('training_pair', input)).toThrow(/worker exited/)
    expect(builtinPolicy('training_pair', input)).toEqual(report(0.625))
    expect(workers.started).toBe(1)
  })

  it('checks a newly selected interpreter instead of reusing another runtime reply', () => {
    const input = pairs(0.375)
    expect(builtinPolicy('training_pair', input)).toEqual(report(0.375))
    vi.stubEnv('GEAR_PYTHON', '/nonexistent-gear-policy-python')
    expect(() => builtinPolicy('training_pair', input)).toThrow(/not executable/)
    expect(workers.started).toBe(0)
  })

  it('does not expose the retired decision dispatcher in the shipped runtime', () => {
    for (const operation of ['generation', 'task_reward', 'archived_round_phase', 'archived_draw'])
      expect(() => builtinPolicy(operation, {})).toThrow(operation)
    expect(builtinPolicy('training_pair', pairs(0.75))).toEqual(report(0.75))
  })
})
