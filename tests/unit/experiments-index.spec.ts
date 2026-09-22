import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EXPERIMENTS_TSV_COLUMNS, serializeExperimentsTsv } from '../../src/state/experiments.js'
import { EvolutionRegistryStore } from '../../src/state/evolution.js'
import type { ChampionState } from '../../src/types.js'
import { evidence, evolutionSpec, roundFixture, SHA } from '../helpers/research-fixture.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function champion(): ChampionState {
  return { schemaVersion: 2, ref: 'a'.repeat(40), manifestDigest: SHA('b'), updatedAt: 'now' }
}

describe('experiments.tsv materialized index', () => {
  it('serializes a fixed candidate-oriented schema and escapes multiline names', () => {
    const round = roundFixture({
      evolutionId: 'evo-1', roundId: 'round-1', status: 'accepted', decision: 'accepted',
      promotedCandidateId: 'round-1-candidate-1', promotionCandidateId: 'round-1-candidate-1', updatedAt: 'later',
    })
    round.candidatePool[0]!.status = 'selected'
    const output = serializeExperimentsTsv([{
      entry: {
        evolutionId: 'evo-1', name: 'line\tone\nline two', specDigest: SHA('a'), status: 'active',
        createdAt: 'now', updatedAt: 'later',
      },
      rounds: [round],
    }])
    const [header, row] = output.trimEnd().split('\n')
    expect(header).toBe(EXPERIMENTS_TSV_COLUMNS.join('\t'))
    expect(row?.split('\t')).toEqual([
      'evo-1', 'line\\tone\\nline two', 'round-1', 'round-1-candidate-1', 'selected', 'a'.repeat(40),
      '', '', '', '', '', '', '', 'promoted', 'finalist', 'evolutions/evo-1/rounds/round-1.json', 'later', '', '', 'held-out',
    ])
  })

  it('updates after round writes and rebuilds exactly from authoritative JSON', async () => {
    const root = join(process.env.TMPDIR ?? '/tmp', `refine-experiments-${crypto.randomUUID()}`)
    roots.push(root)
    const registry = new EvolutionRegistryStore(root)
    await registry.createEvolution({ spec: evolutionSpec('evo-1'), champion: champion(), name: 'experiment one' })
    expect(await readFile(registry.experimentsPath, 'utf8')).toBe(`${EXPERIMENTS_TSV_COLUMNS.join('\t')}\n`)

    const round = roundFixture({ evolutionId: 'evo-1', roundId: 'round-1', updatedAt: 'later' })
    const candidateCommit = 'c'.repeat(40)
    round.status = 'candidate-seed-running'
    round.candidatePool[0] = {
      ...round.candidatePool[0]!,
      status: 'evaluating',
      sealedVersion: {
        commitOid: candidateCommit,
        treeOid: 'd'.repeat(40),
        manifestDigest: SHA('3'),
        patchDigest: SHA('4'),
        immutableRef: `refs/dsh-refine/evolutions/evo-1/candidates/${candidateCommit}`,
      },
      seedEvaluation: evidence(round.plan.seed, candidateCommit, 0.5, '2'),
    }
    await registry.stateStore('evo-1').writeRound(round)

    const indexed = await readFile(registry.experimentsPath, 'utf8')
    const cells = indexed.trimEnd().split('\n')[1]!.split('\t')
    expect(cells).toEqual([
      'evo-1', 'experiment one', 'round-1', 'round-1-candidate-1', 'evaluating', 'a'.repeat(40),
      candidateCommit, 'd'.repeat(40), `refs/dsh-refine/evolutions/evo-1/candidates/${candidateCommit}`,
      `eval_${'2'.repeat(32)}`, '0.5', '', '', '', '', 'evolutions/evo-1/rounds/round-1.json', 'later', '', '', 'held-out',
    ])

    await rm(registry.experimentsPath)
    await registry.initialize()
    expect(await readFile(registry.experimentsPath, 'utf8')).toBe(indexed)
  })

  it('projects infrastructure failures even when candidate status was not advanced', () => {
    const round = roundFixture({ status: 'failed', updatedAt: 'failed-at' })
    const output = serializeExperimentsTsv([{
      entry: {
        evolutionId: 'evo-1', specDigest: SHA('a'), status: 'active', createdAt: 'now', updatedAt: 'failed-at',
      },
      rounds: [round],
    }])
    expect(output.trimEnd().split('\n')[1]!.split('\t')[13]).toBe('failed')
  })

  it('sorts rows by stable IDs rather than write order', () => {
    const left = roundFixture({ evolutionId: 'evo-a', roundId: 'round-a' })
    const right = roundFixture({ evolutionId: 'evo-z', roundId: 'round-z' })
    const entry = (evolutionId: string) => ({
      evolutionId, specDigest: SHA('a'), status: 'active' as const, createdAt: 'now', updatedAt: 'now',
    })
    const rows = serializeExperimentsTsv([
      { entry: entry('evo-z'), rounds: [right] },
      { entry: entry('evo-a'), rounds: [left] },
    ]).trimEnd().split('\n')
    expect(rows[1]?.startsWith('evo-a\t')).toBe(true)
    expect(rows[2]?.startsWith('evo-z\t')).toBe(true)
  })
})
