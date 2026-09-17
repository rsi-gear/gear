import type { ComponentRef } from '../types.js'
import { assertComponentRef } from '../evolution/component-ref.js'
import { digestJson } from '../state/digest.js'
import { invariant, seal, verifyDigest } from './contracts.js'
import { createParentRandom, type ParentRandom } from './parent-random.js'
import { validateSearchSchema } from './schema.js'
import type { ParentSelectionDecision, ResearchArchive } from './types.js'

export interface ParentOption {
  readonly candidateId: string
  readonly snapshotDigest: string
  /** GEPA reference weight; zero-weight eligible parents may be explored by other policies. */
  readonly probability: number
}
export interface ParentScopeOption {
  readonly digest: string
  readonly familyId: string
  readonly epoch: number
  readonly probability: number
  readonly parents: readonly ParentOption[]
}
/** A detached, frozen seed-only projection. No raw cells, held-out results, or writable state. */
export interface ParentSelectionInput {
  readonly archiveDigest: string
  readonly roundId: string
  readonly maxCandidates: number
  readonly randomSeed: string
  readonly scopes: readonly ParentScopeOption[]
  readonly champion?: { readonly candidateId: string; readonly snapshotDigest: string; readonly scopeDigest: string }
}
export interface ParentAllocation {
  scopeDigest: string
  parentSnapshotDigest: string
  slots: number
  drawIndex: number
  /** Existing built-in trace labels; custom reasons belong in reasonCodes. */
  selectionBranch?: 'champion' | 'gepa'
}
export interface ParentSelectionPlan {
  allocations: ParentAllocation[]
  parentProbabilities: Record<string, number>
  reasonCodes: string[]
}
export interface ParentSelectionPolicy {
  readonly ref: ComponentRef<unknown>
  /** Requests a fresh eligible champion view, including committed seed completions. */
  readonly requiresChampion: boolean
  select(input: ParentSelectionInput, random: ParentRandom): ParentSelectionPlan
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

export function parentSelectionInput(archive: ResearchArchive, roundId: string, maxCandidates: number, seed: number, championId?: string): ParentSelectionInput {
  validateSearchSchema('ResearchArchive', archive)
  verifyDigest(archive)
  invariant(Number.isSafeInteger(maxCandidates) && maxCandidates > 0, 'invalid candidate limit')
  invariant(archive.plans.every(plan => plan.partition === 'seed'), 'parent policy cannot read held-out evidence')
  const scopes = archive.scopes.map(scope => {
    const view = archive.scopeViews.find(v => v.scopeDigest === scope.digest)
    invariant(view, 'parent scope view is missing')
    const ids = new Set(view.outcomeEligibleIds)
    // The pinned champion may share a representative or be pruned by GEPA.
    if (championId && view.representatives[championId] !== undefined) ids.add(championId)
    return { digest: scope.digest, familyId: scope.familyId, epoch: scope.epoch,
      probability: archive.scopeProbabilities[scope.digest] ?? 0,
      parents: [...ids].sort().map(candidateId => {
        const snapshot = archive.snapshots.find(s => s.candidateId === candidateId)
        invariant(snapshot, 'eligible parent snapshot is missing')
        return { candidateId, snapshotDigest: snapshot.digest, probability: view.conditionalParentProbabilities[candidateId] ?? 0 }
      }) }
  })
  const championScope = archive.scopes.filter(scope => scopes.find(s => s.digest === scope.digest)!.parents.some(p => p.candidateId === championId))
    .sort((a, b) => b.taskIds.length - a.taskIds.length || b.epoch - a.epoch || a.digest.localeCompare(b.digest))[0]
  const champion = championScope && archive.snapshots.find(s => s.candidateId === championId)
  return freeze({ archiveDigest: archive.digest, roundId, maxCandidates, randomSeed: digestJson([seed, roundId, archive.digest]), scopes,
    ...(champion && championScope ? { champion: { candidateId: champion.candidateId, snapshotDigest: champion.digest, scopeDigest: championScope.digest } } : {}) })
}

/** Used by the runtime and the public conformance kit. Validation precedes all persistence. */
export function validateParentPlan(input: ParentSelectionInput, plan: ParentSelectionPlan): void {
  invariant(plan && Array.isArray(plan.allocations) && plan.allocations.length <= input.maxCandidates, 'invalid parent allocations')
  invariant(Array.isArray(plan.reasonCodes) && plan.reasonCodes.length > 0 && plan.reasonCodes.every(r => typeof r === 'string' && r.length > 0), 'parent policy must explain its decision')
  const eligible = new Set(input.scopes.flatMap(s => s.parents.map(p => p.candidateId)))
  invariant(plan.parentProbabilities && typeof plan.parentProbabilities === 'object' && !Array.isArray(plan.parentProbabilities), 'invalid parent probabilities')
  const entries = Object.entries(plan.parentProbabilities)
  invariant(entries.every(([id, p]) => eligible.has(id) && Number.isFinite(p) && p >= 0), 'probability refers to an ineligible parent')
  const total = entries.reduce((sum, [, p]) => sum + p, 0)
  invariant(plan.allocations.length ? Math.abs(total - 1) < 1e-9 : total === 0, 'parent probabilities must sum to one, or zero when abstaining')
  let allocated = 0
  for (const allocation of plan.allocations) {
    const scope = input.scopes.find(s => s.digest === allocation.scopeDigest)
    const parent = scope?.parents.find(p => p.snapshotDigest === allocation.parentSnapshotDigest)
    invariant(parent && plan.parentProbabilities[parent.candidateId]! > 0, 'policy selected an ineligible parent/scope')
    invariant(Number.isSafeInteger(allocation.slots) && allocation.slots > 0, 'parent slots must be positive integers')
    invariant(Number.isSafeInteger(allocation.drawIndex) && allocation.drawIndex >= 0, 'invalid parent draw index')
    invariant(allocation.selectionBranch === undefined || ['champion', 'gepa'].includes(allocation.selectionBranch), 'invalid parent branch')
    allocated += allocation.slots
  }
  invariant(allocated <= input.maxCandidates, 'parent policy exceeded candidate budget')
}

export function selectParentsWithPolicy(archive: ResearchArchive, policy: ParentSelectionPolicy, maxCandidates: number, roundId: string, seed: number, championId?: string): ParentSelectionDecision {
  assertComponentRef(policy.ref, 'parent-selection')
  const policyRef = structuredClone(policy.ref)
  const input = parentSelectionInput(archive, roundId, maxCandidates, seed, championId)
  invariant(!policy.requiresChampion || input.champion, 'champion has no complete eligible seed scope')
  const plan = structuredClone(policy.select(input, createParentRandom(input.randomSeed)))
  invariant(digestJson(policy.ref) === digestJson(policyRef), 'parent policy changed identity during selection')
  validateParentPlan(input, plan)
  const decision = seal({ archiveDigest: archive.digest, algorithmRef: 'sha256-counter-v1' as const, randomSeed: input.randomSeed,
    policy: { ref: policyRef, inputDigest: digestJson(input), parentProbabilities: plan.parentProbabilities, reasonCodes: plan.reasonCodes },
    batches: plan.allocations.map((a, i) => ({ batchId: `${roundId}-batch-${i}`, sourceScopeDigest: a.scopeDigest, parentSnapshotDigest: a.parentSnapshotDigest,
      maxCandidateSlots: a.slots, drawIndex: a.drawIndex, ...(a.selectionBranch ? { selectionBranch: a.selectionBranch } : {}) })) })
  validateSearchSchema('ParentSelectionDecision', decision)
  return decision
}
