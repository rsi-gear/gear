import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('runs the Forge caller through new admitted runs and resumes without duplicate submission', () => {
  const output = execFileSync(
    process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3',
    ['-m', 'unittest', 'discover', '-s', 'python/tests', '-p', 'test_forge_curriculum_harness.py'],
    {
      encoding: 'utf8',
      timeout: 90_000,
      stdio: 'pipe',
      env: { ...process.env, PYTHONPATH: resolve('python'), GEAR_TEST_FORGE_RUNTIME: '1' },
    },
  )
  expect(output).not.toContain('FAILED')
}, 100_000)
