import type { MutationPolicy } from '../ports/harness.js'
import { canonicalDigest } from './canonical.js'

export function assertMutationPath(path: string, policy: MutationPolicy, directory = false): string {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0'))
    throw new Error(`candidate path is invalid: ${path}`)
  const parts = path.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..'))
    throw new Error(`candidate path is not normalized: ${path}`)
  if (parts.some((part) => policy.protectedNames.includes(part)))
    throw new Error(`candidate path is protected: ${path}`)
  if (
    !policy.writableRoots.some(
      (root) => path === root || path.startsWith(`${root}/`) || (directory && root.startsWith(`${path}/`)),
    )
  )
    throw new Error(`candidate path is fixed substrate: ${path}`)
  return path
}
export function mutationPolicyDigest(policy: MutationPolicy): string {
  return canonicalDigest({
    writableRoots: [...policy.writableRoots].sort(),
    protectedNames: [...policy.protectedNames].sort(),
    allowedImports: [...policy.allowedImports].sort(),
  })
}
