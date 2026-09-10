import type { ComponentKind, ComponentRef } from '../types.js'
import { digestJson } from '../state/digest.js'

export type ComponentImplementation = ComponentRef<unknown>['implementation']

export function componentRef<C>(
  kind: ComponentKind,
  id: string,
  implementation: ComponentImplementation,
  config: C,
): ComponentRef<C> {
  const configDigest = digestJson(config)
  return { kind, id, apiVersion: 1, implementation, config, configDigest }
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
