import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('runs the MLE-bench adapter through the public Project API and sandboxed Python GEPA', async () => {
  const result = await promisify(execFile)(process.execPath, ['--test', 'examples/mle-bench/tests/project.test.mjs'], {
    cwd: resolve('.'), env: process.env, timeout: 90_000, maxBuffer: 1024 * 1024,
  })
  expect(result.stdout).toMatch(/(?:pass 1|# pass 1)/u)
}, 100_000)
