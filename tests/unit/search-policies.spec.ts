import { describe, expect, it } from 'vitest'
import { ComponentRegistry, componentRef, parentSelectionInput, selectParentsWithPolicy, type ParentSelectionPolicy, type ParentSelectionPlan } from '../../src/search/api.js'
import { FailureClusterSearch } from '../../src/search/presets/failure-cluster-gepa.js'
import { MemorySearchStore, checkParentSelectionPolicy, createToySearch, createToySettings, evaluatedFixture, revise, scopeFixture, snapshot, universe } from '../../src/search/testing.js'
import { buildArchive } from '../../src/search/archive.js'
import { digestJson } from '../../src/state/digest.js'

const implementation = { package: 'test-parent-policy', version: '1.0.0', integrity: digestJson('test-policy-bytes') }
const ref = componentRef('parent-selection', 'test-parent-policy', implementation, {})
const fixedPolicy: ParentSelectionPolicy = { ref, requiresChampion: false, select(input) {
  const scope = input.scopes.find(s => s.probability > 0 && s.parents.length)!
  const parent = scope.parents[0]!
  return { allocations: [{ scopeDigest: scope.digest, parentSnapshotDigest: parent.snapshotDigest, slots: input.maxCandidates, drawIndex: 0 }],
    parentProbabilities: { [parent.candidateId]: 1 }, reasonCodes: ['first-eligible-parent'] }
} }
function archive() {
  const u = universe(4), scope = scopeFixture(u, u.tasks.map(t => t.id)), anchor = snapshot('anchor')
  const row = evaluatedFixture(u, scope, anchor, () => ({ outcome: 0 }))
  return buildArchive({ evolutionId: 'test', universe: u, snapshots: [anchor], scopes: [scope], results: [row.result], plans: [row.plan], config: createToySettings().search, championId: anchor.candidateId })
}
function setup() {
  const f = createToySearch(8), settings = createToySettings(), journal = new MemorySearchStore(), components = new ComponentRegistry()
  settings.search.parentPolicy = ref
  let selections = 0
  components.registerParentSelectionPolicy(ref.id, implementation, component => ({ ...fixedPolicy, ref: component, select(input, random) { selections++; return fixedPolicy.select(input, random) } }))
  const admission = { evolutionId: 'test', roundId: 'round', roundIndex: 0, maxCandidates: 2, anchor: f.anchor, championRevisionDigest: f.anchor.digest, settings }
  const engine = (store = journal) => new FailureClusterSearch(store, f.provider, f.diagnosis, f.hooks, components)
  return { f, journal, components, admission, engine, selections: () => selections }
}

describe('public parent policy contract', () => {
  it('resolves and unloads registered policies while checking implementation/config identity', () => {
    const registry = new ComponentRegistry()
    const unload = registry.registerParentSelectionPolicy(ref.id, implementation, component => ({ ...fixedPolicy, ref: component }))
    expect(registry.parentSelectionPolicy(ref).ref).toEqual(ref)
    expect(() => registry.parentSelectionPolicy({ ...ref, config: { unexpected: true } })).toThrow('config digest mismatch')
    expect(() => registry.parentSelectionPolicy({ ...ref, implementation: { ...implementation, integrity: digestJson('other-code') } })).toThrow('implementation identity mismatch')
    unload()
    expect(() => registry.parentSelectionPolicy(ref)).toThrow('unknown parent-selection')
    registry.registerParentSelectionPolicy(ref.id, implementation, () => ({ ...fixedPolicy, ref: { ...ref, id: 'different' } }))
    expect(() => registry.parentSelectionPolicy(ref)).toThrow('different identity')
  })

  it('passes only a detached, frozen seed view, with evidence references in the decision', () => {
    const source = archive(), input = parentSelectionInput(source, 'round', 2, 0)
    expect(Object.keys(input)).toEqual(['archiveDigest', 'roundId', 'maxCandidates', 'randomSeed', 'scopes'])
    expect(Object.isFrozen(input.scopes[0]!.parents[0])).toBe(true)
    expect(checkParentSelectionPolicy(fixedPolicy, input).inputDigest).toBe(digestJson(input))
    const selected = selectParentsWithPolicy(source, fixedPolicy, 2, 'round', 0)
    expect(selected.policy).toMatchObject({ ref, inputDigest: digestJson(input), reasonCodes: ['first-eligible-parent'] })
    expect(() => parentSelectionInput(revise(source, { plans: source.plans.map(p => revise(p, { partition: 'held-out' })) }), 'round', 2, 0)).toThrow('held-out')
  })

  it.each([
    ['too many slots', (plan: ParentSelectionPlan) => { plan.allocations[0]!.slots = 3 }, 'candidate budget'],
    ['unknown parent', (plan: ParentSelectionPlan) => { plan.allocations[0]!.parentSnapshotDigest = digestJson('unknown') }, 'ineligible parent/scope'],
    ['unknown scope', (plan: ParentSelectionPlan) => { plan.allocations[0]!.scopeDigest = digestJson('other scope') }, 'ineligible parent/scope'],
    ['nonfinite probability', (plan: ParentSelectionPlan) => { plan.parentProbabilities.anchor = NaN }, 'probability'],
    ['unnormalized probability', (plan: ParentSelectionPlan) => { plan.parentProbabilities.anchor = 0.5 }, 'sum to one'],
    ['missing explanation', (plan: ParentSelectionPlan) => { plan.reasonCodes = [] }, 'explain'],
  ] as const)('rejects %s before the decision can be stored', (_name, change, error) => {
    const policy: ParentSelectionPolicy = { ...fixedPolicy, select(input, random) { const plan = fixedPolicy.select(input, random); change(plan); return plan } }
    expect(() => selectParentsWithPolicy(archive(), policy, 2, 'round', 0)).toThrow(error)
  })

  it('detects mutable inputs and nondeterministic policies in the contributor testkit', () => {
    const input = parentSelectionInput(archive(), 'round', 2, 0)
    const mutator: ParentSelectionPolicy = { ...fixedPolicy, select(view) { (view.scopes as unknown[]).pop(); throw new Error('unreachable') } }
    expect(() => checkParentSelectionPolicy(mutator, input)).toThrow(TypeError)
    let counter = 0
    const changing: ParentSelectionPolicy = { ...fixedPolicy, select(view, random) { const plan = fixedPolicy.select(view, random); plan.allocations[0]!.drawIndex = counter++; return plan } }
    expect(() => checkParentSelectionPolicy(changing, input)).toThrow('not deterministic')
  })
})

describe('policy execution through the GEPA recipe', () => {
  it('lets an explicit policy override a legacy mixture preset without adding strategy fields to the archive', async () => {
    const f = setup()
    f.admission.settings.search.parentSampling = 'epsilon-greedy-gepa-v1'
    const result = await f.engine().run(f.admission, new AbortController().signal)
    expect(result.research.parents.policy?.ref.id).toBe(ref.id)
    expect((await f.journal.archive())?.parentMixture).toBeUndefined()
  })

  it('runs a custom policy, persists its identity and resumes without redrawing parents or reexecuting cells', async () => {
    const f = setup(), write = f.journal.write.bind(f.journal)
    f.journal.write = async (name, value) => { await write(name, value); if (name === 'rounds/round/parents') throw new Error('interrupted') }
    await expect(f.engine().run(f.admission, new AbortController().signal)).rejects.toThrow('interrupted')
    const restarted = new MemorySearchStore(f.journal.checkpoint())
    const result = await f.engine(restarted).run(f.admission, new AbortController().signal)
    expect(f.selections()).toBe(1)
    expect(result.research.parents.policy?.ref).toEqual(ref)
    expect(result.research.workplans.length).toBeGreaterThan(0)
    const calls = f.f.executions.length
    expect(await f.engine(restarted).run(f.admission, new AbortController().signal)).toEqual(result)
    expect(f.f.executions).toHaveLength(calls)
    const next = { ...f.admission, roundId: 'next', roundIndex: 1, settings: { ...f.admission.settings,
      search: { ...f.admission.settings.search, parentPolicy: componentRef('parent-selection', ref.id, implementation, { changed: true }) } } }
    await expect(f.engine(restarted).run(next, new AbortController().signal)).rejects.toThrow('identity changed')
    expect(f.f.executions).toHaveLength(calls)
  })

  it('does not start generation or persist a decision when a plugin exceeds the candidate limit', async () => {
    const f = createToySearch(8), settings = createToySettings(), journal = new MemorySearchStore(), registry = new ComponentRegistry()
    registry.registerParentSelectionPolicy(ref.id, implementation, () => ({ ...fixedPolicy, select(input, random) {
      const plan = fixedPolicy.select(input, random); plan.allocations[0]!.slots++; return plan
    } }))
    settings.search.parentPolicy = ref
    await expect(new FailureClusterSearch(journal, f.provider, f.diagnosis, f.hooks, registry).run({ evolutionId: 'test', roundId: 'bad', roundIndex: 0,
      maxCandidates: 1, anchor: f.anchor, championRevisionDigest: f.anchor.digest, settings }, new AbortController().signal)).rejects.toThrow('candidate budget')
    expect(f.generated).toEqual([])
    expect(await journal.read('rounds/bad/parents')).toBeUndefined()
  })
})
