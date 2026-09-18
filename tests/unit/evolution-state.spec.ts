import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EvolutionRegistryStore } from '../../src/state/evolution.js'
import { digestJson } from '../../src/state/digest.js'
import { assertMetaReasoningEffortMatches } from '../../src/meta/sampling.js'
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
  it.each([-1, 60_001, 1.5])('rejects invalid finalization reserve %s', async reserve => {
    const root = join(process.env.TMPDIR ?? '/tmp', `refine-reserve-${crypto.randomUUID()}`)
    roots.push(root)
    const registry = new EvolutionRegistryStore(root)
    const value = spec('evo-reserve')
    value.candidateGeneration.budget.finalizationReserveMs = reserve
    await expect(registry.createEvolution({ spec: value, champion: champion() })).rejects.toThrow(/finalization reserve/)
  })

  it('seals an explicit finalization reserve without changing legacy budgets', async () => {
    const root = join(process.env.TMPDIR ?? '/tmp', `refine-reserve-${crypto.randomUUID()}`)
    roots.push(root)
    const registry = new EvolutionRegistryStore(root)
    const value = spec('evo-reserve')
    const previous = digestJson(value)
    value.candidateGeneration.budget.finalizationReserveMs = 10_000
    const entry = await registry.createEvolution({ spec: value, champion: champion() })
    expect(entry.specDigest).not.toBe(previous)
    value.candidateGeneration.budget.finalizationReserveMs = 1
    expect((await registry.requireSpec(value.evolutionId)).candidateGeneration.budget.finalizationReserveMs).toBe(10_000)
  })

  it('seals Medium into persistent Meta sampling and includes it in spec identity', async () => {
    const root = join(process.env.TMPDIR ?? '/tmp', `refine-medium-${crypto.randomUUID()}`)
    roots.push(root)
    const registry = new EvolutionRegistryStore(root)
    const value = spec('evo-medium')
    const legacyDigest = digestJson(value)
    value.metaAgent.sampling.reasoningEffort = 'medium'
    const entry = await registry.createEvolution({ spec: value, champion: champion() })
    expect(entry.specDigest).not.toBe(legacyDigest)
    const restored = await new EvolutionRegistryStore(root).requireSpec(value.evolutionId)
    expect(restored.metaAgent.sampling.reasoningEffort).toBe('medium')
    expect(digestJson(restored)).toBe(entry.specDigest)
    expect(() => assertMetaReasoningEffortMatches(restored.metaAgent.sampling, { reasoningEffort: 'medium' })).not.toThrow()
    expect(() => assertMetaReasoningEffortMatches(restored.metaAgent.sampling, { reasoningEffort: 'low' }))
      .toThrow(/immutable evolution spec/)
    expect(() => assertMetaReasoningEffortMatches({}, { reasoningEffort: 'medium' })).toThrow(/immutable evolution spec/)
    expect(() => assertMetaReasoningEffortMatches({}, {})).not.toThrow()
    expect(() => assertMetaReasoningEffortMatches(restored.metaAgent.sampling, {})).not.toThrow()
  })

  it.each(['', ' medium', 'medium ', 1, null])('rejects invalid persistent Meta effort %j', async (effort) => {
    const root = join(process.env.TMPDIR ?? '/tmp', `refine-invalid-effort-${crypto.randomUUID()}`)
    roots.push(root)
    const value = spec('evo-invalid-effort')
    value.metaAgent.sampling.reasoningEffort = effort as string
    await expect(new EvolutionRegistryStore(root).createEvolution({ spec: value, champion: champion() }))
      .rejects.toThrow(/reasoningEffort/)
  })

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

  it('persists a harness-neutral skill Meta identity without treating it as DSH', async () => {
    const root = join(process.env.TMPDIR ?? '/tmp', `refine-skill-meta-${crypto.randomUUID()}`)
    roots.push(root)
    const registry = new EvolutionRegistryStore(root)
    const external = spec('evo-skill-meta')
    external.metaAgent = {
      runtime: { type: 'claude-code', version: '1.0.0', integrity: `sha256:${'1'.repeat(64)}` },
      preset: {
        id: 'refine',
        digest: `sha256:${'2'.repeat(64)}`,
        resources: [{ logicalPath: 'SKILL.md', kind: 'skill', digest: `sha256:${'2'.repeat(64)}` }],
      },
      model: { provider: 'anthropic', model: 'claude-test' },
      sampling: {},
    }
    await registry.createEvolution({ spec: external, champion: champion() })
    await expect(registry.requireSpec(external.evolutionId)).resolves.toMatchObject({
      metaAgent: { runtime: { type: 'claude-code' }, preset: { id: 'refine' } },
    })

    const invalid = spec('evo-invalid-skill-meta')
    invalid.metaAgent = { ...external.metaAgent, runtime: { ...external.metaAgent.runtime, integrity: 'not-a-digest' } }
    await expect(registry.createEvolution({ spec: invalid, champion: champion() })).rejects.toThrow(/Meta Agent identity/)
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
