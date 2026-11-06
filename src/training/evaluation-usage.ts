import { modelEvaluationRequest, validateModelEvidence } from './evaluation.js'
import { parseModelVersion, requireContract } from './schema.js'
import type { ModelTrainingStore } from './store.js'
import type { EvaluationUsage, ModelEvaluator, ModelExperimentState, ModelTrainingRun, ModelVersion, ReadyEvaluationEndpointBinding } from './types.js'

export async function savedEvaluationBinding(store: ModelTrainingStore, state: ModelExperimentState, model: ModelVersion,
  intentId?: string, runId?: string): Promise<ReadyEvaluationEndpointBinding> {
  const attempt = runId && intentId ? state.runs[runId]?.evaluationIntents[intentId]?.attempts?.at(-1) : undefined
  if (attempt) return store.readJson<ReadyEvaluationEndpointBinding>(attempt.bindingRef)
  const preparation = state.endpointPreparations?.[model.id]
  requireContract(preparation?.status === 'ready' && preparation.bindingRef, 'endpoint-preparation-missing', 'pending evaluation must retain its original ready model binding')
  return store.readJson<ReadyEvaluationEndpointBinding>(preparation.bindingRef)
}

/** A provider key survives run closure. Unknown shared GPU time never becomes zero. */
export async function chargeEvaluationUsage(store: ModelTrainingStore, state: ModelExperimentState,
  runId: string, intentId: string, observation: EvaluationUsage): Promise<void> {
  const gpuSeconds = observation.gpuSeconds
  requireContract((gpuSeconds === null && observation.gpuSecondsSource === null)
    || typeof gpuSeconds === 'number' && Number.isFinite(gpuSeconds) && gpuSeconds >= 0 && typeof observation.gpuSecondsSource === 'string'
      && observation.gpuSecondsSource.length > 0, 'invalid-evaluation-usage', 'GPU usage requires a reliable attribution source or an explicit unknown value')
  const saved = state.runs[runId]!.evaluationIntents[intentId]!
  let charged = 0
  for (const run of Object.values(state.runs)) for (const intent of Object.values(run.evaluationIntents)) {
    if (intent.key !== saved.key) continue
    const evidence = intent.evidenceRef ? validateModelEvidence(await store.readJson(intent.evidenceRef)) : undefined
    const amount = intent.chargedGpuSeconds ?? evidence?.gpuSeconds
    if (amount === null || amount === undefined) continue
    requireContract(Number.isFinite(amount) && amount >= 0, 'invalid-evaluation-usage', 'saved evaluation charge is invalid')
    charged = Math.max(charged, amount)
  }
  if (gpuSeconds !== null) {
    for (const run of Object.values(state.runs)) for (const intent of Object.values(run.evaluationIntents)) {
      requireContract(!intent.gpuSecondsSource || intent.gpuSecondsSource === observation.gpuSecondsSource,
        'evaluation-metering-source-drift', 'shared GPU attribution source changed')
    }
    saved.chargedGpuSeconds = Math.max(charged, gpuSeconds)
    saved.gpuSecondsSource = observation.gpuSecondsSource!
  }
  for (const key of ['inputTokens', 'outputTokens', 'requests', 'elapsedSeconds'] as const) {
    const value = observation[key]
    requireContract(value === undefined || Number.isFinite(value) && value >= 0 && (key === 'elapsedSeconds' || Number.isSafeInteger(value)),
      'invalid-evaluation-usage', 'evaluation usage must be nonnegative with integer token and request counts')
  }
  requireContract(!['inputTokens', 'outputTokens', 'requests'].some(key => observation[key as keyof EvaluationUsage] !== undefined)
    || typeof observation.usageSource === 'string' && observation.usageSource.length > 0, 'invalid-evaluation-usage', 'token and request usage must retain its collection source')
  const observedUsage: EvaluationUsage = { ...observation }
  for (const run of Object.values(state.runs)) for (const intent of Object.values(run.evaluationIntents)) {
    if (intent.key !== saved.key) continue
    for (const key of ['inputTokens', 'outputTokens', 'requests', 'elapsedSeconds'] as const) {
      const previous = intent.observedUsage?.[key]
      if (previous !== undefined && observation[key] !== undefined) observedUsage[key] = Math.max(previous, observedUsage[key]!)
    }
  }
  // A missing current meter keeps the lower bound, while total cost becomes
  // unknown. Updating every duplicate key prevents a closed run from retaining
  // an obsolete unknown observation after the same provider task is reconciled.
  for (const run of Object.values(state.runs)) for (const intent of Object.values(run.evaluationIntents)) {
    if (intent.key === saved.key) intent.observedUsage = structuredClone(observedUsage)
  }
  const intents = new Map<string, { amount: number; usage: EvaluationUsage | undefined }>()
  for (const run of Object.values(state.runs)) for (const intent of Object.values(run.evaluationIntents)) {
    const previous = intents.get(intent.key)
    intents.set(intent.key, { amount: Math.max(previous?.amount ?? 0, intent.chargedGpuSeconds ?? 0), usage: intent.observedUsage ?? previous?.usage })
  }
  const aggregate: EvaluationUsage = { gpuSeconds: null, gpuSecondsSource: null }
  const unique = [...intents.values()]
  if (unique.length > 0 && unique.every(intent => intent.usage?.gpuSeconds !== undefined && intent.usage.gpuSeconds !== null)) {
    aggregate.gpuSeconds = unique.reduce((sum, intent) => sum + intent.amount, 0)
    aggregate.gpuSecondsSource = unique[0]!.usage!.gpuSecondsSource
  }
  for (const key of ['inputTokens', 'outputTokens', 'requests', 'elapsedSeconds'] as const) {
    if (unique.length > 0 && unique.every(intent => intent.usage?.[key] !== undefined)) aggregate[key] = unique.reduce((sum, intent) => sum + intent.usage![key]!, 0)
  }
  const sources = new Set(unique.map(intent => intent.usage?.usageSource).filter((source): source is string => source !== undefined))
  if (sources.size === 1) aggregate.usageSource = [...sources][0]!
  state.evaluationUsage = aggregate
}

/** Observation never submits, cancels, repairs, or establishes GPU release. */
export async function refreshEvaluationUsage(store: ModelTrainingStore, evaluator: ModelEvaluator,
  state: ModelExperimentState, run: ModelTrainingRun): Promise<void> {
  if (run.decision || !evaluator.observeUsage) return
  for (const [intentId, intent] of Object.entries(run.evaluationIntents)) {
    if (intent.evidenceRef && validateModelEvidence(await store.readJson(intent.evidenceRef)).complete) continue
    const [role, partition] = intentId.split(':') as [string, 'dev' | 'held-out']
    const modelRef = role === 'baseline' ? run.parent.modelRef : run.candidateRef!
    const model = parseModelVersion(await store.readJson(modelRef))
    const binding = await savedEvaluationBinding(store, state, model, intentId, run.id)
    const observed = await evaluator.observeUsage(modelEvaluationRequest(state.spec, model, modelRef, partition, binding), `${state.id}/${intent.key}`)
    await store.transaction(state.id, s => chargeEvaluationUsage(store, s, run.id, intentId, observed))
  }
}
