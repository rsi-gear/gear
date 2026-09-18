import type { EvolutionRegistryEntry, RefinementRound } from '../types.js'

export const EXPERIMENTS_TSV_COLUMNS = [
  'evolution_id',
  'evolution_name',
  'round_id',
  'candidate_id',
  'status',
  'parent_commit',
  'candidate_commit',
  'candidate_tree',
  'immutable_ref',
  'seed_eval_id',
  'seed_score',
  'heldout_eval_id',
  'heldout_score',
  'decision',
  'selection_role',
  'record_path',
  'updated_at',
  'evaluation_mode',
] as const

export interface ExperimentIndexEvolution {
  entry: EvolutionRegistryEntry
  rounds: RefinementRound[]
}

function cell(value: string | number | undefined): string {
  if (value === undefined) return ''
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('\t', '\\t')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
}

function decision(round: RefinementRound, candidateId: string): string | undefined {
  if (round.promotedCandidateId === candidateId) return 'promoted'
  if (round.searchMode) {
    if (round.searchOutcome?.nomineeId === candidateId) return round.searchOutcome.promotion?.outcome ?? 'insufficient-evidence'
    if (round.searchOutcome?.findings.some(f => f.candidateId === candidateId)) return 'retained-local'
    return round.candidatePool.find(c => c.candidateId === candidateId)?.status === 'failed' ? 'generation-failed' : undefined
  }
  if (round.decision !== undefined) return round.decision
  if (round.status === 'failed') return 'failed'
  if (round.selection?.selectedCandidateIds.includes(candidateId) === true) return 'selected'
  return undefined
}

function selectionRole(round: RefinementRound, candidateId: string): string | undefined {
  if (round.searchMode) return round.searchOutcome?.nomineeId === candidateId ? 'global-nominee'
    : round.searchOutcome?.findings.some(f => f.candidateId === candidateId) ? 'local-research' : undefined
  if (round.promotionCandidateId === candidateId || round.selection?.promotionCandidateId === candidateId) return 'finalist'
  if (round.selection?.selectedCandidateIds.includes(candidateId) === true) return 'survivor'
  return undefined
}

export function serializeExperimentsTsv(evolutions: readonly ExperimentIndexEvolution[]): string {
  const rows = evolutions
    .flatMap(({ entry, rounds }) => rounds.flatMap(round => round.candidatePool.map(candidate => ({
      sortKey: [entry.evolutionId, round.roundId, candidate.candidateId].join('\0'),
      cells: [
        entry.evolutionId,
        entry.name,
        round.roundId,
        candidate.candidateId,
        candidate.status,
        candidate.parentHarnessRef,
        candidate.sealedVersion?.commitOid,
        candidate.sealedVersion?.treeOid,
        candidate.sealedVersion?.immutableRef,
        candidate.seedEvaluation?.evalId,
        candidate.seedEvaluation?.primaryReward,
        candidate.heldOutEvaluation?.evalId,
        candidate.heldOutEvaluation?.primaryReward,
        decision(round, candidate.candidateId),
        selectionRole(round, candidate.candidateId),
        `evolutions/${entry.evolutionId}/rounds/${round.roundId}.json`,
        round.updatedAt,
        round.evaluationMode ?? 'held-out',
      ],
    }))))
    .sort((left, right) => left.sortKey < right.sortKey ? -1 : left.sortKey > right.sortKey ? 1 : 0)
  return `${[
    EXPERIMENTS_TSV_COLUMNS.join('\t'),
    ...rows.map(row => row.cells.map(cell).join('\t')),
  ].join('\n')}\n`
}
