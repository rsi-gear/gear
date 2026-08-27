import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EvolutionRegistryStore } from '../../src/state/evolution.js'
import type { ChampionState, EvolutionSpec } from '../../src/types.js'
import { evolutionSpec } from '../helpers/research-fixture.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function champion(ref = 'a'.repeat(40)): ChampionState {
  return { schemaVersion: 2, ref, manifestDigest: `sha256:${'b'.repeat(64)}`, updatedAt: 'now' }
}

function spec(evolutionId: string): EvolutionSpec {
  return evolutionSpec(evolutionId)
}

describe('EvolutionRegistryStore', () => {
  it('keeps champion and Meta state under independent evolution roots', async () => {
    const root = join(process.env.TMPDIR ?? '/tmp', `refine-registry-${crypto.randomUUID()}`)
    roots.push(root)
    const registry = new EvolutionRegistryStore(root)
    await registry.createEvolution({ spec: spec('evo-1'), champion: champion(), name: 'one' })
    await registry.createEvolution({ spec: spec('evo-2'), champion: champion(), name: 'two' })
    await registry.stateStore('evo-1').writeChampion(champion('e'.repeat(40)))
    expect((await registry.stateStore('evo-1').readChampion())?.ref).toBe('e'.repeat(40))
    expect((await registry.stateStore('evo-2').readChampion())?.ref).toBe('a'.repeat(40))
    expect(await registry.stateStore('evo-1').readPopulation()).toMatchObject({
      generation: 0,
      members: [{ harnessRef: 'a'.repeat(40), parentCandidateIds: [] }],
    })
    await registry.compareAndSwapPublished(undefined, {
      schemaVersion: 1, ref: 'e'.repeat(40), manifestDigest: `sha256:${'b'.repeat(64)}`,
      publishedAt: 'now', sourceEvolutionId: 'evo-1',
    })
    expect((await registry.readPublished())?.sourceEvolutionId).toBe('evo-1')
  })

  it('rejects the old demo EvolutionSpec instead of implicitly migrating it', async () => {
    const root = join(process.env.TMPDIR ?? '/tmp', `refine-breaking-${crypto.randomUUID()}`)
    roots.push(root)
    const registry = new EvolutionRegistryStore(root)
    const old = {
      schemaVersion: 1, evolutionId: 'evo-old', source: 'native', createdAt: 'now',
      initialHarnessRef: 'a'.repeat(40), initialHarnessDigest: `sha256:${'b'.repeat(64)}`,
    }
    await expect(registry.createEvolution({ spec: old as never, champion: champion() })).rejects.toThrow()
  })

  it('continues to accept immutable specs with the legacy generation timeout', async () => {
    const root = join(process.env.TMPDIR ?? '/tmp', `refine-legacy-budget-${crypto.randomUUID()}`)
    roots.push(root)
    const registry = new EvolutionRegistryStore(root)
    const legacy = spec('evo-legacy-budget')
    legacy.candidateGeneration.budget = { timeoutMs: 300_000 }
    await registry.createEvolution({ spec: legacy, champion: champion() })
    await expect(registry.requireSpec(legacy.evolutionId)).resolves.toMatchObject({
      candidateGeneration: { budget: { timeoutMs: 300_000 } },
    })
  })

  it('rejects a component placed in the wrong extension slot', async () => {
    const root = join(process.env.TMPDIR ?? '/tmp', `refine-kind-${crypto.randomUUID()}`)
    roots.push(root)
    const registry = new EvolutionRegistryStore(root)
    const invalid = spec('evo-kind')
    invalid.selection.strategy = invalid.rollout.taskSampler
    await expect(registry.createEvolution({ spec: invalid, champion: champion() })).rejects.toThrow(/component identity/)
  })

  it('serializes published CAS across independent registry instances', async () => {
    const root = join(process.env.TMPDIR ?? '/tmp', `refine-registry-cas-${crypto.randomUUID()}`)
    roots.push(root)
    const left = new EvolutionRegistryStore(root)
    const right = new EvolutionRegistryStore(root)
    await left.initialize()
    const results = await Promise.allSettled([
      left.compareAndSwapPublished(undefined, {
        schemaVersion: 1, ref: 'a'.repeat(40), manifestDigest: `sha256:${'b'.repeat(64)}`,
        publishedAt: 'left', sourceEvolutionId: 'evo-1',
      }),
      right.compareAndSwapPublished(undefined, {
        schemaVersion: 1, ref: 'c'.repeat(40), manifestDigest: `sha256:${'d'.repeat(64)}`,
        publishedAt: 'right', sourceEvolutionId: 'evo-2',
      }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  })
})
