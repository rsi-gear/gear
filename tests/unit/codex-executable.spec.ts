import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { resolveCodexExecutable } from '../../src/adapters/codex/executable.js'
import { describeCodex } from '../../src/adapters/codex/identity.js'
import type { CodexConfiguration } from '../../src/adapters/codex/contracts.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function installation(optionalDependency: boolean, layout: 'bin' | 'codex') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gear-codex-npm-')))
  roots.push(root)
  const packageRoot = join(root, 'node_modules/@openai/codex')
  const launcher = join(packageRoot, 'bin/codex.js')
  await mkdir(dirname(launcher), { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@openai/codex', version: '0.160.1', bin: { codex: 'bin/codex.js' },
  }))
  // This deliberately cannot serve --version. Resolution must bypass the shim.
  await writeFile(launcher, '#!/usr/bin/env node\nthrow new Error("launcher must not run")\n', { mode: 0o755 })
  const platform = `${process.platform}-${process.arch}`
  const target = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl'}`
  const vendorPackage = optionalDependency
    ? join(packageRoot, 'node_modules/@openai', `codex-${platform}`) : packageRoot
  await mkdir(vendorPackage, { recursive: true })
  if (optionalDependency) await writeFile(join(vendorPackage, 'package.json'), JSON.stringify({ name: `@openai/codex-${platform}` }))
  const native = join(vendorPackage, 'vendor', target, layout, 'codex')
  await mkdir(dirname(native), { recursive: true })
  await writeFile(native, '#!/bin/sh\nprintf "codex-cli 0.160.1\\n"\n', { mode: 0o755 })
  const link = join(root, 'codex')
  await symlink(launcher, link)
  return { root, launcher, native, link }
}

for (const optional of [true, false]) for (const layout of ['bin', 'codex'] as const) {
  it(`resolves ${optional ? 'optional' : 'bundled'} npm binaries using ${layout}/`, async () => {
    const { native, link } = await installation(optional, layout)
    expect(await resolveCodexExecutable(link)).toBe(native)
  })
}

it('binds the native binary and companion without allowing an entire npm directory', async () => {
  const { native, link } = await installation(true, 'bin')
  const config = { executable: link } as CodexConfiguration
  const before = await describeCodex(config)
  expect(before.executable).toBe(native)
  expect(before.version).toBe('codex-cli 0.160.1')
  const companion = join(dirname(native), 'codex-code-mode-host')
  await writeFile(companion, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const after = await describeCodex(config)
  expect(after.codeModeHost).toBe(companion)
  expect(after.identity).not.toBe(before.identity)
  await writeFile(native, '#!/bin/sh\n# changed native executable\nprintf "codex-cli 0.160.1\\n"\n')
  expect((await describeCodex(config)).identity).not.toBe(after.identity)
})

it('fails explicitly when a recognized npm installation is missing its native binary', async () => {
  const { native, link } = await installation(true, 'bin')
  await rm(native)
  await expect(resolveCodexExecutable(link)).rejects.toMatchObject({ code: 'codex-native-unavailable' })
})

it('preserves a directly configured executable outside an npm installation', async () => {
  const { root } = await installation(false, 'bin')
  const custom = join(root, 'custom-codex')
  await writeFile(custom, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  expect(await resolveCodexExecutable(custom)).toBe(custom)
})
