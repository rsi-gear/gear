import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
it('rejects a nonleader --worker before admitting any model execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-guard-test-'))
  roots.push(root)
  const { dedicatedWorkerShutdown } = await import('../../src/adapters/codex/cleanup.js')
  // Vitest is not the leader of a detached operation group; library inspection never signals it.
  const shutdown = await dedicatedWorkerShutdown()
  expect(() => shutdown.assertOwnership()).toThrow('Worker must own a separate process group')
  await mkdir(join(root, 'kept'))
})
