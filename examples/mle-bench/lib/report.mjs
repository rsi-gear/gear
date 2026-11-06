import { assert, digest, seal, verify } from './contracts.mjs'

/** Auxiliary scores cannot alter the immutable sequence receipt or its final delivery. */
export function trajectoryReport(receipt, start, experiments, audit) {
  verify(receipt); assert(receipt.protocol === 'analysis-sequence-receipt@1', 'not a sequence receipt')
  audit ??= { sequenceReceiptDigest: receipt.digest, selectionDigest: digest(receipt.selections), solutions: {}, cost: null }
  assert(audit.sequenceReceiptDigest === receipt.digest && audit.selectionDigest === digest(receipt.selections), 'audit belongs to different choices')
  const score = id => id === null ? 0 : audit.solutions[id]?.status === 'completed' ? audit.solutions[id].quality ?? audit.solutions[id].accuracy
    : audit.solutions[id]?.status === 'candidate_failed' ? 0 : null
  const initial = start.currentSolutionDigest === null ? null : score(start.currentSolutionDigest)
  const points = receipt.selections.map((s, i) => ({ slotIndex: i + 1, solutionDigest: s.incumbentSolutionDigest,
    evidenceRole: i === receipt.planned - 1 ? 'actual_delivery' : 'solution_audit', value: i === receipt.planned - 1 ? receipt.total_score : score(s.incumbentSolutionDigest),
    carryForward: s.carryForward, status: s.status }))
  const pool = [...new Set([start.currentSolutionDigest, ...experiments.filter(e => ['completed', 'reused'].includes(e.execution.status)).map(e => e.sourceDigest)].filter(Boolean))]
  // A valid actual delivery is also evidence for that exact solution identity.
  const values = pool.map(id => id === receipt.delivery.solutionDigest && receipt.valid_output === 1 ? receipt.total_score : score(id))
  const known = values.filter(v => v !== null)
  const complete = values.length > 0 && known.length === values.length
  const mean = points.every(p => p.value !== null) ? points.reduce((a, p) => a + p.value, 0) / receipt.planned : null
  const best = complete ? Math.max(...known) : null
  return seal({ protocol: 'analysis-trajectory-report@2', planned: receipt.planned, sequenceReceiptDigest: receipt.digest, points,
    ...(receipt.delivery.metric ? { metric: receipt.delivery.metric, actualRawScore: receipt.delivery.score,
      utilityTransform: receipt.delivery.metric === 'mean-column-wise-rmsle' ? '1/(1+score)' : 'identity' } : {}),
    final_quality: receipt.total_score, final_gain_from_start: initial === null ? null : receipt.total_score - initial,
    incumbent_slot_mean: mean, progress_gain_mean: initial === null || mean === null ? null : mean - initial,
    oracle_best: best, known_best_lower_bound: known.length ? Math.max(...known) : null,
    selection_loss: best === null || receipt.valid_output !== 1 ? null : best - receipt.total_score,
    curveCoverage: mean === null ? 'incomplete' : 'complete', oracleCoverage: complete ? 'complete' : 'incomplete',
    auditCost: audit.cost })
}
