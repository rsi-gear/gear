import type { ComponentSpec, OperatorRef } from './algorithm-wire-v2.js'
import { canonicalDigest } from './canonical.js'
import { GearError } from './errors.js'

export function frozenComponent(tree: ComponentSpec, reference: OperatorRef): ComponentSpec {
  if (tree.entrypoint === reference.entrypoint && canonicalDigest(tree) === reference.configuration_digest)
    return tree
  for (const child of tree.kind === 'module' ? Object.values(tree.children) : []) {
    try {
      return frozenComponent(child, reference)
    } catch (error) {
      if (!(error instanceof GearError) || error.code !== 'operator-not-frozen') throw error
    }
  }
  throw new GearError('operator-not-frozen', 'Operator is outside the frozen component tree')
}
