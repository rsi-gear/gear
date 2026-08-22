import { describe, expect, it } from 'vitest'
import { parseAdmissionInput } from '../../src/index.js'

describe('/refine admission input', () => {
  it('parses seed ref, rounds, wall-clock budget, and semantic target', () => {
    expect(parseAdmissionInput([
      'seed-commit', '--rounds', '3', '--budget', '90000', '--target', 'post_action',
    ])).toEqual({ seedTaskRef: 'seed-commit', rounds: 3, taskBudgetMs: 90_000, target: 'post_action', focus: ['post_action'] })
  })

  it('rejects unknown options and targets', () => {
    expect(() => parseAdmissionInput(['--unknown', 'x'])).toThrow(/unknown refine option/)
    expect(() => parseAdmissionInput(['--target', 'evaluator'])).toThrow(/unknown semantic focus/)
  })
})
