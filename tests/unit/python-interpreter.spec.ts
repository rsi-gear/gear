import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { builtinPolicy } from '../../src/adapters/python/builtin-policy.js'
import { managedPythonRoot, packageRoot, resolvePythonExecutable } from '../../src/adapters/python/interpreter.js'
import { pythonExecutable } from '../../src/application/python.js'

const python = process.env.GEAR_PYTHON || process.env.GEAR_TRAINING_TEST_PYTHON || join(packageRoot, '.venv/bin/python')
let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gear-python-selection-'))
  vi.stubEnv('GEAR_HOME', home)
  vi.stubEnv('GEAR_PYTHON', '')
  vi.stubEnv('GEAR_TRAINING_TEST_PYTHON', '')
  await mkdir(managedPythonRoot(), { recursive: true })
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }) })

it('uses the setup selection for author commands and synchronous algorithms without overrides', async () => {
  const selected = join(managedPythonRoot(), 'env-Selected/bin/python')
  await mkdir(join(selected, '..'), { recursive: true })
  await symlink(python, selected)
  await writeFile(join(managedPythonRoot(), 'current.json'), JSON.stringify({ environment: 'env-Selected' }))
  expect(await pythonExecutable()).toBe(selected)
  expect(resolvePythonExecutable(true)).toBe(selected)
  expect(builtinPolicy('training_pair', {
    partition: 'dev', pairs: [{ taskId: 'managed', baselineReward: 0, candidateReward: 1 }],
    slot_count: 1, inference_errors: 0,
  })).toEqual({ partition: 'dev', taskDeltas: [{ taskId: 'managed', baseline: 0, candidate: 1, delta: 1 }],
    meanDelta: 1, standardError: null, inferenceErrorRate: 0 })
})

it('rejects a corrupt or escaping managed selection consistently', async () => {
  for (const content of ['{', JSON.stringify({ environment: '../../elsewhere' }), JSON.stringify({})]) {
    await writeFile(join(managedPythonRoot(), 'current.json'), content)
    expect(() => resolvePythonExecutable(true)).toThrow(/selection is invalid/)
    await expect(pythonExecutable()).rejects.toMatchObject({ code: 'python-not-configured' })
  }
})

it('requires executable explicit paths and gives the user override precedence over test configuration', async () => {
  const file = join(home, 'not-executable')
  await writeFile(file, '#!/bin/sh\nexit 1\n')
  await chmod(file, 0o600)
  vi.stubEnv('GEAR_PYTHON', file)
  vi.stubEnv('GEAR_TRAINING_TEST_PYTHON', python)
  expect(() => resolvePythonExecutable(true)).toThrow(/not executable/)
  await expect(pythonExecutable()).rejects.toMatchObject({ code: 'python-not-configured' })
  vi.stubEnv('GEAR_PYTHON', '')
  expect(resolvePythonExecutable(true)).toBe(python)
})
