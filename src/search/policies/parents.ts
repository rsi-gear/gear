import { readFileSync } from 'node:fs'
import type { ComponentRef } from '../../types.js'
import { componentRef } from '../../evolution/component-ref.js'
import { implementationFromFiles } from '../../evolution/implementation-files.js'
import type { ParentSelectionInput, ParentSelectionPolicy } from '../parent-selection.js'
import type { SearchConfig } from '../types.js'

const manifest = new URL('../../../package.json', import.meta.url)
const metadata = JSON.parse(readFileSync(manifest, 'utf8')) as { name: string; version: string }
const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
export const parentPolicyImplementation = implementationFromFiles(metadata.name, metadata.version,
  [new URL(import.meta.url), new URL(`../parent-random${extension}`, import.meta.url), manifest])

export function resolveParentPolicyRef(config: SearchConfig): ComponentRef<unknown> {
  return config.parentPolicy ?? componentRef('parent-selection', config.parentSampling, parentPolicyImplementation,
    config.parentSampling === 'epsilon-greedy-gepa-v1' ? { championProbability: config.championProbability ?? 0.5 } : { batchCount: config.parentBatchCount })
}

function objectConfig(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('parent policy config must be an object')
  return value as Record<string, unknown>
}
function probabilities(input: ParentSelectionInput): Record<string, number> {
  const result: Record<string, number> = {}
  for (const scope of input.scopes) for (const parent of scope.parents) {
    const p = scope.probability * parent.probability
    if (p > 0) result[parent.candidateId] = (result[parent.candidateId] ?? 0) + p
  }
  return result
}

export function scopedFrontierPolicy(ref: ComponentRef<unknown>): ParentSelectionPolicy {
  const config = objectConfig(ref.config), batchCount = config.batchCount
  if (Object.keys(config).some(k => k !== 'batchCount') || typeof batchCount !== 'number' || !Number.isSafeInteger(batchCount) || batchCount < 1) throw new TypeError('scoped frontier requires a positive batchCount')
  return { ref, requiresChampion: false, select(input, random) {
    if (batchCount > input.maxCandidates) throw new Error('parent batches exceed candidate limit')
    return { reasonCodes: ['scoped-frontier-membership'], parentProbabilities: probabilities(input),
      allocations: Array.from({ length: batchCount }, (_, i) => {
        const scopeId = random.weighted(Object.fromEntries(input.scopes.map(s => [s.digest, s.probability])), i * 2)
        const scope = input.scopes.find(s => s.digest === scopeId)!
        const id = random.weighted(Object.fromEntries(scope.parents.map(p => [p.candidateId, p.probability])), i * 2 + 1)
        return { scopeDigest: scope.digest, parentSnapshotDigest: scope.parents.find(p => p.candidateId === id)!.snapshotDigest,
          slots: Math.floor(input.maxCandidates / batchCount) + (i < input.maxCandidates % batchCount ? 1 : 0), drawIndex: i * 2 }
      }) }
  } }
}

export function championGepaPolicy(ref: ComponentRef<unknown>): ParentSelectionPolicy {
  const config = objectConfig(ref.config), championProbability = config.championProbability
  if (Object.keys(config).some(k => k !== 'championProbability') || typeof championProbability !== 'number' || !Number.isFinite(championProbability) || championProbability < 0 || championProbability > 1) throw new TypeError('championProbability must be between zero and one')
  return { ref, requiresChampion: true, select(input, random) {
    if (!input.champion) throw new Error('champion has no complete eligible seed scope')
    const champion = input.champion, exploration = probabilities(input)
    const weights = Object.fromEntries(Object.entries(exploration).map(([id, p]) => [id, p * (1 - championProbability)]))
    weights[champion.candidateId] = (weights[champion.candidateId] ?? 0) + championProbability
    if (!Object.keys(exploration).length) weights[champion.candidateId] = 1
    return { reasonCodes: ['champion-gepa-mixture'], parentProbabilities: Object.fromEntries(Object.entries(weights).filter(([, p]) => p > 0)),
      allocations: Array.from({ length: input.maxCandidates }, (_, i) => {
        const branch = random.weighted({ champion: championProbability, gepa: 1 - championProbability }, i * 3)
        if (branch === 'champion' || !Object.keys(exploration).length) return { scopeDigest: champion.scopeDigest, parentSnapshotDigest: champion.snapshotDigest, slots: 1, drawIndex: i * 3, selectionBranch: 'champion' as const }
        const scopeId = random.weighted(Object.fromEntries(input.scopes.map(s => [s.digest, s.probability])), i * 3 + 1)
        const scope = input.scopes.find(s => s.digest === scopeId)!
        const id = random.weighted(Object.fromEntries(scope.parents.map(p => [p.candidateId, p.probability])), i * 3 + 2)
        return { scopeDigest: scope.digest, parentSnapshotDigest: scope.parents.find(p => p.candidateId === id)!.snapshotDigest, slots: 1, drawIndex: i * 3, selectionBranch: 'gepa' as const }
      }) }
  } }
}
