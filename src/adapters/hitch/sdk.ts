import { findExecutable } from '../process/executable.js'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import {
  assertProviderEnvironmentAvailable,
  controllerObservation,
  providerDiagnostics,
} from './environment.js'
import type { HitchProfile } from './provider.js'
import type { observeEvaluationEnvironment } from './observation.js'

export type HitchEnvironment = Awaited<ReturnType<typeof observeEvaluationEnvironment>>
type Namespace = 'controller' | 'backends' | 'evals' | 'revisions'
type Modules = Record<Namespace, Record<string, unknown>>
const loaded = new Map<string, { runtime: string; modules: Promise<Modules> }>()
export function sdkObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new GearError('hitch-sdk-contract', 'Hitch SDK returned an unsupported preparation contract')
  return value as Record<string, unknown>
}
export async function openHitchSdk(profile: HitchProfile, expected: HitchEnvironment) {
  let root = dirname(await findExecutable(profile.executable)),
    metadata: Record<string, unknown>
  for (;;) {
    const value: unknown = await readFile(join(root, 'package.json'), 'utf8').then(JSON.parse, () => null)
    if (value && typeof value === 'object' && 'name' in value && value.name === 'agent-hitch') {
      metadata = sdkObject(value)
      break
    }
    if (dirname(root) === root)
      throw new GearError(
        'hitch-sdk-unavailable',
        'Select a Hitch executable from an installed agent-hitch package with public preparation APIs',
      )
    root = dirname(root)
  }
  const exports = sdkObject(metadata.exports)
  let cached = loaded.get(root)
  if (cached && cached.runtime !== expected.controller.runtime_id)
    throw new GearError(
      'hitch-sdk-runtime-changed',
      'Hitch changed after its SDK was loaded; restart this Gear process',
    )
  if (!cached) {
    const names = {
      controller: './controller-runtime',
      backends: './backends',
      evals: './evals',
      revisions: './revisions',
    } as const
    const modules = Promise.all(
      Object.entries(names).map(async ([name, key]) => {
        const entry = exports[key]
        if (typeof entry !== 'string' || !resolve(root, entry).startsWith(root + sep))
          throw new GearError('hitch-sdk-unavailable', 'Hitch is missing a public preparation API')
        return [name, await import(pathToFileURL(resolve(root, entry)).href)]
      }),
    ).then((entries) => Object.fromEntries(entries) as Modules)
    cached = { runtime: expected.controller.runtime_id, modules }
    loaded.set(root, cached)
  }
  const modules = await cached.modules
  const value = (namespace: Namespace, key: string): unknown => modules[namespace][key]
  const call = async (namespace: Namespace, key: string, ...args: unknown[]): Promise<unknown> => {
    const fn = value(namespace, key)
    if (typeof fn !== 'function')
      throw new GearError('hitch-sdk-unavailable', 'Hitch is missing a public preparation API')
    return fn(...args)
  }
  const check = async (signal: AbortSignal) => {
    signal.throwIfAborted()
    const controller = controllerObservation(await call('controller', 'observeControllerRuntime', root))
    // SDK may run under another supported Node executable. The prepared trial Node is separately pinned.
    const payload = ({ node_version: _node, ...identity }: typeof controller) => identity
    if (canonicalDigest(payload(controller)) !== canonicalDigest(payload(expected.controller)))
      throw new GearError(
        'hitch-sdk-runtime-mismatch',
        'Preparation SDK does not match the observed Hitch controller payload',
      )
    let diagnostics: ReturnType<typeof providerDiagnostics> | undefined
    let invalidDiagnostics = false
    const environment = await call('backends', 'observeHarborEnvironment', {
      root: profile.root,
      env: process.env,
      signal,
      onDiagnostic: (probe: unknown) => {
        if (invalidDiagnostics) return
        try {
          diagnostics = providerDiagnostics({
            schema_version: '1',
            probes: [...(diagnostics?.probes ?? []), probe],
          })
        } catch {
          invalidDiagnostics = true
          diagnostics = undefined
        }
      },
    })
    signal.throwIfAborted()
    if (invalidDiagnostics)
      throw new GearError('invalid-provider-environment', 'Hitch returned invalid provider probe diagnostics')
    assertProviderEnvironmentAvailable(environment, diagnostics)
    if (canonicalDigest(environment) !== canonicalDigest(expected.environment))
      throw new GearError(
        'hitch-sdk-environment-mismatch',
        'Preparation SDK and Hitch daemon do not observe the same Harbor and Docker environment',
      )
    signal.throwIfAborted()
  }
  return { root, value, call, check }
}
