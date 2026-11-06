import { describe, expect, it } from 'vitest'
import { parseProjectCommand } from '../../src/cli/project-input.js'

describe('native Gear project command projection', () => {
  it('maps creation and explicit evaluation to the shared service', () => {
    expect(parseProjectCommand('refine --rounds 3')).toEqual({ method: 'run.refine', params: { rounds: 3 } })
    expect(parseProjectCommand('evaluate --limit 2 --split seed')).toEqual({ method: 'run.evaluate', params: { split: 'seed', limit: 2 } })
    expect(parseProjectCommand('benchmark preview task-1')).toEqual({ method: 'benchmark.preview', params: { task_id: 'task-1' } })
    expect(parseProjectCommand('benchmark probe --task task-1 --scorer --image python:local')).toEqual({ method: 'benchmark.probe', params: { task_id: 'task-1', scorer: true, image: 'python:local' } })
    expect(() => parseProjectCommand('benchmark probe --scorer --scorer')).toThrow('Unexpected arguments')
    expect(parseProjectCommand('benchmark import tasks.jsonl --template text --research')).toEqual({ method: 'benchmark.import', params: { source: 'tasks.jsonl', template: 'text', mode: 'research' } })
    expect(parseProjectCommand('benchmark import --apply import_abc')).toEqual({ method: 'benchmark.apply', params: { plan_id: 'import_abc' } })
    expect(() => parseProjectCommand('benchmark import --apply import_abc --research')).toThrow('Use benchmark import --apply')
  })
  it('separates creating a run from recovering a saved run', () => {
    expect(parseProjectCommand('resume run_1')).toEqual({ method: 'run.resume', params: { run_id: 'run_1' } })
    expect(() => parseProjectCommand('resume run_1 --rounds 2')).toThrow('Unexpected arguments')
    expect(() => parseProjectCommand('resume')).toThrow('requires one run ID')
    expect(() => parseProjectCommand('refine --rounds')).toThrow('requires a value')
  })
  it('reports the latest run by default and rejects obsolete or unknown options', () => {
    expect(parseProjectCommand('')).toEqual({ method: 'run.report', params: {} })
    expect(parseProjectCommand('report run_1')).toEqual({ method: 'run.report', params: { run_id: 'run_1' } })
    expect(() => parseProjectCommand('continue evolution-1')).toThrow('Unknown project command')
    expect(() => parseProjectCommand('refine --target evaluator')).toThrow('Unexpected arguments')
    expect(() => parseProjectCommand('refine --rounds 1 --rounds 2')).toThrow('Unexpected arguments')
  })
})
