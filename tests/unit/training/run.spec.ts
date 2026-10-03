import { describe, expect, it, vi } from 'vitest'
import { runTraining } from '../../../src/training/cli.js'
import type { ModelTrainingRun, TrainingExecution } from '../../../src/training/types.js'

const state = (execution: TrainingExecution) => ({ execution } as ModelTrainingRun)
function coordinator() {
  return { inspect: vi.fn(async () => state('running')), advance: vi.fn(async () => state('completed')),
    pause: vi.fn(async () => state('paused')) }
}

describe('one-command training coordination', () => {
  it('continues reconciliation until completion without resubmitting or resuming', async () => {
    const c = coordinator()
    c.advance.mockResolvedValueOnce(state('running')).mockResolvedValueOnce(state('running'))
    const onProgress = vi.fn()
    expect((await runTraining(c, 'experiment', 'run', { intervalMs: 1, onProgress })).execution).toBe('completed')
    expect(c.advance).toHaveBeenCalledTimes(3)
    expect(c.advance).toHaveBeenCalledWith('experiment', 'run')
    expect(c.pause).not.toHaveBeenCalled()
    expect(onProgress).toHaveBeenCalledTimes(3)
  })
  it.each(['paused', 'blocked', 'interrupted', 'failed', 'completed'] as TrainingExecution[])('does not restart a %s run', async execution => {
    const c = coordinator(); c.inspect.mockResolvedValue(state(execution))
    expect((await runTraining(c, 'experiment', 'run')).execution).toBe(execution)
    expect(c.advance).not.toHaveBeenCalled()
  })
  it('on cancellation continues the existing pause protocol until release is acknowledged', async () => {
    const c = coordinator(), controller = new AbortController()
    c.advance.mockImplementation(async () => { controller.abort(); return state('running') })
    c.pause.mockResolvedValueOnce(state('pausing')).mockResolvedValueOnce(state('paused'))
    expect((await runTraining(c, 'experiment', 'run', { intervalMs: 1, signal: controller.signal })).execution).toBe('paused')
    expect(c.advance).toHaveBeenCalledTimes(1)
    expect(c.pause).toHaveBeenCalledTimes(2)
  })
  it('surfaces errors instead of silently retrying an ambiguous operation', async () => {
    const c = coordinator(); c.advance.mockRejectedValue(new Error('node unavailable'))
    await expect(runTraining(c, 'experiment', 'run')).rejects.toThrow('node unavailable')
    expect(c.advance).toHaveBeenCalledTimes(1)
  })
})
