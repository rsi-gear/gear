import { digestJson } from './digest.js'
import { gpuUuids } from './deployment.js'
import { parseModelEvaluationEvidence, requireContract } from './schema.js'
import type { ContentRef, ModelDecision, ModelEvaluationCondition, ModelEvaluationEvidence, ModelEvaluationRequest, ModelTrainingSpec, ModelVersion, PairedModelReport } from './types.js'

export function modelEvaluationRequest(spec: ModelTrainingSpec, model: ModelVersion, modelRef: ContentRef, partition: 'dev' | 'held-out'): ModelEvaluationRequest {
  const dataset = partition === 'dev' ? spec.datasets.dev : spec.datasets.heldOut
  const common = spec.evaluation.common
  const condition: ModelEvaluationCondition = {
    schemaVersion: 1, partition, datasetDigest: dataset.snapshotRef.digest,
    slots: dataset.tasks.flatMap(task => Array.from({ length: common.attempts }, (_, i) => ({ taskId: task.id, attempt: i + 1, environmentDigest: task.environmentRef.digest }))),
    verifierDigest: spec.verifier.digest, budgetsDigest: common.budgetsDigest, samplingDigest: common.samplingDigest,
    runtimeDigest: common.runtimeDigest, protocolDigest: common.protocolDigest, tokenizerDigest: model.tokenizerDigest,
    chatTemplateDigest: model.chatTemplateDigest, architecture: model.architecture, dtype: model.dtype,
    ...(spec.schemaVersion === 2 ? { deploymentDigest: digestJson(spec.deployment) } : {}),
  }
  return { schemaVersion: 1, subject: { harnessRef: spec.fixedHarness.manifestRef, modelVersionRef: modelRef, weightsDigest: model.weightsDigest },
    model, condition, datasetRef: dataset.snapshotRef, harnessCommit: spec.fixedHarness.commit, harnessAdapter: spec.fixedHarness.adapter,
    datasetTasks: dataset.tasks, verifierRef: spec.verifier, evaluationDevices: gpuUuids(spec.resources.evaluationDevices),
    ...(spec.schemaVersion === 2 ? { deployment: spec.deployment } : {}) }
}
export const modelEvidenceKey = (request: Pick<ModelEvaluationRequest, 'subject' | 'condition'>): string => digestJson(request)
const slotKey = (slot: { taskId: string; attempt: number }): string => JSON.stringify([slot.taskId, slot.attempt])

export function validateModelEvidence(value: unknown, request?: ModelEvaluationRequest): ModelEvaluationEvidence {
  const e = parseModelEvaluationEvidence(value)
  requireContract(e.evidenceKey === modelEvidenceKey({ subject: e.subject, condition: e.condition }), 'invalid-evidence-key', 'evaluation evidence identity mismatch')
  if (request) requireContract(e.evidenceKey === modelEvidenceKey({ subject: request.subject, condition: request.condition }), 'evaluation-drift', 'evaluation does not match the frozen subject and common conditions')
  const slots = new Set(e.condition.slots.map(slotKey))
  requireContract(slots.size === e.condition.slots.length, 'duplicate-eval-slot', 'evaluation condition has duplicate slots')
  const seen = new Set<string>(); const runs = new Set<string>()
  for (const t of e.trials) {
    const key = slotKey(t)
    requireContract(slots.has(key) && !seen.has(key) && !runs.has(t.runId), 'invalid-eval-slot', 'evidence has a duplicate or unexpected slot / run')
    seen.add(key); runs.add(t.runId)
    requireContract(!t.valid || (t.reward !== undefined && !t.inferenceError), 'invalid-eval-reward', 'valid trial needs a finite verifier reward and no inference error')
  }
  requireContract(e.complete === (seen.size === slots.size && e.trials.every(t => t.valid)), 'invalid-completeness', 'evaluation completeness does not match its slots')
  return e
}

/** A weight-only comparison uses an explicit common-condition allowlist. */
export function pairModelEvidence(beforeInput: ModelEvaluationEvidence, afterInput: ModelEvaluationEvidence): PairedModelReport {
  const before = validateModelEvidence(beforeInput); const after = validateModelEvidence(afterInput)
  requireContract(before.complete && after.complete, 'incomplete-evaluation', 'promotion requires every fixed evaluation slot')
  requireContract(digestJson(before.condition) === digestJson(after.condition)
    && before.subject.harnessRef.digest === after.subject.harnessRef.digest, 'unpaired-model-evaluation', 'model comparisons may change weights only; harness and all common conditions must match')
  const originals = new Map(before.trials.map(t => [slotKey(t), t]))
  const grouped = new Map<string, { before: number[]; after: number[] }>()
  for (const trial of after.trials) {
    const baseline = originals.get(slotKey(trial))!
    const group = grouped.get(trial.taskId) ?? { before: [], after: [] }
    group.before.push(baseline.reward!); group.after.push(trial.reward!); grouped.set(trial.taskId, group)
  }
  const avg = (xs: number[]): number => xs.reduce((sum, v) => sum + v, 0) / xs.length
  const taskDeltas = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([taskId, group]) => ({
    taskId, baseline: avg(group.before), candidate: avg(group.after), delta: avg(group.after) - avg(group.before),
  }))
  const meanDelta = avg(taskDeltas.map(t => t.delta))
  const standardError = taskDeltas.length < 2 ? null : Math.sqrt(taskDeltas.reduce((sum, t) => sum + (t.delta - meanDelta) ** 2, 0) / (taskDeltas.length - 1) / taskDeltas.length)
  return { partition: after.condition.partition, taskDeltas, meanDelta, standardError,
    inferenceErrorRate: after.trials.filter(t => t.inferenceError).length / after.condition.slots.length }
}

export function devGate(spec: ModelTrainingSpec, dev: PairedModelReport): string[] {
  const reasons: string[] = []
  if (dev.meanDelta < spec.evaluation.policy.minDevGain) reasons.push('dev-gain-below-threshold')
  if (dev.inferenceErrorRate > spec.evaluation.policy.maxInferenceErrorRate) reasons.push('dev-inference-error-rate')
  for (const task of dev.taskDeltas) if (spec.evaluation.policy.requiredTaskIds.includes(task.taskId) && task.delta < 0) reasons.push(`required-task-regression:${task.taskId}`)
  return reasons
}
export function decideModel(spec: ModelTrainingSpec, dev: PairedModelReport, heldOut: PairedModelReport): ModelDecision {
  const reasons = devGate(spec, dev)
  if (heldOut.meanDelta < -spec.evaluation.policy.maxHeldOutRegression) reasons.push('held-out-regression')
  if (heldOut.inferenceErrorRate > spec.evaluation.policy.maxInferenceErrorRate) reasons.push('held-out-inference-error-rate')
  if (heldOut.taskDeltas.some(t => spec.evaluation.policy.requiredTaskIds.includes(t.taskId) && t.delta < 0)) reasons.push('held-out-required-task-regression')
  return { outcome: reasons.length ? 'rejected' : 'accepted', reasons, dev,
    heldOut: { meanDelta: heldOut.meanDelta, standardError: heldOut.standardError, taskCount: heldOut.taskDeltas.length, inferenceErrorRate: heldOut.inferenceErrorRate } }
}
