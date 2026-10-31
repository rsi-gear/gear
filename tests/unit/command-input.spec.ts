import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { projectCommand } from '../../src/cli/project.js'
import { parseProjectCommand } from '../../src/cli/project-input.js'
import { GearError } from '../../src/domain/errors.js'

async function jsonInputError(action: () => unknown): Promise<GearError> {
  const error = await Promise.resolve().then(action).then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(GearError)
  expect((error as GearError).code).toBe('invalid-json-input')
  return error as GearError
}

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
  it('reports malformed JSON input as a command error', async () => {
    expect(parseProjectCommand('experience query run_1 --query-json {"query":"x"}')).toEqual({ method: 'experience.query', params: { run_id: 'run_1', query: { query: 'x' } } })
    expect((await jsonInputError(() => parseProjectCommand('experience query run_1 --query-json {bad'))).message).toContain('--query-json must be valid JSON')
    await jsonInputError(() => parseProjectCommand('experience trajectory run_1 ref_1 src_1 --snapshot sha256:a --query-json [1,'))
    const root = await mkdtemp(join(tmpdir(), 'gear-command-input-'))
    try {
      await writeFile(join(root, 'broken.json'), '{"name": ')
      await jsonInputError(() => projectCommand(['experience', 'query', 'run_1', '--query-json', '{bad', '--project', root, '--json']))
      await jsonInputError(() => projectCommand(['experience', 'trajectory', 'run_1', 'ref_1', 'src_1', '--snapshot', 'sha256:a', '--query-json', '{bad', '--project', root, '--json']))
      expect((await jsonInputError(() => projectCommand(['refine', '--algorithm-config', 'broken.json', '--project', root, '--json']))).message).toContain('--algorithm-config broken.json must be valid JSON')
      await jsonInputError(() => projectCommand(['profile', 'create', 'imported', '--from', 'broken.json', '--project', root, '--json']))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
