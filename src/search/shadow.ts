import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { EvaluationEvidence } from '../types.js'
import { isExactGitCommit } from '../types.js'
import { digestJson } from '../state/digest.js'
import { comparisonKey, digest, invariant, numeric, seal, sorted, weightedMean } from './contracts.js'

export interface SearchShadowReport {
  kind: 'legacy-search-shadow-replay'
  advisory: true
  championChanged: false
  sources: Array<{ path: string; bytes: number; sha256: string; evidenceDigest: string; evidenceDigestAlgorithm: 'json-stringify-sha256'; commit: string }>
  sourceBytesUnchanged: true
  assumptions: { comparisonQuantum: number; weighting: 'uniform-per-task'; repetitions: 'one-observed-trial-per-task'; outcomeDirection: 'maximize'; processDirection: 'maximize-assumed'; process: 'observed-legacy-scalar-only' }
  comparison: { pairedTasks: number; baselineOutcome: number; candidateOutcome: number; outcomeImprovedTaskIds: string[]; outcomeRegressedTaskIds: string[];
    processImprovedTaskIds: string[]; processRegressedTaskIds: string[]; missingProcessTaskIds: string[]; baselineProcess?: number; candidateProcess?: number }
  suggestions: Array<{ advisory: true; action: 'investigate-specialist' | 'investigate-regressions' | 'no-release-decision'; taskIds: string[]; reasonCodes: string[] }>
  heldOut: 'not-evaluated'
  v2CellReuse: 'not-certified'
  digest: string
}
interface LegacyCache { contextDigest: string; evidenceHash: string; evidence: EvaluationEvidence }
const hash = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
function checkedCache(bytes: Uint8Array): LegacyCache {
  const cache = JSON.parse(Buffer.from(bytes).toString('utf8')) as LegacyCache, e = cache.evidence
  // The documented unified-cache-v1 adapter hashes JSON.stringify, preserving insertion order.
  invariant(e && cache.evidenceHash === hash(Buffer.from(JSON.stringify(e))), 'historical evidence digest mismatch')
  digest(cache.contextDigest)
  invariant(e.completeness === 'complete' && e.invalidTrials.length === 0 && e.plannedTrialCount === e.trials.length && e.trials.length > 0, 'shadow replay requires a complete historical trial manifest')
  invariant(isExactGitCommit(e.actualCommit) && e.actualCommit === e.requestedCommit, 'historical code identity mismatch')
  invariant(sorted(e.trials.map(t => t.taskName)).length === e.trials.length, 'shadow replay does not infer logical slots from duplicate/retried tasks')
  for (const trial of e.trials) invariant(trial.status === 'completed' && trial.attempt === 1 && trial.runId && trial.scores?.normalization === 'standard'
    && Number.isFinite(trial.scores.totalScore) && (trial.scores.processScore === undefined || Number.isFinite(trial.scores.processScore)), 'shadow replay requires one explicit valid standardized observation per task')
  return cache
}

/** Read-only analysis of the documented legacy single-trial case. No v2 execution identity is inferred. */
export async function replaySearchCase(baselinePath: string, candidatePath: string, comparisonQuantum = 0.000001): Promise<SearchShadowReport> {
  comparisonKey(0, comparisonQuantum)
  const paths = [resolve(baselinePath), resolve(candidatePath)], before = await Promise.all(paths.map(path => readFile(path)))
  const [a, b] = before.map(checkedCache) as [LegacyCache, LegacyCache]
  invariant(a.contextDigest === b.contextDigest && a.evidence.provider === b.evidence.provider
    && a.evidence.conditionId === b.evidence.conditionId && a.evidence.effectiveConfigDigest === b.evidence.effectiveConfigDigest
    && a.evidence.dataset === b.evidence.dataset && digestJson(a.evidence.benchmark) === digestJson(b.evidence.benchmark), 'historical evaluation conditions differ')
  const taskIds = sorted(a.evidence.trials.map(t => t.taskName))
  invariant(digestJson(taskIds) === digestJson(sorted(b.evidence.trials.map(t => t.taskName))), 'historical task manifests differ')
  const rows = taskIds.map(taskId => ({ taskId, a: a.evidence.trials.find(t => t.taskName === taskId)!.scores!, b: b.evidence.trials.find(t => t.taskName === taskId)!.scores! }))
  const gain = (a: number, b: number) => comparisonKey(b, comparisonQuantum) - comparisonKey(a, comparisonQuantum)
  const mean = (values: number[]) => numeric(weightedMean(values.map(value => ({ value, weight: 1 }))))
  const outcomeImprovedTaskIds = rows.filter(r => gain(r.a.totalScore, r.b.totalScore) > 0n).map(r => r.taskId)
  const outcomeRegressedTaskIds = rows.filter(r => gain(r.a.totalScore, r.b.totalScore) < 0n).map(r => r.taskId)
  const processRows = rows.filter(r => r.a.processScore !== undefined && r.b.processScore !== undefined)
  const processImprovedTaskIds = processRows.filter(r => gain(r.a.processScore!, r.b.processScore!) > 0n).map(r => r.taskId)
  const processRegressedTaskIds = processRows.filter(r => gain(r.a.processScore!, r.b.processScore!) < 0n).map(r => r.taskId)
  const suggestions: SearchShadowReport['suggestions'] = []
  const improvement = sorted([...outcomeImprovedTaskIds, ...processImprovedTaskIds])
  if (improvement.length) suggestions.push({ advisory: true, action: 'investigate-specialist', taskIds: improvement, reasonCodes: ['observed-task-improvement', 'requires-frozen-scope-and-new-evidence'] })
  if (outcomeRegressedTaskIds.length || processRegressedTaskIds.length) suggestions.push({ advisory: true, action: 'investigate-regressions', taskIds: sorted([...outcomeRegressedTaskIds, ...processRegressedTaskIds]), reasonCodes: ['observed-regression-not-offset-by-other-task-gains'] })
  suggestions.push({ advisory: true, action: 'no-release-decision', taskIds: [], reasonCodes: ['independent-held-out-not-evaluated', 'legacy-metric-contracts-not-certified', 'no-champion-or-archive-write'] })
  const after = await Promise.all(paths.map(path => readFile(path)))
  invariant(before.every((bytes, i) => bytes.equals(after[i]!)), 'historical source changed during shadow replay')
  return seal({ kind: 'legacy-search-shadow-replay' as const, advisory: true as const, championChanged: false as const,
    sources: before.map((bytes, i) => ({ path: paths[i]!, bytes: bytes.length, sha256: hash(bytes), evidenceDigest: [a, b][i]!.evidenceHash, evidenceDigestAlgorithm: 'json-stringify-sha256' as const, commit: [a, b][i]!.evidence.actualCommit })),
    sourceBytesUnchanged: true as const, assumptions: { comparisonQuantum, weighting: 'uniform-per-task' as const, repetitions: 'one-observed-trial-per-task' as const, outcomeDirection: 'maximize' as const, processDirection: 'maximize-assumed' as const, process: 'observed-legacy-scalar-only' as const },
    comparison: { pairedTasks: taskIds.length, baselineOutcome: mean(rows.map(r => r.a.totalScore)), candidateOutcome: mean(rows.map(r => r.b.totalScore)),
      outcomeImprovedTaskIds, outcomeRegressedTaskIds, processImprovedTaskIds, processRegressedTaskIds, missingProcessTaskIds: rows.filter(r => r.a.processScore === undefined || r.b.processScore === undefined).map(r => r.taskId),
      ...(processRows.length === rows.length ? { baselineProcess: mean(rows.map(r => r.a.processScore!)), candidateProcess: mean(rows.map(r => r.b.processScore!)) } : {}) },
    suggestions, heldOut: 'not-evaluated' as const, v2CellReuse: 'not-certified' as const })
}
