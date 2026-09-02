import { access, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { execFile as execFileCallback } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'

const execFile = promisify(execFileCallback)

export type LinuxSandboxIsolation = 'seccomp' | 'bubblewrap-only'

export interface AirGappedSandboxOptions {
  linuxIsolation?: LinuxSandboxIsolation | undefined
  allowRead: string[]
  allowWrite: string[]
  denyRead?: string[]
  denyWrite?: string[]
  allowGitConfig?: boolean
}

export interface AirGappedSandboxLease {
  release(): Promise<void>
}

let applySeccompPath: Promise<string> | undefined
let nextSandboxGeneration = 1
let managerNeedsReinitialize = false
let sharedTeardown: Promise<void> | undefined

interface SharedSandboxState {
  generation: number
  policyKey: string
  config: SandboxRuntimeConfig
  initializedByGear: boolean
  users: number
  initialization: Promise<void>
}

let sharedState: SharedSandboxState | undefined

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function sandboxSystemReadPaths(): string[] {
  return process.platform === 'darwin'
    ? ['/System', '/usr', '/bin', '/sbin', '/Library', '/private/etc', '/dev']
    : ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/dev']
}

function vendorArchitecture(): string {
  if (process.arch === 'x64' || process.arch === 'arm64') return process.arch
  throw new Error(`Linux seccomp isolation is unsupported on ${process.arch}; set metaSandbox.linuxIsolation to bubblewrap-only only after reviewing the reduced Unix-socket isolation`)
}

async function executable(path: string): Promise<string | undefined> {
  try {
    await access(path, constants.X_OK)
    return await realpath(path)
  } catch {
    return undefined
  }
}

/** Resolve the pinned sandbox-runtime helper without importing its private API. */
async function resolveApplySeccompPath(): Promise<string> {
  applySeccompPath ??= (async () => {
    const entry = fileURLToPath(import.meta.resolve('@anthropic-ai/sandbox-runtime'))
    const packageRoot = resolve(dirname(entry), '..')
    const arch = vendorArchitecture()
    const candidates = [
      join(packageRoot, 'vendor', 'seccomp', arch, 'apply-seccomp'),
      join(packageRoot, 'dist', 'vendor', 'seccomp', arch, 'apply-seccomp'),
    ]
    for (const candidate of candidates) {
      const resolved = await executable(candidate)
      if (resolved !== undefined) return resolved
    }
    throw new Error('Linux seccomp isolation is required, but sandbox-runtime apply-seccomp is missing or not executable')
  })()
  return applySeccompPath
}

/**
 * Build the common fail-closed sandbox policy used by notebooks, candidate
 * shells, and compiler subprocesses. On Linux, bubblewrap-only deliberately
 * relies on the network and mount namespaces instead of apply-seccomp because
 * Ubuntu AppArmor can forbid the helper's nested CAP_SYS_ADMIN user namespace.
 */
export async function createAirGappedSandboxConfig(options: AirGappedSandboxOptions): Promise<SandboxRuntimeConfig> {
  const linuxIsolation = options.linuxIsolation ?? 'seccomp'
  const bubblewrapOnly = process.platform === 'linux' && linuxIsolation === 'bubblewrap-only'
  const seccompPath = process.platform === 'linux' && !bubblewrapOnly
    ? await resolveApplySeccompPath()
    : undefined
  return {
    network: {
      allowedDomains: [],
      deniedDomains: ['*'],
      allowUnixSockets: [],
      allowAllUnixSockets: bubblewrapOnly,
      allowLocalBinding: false,
    },
    filesystem: {
      denyRead: options.denyRead ?? ['/'],
      allowRead: [...new Set([...options.allowRead, ...(seccompPath === undefined ? [] : [seccompPath])])],
      allowWrite: options.allowWrite,
      denyWrite: options.denyWrite ?? [],
      allowGitConfig: options.allowGitConfig ?? false,
    },
    ...(seccompPath === undefined ? {} : { seccomp: { applyPath: seccompPath } }),
    allowAppleEvents: false,
  }
}

function globalPolicyProjection(config: SandboxRuntimeConfig): unknown {
  return {
    network: {
      allowedDomains: config.network.allowedDomains,
      deniedDomains: config.network.deniedDomains,
      strictAllowlist: config.network.strictAllowlist ?? null,
      allowUnixSockets: config.network.allowUnixSockets ?? [],
      allowAllUnixSockets: config.network.allowAllUnixSockets === true,
      allowLocalBinding: config.network.allowLocalBinding === true,
      allowMachLookup: config.network.allowMachLookup ?? [],
      httpProxyPort: config.network.httpProxyPort ?? null,
      socksProxyPort: config.network.socksProxyPort ?? null,
      mitmProxy: config.network.mitmProxy ?? null,
      hasFilterRequest: config.network.filterRequest !== undefined,
      tlsTerminate: config.network.tlsTerminate ?? null,
      parentProxy: config.network.parentProxy ?? null,
    },
    allowGitConfig: config.filesystem.allowGitConfig === true,
    ignoreViolations: config.ignoreViolations ?? null,
    enableWeakerNestedSandbox: config.enableWeakerNestedSandbox === true,
    enableWeakerNetworkIsolation: config.enableWeakerNetworkIsolation === true,
    allowAppleEvents: config.allowAppleEvents === true,
    ripgrep: config.ripgrep ?? null,
    mandatoryDenySearchDepth: config.mandatoryDenySearchDepth ?? null,
    allowPty: config.allowPty === true,
    seccomp: {
      applyPath: config.seccomp?.applyPath ?? null,
      argv0: config.seccomp?.argv0 ?? null,
    },
    bwrapPath: config.bwrapPath ?? null,
    socatPath: config.socatPath ?? null,
  }
}

export function assertAirGappedSandboxActive(config: SandboxRuntimeConfig): void {
  const active = SandboxManager.getConfig()
  if (active === undefined
    || JSON.stringify(globalPolicyProjection(active)) !== JSON.stringify(globalPolicyProjection(config))) {
    throw new Error('sandbox requires a process-global air-gapped SandboxManager configuration matching metaSandbox.linuxIsolation')
  }
}

function sandboxPolicyKey(config: SandboxRuntimeConfig): string {
  return JSON.stringify(globalPolicyProjection(config))
}

async function waitForSharedTeardown(): Promise<void> {
  while (sharedTeardown !== undefined) await sharedTeardown
}

function startSharedInitialization(
  state: SharedSandboxState,
  linuxIsolation: LinuxSandboxIsolation | undefined,
  label: string,
): Promise<void> {
  return (async () => {
    const existing = SandboxManager.getConfig()
    if (existing === undefined || managerNeedsReinitialize) {
      state.initializedByGear = true
      await SandboxManager.initialize(state.config)
      managerNeedsReinitialize = false
    }
    assertAirGappedSandboxActive(state.config)
    await runAirGappedSandboxProbe(state.config, linuxIsolation, label)
  })().catch(async error => {
    if (sharedState === state) sharedState = undefined
    if (state.initializedByGear) {
      const teardown = SandboxManager.reset()
        .then(() => { managerNeedsReinitialize = true })
        .catch(() => { managerNeedsReinitialize = true })
      sharedTeardown = teardown
      await teardown
      if (sharedTeardown === teardown) sharedTeardown = undefined
    }
    throw error
  })
}

/** Execute a real sandboxed process and report only sanitized failure output. */
export async function runAirGappedSandboxProbe(
  config: SandboxRuntimeConfig,
  linuxIsolation: LinuxSandboxIsolation | undefined,
  label: string,
): Promise<void> {
  let wrapped = false
  try {
    assertAirGappedSandboxActive(config)
    const command = await SandboxManager.wrapWithSandboxArgv(shellQuote('/usr/bin/true'), '/bin/bash', config)
    wrapped = true
    await execFile(command.argv[0]!, command.argv.slice(1), {
      env: command.env,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    })
  } catch (error) {
    const failure = error as { code?: unknown; signal?: unknown; stderr?: unknown }
    const stderr = typeof failure.stderr === 'string' ? failure.stderr.trim().slice(-2_000) : ''
    const detail = stderr.length > 0
      ? stderr
      : `sandbox probe exited with ${String(failure.signal ?? failure.code ?? 'an unknown error')}`
    const hint = process.platform === 'linux' && linuxIsolation !== 'bubblewrap-only'
      ? '; on Ubuntu/AppArmor, use metaSandbox.linuxIsolation: bubblewrap-only after accepting namespace-only Unix-socket isolation'
      : ''
    throw new Error(`${label} sandbox preflight failed${hint}: ${detail}`)
  } finally {
    if (wrapped) SandboxManager.cleanupAfterCommand()
  }
}

/** Hold the process-global sandbox policy for an entire plugin/runtime lifetime. */
export async function acquireAirGappedSandbox(
  linuxIsolation: LinuxSandboxIsolation | undefined,
  label: string,
): Promise<AirGappedSandboxLease> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error(`${label} sandbox is required but unsupported on ${process.platform}`)
  }
  await waitForSharedTeardown()
  const config = await createAirGappedSandboxConfig({ linuxIsolation, allowRead: sandboxSystemReadPaths(), allowWrite: [] })
  const policyKey = sandboxPolicyKey(config)
  let state = sharedState
  if (state === undefined) {
    state = {
      generation: nextSandboxGeneration++,
      policyKey,
      config,
      initializedByGear: false,
      users: 0,
      initialization: Promise.resolve(),
    }
    sharedState = state
    state.initialization = startSharedInitialization(state, linuxIsolation, label)
  } else if (state.policyKey !== policyKey) {
    throw new Error('sandbox process-global policy is already leased with a different metaSandbox.linuxIsolation')
  }
  await state.initialization
  if (sharedState !== state) throw new Error(`sandbox generation ${state.generation} was released during acquisition`)
  assertAirGappedSandboxActive(config)
  state.users += 1
  let released = false
  return {
    async release() {
      if (released) return
      released = true
      if (state.users > 0) state.users -= 1
      if (state.users !== 0 || sharedState !== state) return
      sharedState = undefined
      if (state.initializedByGear) {
        const teardown = SandboxManager.reset()
          .then(() => { managerNeedsReinitialize = true })
          .catch(error => { managerNeedsReinitialize = true; throw error })
        sharedTeardown = teardown
        try {
          await teardown
        } finally {
          if (sharedTeardown === teardown) sharedTeardown = undefined
        }
      }
    },
  }
}
