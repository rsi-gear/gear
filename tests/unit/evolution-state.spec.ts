import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EvolutionRegistryStore } from '../../src/state/evolution.js'
import { migrateLegacyState } from '../../src/state/migration.js'
import type { ChampionState, EvolutionSpec } from '../../src/types.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function champion(ref = 'a'.repeat(40)): ChampionState {
  return { schemaVersion: 2, ref, manifestDigest: `sha256:${'b'.repeat(64)}`, updatedAt: 'now' }
}

function spec(evolutionId: string): EvolutionSpec {
  return {
    schemaVersion: 1, evolutionId, source: 'native', createdAt: 'now',
    initialHarnessRef: 'a'.repeat(40), initialHarnessDigest: `sha256:${'b'.repeat(64)}`,
    seedTaskRef: 'seed', seedTaskDigest: `sha256:${'c'.repeat(64)}`,
    heldOutRef: 'held', heldOutDigest: `sha256:${'d'.repeat(64)}`,
    metaHarnessRef: 'meta-v1', metaModel: {}, promotionPolicy: {
      minimumCandidateScore: 0, minimumAbsoluteGain: 0, requireNoRegression: true,
      maxHeldOutRegression: 0, maxRequiredRegressions: 0,
    },
    taskBudgetMs: 1_000, toolchainRef: 'node', sandboxProfileRef: 'sandbox-v1',
  }
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
    await registry.compareAndSwapPublished(undefined, {
      schemaVersion: 1, ref: 'e'.repeat(40), manifestDigest: `sha256:${'b'.repeat(64)}`,
      publishedAt: 'now', sourceEvolutionId: 'evo-1',
    })
    expect((await registry.readPublished())?.sourceEvolutionId).toBe('evo-1')
  })

  it('archives each legacy batch and never grants its shared session resume authority', async () => {
    const root = join(process.env.TMPDIR ?? '/tmp', `refine-migration-${crypto.randomUUID()}`)
    roots.push(root)
    await mkdir(join(root, 'rounds'), { recursive: true })
    await writeFile(join(root, 'champion.json'), JSON.stringify(champion()))
    await writeFile(join(root, 'meta.json'), JSON.stringify({ sessionId: 'shared-old-meta', metaHarnessRef: 'meta-v1' }))
    await writeFile(join(root, 'rounds', 'round-1.json'), JSON.stringify({
      schemaVersion: 2, roundId: 'round-1', workspaceRoot: '/old', status: 'rejected', source: 'api',
      createdAt: 'now', updatedAt: 'now', metaHarnessRef: 'meta-v1', targetHarnessRef: 'a'.repeat(40),
      targetHarnessDigest: `sha256:${'b'.repeat(64)}`, sandboxProfileRef: 'sandbox-v1',
      seedTaskRef: 'seed', heldOutRef: 'held', taskBudgetMs: 1_000,
      promotionPolicy: { minimumCandidateScore: 0, minimumAbsoluteGain: 0, requireNoRegression: true, maxHeldOutRegression: 0, maxRequiredRegressions: 0 },
      batchId: 'old-batch', roundIndex: 1, roundCount: 1, mutation: null, decision: 'no-change',
    }))
    const registry = new EvolutionRegistryStore(root)
    const ids = await migrateLegacyState(registry)
    expect(ids).toHaveLength(1)
    expect(await registry.readEntry(ids[0]!)).toMatchObject({ status: 'archived' })
    expect((await registry.stateStore(ids[0]!).readRound('round-1'))?.finalization).toBeNull()
    expect(await registry.stateStore(ids[0]!).readMeta()).toBeUndefined()
    expect((await registry.readPublished())?.ref).toBe('a'.repeat(40))
    expect(JSON.parse(await readFile(join(root, 'migration-v3.json'), 'utf8'))).toMatchObject({ status: 'complete' })
    expect(await migrateLegacyState(registry)).toEqual(ids)
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
