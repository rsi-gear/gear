import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { describeCodex } from '../../src/adapters/codex/identity.js'
import type { CodexConfiguration } from '../../src/adapters/codex/contracts.js'
import { HitchOperationProvider } from '../../src/adapters/hitch/provider.js'
import { configuredProvider } from '../../src/application/profiles.js'
import type { ProjectRuntimeContext } from '../../src/application/project-service.js'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})
const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const roots: string[] = []
const redirectedFiles = new Map<string, string>()
beforeEach(() => {
  vi.mocked(fs.readFile).mockImplementation((file, options) =>
    native.readFile(redirectedFiles.get(String(file)) ?? file, options),
  )
})
afterEach(async () => {
  redirectedFiles.clear()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => native.rm(root, { recursive: true, force: true })))
})

async function copiedModule(name: string) {
  const root = await native.mkdtemp(join(tmpdir(), 'gear-provider-implementation-'))
  roots.push(root)
  const source = new URL(`../../src/${name}.ts`, import.meta.url)
  const original = await native.readFile(source, 'utf8')
  const copy = join(root, 'implementation.ts')
  await native.writeFile(copy, original)
  redirectedFiles.set(source.href, copy)
  return { root, source, original, copy }
}

it.each(['experience-files', 'experience-format'])(
  'Codex identity tracks storage/%s content',
  async (name) => {
    const copied = await copiedModule(`adapters/storage/${name}`)
    const executable = join(copied.root, 'codex')
    await native.writeFile(executable, '#!/bin/sh\nprintf "codex-cli 0.160.1\\n"\n', { mode: 0o755 })
    const config = { executable } as CodexConfiguration
    const before = (await describeCodex(config)).identity
    await native.writeFile(copied.copy, `${copied.original}\n// changed implementation fixture\n`)
    expect((await describeCodex(config)).identity).not.toBe(before)
    await native.writeFile(copied.copy, copied.original)
    expect((await describeCodex(config)).identity).toBe(before)
    expect(await native.readFile(copied.source, 'utf8')).toBe(copied.original)
  },
)

it('configured Hitch identity tracks failure module content', async () => {
  const copied = await copiedModule('adapters/hitch/failure')
  vi.stubEnv('GEAR_PROFILE_ROOT', copied.root)
  await native.writeFile(
    join(copied.root, 'target.json'),
    JSON.stringify({
      kind: 'hitch',
      executable: process.execPath,
      root: copied.root,
      harnessRef: 'deepseek@version:0.1.1-rc.2',
      model: 'fixture',
      baseImage: `python@sha256:${'1'.repeat(64)}`,
      passEnv: [],
      timeoutMs: 3000,
    }),
  )
  // Stop at the connection boundary after configuredProvider computes the real fingerprint.
  const stopped = new Error('connection boundary')
  const connect = vi.spyOn(HitchOperationProvider, 'connect').mockRejectedValue(stopped)
  const context = {
    kind: 'evaluate',
    root: copied.root,
    stateRoot: copied.root,
    runId: 'fixture',
    config: { target: { adapter: 'dsh', profile: 'target' } },
    benchmark: { tasks: [{ id: 'one' }] },
  } as ProjectRuntimeContext
  const identity = async () => {
    await expect(configuredProvider(context)).rejects.toBe(stopped)
    return connect.mock.calls.at(-1)![1].implementationIdentity
  }
  const before = await identity()
  expect(before).toMatch(/^sha256:[a-f0-9]{64}$/u)
  await native.writeFile(copied.copy, `${copied.original}\n// changed implementation fixture\n`)
  expect(await identity()).not.toBe(before)
  await native.writeFile(copied.copy, copied.original)
  expect(await identity()).toBe(before)
  expect(await native.readFile(copied.source, 'utf8')).toBe(copied.original)
})
