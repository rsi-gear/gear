import type { JsonValue } from '@deepseek-ai/dsh-session'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { digestJson } from '../state/digest.js'
import type { ComponentKind, ComponentRef } from '../types.js'

const PACKAGE_NAME = 'dsh-plugin-refine'
const PACKAGE_MANIFEST_BYTES = readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)))
const PACKAGE_VERSION = (JSON.parse(PACKAGE_MANIFEST_BYTES.toString('utf8')) as { version: string }).version

export type ComponentImplementation = ComponentRef<unknown>['implementation']

export function builtinImplementation(kind: ComponentKind, id: string): ComponentImplementation {
  const moduleBytes = readFileSync(fileURLToPath(new URL('./components' + (import.meta.url.endsWith('.ts') ? '.ts' : '.js'), import.meta.url)))
  return {
    package: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    integrity: `sha256:${createHash('sha256')
      .update(moduleBytes)
      .update('\0')
      .update(PACKAGE_MANIFEST_BYTES)
      .update('\0')
      .update(JSON.stringify({ package: PACKAGE_NAME, version: PACKAGE_VERSION, kind, id, apiVersion: 1 }))
      .digest('hex')}`,
  }
}

export function componentRef<C>(
  kind: ComponentKind,
  id: string,
  implementation: ComponentImplementation,
  config: C,
): ComponentRef<C> {
  const configDigest = digestJson(config)
  return {
    kind,
    id,
    apiVersion: 1,
    implementation,
    config,
    configDigest,
  }
}

export function builtinComponentRef<C>(kind: ComponentKind, id: string, config: C): ComponentRef<C> {
  return componentRef(kind, id, builtinImplementation(kind, id), config)
}

/**
 * Builds the stable identity used to decide whether rollout evidence is semantically reusable.
 * Callers must pass only settings that can change the evaluated result. Operational placement,
 * credentials, concurrency, and logging/output limits belong in the provider config, not here.
 */
export function rolloutProviderSemanticDigest(
  provider: ComponentRef<unknown>,
  semanticConfig: JsonValue,
  agentConfig: JsonValue,
): string {
  return digestJson({
    provider: {
      kind: provider.kind,
      id: provider.id,
      apiVersion: provider.apiVersion,
      implementation: provider.implementation,
    },
    semanticConfig,
    agentConfig,
  })
}

export function assertComponentRef(value: ComponentRef<unknown>, expectedKind?: ComponentKind): void {
  if (expectedKind !== undefined && value.kind !== expectedKind) {
    throw new TypeError(`component ${value.id} has kind ${value.kind}; expected ${expectedKind}`)
  }
  if (value.apiVersion !== 1 || value.id.length === 0 || value.implementation.package.length === 0
    || value.implementation.version.length === 0 || value.implementation.integrity.length === 0) {
    throw new TypeError('component identity is invalid')
  }
  if (digestJson(value.config) !== value.configDigest) {
    throw new TypeError(`component config digest mismatch: ${value.id}`)
  }
}

/** Hash the package's shipped implementation files, including its manifest and local dependencies. */
export function implementationFromFiles(packageName: string, version: string, files: readonly URL[]): ComponentImplementation {
  if (!packageName || !version || !files.length) throw new TypeError('implementation requires a package, version and files')
  const hash = createHash('sha256')
  for (const file of files) {
    const bytes = readFileSync(file)
    hash.update(String(bytes.length)).update('\0').update(bytes).update('\0')
  }
  return { package: packageName, version, integrity: `sha256:${hash.digest('hex')}` }
}
