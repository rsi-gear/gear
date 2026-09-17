import { componentRef, implementationFromFiles } from 'rsi-gear/search/api'

// Include every local implementation dependency when this example grows into a package.
export const implementation = implementationFromFiles('gear-example-parent-policy', '1.0.0', [new URL(import.meta.url)])
export const ref = componentRef('parent-selection', 'example-uniform-parent', implementation, {})

/** @param {import('rsi-gear/search/api').ComponentRef<unknown>} component */
export function uniformParentPolicy(component) {
  if (!component.config || typeof component.config !== 'object' || Array.isArray(component.config) || Object.keys(component.config).length) {
    throw new TypeError('uniform parent policy accepts an empty config')
  }
  /** @type {import('rsi-gear/search/api').ParentSelectionPolicy} */
  const policy = {
    ref: component,
    requiresChampion: false,
    select(input, random) {
      const scopes = input.scopes.filter(scope => scope.probability > 0 && scope.parents.length)
      if (!scopes.length) return { allocations: [], parentProbabilities: {}, reasonCodes: ['no-eligible-parent'] }
      const scopeWeights = Object.fromEntries(scopes.map(scope => [scope.digest, 1 / scopes.length]))
      /** @type {Record<string, number>} */
      const parentProbabilities = {}
      for (const scope of scopes) for (const parent of scope.parents) {
        parentProbabilities[parent.candidateId] = (parentProbabilities[parent.candidateId] ?? 0) + 1 / scopes.length / scope.parents.length
      }
      return {
        parentProbabilities,
        reasonCodes: ['uniform-active-scope', 'uniform-eligible-parent'],
        allocations: Array.from({ length: input.maxCandidates }, (_, index) => {
          const scopeId = random.weighted(scopeWeights, index * 2)
          const scope = scopes.find(scope => scope.digest === scopeId)
          if (!scope) throw new Error('selected scope is missing')
          const weights = Object.fromEntries(scope.parents.map(parent => [parent.candidateId, 1 / scope.parents.length]))
          const parentId = random.weighted(weights, index * 2 + 1)
          const parent = scope.parents.find(parent => parent.candidateId === parentId)
          if (!parent) throw new Error('selected parent is missing')
          return { scopeDigest: scope.digest, parentSnapshotDigest: parent.snapshotDigest, slots: 1, drawIndex: index * 2 }
        }),
      }
    },
  }
  return policy
}
