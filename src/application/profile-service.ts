import { findExecutable } from '../adapters/process/executable.js'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { load, dump } from 'js-yaml'
import { GearError } from '../domain/errors.js'
import { publishFile } from '../adapters/storage/atomic.js'
import { withFileLock } from '../adapters/storage/file-lock.js'
import { resolveProject } from './project-config.js'
import { assertProfileRole, profile, saveProfile, type ProfileRole } from './profile-store.js'
import { runtimeMatrix } from './runtime-matrix.js'
import {
  defaultHitchConcurrency,
  defaultPreparationTimeoutMs,
  defaultSetupTimeoutMs,
} from '../adapters/hitch/settings.js'

export { findExecutable } from '../adapters/process/executable.js'
export async function pinImage(image: string): Promise<string> {
  if (/^[A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64}$/u.test(image)) return image
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(image))
    throw new GearError('invalid-image', 'Expected an OCI image name or digest')
  try {
    const { stdout } = await promisify(execFile)(
      'docker',
      ['image', 'inspect', image, '--format', '{{json .RepoDigests}}'],
      { timeout: 15_000, maxBuffer: 64 * 1024 },
    )
    const digests: unknown = JSON.parse(stdout)
    if (Array.isArray(digests)) {
      const digest = digests.find(
        (value) => typeof value === 'string' && /^[A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64}$/u.test(value),
      )
      if (digest) return digest as string
    }
  } catch {
    /* Give an actionable error without exposing Docker diagnostics. */
  }
  throw new GearError('image-unavailable', 'The image has no local registry digest', {
    next_action: `gear setup --hitch --image ${image}`,
  })
}
export interface CreateProfileOptions {
  kind: 'hitch' | 'codex'
  model: string
  executable?: string
  adapter?: 'dsh' | 'pi'
  root?: string
  harnessRef?: string
  baseImage?: string
  passEnv?: string[]
  agentArgs?: string[]
  timeoutMs?: number
  maxConcurrent?: number
  preparationTimeoutMs?: number
  setupTimeoutMs?: number
  authHome?: string
  allowedDomains?: string[]
}
export async function createProfile(name: string, options: CreateProfileOptions) {
  if (
    !options ||
    !['hitch', 'codex'].includes(options.kind) ||
    typeof options.model !== 'string' ||
    !options.model.trim()
  )
    throw new GearError('invalid-profile-options', 'Choose kind hitch|codex and a model')
  const common = ['kind', 'model', 'executable', 'passEnv', 'timeoutMs']
  const keys =
    options.kind === 'hitch'
      ? [
          ...common,
          'adapter',
          'root',
          'harnessRef',
          'baseImage',
          'agentArgs',
          'maxConcurrent',
          'preparationTimeoutMs',
          'setupTimeoutMs',
        ]
      : [...common, 'authHome', 'allowedDomains']
  if (Object.keys(options).some((key) => !keys.includes(key)))
    throw new GearError('invalid-profile-options', 'Unknown options for this profile kind')
  if (options.kind === 'hitch') {
    if (!options.adapter || !['dsh', 'pi'].includes(options.adapter))
      throw new GearError('invalid-profile-options', 'Hitch requires adapter dsh|pi')
    const value = {
      kind: 'hitch',
      executable: await findExecutable(options.executable ?? 'hitch'),
      root: resolve(options.root ?? join(homedir(), '.hitch')),
      harnessRef: options.harnessRef ?? runtimeMatrix.harnesses[options.adapter],
      model: options.model,
      baseImage: await pinImage(options.baseImage ?? runtimeMatrix.baseImage),
      passEnv: options.passEnv ?? [],
      ...(options.agentArgs === undefined ? {} : { agentArgs: options.agentArgs }),
      timeoutMs: options.timeoutMs ?? 1_800_000,
      maxConcurrent: options.maxConcurrent ?? defaultHitchConcurrency,
      preparationTimeoutMs: options.preparationTimeoutMs ?? defaultPreparationTimeoutMs,
      setupTimeoutMs: options.setupTimeoutMs ?? defaultSetupTimeoutMs,
    } as const
    assertProfileRole(value, 'target', options.adapter)
    return saveProfile(name, value)
  }
  return saveProfile(name, {
    kind: 'codex',
    passEnv: options.passEnv ?? (options.authHome ? [] : ['CODEX_API_KEY']),
    configuration: {
      executable: await findExecutable(options.executable ?? 'codex'),
      model: options.model,
      allowedDomains: options.allowedDomains ?? ['api.openai.com', 'chatgpt.com', 'auth.openai.com'],
      timeoutMs: options.timeoutMs ?? 600_000,
      ...(options.authHome === undefined ? {} : { authHome: resolve(options.authHome) }),
    },
  })
}
export async function selectProjectProfile(root: string, name: string, role: ProfileRole) {
  const selected = await profile(name),
    path = join(root, 'gear.yaml')
  await withFileLock(join(root, '.gear', 'config.lock'), async () => {
    const before = await readFile(path, 'utf8')
    const { config } = await resolveProject(root)
    assertProfileRole(selected, role, config.target.adapter)
    const raw = load(before) as Record<string, Record<string, unknown>>
    raw[role] = { ...raw[role], profile: name }
    await publishFile(path, dump(raw, { flowLevel: 1, lineWidth: 100 }), {
      beforePublish: async () => {
        if ((await readFile(path, 'utf8')) !== before)
          throw new GearError('config-changed', 'gear.yaml changed while selecting a profile; retry')
      },
    })
  })
  return { name, role, scope: 'project', project: resolve(root) }
}
