import { assert, digest, seal, verify } from './contracts.mjs'
import { internalQuality } from './metrics.mjs'
import { experimentValidationDigest } from './validation.mjs'

/** Auxiliary scores cannot alter the immutable sequence receipt or its C5. */
export function trajectoryReport(receipt, start, experiments, audit) {
  verify(receipt); assert(receipt.protocol === 'analysis-sequence-receipt@1', 'not a sequence receipt')
  audit ??= { sequenceReceiptDigest: receipt.digest, selectionDigest: digest(receipt.selections), solutions: {}, cost: null }
  assert(audit.sequenceReceiptDigest === receipt.digest && audit.selectionDigest === digest(receipt.selections), 'audit belongs to different choices')
  const cv = receipt.delivery.protocol === 'analysis-cv-selection@1'
  const currentCv = experiments.filter(e => ['completed', 'reused'].includes(e.execution.status)
    && experimentValidationDigest(e) === receipt.delivery.validationPlanDigest)
  const score = id => id === null ? 0 : cv ? internalQuality(currentCv.findLast(e => e.sourceDigest === id) ?? { execution: {} })
    : audit.solutions[id]?.status === 'completed' ? audit.solutions[id].quality ?? audit.solutions[id].accuracy
    : audit.solutions[id]?.status === 'candidate_failed' ? 0 : null
  const initial = start.currentSolutionDigest === null ? null : score(start.currentSolutionDigest)
  const points = receipt.selections.map((s, i) => ({ slotIndex: i + 1, solutionDigest: s.incumbentSolutionDigest,
    evidenceRole: cv ? 'current_round_cv' : i === 4 ? 'actual_delivery' : 'solution_audit', value: i === 4 ? receipt.total_score : score(s.incumbentSolutionDigest),
    carryForward: s.carryForward, status: s.status }))
  const pool = [...new Set([start.currentSolutionDigest, ...experiments.filter(e => ['completed', 'reused'].includes(e.execution.status)).map(e => e.sourceDigest)].filter(Boolean))]
  // A valid actual delivery is also evidence for that exact solution identity.
  const values = pool.map(id => id === receipt.delivery.solutionDigest && receipt.valid_output === 1 ? receipt.total_score : score(id))
  const known = values.filter(v => v !== null)
  const complete = values.length > 0 && known.length === values.length
  const mean = points.every(p => p.value !== null) ? points.reduce((a, p) => a + p.value, 0) / 5 : null
  const best = complete ? Math.max(...known) : null
  return seal({ protocol: 'analysis-trajectory-report@1', sequenceReceiptDigest: receipt.digest, points,
    ...(receipt.delivery.metric ? { metric: receipt.delivery.metric, actualRawScore: receipt.delivery.score,
      utilityTransform: receipt.delivery.metric === 'mean-column-wise-rmsle' ? cv ? 'mean(1/(1+fold_score))' : '1/(1+score)' : 'identity' } : {}),
    ...(cv ? { evaluationKind: 'round_five_fold_cv', independentTest: false, validationPlanDigest: receipt.delivery.validationPlanDigest } : {}),
    final_quality_5: receipt.total_score, final_gain_from_start: initial === null ? null : receipt.total_score - initial,
    incumbent_slot_mean_5: mean, progress_gain_mean_5: initial === null || mean === null ? null : mean - initial,
    oracle_best_5: best, known_best_lower_bound: known.length ? Math.max(...known) : null,
    selection_loss_5: best === null || receipt.valid_output !== 1 ? null : best - receipt.total_score,
    curveCoverage: mean === null ? 'incomplete' : 'complete', oracleCoverage: complete ? 'complete' : 'incomplete',
    auditCost: audit.cost })
}
