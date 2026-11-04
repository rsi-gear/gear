import type { Operation } from './algorithm-wire.js'
import { assertMutationPath } from './mutation-policy.js'
import type { MutationPolicy } from '../ports/harness.js'
import type { TargetResource } from './target.js'
import { canonicalDigest } from './canonical.js'
import { GearError } from './errors.js'
export function editPaths(operation: Operation, policy: MutationPolicy): readonly string[] {
  const payload = operation.payload as Record<string, unknown> | null
  if (!payload || !Object.hasOwn(payload, 'gear_write_paths_v1')) return policy.writableRoots
  const paths = payload.gear_write_paths_v1
  if (!Array.isArray(paths) || !paths.length || paths.some((path) => typeof path !== 'string'))
    throw new GearError('invalid-edit-scope', 'Edit scope requires explicit writable resource paths')
  return paths.map((path) => assertMutationPath(path as string, policy))
}
export function checkEditPaths(
  operation: Operation,
  policy: MutationPolicy,
  before: TargetResource[],
  after: TargetResource[],
): void {
  const paths = editPaths(operation, policy)
  const oldFiles = new Map(before.map((item) => [item.path, item]))
  const newFiles = new Map(after.map((item) => [item.path, item]))
  for (const path of new Set([...oldFiles.keys(), ...newFiles.keys()]))
    if (canonicalDigest(oldFiles.get(path) ?? null) !== canonicalDigest(newFiles.get(path) ?? null)) {
      assertMutationPath(path, policy)
      if (!paths.some((root) => path === root || path.startsWith(root + '/')))
        throw new GearError(
          'edit-outside-scope',
          'Editor changed a resource outside this call’s declared scope',
        )
    }
}
