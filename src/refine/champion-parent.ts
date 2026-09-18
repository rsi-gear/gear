import { digestJson } from '../state/digest.js'
import type { RefineStateStore } from '../state/store.js'
import type { CandidateRecord, ChampionState, EvolutionSpec, PopulationMember, RefinementRound } from '../types.js'

function initialParent(spec: Readonly<EvolutionSpec>): PopulationMember {
  const candidateId = `initial-${spec.initialHarness.ref}`
  return {
    candidateId,
    harnessRef: spec.initialHarness.ref,
    harnessDigest: spec.initialHarness.digest,
    parentCandidateIds: [],
    lineageRootId: candidateId,
    metrics: { quality: 0, taskSuccessRate: 0 },
    selectedAt: spec.createdAt,
  }
}

function unavailable(detail: string): Error {
  return new Error(`Cannot resolve the admitted champion parent: ${detail}`)
}

function memberMatchesCandidate(member: PopulationMember, candidate: CandidateRecord): boolean {
  return member.candidateId === candidate.candidateId
    && member.harnessRef === candidate.sealedVersion?.commitOid
    && member.harnessDigest === candidate.sealedVersion.manifestDigest
    && digestJson(member.parentCandidateIds) === digestJson(candidate.parentCandidateIds)
    && member.metaSessionId === candidate.metaSessionId
    && digestJson(member.metaCheckpoint) === digestJson(candidate.resultCheckpoint)
    && digestJson(member.metrics) === digestJson(candidate.metrics)
}

// Keep the parent projection seed-only, even if a historical record contains
// additional round or promotion fields.
function copyMember(member: PopulationMember): PopulationMember {
  return {
    candidateId: member.candidateId,
    harnessRef: member.harnessRef,
    harnessDigest: member.harnessDigest,
    parentCandidateIds: [...member.parentCandidateIds],
    lineageRootId: member.lineageRootId,
    ...(member.metaSessionId === undefined ? {} : { metaSessionId: member.metaSessionId }),
    ...(member.metaCheckpoint === undefined ? {} : { metaCheckpoint: structuredClone(member.metaCheckpoint) }),
    metrics: structuredClone(member.metrics),
    selectedAt: member.selectedAt,
  }
}

/** Resolve from the promotion's durable origin, independently of current research survivors. */
export async function resolveChampionParent(
  spec: Readonly<EvolutionSpec>,
  champion: Readonly<ChampionState>,
  store: RefineStateStore,
): Promise<PopulationMember> {
  // A published initial harness can carry a round ID belonging to another
  // evolution. Its initial identity in this evolution is authoritative.
  if (champion.ref === spec.initialHarness.ref && champion.manifestDigest === spec.initialHarness.digest) {
    return initialParent(spec)
  }
  const sourceRoundId = champion.roundId?.replace(/^rollback:/u, '')
  if (!sourceRoundId) throw unavailable('the non-initial champion has no promotion round')
  const source = await store.readRound(sourceRoundId)
  const candidate = source?.candidatePool.find(value => value.candidateId === source.promotedCandidateId)
  if (source?.evolutionId !== spec.evolutionId || source.status !== 'accepted' || source.decision !== 'accepted'
    || candidate?.sealedVersion?.commitOid !== champion.ref
    || candidate.sealedVersion.manifestDigest !== champion.manifestDigest) {
    throw unavailable('the recorded promotion does not prove the current champion identity')
  }
  if (!candidate.metaSessionId || candidate.resultCheckpoint?.sourceSessionId !== candidate.metaSessionId
    || !Number.isSafeInteger(candidate.resultCheckpoint.eventCount) || candidate.resultCheckpoint.eventCount < 0
    || !/^sha256:[a-f0-9]{64}$/u.test(candidate.resultCheckpoint.prefixDigest)
    || candidate.metrics === undefined || !Number.isFinite(candidate.metrics.quality)
    || !Number.isFinite(candidate.metrics.taskSuccessRate)) {
    throw unavailable('the promoted candidate is missing its verified Meta checkpoint or seed metrics')
  }
  if (source.commitIntent !== undefined) {
    const intent = source.commitIntent
    const member = intent.nextPopulation.members.find(value => value.candidateId === candidate.candidateId)
    if (intent.decision !== 'accepted' || intent.promotionCandidateId !== candidate.candidateId
      || intent.nextChampion?.ref !== champion.ref || intent.nextChampion.manifestDigest !== champion.manifestDigest
      || member === undefined || !memberMatchesCandidate(member, candidate)) {
      throw unavailable('the promotion commit does not contain the original champion parent state')
    }
    return copyMember(member)
  }

  // Older accepted rounds may predate the population commit intent. Recover
  // their lineage only through the recorded parent ID and commit, never by
  // choosing another candidate which happens to have the same harness ref.
  let history: RefinementRound[] | undefined
  const visited = new Set<string>()
  const proveLineage = async (round: RefinementRound, child: CandidateRecord): Promise<string> => {
    if (visited.has(child.candidateId)) throw unavailable('the historical parent lineage contains a cycle')
    visited.add(child.candidateId)
    const parentId = child.parentCandidateIds.length === 1 ? child.parentCandidateIds[0] : undefined
    const frozen = round.championParent
    if (frozen !== undefined && frozen.candidateId === parentId && frozen.harnessRef === child.parentHarnessRef) {
      return frozen.lineageRootId
    }
    const initial = initialParent(spec)
    if (parentId === initial.candidateId && child.parentHarnessRef === initial.harnessRef) return initial.lineageRootId
    history ??= await store.listRounds()
    const parents = history.filter(value => value.evolutionId === spec.evolutionId).flatMap(value => value.candidatePool
      .filter(parent => parent.candidateId === parentId && parent.sealedVersion?.commitOid === child.parentHarnessRef)
      .map(parent => ({ round: value, candidate: parent })))
    if (parents.length !== 1) throw unavailable('the promoted candidate has no unambiguous recorded parent lineage')
    const parent = parents[0]!
    const member = parent.round.commitIntent?.nextPopulation.members.find(value => value.candidateId === parentId)
    if (member !== undefined) {
      if (!memberMatchesCandidate(member, parent.candidate)) throw unavailable('the historical parent lineage is inconsistent')
      return member.lineageRootId
    }
    return proveLineage(parent.round, parent.candidate)
  }
  return {
    candidateId: candidate.candidateId,
    harnessRef: champion.ref,
    harnessDigest: champion.manifestDigest,
    parentCandidateIds: [...candidate.parentCandidateIds],
    lineageRootId: await proveLineage(source, candidate),
    metaSessionId: candidate.metaSessionId,
    metaCheckpoint: structuredClone(candidate.resultCheckpoint),
    metrics: structuredClone(candidate.metrics),
    selectedAt: source.updatedAt,
  }
}
