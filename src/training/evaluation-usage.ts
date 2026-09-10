import { modelEvaluationRequest, validateModelEvidence } from './evaluation.js'
import { parseModelVersion, requireContract } from './schema.js'
import type { ModelTrainingStore } from './store.js'
import type { ModelEvaluator, ModelExperimentState, ModelTrainingRun } from './types.js'

/** Called inside the experiment transaction. A provider key survives run closure. */
export async function chargeEvaluationUsage(store: ModelTrainingStore, state: ModelExperimentState,
  runId: string, intentId: string, gpuSeconds: number): Promise<void> {
  requireContract(Number.isFinite(gpuSeconds) && gpuSeconds >= 0, 'invalid-evaluation-usage', 'evaluation GPU usage must be finite and nonnegative')
  const saved = state.runs[runId]!.evaluationIntents[intentId]!
  let charged = 0
  for (const run of Object.values(state.runs)) for (const intent of Object.values(run.evaluationIntents)) {
    if (intent.key !== saved.key) continue
    // Older state charged completed evidence before chargedGpuSeconds existed.
    const amount = intent.chargedGpuSeconds ?? (intent.evidenceRef ? validateModelEvidence(await store.readJson(intent.evidenceRef)).gpuSeconds : 0)
    requireContract(Number.isFinite(amount) && amount >= 0, 'invalid-evaluation-usage', 'saved evaluation charge is invalid')
    charged = Math.max(charged, amount)
  }
  // A slow observation may arrive after a newer cancellation/usage reply.
  // Merge their high water mark without charging the same provider time twice.
  state.usage.gpuSeconds += Math.max(0, gpuSeconds - charged)
  saved.chargedGpuSeconds = Math.max(charged, gpuSeconds)
}

/** Observation never submits, cancels, repairs, or establishes GPU release. */
export async function refreshEvaluationUsage(store: ModelTrainingStore, evaluator: ModelEvaluator,
  state: ModelExperimentState, run: ModelTrainingRun): Promise<void> {
  if (state.spec.schemaVersion !== 2 || run.decision) return
  for (const [intentId, intent] of Object.entries(run.evaluationIntents)) {
    if (intent.evidenceRef && validateModelEvidence(await store.readJson(intent.evidenceRef)).complete) continue
    requireContract(evaluator.observeUsage, 'evaluation-usage-unavailable', 'v2 evaluation requires read-only cumulative GPU usage')
    const [role, partition] = intentId.split(':') as [string, 'dev' | 'held-out']
    const modelRef = role === 'baseline' ? run.parent.modelRef : run.candidateRef!
    const model = parseModelVersion(await store.readJson(modelRef))
    const observed = await evaluator.observeUsage(modelEvaluationRequest(state.spec, model, modelRef, partition), `${state.id}/${intent.key}`)
    // A controller intent can precede its evaluator journal. Reconcile that same
    // intent normally; absence is not zero cost and does not release ownership.
    if (observed.gpuSeconds === null) continue
    await store.transaction(state.id, s => chargeEvaluationUsage(store, s, run.id, intentId, observed.gpuSeconds!))
  }
}
