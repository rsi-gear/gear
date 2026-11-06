import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { initProject } from '../../src/application/init.js'
import { ProjectController } from '../../src/application/project-controller.js'
import { ProjectApplication } from '../../src/application/project-service.js'
import { DockerBenchmarkProbe } from '../../src/adapters/hitch/benchmark-probe.js'
import { GearError } from '../../src/domain/errors.js'

let root: string, controller: ProjectController
const image = `python@sha256:${'1'.repeat(64)}`
const python = execFileSync(process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim()
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gear-probe-test-'))
  vi.stubEnv('GEAR_PROFILE_ROOT', join(root, 'profiles')); vi.stubEnv('GEAR_PYTHON', python)
  await initProject(join(root, 'project'))
  controller = new ProjectController(new ProjectApplication(join(root, 'project'), { provider: async () => { throw new Error('Probe must not connect to a model') } }))
  vi.spyOn(DockerBenchmarkProbe.prototype, 'build').mockResolvedValue(`sha256:${'2'.repeat(64)}`)
  vi.spyOn(DockerBenchmarkProbe.prototype, 'dispose').mockResolvedValue([])
  vi.spyOn(DockerBenchmarkProbe.prototype, 'verify').mockImplementation(async (_plan, fixture) => {
    await writeFile(join(fixture.logs, 'gear-result.json'), JSON.stringify({ status: 'valid', value: fixture.expected_score }))
    await writeFile(join(fixture.logs, 'reward.txt'), String(fixture.expected_score))
  })
})
afterEach(async () => { await controller.dispose(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })
it('persists a seed scorer probe with valid zero, independent of the run ledger', async () => {
  const check = await controller.invoke('benchmark.check') as { splits: { seed: string[]; held_out: string[] } }
  const before = await readFile(join(root, 'project/gear.yaml'), 'utf8')
  const result = await controller.invoke('benchmark.probe', { scorer: true, image }) as Record<string, unknown>
  expect(result).toMatchObject({ task_id: check.splits.seed[0], status: 'passed', environment: 'passed', scorer: 'passed', model_requests: 0, baseline: false, target_executed: false })
  expect(result.fixtures).toEqual([{ index: 0, status: 'passed', expected_score: 1, observed_score: 1 }, { index: 1, status: 'passed', expected_score: 0, observed_score: 0 }])
  expect(JSON.parse(await readFile(join(root, 'project', String(result.report)), 'utf8'))).toEqual(result)
  expect(await readFile(join(root, 'project/gear.yaml'), 'utf8')).toBe(before)
  expect(await readdir(join(root, 'project/.gear'))).not.toContain('runs')
  await expect(controller.invoke('benchmark.probe', { task_id: check.splits.held_out[0], scorer: true, image })).rejects.toMatchObject({ code: 'probe-seed-required' })
  expect(DockerBenchmarkProbe.prototype.build).toHaveBeenCalledTimes(1)
})
it('runs only the environment unless scorer is explicitly requested', async () => {
  expect(await controller.invoke('benchmark.probe', { image })).toMatchObject({ status: 'passed', scorer: 'not_run', environment: 'passed', fixtures: [] })
  expect(DockerBenchmarkProbe.prototype.verify).not.toHaveBeenCalled()
  await expect(controller.invoke('benchmark.probe', { scorer: 'yes', image })).rejects.toMatchObject({ code: 'invalid-command-params' })
})
it('checks custom Python source without importing it and records the explicit scorer identity', async () => {
  const project = join(root, 'project')
  await writeFile(join(project, 'scorers.py'), 'raise RuntimeError("check imported project code")\ndef score(actual, expected, artifacts, *, seed):\n    return actual == expected\n')
  await writeFile(join(project, 'tasks.jsonl'), [
    { id: 'seed', instruction: 'Seed instruction', expected: 'PRIVATE', split: 'seed' },
    { id: 'held', instruction: 'Held instruction', expected: 'HELD', split: 'held_out' },
  ].map(row => JSON.stringify(row)).join('\n'))
  const scorer = { entrypoint: 'scorers.py:score', version: 'v1', randomness: { seed: 7 }, cost: { model_requests: 0 }, artifacts: [] }
  await writeFile(join(project, 'benchmark.yaml'), JSON.stringify({
    version: 1, template: 'python', source: 'tasks.jsonl', scorer,
    fixtures: Object.fromEntries(['seed', 'held'].map(id => [id, [{ actual: 'yes', score: 1 }, { actual: 'no', score: 0 }]])),
  }))
  expect(await controller.invoke('benchmark.check')).toMatchObject({ checks: { static: 'passed', verifier_fixtures: 'not_run' } })
  expect(await controller.invoke('benchmark.preview', { task_id: 'seed' })).toMatchObject({ scorer: { rule: { kind: 'python', scorer } } })
  const report = await controller.invoke('benchmark.probe', { scorer: true, image }) as Record<string, unknown>
  expect(report).toMatchObject({ status: 'passed', scorer_metadata: scorer })
  expect(report.scorer_metadata).not.toHaveProperty('source')
  expect(report.scorer_metadata).toHaveProperty('source_digest', expect.stringMatching(/^sha256:/u))
})
it('reports environment failure and verifier failure without substituting a score', async () => {
  vi.mocked(DockerBenchmarkProbe.prototype.build).mockRejectedValueOnce(new GearError('benchmark-environment-failed', 'bad environment'))
  expect(await controller.invoke('benchmark.probe', { scorer: true, image })).toMatchObject({ status: 'environment_failed', scorer: 'not_run', environment: 'failed', fixtures: [] })
  vi.mocked(DockerBenchmarkProbe.prototype.verify).mockRejectedValueOnce(new GearError('benchmark-verifier-failed', 'bad verifier'))
  expect(await controller.invoke('benchmark.probe', { scorer: true, image })).toMatchObject({ status: 'scoring_failed', environment: 'passed', fixtures: [{ index: 0, status: 'scoring_failed' }, { index: 1, status: 'passed', observed_score: 0 }] })
})
it('retains cancellation and outstanding cleanup in an authoring report', async () => {
  const abort = new AbortController()
  vi.mocked(DockerBenchmarkProbe.prototype.verify).mockImplementationOnce(async () => { abort.abort(); abort.signal.throwIfAborted() })
  expect(await controller.invoke('benchmark.probe', { scorer: true, image }, { signal: abort.signal })).toMatchObject({ status: 'cancelled', environment: 'passed', scorer: 'not_run' })
  expect(DockerBenchmarkProbe.prototype.dispose).toHaveBeenCalled()
  vi.mocked(DockerBenchmarkProbe.prototype.dispose).mockResolvedValueOnce(['owned-container'])
  expect(await controller.invoke('benchmark.probe', { image })).toMatchObject({ status: 'cleanup_required', cleanup_required: ['owned-container'] })
})

async function llmBenchmark() {
  const project = join(root, 'project')
  const scorer = {
    version: 'v1', protocol: 'chat-completions@1', endpoint: 'https://judge.example/v1/chat/completions',
    api_key_env: 'GEAR_SCORER_TEST_API_KEY', model: 'pinned-test-model', rubric: 'Pass when correct.',
    randomness: { temperature: 0, seed: 7 }, artifacts: [],
    cost: { price_version: 'fixture-prices', input_usd_per_million: 2, cached_input_usd_per_million: 1, output_usd_per_million: 4 },
    limits: { max_request_bytes: 65536, max_completion_tokens: 128, timeout_seconds: 15 },
  }
  await writeFile(join(project, 'tasks.jsonl'), [
    { id: 'seed', instruction: 'Seed task', expected: 'PRIVATE', split: 'seed' },
    { id: 'held', instruction: 'Held task', expected: 'HELD', split: 'held_out' },
  ].map(row => JSON.stringify(row)).join('\n'))
  await writeFile(join(project, 'benchmark.yaml'), JSON.stringify({
    version: 1, template: 'llm', source: 'tasks.jsonl', scorer,
    fixtures: Object.fromEntries(['seed', 'held'].map(id => [id, [{ actual: 'yes', score: 1 }, { actual: 'no', score: 0 }]])),
  }))
  return scorer
}
it('does not require judge credentials for static or environment-only checks', async () => {
  await llmBenchmark()
  vi.stubEnv('GEAR_SCORER_TEST_API_KEY', '')
  expect(await controller.invoke('benchmark.check')).toMatchObject({ checks: { verifier_fixtures: 'not_run' } })
  expect(await controller.invoke('benchmark.probe', { image })).toMatchObject({ status: 'passed', scorer: 'not_run', model_requests: 0 })
  expect(await controller.invoke('benchmark.probe', { image, scorer: true })).toMatchObject({
    status: 'scoring_failed', environment: 'not_run', model_requests: 0,
    error: { code: 'benchmark-scorer-credentials' },
  })
  expect(DockerBenchmarkProbe.prototype.verify).not.toHaveBeenCalled()
})
it('records judge token usage and quoted cost separately from unknown billed dollars', async () => {
  const scorer = await llmBenchmark()
  vi.stubEnv('GEAR_SCORER_TEST_API_KEY', 'fixture-key-not-for-network')
  vi.mocked(DockerBenchmarkProbe.prototype.verify).mockImplementation(async (plan, fixture) => {
    expect(plan.credential_env).toEqual(['GEAR_SCORER_TEST_API_KEY'])
    expect(plan.usage_required).toBe(true)
    await writeFile(join(fixture.logs, 'gear-result.json'), JSON.stringify({ status: 'valid', value: fixture.expected_score }))
    await writeFile(join(fixture.logs, 'reward.txt'), String(fixture.expected_score))
    await writeFile(join(fixture.logs, 'gear-usage.json'), JSON.stringify({
      request_attempts: 1, model_requests: 1, input_tokens: 100, cached_input_tokens: 40, output_tokens: 20,
      tokens: 120, dollars: null, estimated_dollars: 0.00024, price_version: 'fixture-prices',
    }))
  })
  const result = await controller.invoke('benchmark.probe', { image, scorer: true }) as Record<string, unknown>
  expect(result).toMatchObject({ status: 'passed', scorer_metadata: scorer, planned_model_requests: 2,
    request_attempts: 2, model_requests: 2, model_tokens: 240, model_cost_usd: null, estimated_model_cost_usd: 0.00048 })
  expect(JSON.stringify(result)).not.toContain('fixture-key-not-for-network')
})
it('keeps interrupted judge usage unknown and reads the durable attempt marker on cancellation', async () => {
  await llmBenchmark()
  vi.stubEnv('GEAR_SCORER_TEST_API_KEY', 'fixture-key-not-for-network')
  const abort = new AbortController()
  vi.mocked(DockerBenchmarkProbe.prototype.verify).mockImplementationOnce(async (_plan, fixture) => {
    await writeFile(join(fixture.logs, 'gear-usage.json'), JSON.stringify({
      request_attempts: 1, model_requests: null, input_tokens: null, cached_input_tokens: null,
      output_tokens: null, tokens: null, dollars: null, estimated_dollars: null, price_version: 'fixture-prices',
    }))
    abort.abort()
    abort.signal.throwIfAborted()
  })
  expect(await controller.invoke('benchmark.probe', { image, scorer: true }, { signal: abort.signal })).toMatchObject({
    status: 'cancelled', request_attempts: 1, model_requests: null, model_tokens: null,
    model_cost_usd: null, estimated_model_cost_usd: null,
    fixtures: [{ index: 0, status: 'scoring_failed', usage: { request_attempts: 1, model_requests: null } }],
  })
  expect(DockerBenchmarkProbe.prototype.verify).toHaveBeenCalledTimes(1)
})
