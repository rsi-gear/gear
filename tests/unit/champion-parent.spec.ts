import { describe, expect, it, vi } from 'vitest'
import { resolveChampionParent } from '../../src/refine/champion-parent.js'
import { digestJson } from '../../src/state/digest.js'
import { RefineStateStore } from '../../src/state/store.js'
import type { ChampionState, EvolutionSpec, PopulationMember, RefinementRound } from '../../src/types.js'
import { evidence, evolutionSpec, roundFixture, SHA } from '../helpers/research-fixture.js'

function initialMember(spec: EvolutionSpec): PopulationMember {
  return {
    candidateId: `initial-${spec.initialHarness.ref}`,
    harnessRef: spec.initialHarness.ref,
    harnessDigest: spec.initialHarness.digest,
    parentCandidateIds: [],
    lineageRootId: `initial-${spec.initialHarness.ref}`,
    metrics: { quality: 0, taskSuccessRate: 0 },
    selectedAt: spec.createdAt,
  }
}

function promotion(spec: EvolutionSpec, roundId = 'promotion-1', ref = 'b'.repeat(40), parent = initialMember(spec)) {
  const candidateId = `${roundId}-candidate-1`
  const metaSessionId = `${roundId}-meta`
  const checkpoint = { sourceSessionId: metaSessionId, eventCount: 12, prefixDigest: SHA('1') }
  const champion: ChampionState = { schemaVersion: 2, ref, manifestDigest: SHA('2'), updatedAt: 'promoted', roundId }
  const member: PopulationMember = {
    candidateId, harnessRef: ref, harnessDigest: champion.manifestDigest,
    parentCandidateIds: [parent.candidateId], lineageRootId: parent.lineageRootId,
    metaSessionId, metaCheckpoint: checkpoint,
    metrics: { quality: 0.7, taskSuccessRate: 0.7 }, selectedAt: 'selected-originally',
  }
  const population = { evolutionId: spec.evolutionId, generation: 1, members: [member] }
  const source = roundFixture({
    evolutionId: spec.evolutionId, roundId, status: 'accepted', decision: 'accepted',
    targetHarnessRef: parent.harnessRef, targetHarnessDigest: parent.harnessDigest,
    createdAt: 'before-promotion', updatedAt: 'promotion-completed',
    promotionCandidateId: candidateId, promotedCandidateId: candidateId,
    parentPopulationDigest: SHA('3'),
    parentAllocations: [{ candidateId, parentCandidateId: parent.candidateId,
      parentHarnessRef: parent.harnessRef, parentHarnessDigest: parent.harnessDigest }],
    candidatePool: [{
      candidateId, roundId, parentHarnessRef: parent.harnessRef, parentCandidateIds: [parent.candidateId],
      status: 'selected', metaSessionId, resultCheckpoint: checkpoint, metrics: member.metrics,
      sealedVersion: { commitOid: ref, treeOid: 'c'.repeat(40), manifestDigest: champion.manifestDigest,
        patchDigest: SHA('4'), immutableRef: `refs/dsh-refine/evolutions/${spec.evolutionId}/${candidateId}` },
    }],
    commitIntent: {
      expectedPopulationDigest: SHA('3'), nextPopulation: { ...population, digest: digestJson(population) },
      expectedChampionRef: parent.harnessRef, nextChampion: champion, decision: 'accepted',
      promotionCandidateId: candidateId, phase: 'champion-committed',
    },
  })
  source.candidatePool[0]!.seedEvaluation = evidence(source.plan.seed, ref, 0.7)
  source.candidatePool[0]!.heldOutEvaluation = evidence(source.plan.heldOut, ref, 0.95)
  return { source, champion, member }
}

function historyStore(rounds: RefinementRound[]) {
  const store = new RefineStateStore('/unused-champion-parent-unit-fixture')
  const readRound = vi.spyOn(store, 'readRound').mockImplementation(async id => rounds.find(round => round.roundId === id))
  const listRounds = vi.spyOn(store, 'listRounds').mockResolvedValue(rounds)
  const readPopulation = vi.spyOn(store, 'readPopulation').mockRejectedValue(new Error('current survivors must not supply champion identity'))
  return { store, readRound, listRounds, readPopulation }
}

describe('resolveChampionParent', () => {
  it('reconstructs an initial published champion without reading its foreign promotion round', async () => {
    const spec = evolutionSpec()
    const { store, readRound, listRounds } = historyStore([])
    const result = await resolveChampionParent(spec, {
      schemaVersion: 2, ref: spec.initialHarness.ref, manifestDigest: spec.initialHarness.digest,
      updatedAt: 'published-now', roundId: 'another-evolution-promotion',
    }, store)
    expect(result).toEqual(initialMember(spec))
    expect(readRound).not.toHaveBeenCalled()
    expect(listRounds).not.toHaveBeenCalled()
  })

  it('restores the original promoted member after research survivors have replaced it', async () => {
    const spec = evolutionSpec()
    const { source, champion, member } = promotion(spec)
    const discarded = promotion(spec, 'later-rejected', 'd'.repeat(40), member).source
    discarded.status = 'rejected'
    discarded.decision = 'rejected'
    const { store, readPopulation, listRounds } = historyStore([discarded, source])
    const before = structuredClone(source)
    const result = await resolveChampionParent(spec, champion, store)
    expect(result).toEqual(member)
    expect(Object.keys(result).sort()).toEqual(Object.keys(member).sort())
    expect(result.metrics.quality).toBe(0.7)
    expect(result).not.toHaveProperty('heldOutEvaluation')
    expect(result).not.toHaveProperty('seedEvaluation')
    result.metaCheckpoint!.eventCount = 99
    result.metrics.quality = 0
    result.parentCandidateIds.push('unrelated')
    expect(source).toEqual(before)
    expect(readPopulation).not.toHaveBeenCalled()
    expect(listRounds).not.toHaveBeenCalled()
  })

  it('resolves rollback identity from the original promotion rather than later same-ref records', async () => {
    const spec = evolutionSpec()
    const { source, champion, member } = promotion(spec)
    const duplicate = promotion(spec, 'later-same-ref', champion.ref).source
    duplicate.status = 'rejected'
    duplicate.decision = 'rejected'
    const { store, readRound } = historyStore([duplicate, source])
    expect(await resolveChampionParent(spec, { ...champion, roundId: `rollback:${source.roundId}` }, store)).toEqual(member)
    expect(readRound).toHaveBeenCalledExactlyOnceWith(source.roundId)
  })

  it.each(['missing-id', 'missing-round', 'foreign-evolution', 'rejected', 'wrong-digest', 'wrong-promoted-id'])(
    'rejects an unproven champion origin: %s', async invalid => {
      const spec = evolutionSpec()
      const { source, champion } = promotion(spec)
      const rounds = [source]
      if (invalid === 'missing-id') delete champion.roundId
      if (invalid === 'missing-round') champion.roundId = 'unknown'
      if (invalid === 'foreign-evolution') source.evolutionId = 'different-evolution'
      if (invalid === 'rejected') { source.status = 'rejected'; source.decision = 'rejected' }
      if (invalid === 'wrong-digest') champion.manifestDigest = SHA('f')
      if (invalid === 'wrong-promoted-id') source.promotedCandidateId = 'not-the-promoted-candidate'
      const { store, listRounds } = historyStore(rounds)
      await expect(resolveChampionParent(spec, champion, store)).rejects.toThrow(/Cannot resolve the admitted champion parent/u)
      expect(listRounds).not.toHaveBeenCalled()
    },
  )

  it('does not treat an initial commit with a different manifest as the initial identity', async () => {
    const spec = evolutionSpec()
    const { store } = historyStore([])
    await expect(resolveChampionParent(spec, {
      schemaVersion: 2, ref: spec.initialHarness.ref, manifestDigest: SHA('f'), updatedAt: 'now',
    }, store)).rejects.toThrow(/non-initial champion has no promotion round/u)
  })

  it('rejects another unpromoted candidate with the requested commit in an accepted round', async () => {
    const spec = evolutionSpec()
    const { source, champion } = promotion(spec)
    const unpromoted = structuredClone(source.candidatePool[0]!)
    unpromoted.candidateId = 'unpromoted-sibling'
    source.candidatePool.push(unpromoted)
    source.candidatePool[0]!.sealedVersion!.commitOid = 'f'.repeat(40)
    const { store } = historyStore([source])
    await expect(resolveChampionParent(spec, champion, store)).rejects.toThrow(/does not prove the current champion identity/u)
  })

  it.each(['missing-member', 'different-checkpoint', 'different-parents', 'different-champion'])(
    'rejects inconsistent original commit metadata: %s', async invalid => {
      const spec = evolutionSpec()
      const { source, champion, member } = promotion(spec)
      if (invalid === 'missing-member') source.commitIntent!.nextPopulation.members = []
      if (invalid === 'different-checkpoint') member.metaCheckpoint = { ...member.metaCheckpoint!, prefixDigest: SHA('f') }
      if (invalid === 'different-parents') member.parentCandidateIds = ['different-parent']
      if (invalid === 'different-champion') source.commitIntent!.nextChampion = { ...champion, ref: 'f'.repeat(40) }
      const { store } = historyStore([source])
      await expect(resolveChampionParent(spec, champion, store)).rejects.toThrow(/promotion commit does not contain/u)
    },
  )

  it.each(['missing-checkpoint', 'different-session', 'missing-metrics'])(
    'rejects missing or inconsistent promoted candidate research state: %s', async invalid => {
      const spec = evolutionSpec()
      const { source, champion } = promotion(spec)
      const candidate = source.candidatePool[0]!
      if (invalid === 'missing-checkpoint') delete candidate.resultCheckpoint
      if (invalid === 'different-session') candidate.metaSessionId = 'unrelated-session'
      if (invalid === 'missing-metrics') delete candidate.metrics
      const { store } = historyStore([source])
      await expect(resolveChampionParent(spec, champion, store)).rejects.toThrow(/verified Meta checkpoint or seed metrics/u)
    },
  )

  it('recovers a legacy promoted candidate directly descending from the initial harness', async () => {
    const spec = evolutionSpec()
    const { source, champion, member } = promotion(spec)
    delete source.commitIntent
    const { store, listRounds } = historyStore([source])
    expect(await resolveChampionParent(spec, champion, store)).toEqual({ ...member, selectedAt: source.updatedAt })
    expect(listRounds).not.toHaveBeenCalled()
  })

  it('recovers legacy lineage from the admitted champion snapshot without using its checkpoint as the result', async () => {
    const spec = evolutionSpec()
    const first = promotion(spec)
    const next = promotion(spec, 'legacy-promotion', 'd'.repeat(40), first.member)
    delete next.source.commitIntent
    next.source.championParent = first.member
    const { store, listRounds } = historyStore([next.source])
    expect(await resolveChampionParent(spec, next.champion, store)).toEqual({ ...next.member, selectedAt: next.source.updatedAt })
    expect(listRounds).not.toHaveBeenCalled()
  })

  it('proves legacy lineage through exact recorded parent candidate IDs including rejected research ancestors', async () => {
    const spec = evolutionSpec()
    const ancestor = promotion(spec)
    ancestor.source.status = 'rejected'
    ancestor.source.decision = 'rejected'
    delete ancestor.source.commitIntent
    const next = promotion(spec, 'legacy-promotion', 'd'.repeat(40), ancestor.member)
    delete next.source.commitIntent
    const { store } = historyStore([ancestor.source, next.source])
    expect(await resolveChampionParent(spec, next.champion, store)).toEqual({ ...next.member, selectedAt: next.source.updatedAt })
  })

  it('rejects a legacy parent with only an unrelated same-commit candidate available', async () => {
    const spec = evolutionSpec()
    const ancestor = promotion(spec)
    const next = promotion(spec, 'legacy-promotion', 'd'.repeat(40), ancestor.member)
    delete next.source.commitIntent
    next.source.candidatePool[0]!.parentCandidateIds = ['missing-recorded-parent']
    const { store } = historyStore([ancestor.source, next.source])
    await expect(resolveChampionParent(spec, next.champion, store)).rejects.toThrow(/no unambiguous recorded parent lineage/u)
  })

  it('rejects a cycle in legacy parent history', async () => {
    const spec = evolutionSpec()
    const { source, champion } = promotion(spec)
    delete source.commitIntent
    source.candidatePool[0]!.parentCandidateIds = [source.candidatePool[0]!.candidateId]
    source.candidatePool[0]!.parentHarnessRef = champion.ref
    const { store } = historyStore([source])
    await expect(resolveChampionParent(spec, champion, store)).rejects.toThrow(/lineage contains a cycle/u)
  })
})
