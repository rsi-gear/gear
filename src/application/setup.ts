import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { GearError } from '../domain/errors.js'
import { hitchJson } from '../adapters/hitch/transport.js'
import { setupPython } from './python.js'
import { findExecutable, pinImage } from './profile-service.js'
import { assertProfileRole, profile, selectDefaultProfile } from './profile-store.js'
import { runtimeMatrix, supportedNode } from './runtime-matrix.js'

export interface SetupOptions {
  python?: string
  hitch?: boolean
  adapter?: 'dsh' | 'pi'
  hitchExecutable?: string
  hitchRoot?: string
  image?: string
  targetProfile?: string
  metaProfile?: string
}
export async function setup(options: SetupOptions = {}) {
  if (!supportedNode(process.version) || !['darwin', 'linux'].includes(process.platform))
    throw new GearError('unsupported-runtime', `Setup requires macOS/Linux and Node ${runtimeMatrix.node}`)
  if (!options.hitch && (options.image || options.hitchExecutable || options.hitchRoot || options.adapter))
    throw new GearError('invalid-setup-options', 'Hitch/image options require --hitch')
  const image = options.image ?? runtimeMatrix.baseImage
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u.test(image))
    throw new GearError('invalid-image', 'Expected an OCI image reference')
  if (options.adapter !== undefined && !['dsh', 'pi'].includes(options.adapter))
    throw new GearError('invalid-setup-options', 'Target adapter must be dsh|pi')
  if (options.targetProfile)
    assertProfileRole(await profile(options.targetProfile), 'target', options.adapter)
  if (options.metaProfile) assertProfileRole(await profile(options.metaProfile), 'meta')
  const python = await setupPython(options.python)
  let execution: unknown = { status: 'not_requested', next_action: 'gear setup --hitch' }
  if (options.hitch) {
    const executable = await findExecutable(options.hitchExecutable ?? 'hitch'),
      root = resolve(options.hitchRoot ?? join(homedir(), '.hitch'))
    const harness = runtimeMatrix.harnesses[options.adapter ?? 'dsh']
    const prepared = await hitchJson(
      executable,
      root,
      ['prepare', harness, '--json'],
      new AbortController().signal,
      300_000,
    )
    const revision = prepared.resolved_revision as { identity?: unknown } | undefined
    if (typeof revision?.identity !== 'string' || !revision.identity)
      throw new GearError('hitch-identity-missing', 'Hitch did not return the prepared runtime identity')
    const args = ['eval', 'setup', 'harbor', '--version', runtimeMatrix.harbor, '--json']
    if (options.python) args.push('--python', options.python)
    await hitchJson(executable, root, args, new AbortController().signal, 300_000)
    try {
      await promisify(execFile)('docker', ['pull', image], { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 })
    } catch {
      throw new GearError(
        'docker-image-setup-failed',
        'Docker could not prepare the requested image; check daemon and registry access',
      )
    }
    const pinned = await pinImage(image)
    const daemon = await hitchJson(
      executable,
      root,
      ['daemon', 'status', '--json'],
      new AbortController().signal,
    )
    if (daemon.status !== 'running') {
      await hitchJson(executable, root, ['daemon', 'start', '--json'], new AbortController().signal)
      const started = await hitchJson(
        executable,
        root,
        ['daemon', 'status', '--json'],
        new AbortController().signal,
      )
      if (started.status !== 'running')
        throw new GearError('hitch-daemon-unavailable', 'Hitch daemon did not start')
    }
    execution = {
      status: 'prepared',
      harness,
      harness_identity: revision.identity,
      harbor: runtimeMatrix.harbor,
      image: pinned,
      daemon: 'running',
    }
  }
  for (const role of ['target', 'meta'] as const) {
    const name = role === 'target' ? options.targetProfile : options.metaProfile
    if (name) await selectDefaultProfile(name, role)
  }
  return {
    python,
    execution,
    authentication: 'not_checked',
    benchmark: 'not_run',
    next_action: 'Create/select Target and Meta profiles, then run gear doctor',
    matrix: runtimeMatrix,
  }
}
