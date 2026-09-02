import { describe, expect, it } from 'vitest'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  acquireAirGappedSandbox, assertAirGappedSandboxActive, createAirGappedSandboxConfig,
} from '../../src/sandbox.js'
import { SubprocessHarnessCompiler } from '../../src/harness/compiler.js'

describe('air-gapped sandbox policy', () => {
  it('makes the Linux bubblewrap compatibility downgrade explicit and narrow', async () => {
    const config = await createAirGappedSandboxConfig({
      linuxIsolation: 'bubblewrap-only',
      allowRead: ['/usr'],
      allowWrite: ['/tmp/gear-scratch'],
    })
    expect(config.network.allowedDomains).toEqual([])
    expect(config.network.deniedDomains).toEqual(['*'])
    expect(config.network.allowLocalBinding).toBe(false)
    expect(config.network.allowAllUnixSockets).toBe(process.platform === 'linux')
    expect(config.filesystem.denyRead).toEqual(['/'])
    expect(config.filesystem.allowWrite).toEqual(['/tmp/gear-scratch'])
    expect(config.seccomp).toBeUndefined()
  })

  it('binds the exact apply-seccomp helper into a strict Linux filesystem namespace', async () => {
    const config = await createAirGappedSandboxConfig({
      linuxIsolation: 'seccomp',
      allowRead: ['/usr'],
      allowWrite: [],
    })
    if (process.platform === 'linux') {
      expect(config.seccomp?.applyPath).toMatch(/\/apply-seccomp$/u)
      expect(config.filesystem.allowRead).toContain(config.seccomp?.applyPath)
    } else {
      expect(config.seccomp).toBeUndefined()
    }
  })

  const sandboxDependencies = process.platform === 'darwin' || process.platform === 'linux'
    ? SandboxManager.checkDependencies().errors
    : ['unsupported platform']
  const canListenLoopback = spawnSync(process.execPath, ['-e', "const n=require('node:net').createServer();n.listen(0,'127.0.0.1',()=>n.close(()=>process.exit(0)));n.on('error',()=>process.exit(1))"]).status === 0
  const cannotRunSandbox = sandboxDependencies.length > 0 || !canListenLoopback
  it.skipIf(cannotRunSandbox)('reinitializes the process-global manager instead of reusing a reset policy', async () => {
    const firstMode = process.platform === 'linux' ? 'bubblewrap-only' : 'seccomp'
    const first = await acquireAirGappedSandbox(firstMode, 'first lifecycle probe')
    await first.release()

    if (process.platform === 'linux') {
      const second = await acquireAirGappedSandbox('seccomp', 'second lifecycle probe').catch(() => undefined)
      await second?.release()
      const active = SandboxManager.getConfig()
      expect(active?.network.allowAllUnixSockets).not.toBe(true)
      expect(active?.seccomp?.applyPath).toMatch(/\/apply-seccomp$/u)
    } else {
      const second = await acquireAirGappedSandbox('seccomp', 'second lifecycle probe')
      await second.release()
    }
  })

  it.skipIf(cannotRunSandbox)('shares one generation for concurrent matching leases and serializes teardown with reacquire', async () => {
    const mode = process.platform === 'linux' ? 'bubblewrap-only' : 'seccomp'
    const [first, second] = await Promise.all([
      acquireAirGappedSandbox(mode, 'concurrent probe'),
      acquireAirGappedSandbox(mode, 'concurrent probe'),
    ])
    await first.release()
    const finalRelease = second.release()
    const reacquire = acquireAirGappedSandbox(mode, 'reacquire probe')
    await finalRelease
    const third = await reacquire
    await third.release()
  })

  it.skipIf(cannotRunSandbox || process.platform !== 'linux')('rejects a conflicting policy without resetting the active lease', async () => {
    const activeLease = await acquireAirGappedSandbox('bubblewrap-only', 'active compatibility probe')
    await expect(acquireAirGappedSandbox('seccomp', 'conflicting strict probe'))
      .rejects.toThrow(/already leased with a different/iu)
    expect(SandboxManager.getConfig()?.network.allowAllUnixSockets).toBe(true)
    await activeLease.release()
  })

  it.skipIf(cannotRunSandbox)('runs a required compiler command under the leased compatibility policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-sandbox-compiler-'))
    await mkdir(join(root, 'harness'))
    const mode = process.platform === 'linux' ? 'bubblewrap-only' : 'seccomp'
    const lease = await acquireAirGappedSandbox(mode, 'compiler integration probe')
    try {
      const compiler = new SubprocessHarnessCompiler({
        command: '/usr/bin/true',
        sandboxMode: 'required',
        linuxIsolation: mode,
        targetRoot: 'harness',
      })
      await compiler.compile(root, new AbortController().signal)
    } finally {
      await lease.release()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(cannotRunSandbox)('fails closed when another component mutates the process-global policy', async () => {
    const mode = process.platform === 'linux' ? 'bubblewrap-only' : 'seccomp'
    const lease = await acquireAirGappedSandbox(mode, 'policy drift probe')
    const original = SandboxManager.getConfig()
    if (original === undefined) throw new Error('sandbox manager has no active config')
    const expected = await createAirGappedSandboxConfig({
      linuxIsolation: mode,
      allowRead: ['/usr'],
      allowWrite: [],
    })
    try {
      SandboxManager.updateConfig({
        ...original,
        network: { ...original.network, allowAllUnixSockets: original.network.allowAllUnixSockets !== true },
      })
      expect(() => assertAirGappedSandboxActive(expected)).toThrow(/process-global air-gapped/iu)
    } finally {
      SandboxManager.updateConfig(original)
      await lease.release()
    }
  })
})
