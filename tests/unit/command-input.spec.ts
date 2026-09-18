import { describe, expect, it } from 'vitest'
import { parseAdmissionInput, parseContinueInput, parseEvaluationRerunInput } from '../../src/index.js'

describe('/refine admission input', () => {
  it('parses seed ref, rounds, wall-clock budget, and semantic target', () => {
    expect(parseAdmissionInput([
      'seed-commit', '--rounds', '3', '--budget', '90000', '--target', 'post_action',
    ])).toEqual({ seedTaskRef: 'seed-commit', rounds: 3, taskBudgetMs: 90_000, target: 'post_action', focus: ['post_action'] })
  })

  it('rejects unknown options and targets', () => {
    expect(() => parseAdmissionInput(['--unknown', 'x'])).toThrow(/unknown refine option/)
    expect(() => parseAdmissionInput(['--target', 'evaluator'])).toThrow(/unknown semantic focus/)
    expect(() => parseAdmissionInput(['--round', 'round-1'])).toThrow(/unknown refine option/)
  })
})

describe('/refine continue input', () => {
  it('parses a specific round to recover', () => {
    expect(parseContinueInput(['--round', 'round-1'])).toEqual({ roundId: 'round-1' })
  })

  it('keeps new-batch options separate from round recovery', () => {
    expect(parseContinueInput(['--rounds', '2', '--focus', 'context,routing'])).toEqual({
      rounds: 2, focus: ['context', 'routing'],
    })
    expect(() => parseContinueInput(['--round', 'round-1', '--rounds', '2'])).toThrow(/cannot be combined/)
    expect(() => parseContinueInput(['--round', 'round-1', '--focus', 'context'])).toThrow(/cannot be combined/)
    expect(() => parseContinueInput(['--round'])).toThrow(/requires a value/)
    expect(() => parseContinueInput(['--round', '--focus', 'context'])).toThrow(/requires a value/)
  })
})

describe('/refine rerun input', () => {
  it('parses all-invalid and named-task selectors', () => {
    const evalId = `eval_${'1'.repeat(32)}`
    expect(parseEvaluationRerunInput(['evolution-1', 'round-1', '--eval', evalId, '--invalid'])).toEqual({
      evolutionId: 'evolution-1', roundId: 'round-1', evalId, selector: { mode: 'invalid' },
    })
    expect(parseEvaluationRerunInput([
      'evolution-1', 'round-1', '--eval', evalId, '--task', 'task-b', '--task', 'task-a', '--task', 'task-b',
    ])).toEqual({
      evolutionId: 'evolution-1', roundId: 'round-1', evalId,
      selector: { mode: 'tasks', taskNames: ['task-b', 'task-a'] },
    })
  })

  it('requires exactly one selector', () => {
    const evalId = `eval_${'1'.repeat(32)}`
    expect(() => parseEvaluationRerunInput(['evolution-1', 'round-1', '--eval', evalId])).toThrow(/exactly one/)
    expect(() => parseEvaluationRerunInput([
      'evolution-1', 'round-1', '--eval', evalId, '--invalid', '--task', 'task-a',
    ])).toThrow(/exactly one/)
  })
})
