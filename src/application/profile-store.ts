import { mkdir, readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { GearError } from '../domain/errors.js'
import { canonicalDigest } from '../domain/canonical.js'
import type { OperationProfile } from '../adapters/process/operation-provider.js'
import type { HitchProfile } from '../adapters/hitch/provider.js'
import { hitchAgentArgs, hitchSettings } from '../adapters/hitch/settings.js'
import { isPinnedHarnessReference } from '../adapters/hitch/reference.js'
import { configuration, codexPassEnvNames, type CodexConfiguration } from '../adapters/codex/contracts.js'
import { publishFile } from '../adapters/storage/atomic.js'
import { withFileLock } from '../adapters/storage/file-lock.js'
import { packageRoot } from './python.js'

export interface CodexProfile {
  kind: 'codex'
  configuration: CodexConfiguration
  passEnv: string[]
}
export type Profile = OperationProfile | HitchProfile | CodexProfile
export type ProfileRole = 'target' | 'meta'
export const profileRoot = (): string =>
  process.env.GEAR_PROFILE_ROOT ?? join(homedir(), '.config', 'gear', 'profiles')
export function profileName(name: string): string {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/u.test(name))
    throw new GearError('invalid-profile-name', 'Use 1–100 letters, numbers, underscores or hyphens')
  return name
}
export function validateProfile(input: unknown): Profile {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new GearError('invalid-profile', 'Profile must be an object')
  const value = input as Record<string, unknown>
  const kind = value.kind
  const keys =
    kind === 'hitch'
      ? [
          'kind',
          'executable',
          'root',
          'harnessRef',
          'model',
          'baseImage',
          'passEnv',
          'agentArgs',
          'timeoutMs',
          'maxConcurrent',
          'preparationTimeoutMs',
          'setupTimeoutMs',
        ]
      : kind === 'codex'
        ? ['kind', 'configuration', 'passEnv']
        : ['command', 'workingDirectory', 'configuration', 'passEnv', 'timeoutMs']
  if (
    Object.keys(value).some((key) => !keys.includes(key)) ||
    !Array.isArray(value.passEnv) ||
    value.passEnv.some((name) => typeof name !== 'string' || !/^[A-Z_][A-Z0-9_]*$/u.test(name)) ||
    new Set(value.passEnv).size !== value.passEnv.length
  )
    throw new GearError('invalid-profile', 'Invalid profile fields or environment variable names')
  if (kind === 'codex') {
    configuration(value.configuration)
    if (value.passEnv.some((name) => !codexPassEnvNames.includes(name)))
      throw new GearError(
        'invalid-profile',
        'Codex passEnv accepts CODEX_API_KEY, OPENAI_API_KEY, HTTP_PROXY, HTTPS_PROXY and NO_PROXY; local login uses authHome',
      )
  } else {
    if (
      !Number.isSafeInteger(value.timeoutMs) ||
      (value.timeoutMs as number) < 100 ||
      (value.timeoutMs as number) > 86_400_000
    )
      throw new GearError('invalid-profile', 'timeoutMs must be between 100 and 86400000')
    if (kind === 'hitch') {
      hitchSettings(value as unknown as HitchProfile)
      hitchAgentArgs(value)
      if (
        ['executable', 'root', 'harnessRef', 'model', 'baseImage'].some(
          (key) => typeof value[key] !== 'string' || !(value[key] as string).trim(),
        ) ||
        !isAbsolute(value.root as string) ||
        !isPinnedHarnessReference(value.harnessRef as string) ||
        !/^[A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64}$/u.test(value.baseImage as string)
      )
        throw new GearError(
          'invalid-profile',
          'Hitch requires an absolute root, pinned harness revision (exact version or 40-character SHA-1 commit) and OCI image digest',
        )
    } else if (
      !Array.isArray(value.command) ||
      !value.command.length ||
      value.command.some((part) => typeof part !== 'string' || !part) ||
      typeof value.workingDirectory !== 'string' ||
      !isAbsolute(value.workingDirectory) ||
      !value.configuration ||
      typeof value.configuration !== 'object' ||
      Array.isArray(value.configuration)
    )
      throw new GearError(
        'invalid-profile',
        'Process profiles require command, absolute workingDirectory and configuration',
      )
  }
  canonicalDigest(input)
  return input as Profile
}
export async function profile(name: string): Promise<Profile> {
  profileName(name)
  let input: unknown
  try {
    input = JSON.parse(await readFile(join(profileRoot(), `${name}.json`), 'utf8'))
  } catch {
    throw new GearError('profile-unavailable', `Unable to load profile ${name}`, {
      next_action: `gear profile create ${name}`,
    })
  }
  return validateProfile(input)
}
export async function saveProfile(
  name: string,
  input: unknown,
): Promise<{ name: string; path: string; kind: string }> {
  profileName(name)
  const value = validateProfile(input),
    path = join(profileRoot(), `${name}.json`)
  await mkdir(profileRoot(), { recursive: true, mode: 0o700 })
  await withFileLock(join(profileRoot(), '.write.lock'), async () => {
    try {
      await readFile(path)
      throw new GearError('profile-exists', `Profile ${name} already exists; choose a new name`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await publishFile(path, JSON.stringify(value, null, 2) + '\n', { immutable: true })
  })
  return { name, path, kind: 'kind' in value ? value.kind : 'process' }
}
export async function listProfiles() {
  const names = (
    await readdir(profileRoot()).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return [] as string[]
    })
  )
    .filter((name) => /^[a-zA-Z0-9_-]+\.json$/u.test(name))
    .sort()
  return Promise.all(
    names.map(async (file) => {
      const name = file.slice(0, -5)
      try {
        const value = await profile(name)
        return { name, kind: 'kind' in value ? value.kind : 'process', valid: true }
      } catch {
        return { name, kind: 'unknown', valid: false }
      }
    }),
  )
}
export function assertProfileRole(value: Profile, role: ProfileRole, adapter?: 'dsh' | 'pi'): void {
  if (role !== 'target' && role !== 'meta')
    throw new GearError('invalid-profile-role', 'Profile role must be target|meta')
  if (
    ('kind' in value && value.kind === 'hitch' && role !== 'target') ||
    ('kind' in value && value.kind === 'codex' && role !== 'meta')
  )
    throw new GearError(
      'profile-role-mismatch',
      'Hitch profiles are Target profiles; Codex profiles are Meta profiles',
    )
  if (
    'kind' in value &&
    value.kind === 'hitch' &&
    adapter &&
    !value.harnessRef.startsWith(adapter === 'dsh' ? 'deepseek@' : 'pi@')
  )
    throw new GearError('profile-adapter-mismatch', `Target profile does not use the ${adapter} harness`)
}
export function processProfile(value: OperationProfile | CodexProfile): OperationProfile {
  if (!('kind' in value)) return value
  return {
    command: [process.execPath, join(packageRoot, 'assets/codex-meta-runner.mjs')],
    workingDirectory: packageRoot,
    passEnv: value.passEnv,
    configuration: { ...value.configuration },
    // submit waits for the durable receipt. Allow generation to reach its own
    // deadline and publish the outcome before the transport stops waiting.
    timeoutMs: Math.min(value.configuration.timeoutMs + 30_000, 86_400_000),
  }
}
export async function defaultProfiles(): Promise<Partial<Record<ProfileRole, string>>> {
  let input: unknown
  try {
    input = JSON.parse(await readFile(join(profileRoot(), '.selection.json'), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.entries(input).some(
      ([key, value]) => !['target', 'meta'].includes(key) || typeof value !== 'string',
    )
  )
    throw new GearError('invalid-profile-selection', 'Invalid default profile selection')
  for (const name of Object.values(input)) profileName(name as string)
  return input as Partial<Record<ProfileRole, string>>
}
export async function selectDefaultProfile(name: string, role: ProfileRole) {
  assertProfileRole(await profile(name), role)
  await withFileLock(join(profileRoot(), '.write.lock'), async () => {
    await publishFile(
      join(profileRoot(), '.selection.json'),
      JSON.stringify({ ...(await defaultProfiles()), [role]: name }) + '\n',
    )
  })
  return { name, role, scope: 'default' }
}
