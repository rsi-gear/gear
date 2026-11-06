import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { benchmarkLimits } from '../../src/adapters/python/benchmark-limits.js'
import { pythonExecutable, pythonSourceRoot } from '../../src/application/python.js'

afterEach(() => vi.unstubAllEnvs())

it.each(['{"maxFiles":3e5,"authorTimeoutMs":4e5}', '{"maxFiles":1.0}'])(
  'normalizes integral JSON numbers in both runtimes: %s', async (raw) => {
    vi.stubEnv('GEAR_BENCHMARK_LIMITS_JSON', raw)
    const actual = execFileSync(await pythonExecutable(), ['-c',
      'import json;from gear.benchmark.limits import benchmark_limits;print(json.dumps(benchmark_limits()))'],
    { encoding: 'utf8', env: { ...process.env, PYTHONPATH: pythonSourceRoot } })
    expect(JSON.parse(actual)).toEqual(benchmarkLimits())
  })

it('uses the same budgets in Python payload creation and TypeScript validation', async () => {
  const overrides = { maxFiles: 300000, maxDirectories: 100001, authorTimeoutMs: 400000 }
  vi.stubEnv('GEAR_BENCHMARK_LIMITS_JSON', JSON.stringify(overrides))
  const actual = execFileSync(await pythonExecutable(), ['-c',
    'import json;from gear.benchmark.limits import benchmark_limits;print(json.dumps(benchmark_limits()))'],
  { encoding: 'utf8', env: { ...process.env, PYTHONPATH: pythonSourceRoot } })
  expect(JSON.parse(actual)).toEqual(benchmarkLimits())
  expect(benchmarkLimits()).toMatchObject(overrides)
})

it.each([null, [], 1, { unknown: 1 }, { maxFiles: 0 }, { maxFiles: -1 }, { maxFiles: 1.5 },
  { maxFiles: true }, { maxFiles: 2 ** 53 }, { authorTimeoutMs: 2 ** 31 }])(
  'rejects invalid preparation budgets: %j', (value) => {
    expect(() => benchmarkLimits({ GEAR_BENCHMARK_LIMITS_JSON: JSON.stringify(value) }))
      .toThrow(/known positive integer budgets/)
  })
