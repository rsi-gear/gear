import { assert, digest, seal, verify, validCandidate, zeroCost } from './contracts.mjs'
import { internalScore, internalQuality } from './metrics.mjs'

export const isRoundCvTask = task => ['analysis-task@5', 'analysis-task@6'].includes(task.protocol)

// A round is identified by its frozen starting checkpoint, never by the harness,
// slot, current branch head or wall clock. Recovery therefore cannot resample it.
export function roundValidation(task, startingCheckpointDigest) {
  if (!isRoundCvTask(task)) return null
  const seed = Number.parseInt(digest({ policy: task.validationPlanDigest, round: startingCheckpointDigest }).slice(7, 15), 16)
  return { protocol: 'analysis-round-cv-plan@1', policyDigest: task.validationPlanDigest,
    roundDigest: startingCheckpointDigest, trainDigest: task.inputs.trainDigest,
    metric: task.prediction.metric, kind: task.prediction.metric === 'mean-column-wise-rmsle' ? 'kfold' : 'stratified',
    folds: 5, shuffle: true, seed, splitter: 'python-random-stratified-round-robin@1' }
}

export function validateRoundValidation(plan, task) {
  assert(isRoundCvTask(task) && plan?.roundDigest, 'round CV plan required')
  assert(digest(plan) === digest(roundValidation(task, plan.roundDigest)), 'round CV plan changed')
  return plan
}

export function requestValidationDigest(request) {
  return request.roundValidation ? digest(request.roundValidation) : request.task.validationPlanDigest
}

export function experimentValidationDigest(experiment) {
  return experiment.protocol === 'analysis-experiment@5' ? experiment.analysis?.validation?.digest : experiment.validationPlanDigest
}

// A CV selection cites an existing trusted rollout. It performs no additional
// training, prediction or evaluation and is not an independent test score.
export function cvSelection(plan, steps, solutionDigest) {
  assert(isRoundCvTask(plan.task), 'CV selection requires a round CV task')
  const scope = digest(plan.roundValidation)
  const step = [...steps].reverse().find(s => validCandidate(s.experiment)
    && s.experiment.sourceDigest === solutionDigest && experimentValidationDigest(s.experiment) === scope)
  assert(!solutionDigest || step, 'selected source has no current-round CV evidence')
  if (step) verify(step)
  const e = step?.experiment
  return seal({ protocol: 'analysis-cv-selection@1', status: step ? 'completed' : 'candidate_failed',
    evaluationKind: 'round_five_fold_cv', validationPlanDigest: scope,
    solutionDigest, experimentId: e?.experimentId ?? null, sourceReceiptDigest: step?.digest ?? null,
    quality: step ? internalQuality(e) : 0, metric: plan.task.prediction.metric,
    score: e ? internalScore(e) : null, accuracy: e && plan.task.prediction.metric === 'accuracy' ? internalScore(e) : null,
    stdScore: e?.execution.stdScore ?? null, foldMetrics: e?.execution.foldMetrics ?? [],
    runId: step?.runId ?? null, outputManifestDigest: step?.outputManifestDigest ?? null,
    modelRequests: 0, fits: 0, searchCalls: 0, cost: zeroCost() })
}
