import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { cleanupCodex, ownCodexRoot, type CodexResources } from '../../src/adapters/codex/cleanup.js'
import { prepareSandbox } from '../../src/adapters/codex/sandbox.js'
import * as experiences from '../../src/adapters/codex/experience.js'
import { trajectoryGateway } from '../../src/adapters/codex/trajectory-gateway.js'
import type { CodexJob } from '../../src/adapters/codex/contracts.js'
import { PiHarnessAdapter } from '../../src/adapters/pi/harness.js'
import type { ExperienceSnapshot } from '../../src/domain/experience.js'
import type { ArtifactReaderDescriptor } from '../../src/domain/trajectory.js'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function root(prefix = 'gear-meta-') {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  roots.push(path)
  return path
}
it('continues after a stuck disposer and reset, safely removes credentials, and records fallback separately', async () => {
  const directory = await root('gear-cleanup-test-'),
    path = await root(),
    outside = await root('gear-cleanup-outside-')
  await mkdir(join(path, 'home'))
  await writeFile(join(outside, 'auth.json'), 'EXTERNAL_CANARY')
  await symlink(outside, join(path, 'home/.codex'), 'dir')
  vi.spyOn(SandboxManager, 'reset').mockImplementation(() => new Promise(() => {}))
  const before = Date.now()
  await cleanupCodex(directory, 'frozen-digest', {
    root: await ownCodexRoot(path),
    dispose: () => new Promise(() => {}),
  })
  expect(Date.now() - before).toBeLessThan(4000)
  expect(await readFile(join(outside, 'auth.json'), 'utf8')).toBe('EXTERNAL_CANARY')
  await expect(readFile(join(path, 'home/.codex/auth.json'))).rejects.toThrow()
  expect(JSON.parse(await readFile(join(directory, 'cleanup.json'), 'utf8'))).toMatchObject({
    input_digest: 'frozen-digest',
    status: 'fallback-required',
    model_stopped: true,
    stages: { gateway: 'timed-out', credentials: 'complete', sandbox: 'timed-out', root: 'complete' },
  })
  await expect(readFile(join(directory, 'receipt.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('does not follow a replaced root or delete files while the model state is unknown', async () => {
  const directory = await root('gear-cleanup-test-'),
    path = await root(),
    outside = await root('gear-cleanup-outside-')
  const owned = await ownCodexRoot(path)
  await writeFile(join(outside, 'canary'), 'KEEP')
  await rm(path, { recursive: true })
  await symlink(outside, path, 'dir')
  vi.spyOn(SandboxManager, 'reset').mockResolvedValue()
  await cleanupCodex(directory, 'digest', { root: owned })
  expect(await readFile(join(outside, 'canary'), 'utf8')).toBe('KEEP')
  expect(JSON.parse(await readFile(join(directory, 'cleanup.json'), 'utf8')).stages.root).toBe('failed')
  const pending = await root(),
    other = await root('gear-cleanup-test-')
  await mkdir(join(pending, 'home'))
  await writeFile(join(pending, 'home/auth.json'), 'PRIVATE')
  await cleanupCodex(other, 'digest', { root: await ownCodexRoot(pending) }, false)
  expect(await readFile(join(pending, 'home/auth.json'), 'utf8')).toBe('PRIVATE')
  expect(JSON.parse(await readFile(join(other, 'cleanup.json'), 'utf8'))).toMatchObject({
    model_stopped: false,
    stages: { credentials: 'unconfirmed', root: 'unconfirmed' },
  })
})
it('registers and releases a partial gateway and root when preparation fails', async () => {
  const directory = await root('gear-cleanup-test-'),
    targets = join(directory, 'targets')
  await new PiHarnessAdapter().prepare(join(targets, 'anchor'))
  const resources: CodexResources = {}
  let registered = false,
    disposed = false
  vi.spyOn(experiences, 'stageExperience').mockImplementation(async (_job, path, register) => {
    await mkdir(join(path, 'experience/gateway.json'), { recursive: true })
    return trajectoryGateway(
      path,
      directory,
      {} as ExperienceSnapshot,
      {} as ArtifactReaderDescriptor,
      process.env.GEAR_PYTHON || 'python3',
      (dispose) => {
        registered = true
        register?.(async () => {
          await dispose()
          disposed = true
        })
      },
    ) as never
  })
  const job = {
    input: {
      configuration: {},
      context: { targets, targetAdapter: 'pi' },
      request: { operation: { kind: 'generate_candidate', parent_id: 'anchor', task_ids: ['seed'] } },
    },
  } as unknown as CodexJob
  await expect(
    prepareSandbox(job, { executable: '/usr/bin/true', identity: 'test', version: 'test' }, resources),
  ).rejects.toThrow()
  expect(registered).toBe(true)
  expect(resources.root).toBeDefined()
  vi.spyOn(SandboxManager, 'reset').mockResolvedValue()
  await cleanupCodex(directory, 'digest', resources)
  expect(disposed).toBe(true)
  await expect(readFile(join(resources.root!.path, 'experience/gateway.json'))).rejects.toThrow()
})
