import type { ArtifactRef, BindingSchema, BindingSetRef, OperationOutcome } from '../contracts.js'
import { ALGORITHM_API_VERSION } from '../contracts.js'
import { FileArtifactStore } from '../artifacts.js'
import { type JsonValue } from '../schema.js'
import { defineWorkflow, parallel, task } from '../steps.js'
import { implementationClosureDigest } from '../data/identity.js'
import { decideModel, devGate, pairModelEvidence, validateModelEvidence } from '../../training/evaluation.js'
import { parseModelTrainingSpec, requireContract } from '../../training/schema.js'
import type * as T from '../../training/types.js'

type RecipeState = { baseline: BindingSetRef; candidateBindingRef: ArtifactRef | null; candidateSetRef: BindingSetRef | null;
  dev: { baseline: ArtifactRef; candidate: ArtifactRef } | null; heldOut: { baseline: ArtifactRef; candidate: ArtifactRef } | null;
  decision: JsonValue | null; reason: string | null }
type RecipeOptions = { plan: T.ModelTrainingSpec; bindingSchema: BindingSchema; learnerSlot: string; harnessSlot: string;
  artifacts: FileArtifactStore; trainingLimits: { trainingGpuSeconds: number; rolloutTokens: number; groupResamples: number };
  evaluationGpuSeconds: number }

function resultRef(outcome: OperationOutcome | undefined, field: string): ArtifactRef | null {
  if (outcome?.kind !== 'result' || !outcome.value || typeof outcome.value !== 'object' || Array.isArray(outcome.value)) return null
  const ref = (outcome.value as Record<string, unknown>)[field] as ArtifactRef | undefined
  return ref?.kind === 'artifact' && typeof ref.digest === 'string' ? ref : null
}
function evidencePair(artifacts: FileArtifactStore, pair: RecipeState['dev']): [T.ModelEvaluationEvidence, T.ModelEvaluationEvidence] {
  requireContract(pair, 'missing-evaluation', 'paired model evidence is unavailable')
  return [validateModelEvidence(artifacts.getJson(pair.baseline)), validateModelEvidence(artifacts.getJson(pair.candidate))]
}

/** Fixed-Harness GRPO: train, create an explicit candidate binding, compare independent evaluations, then transition only if accepted. */
export function fixedHarnessGrpoRecipe(options: RecipeOptions) {
  const plan = parseModelTrainingSpec(options.plan)
  requireContract(options.bindingSchema.slots[options.learnerSlot]?.replaceable === true
    && options.bindingSchema.slots[options.harnessSlot]?.replaceable !== true,
  'invalid-grpo-bindings', 'learner must be replaceable and the Harness must be immutable')
  requireContract(options.evaluationGpuSeconds > 0, 'invalid-grpo-budget', 'evaluation GPU reservation must be positive')
  const trainingInput = { plan, learnerSlot: options.learnerSlot, harnessSlot: options.harnessSlot } as unknown as JsonValue
  const implementationDigest = implementationClosureDigest(['recipes/grpo'], { plan, bindingSchema: options.bindingSchema,
    learnerSlot: options.learnerSlot, harnessSlot: options.harnessSlot, trainingLimits: options.trainingLimits,
    evaluationGpuSeconds: options.evaluationGpuSeconds })
  const initial = (baseline: BindingSetRef): RecipeState => ({ baseline, candidateBindingRef: null, candidateSetRef: null,
    dev: null, heldOut: null, decision: null, reason: null })
  const evaluation = (partition: 'dev' | 'held-out', state: RecipeState) => {
    if (!state.candidateSetRef) return []
    const input = { plan, learnerSlot: options.learnerSlot, harnessSlot: options.harnessSlot, partition } as unknown as JsonValue
    return parallel(
      task(`baseline-${partition}`, 'model.evaluate', input, { bindingSetRef: state.baseline,
        limits: { evaluationGpuSeconds: options.evaluationGpuSeconds } }),
      task(`candidate-${partition}`, 'model.evaluate', input, { bindingSetRef: state.candidateSetRef,
        limits: { evaluationGpuSeconds: options.evaluationGpuSeconds } }),
    )
  }
  return defineWorkflow({
    manifest: { id: 'fixed-harness-grpo', apiVersion: ALGORITHM_API_VERSION, implementationDigest,
      configSchema: { type: 'object', additionalProperties: true }, bindingSchema: options.bindingSchema },
    businessStateSchema: { type: 'object', additionalProperties: true },
    initialState: context => initial(context.activeBindingSetRef) as unknown as JsonValue,
    steps: [
      { name: 'train', plan: () => [task('train', 'training.slime', trainingInput, { limits: options.trainingLimits })],
        join: ({ state, completed }) => {
          const next = state as RecipeState
          const candidateBindingRef = resultRef(completed.train, 'candidateBindingRef')
          return { state: { ...next, candidateBindingRef, reason: candidateBindingRef ? null : completed.train?.kind ?? 'training missing' } as unknown as JsonValue }
        } },
      { name: 'candidate-binding', plan: ({ state }) => {
          const current = state as RecipeState
          return current.candidateBindingRef ? [task('derive-candidate', 'bindings.derive',
            { baseRef: current.baseline, replacements: { [options.learnerSlot]: current.candidateBindingRef } } as unknown as JsonValue)] : []
        }, join: ({ state, completed }) => {
          const current = state as RecipeState
          const outcome = completed['derive-candidate']
          const candidateSetRef = outcome?.kind === 'result' && outcome.value && typeof outcome.value === 'object' && !Array.isArray(outcome.value)
            ? (outcome.value as Record<string, unknown>).bindingSetRef as BindingSetRef : null
          return { state: { ...current, candidateSetRef,
            reason: current.candidateBindingRef && !candidateSetRef ? 'candidate binding derivation failed' : current.reason } as unknown as JsonValue }
        } },
      { name: 'dev', plan: ({ state }) => evaluation('dev', state as RecipeState), join: ({ state, completed }) => {
          const current = state as RecipeState
          const baseline = resultRef(completed['baseline-dev'], 'evidenceRef')
          const candidate = resultRef(completed['candidate-dev'], 'evidenceRef')
          return { state: { ...current, dev: baseline && candidate ? { baseline, candidate } : null,
            reason: current.candidateSetRef && !(baseline && candidate) ? 'dev evaluation incomplete' : current.reason } as unknown as JsonValue }
        } },
      { name: 'held-out', plan: ({ state }) => {
          const current = state as RecipeState
          if (!current.dev || plan.evaluation.policy.maxHeldOutEvaluations < 1) return []
          const dev = pairModelEvidence(...evidencePair(options.artifacts, current.dev))
          return devGate(plan, dev).length ? [] : evaluation('held-out', current)
        }, join: ({ state, completed }) => {
          const current = state as RecipeState
          if (current.dev) {
            const dev = pairModelEvidence(...evidencePair(options.artifacts, current.dev))
            const reasons = devGate(plan, dev)
            if (reasons.length) return { state: { ...current,
              decision: { outcome: 'rejected', reasons, dev } } as unknown as JsonValue }
          }
          const baseline = resultRef(completed['baseline-held-out'], 'evidenceRef')
          const candidate = resultRef(completed['candidate-held-out'], 'evidenceRef')
          if (!current.dev || !baseline || !candidate || !current.candidateSetRef) return { state: { ...current,
            decision: { outcome: 'inconclusive', reasons: [current.reason ?? 'held-out evaluation incomplete'] } } as unknown as JsonValue }
          const dev = pairModelEvidence(...evidencePair(options.artifacts, current.dev))
          const heldOut = pairModelEvidence(...evidencePair(options.artifacts, { baseline, candidate }))
          const decision = decideModel(plan, dev, heldOut)
          return { state: { ...current, heldOut: { baseline, candidate }, decision } as unknown as JsonValue,
            ...(decision.outcome === 'accepted' ? { bindingTransition: current.candidateSetRef } : {}) }
        } },
    ],
  })
}
