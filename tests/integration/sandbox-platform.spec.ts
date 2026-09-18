import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { describe, expect, it } from 'vitest'
import {
  acquireAirGappedSandbox,
  createAirGappedSandboxConfig,
  type AirGappedSandboxLease,
} from '../../src/sandbox.js'

const supportedPlatform = process.platform === 'linux' || process.platform === 'darwin'

describe.runIf(supportedPlatform)('platform sandbox CI contract', () => {
  it('has every native sandbox dependency required by the runner', () => {
    expect(SandboxManager.checkDependencies().errors).toEqual([])
  })

  it('starts the production-compatible sandbox instead of silently skipping it', async () => {
    const mode = process.platform === 'linux' ? 'bubblewrap-only' : 'seccomp'
    const lease = await acquireAirGappedSandbox(mode, 'platform CI')
    await lease.release()
  })

  it.runIf(process.platform === 'linux')('binds an executable apply-seccomp helper and handles the host AppArmor policy', async () => {
    const config = await createAirGappedSandboxConfig({
      linuxIsolation: 'seccomp',
      allowRead: ['/usr'],
      allowWrite: [],
    })
    const applyPath = config.seccomp?.applyPath
    expect(applyPath).toMatch(/\/apply-seccomp$/u)
    expect(config.filesystem.allowRead).toContain(applyPath)
    await access(applyPath as string, constants.X_OK)

    let lease: AirGappedSandboxLease | undefined
    try {
      lease = await acquireAirGappedSandbox('seccomp', 'strict Linux CI')
    } catch (error) {
      const message = String(error)
      expect(message).toMatch(/sandbox preflight failed/iu)
      expect(message).not.toMatch(/no such file or directory|ENOENT/iu)
    } finally {
      await lease?.release()
    }
  })
})
