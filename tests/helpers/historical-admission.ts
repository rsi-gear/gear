/** Historical admission producer for compatibility fixtures only.
 * These records intentionally predate objective V1. New API tests must use
 * service.admit directly; production exposes no way to omit the new objective.
 * Runtime, recovery, persistence and all scoring still use production code.
 */
import type { RefineService, AdmissionOptions } from '../../src/refine/service.js'
import type { AdmissionResult, EvolutionSpec, RefinementRound, SemanticTarget } from '../../src/types.js'
import { digestDatasetRef } from '../../src/state/dataset.js'
import { digestJson } from '../../src/state/digest.js'
import { invariant, validateSettings } from '../../src/search/contracts.js'
import { resolveRegressionSettings } from '../../src/search/regression.js'
import { parseBaselineSourceRequest, type PreparedBaselineSource } from '../../src/refine/baseline-source.js'
const now = () => new Date().toISOString()
function validateCount(rounds: number) {
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 100) throw new TypeError('rounds must be an integer between 1 and 100')
  return rounds
}
function normalizeFocus(values: readonly SemanticTarget[] | undefined) {
  return values === undefined || values.length === 0 ? undefined : [...new Set(values)]
}
export async function admitHistoricalFixture(service: RefineService, source: RefinementRound['source'], options: AdmissionOptions = {}): Promise<AdmissionResult> {
  service['assertAvailable']()
  if (options.objective !== undefined) throw new TypeError('historical fixtures cannot contain objective V1')
  const roundCount = validateCount(options.rounds ?? 1)
  const taskBudgetMs = options.taskBudgetMs ?? service['options'].taskBudgetMs
  if (!Number.isSafeInteger(taskBudgetMs) || taskBudgetMs <= 0) throw new TypeError('taskBudgetMs must be a positive integer')
  const baselineSource = options.baselineSource === undefined
    ? undefined
    : parseBaselineSourceRequest(options.baselineSource)
  const evolutionId = crypto.randomUUID()
  const batchId = crypto.randomUUID()
  let from = options.from
  if (from === undefined && baselineSource !== undefined) {
    const sourceRound = await service['registry'].stateStore(baselineSource.evolutionId).readRound(baselineSource.roundId)
    if (sourceRound === undefined) {
      throw new Error(`baseline source is incompatible: unknown source round: ${baselineSource.roundId}`)
    }
    from = sourceRound.targetHarnessRef
  }
  const initial = await service['resolveInitialChampion'](from)
  const seedTaskRef = options.seedTaskRef ?? service['options'].seedTaskRef
  const spec: EvolutionSpec = {
    ...(service['options'].searchSettings === undefined ? {} : { searchSettings: structuredClone(service['options'].searchSettings) }),
    evolutionId, createdAt: now(),
    initialHarness: { ref: initial.ref, digest: initial.manifestDigest },
    datasets: {
      seed: { ref: seedTaskRef, digest: await digestDatasetRef(seedTaskRef, service['options'].workspaceRoot) },
      heldOut: { ref: service['options'].heldOutRef, digest: await digestDatasetRef(service['options'].heldOutRef, service['options'].workspaceRoot) },
    },
    metaAgent: structuredClone(service['options'].metaAgent),
    candidateGeneration: structuredClone(service['options'].candidateGeneration),
    rollout: structuredClone(service['options'].rollout),
    evaluation: structuredClone(service['options'].evaluation),
    selection: structuredClone(service['options'].selection),
    promotion: structuredClone(service['options'].promotion),
    taskBudgetMs,
    toolchainRef: service['options'].toolchainRef, sandboxProfileRef: service['options'].sandboxProfileRef,
    ...((service['options'].experienceMemoryEnabled === true || source === 'skill')
      ? { experienceMemory: { schemaVersion: 1 as const, enabled: true } }
      : {}),
  }
  service['resolveComponents'](spec)
  if (spec.searchSettings) {
    const search = service['evaluatorForSpec'](spec).search
    if (!search || !search.provider.capabilities.taskSubsetPlans || !search.provider.capabilities.batchIndependentCells || !search.provider.capabilities.idempotentExecution) {
      throw new Error('failure-cluster-gepa-v1 requires provider-verified subset plans, cell reuse, idempotent execution and a diagnosis provider')
    }
    const [seed, heldOut] = await Promise.all([search.provider.describe('seed'), search.provider.describe('held-out')])
    spec.searchSettings = resolveRegressionSettings(spec.searchSettings, seed, heldOut)
    validateSettings(spec.searchSettings, seed, heldOut, spec.candidateGeneration.maxCandidates)
    if (spec.searchSettings.regression.suiteRef) invariant(await search.provider.verifyRegressionSuite?.(spec.searchSettings.regression.suiteRef, seed), 'provider must verify the frozen regression suite was included at new admission')
  }
  let preparedBaseline: PreparedBaselineSource | undefined
  if (baselineSource !== undefined) {
    preparedBaseline = await service['prepareExternalBaseline'](spec, initial, baselineSource)
    spec.rollout.providerSemanticDigest = preparedBaseline.inheritedRolloutProviderDigest
    spec.baselineConditionSource = preparedBaseline.conditionSource
  }
  const state = service['registry'].stateStore(evolutionId)
  const meta = await service['createMetaSession'](spec, digestJson(spec), state)
  try {
    service['assertGenerationBudgetCapability'](spec, meta)
    await service['registry'].createEvolution({ spec, champion: initial, ...(options.name === undefined ? {} : { name: options.name }) })
    return await service['startBatch'](await service['runtime'](evolutionId, { meta, store: state }), source, batchId, roundCount, normalizeFocus(options.focus), preparedBaseline?.snapshot)
  } catch (error) { await meta.dispose(); throw error }
}
