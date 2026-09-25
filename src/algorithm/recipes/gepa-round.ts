import type { ArtifactRef, BudgetPlan, CampaignSpec } from '../contracts.js'
import type { CampaignState } from '../runtime/engine.js'
import type { JsonValue } from '../schema.js'
import { FileArtifactStore } from '../artifacts.js'
import { verifyDigest } from '../../search/contracts.js'
import type { ResearchArchive, ResearchFinding, Snapshot, TaskUniverse } from '../../search/types.js'
import type { ParentSelectionPolicy } from '../../search/parent-selection.js'
import { digestJson } from '../../state/digest.js'
import { failureClusterGepaRecipe, type GepaRecipeOptions } from './gepa.js'

type FrozenRound = {
  recipe: 'failure-cluster-gepa'; schemaVersion: 1; evolutionId: string; roundId: string; roundIndex: number;
  maxCandidates: number; seedRef: ArtifactRef; heldOutRef: ArtifactRef; archiveRef: ArtifactRef;
  anchorDigest: string; settings: GepaRecipeOptions['settings']; bindingSchema: GepaRecipeOptions['bindingSchema'];
  snapshotBindings: GepaRecipeOptions['snapshotBindings']; deadlineAt: number;
  evolutionBudget: BudgetPlan; cumulativeSpent: Record<string, number>;
  findings: Record<string, ResearchFinding>;
  parentPolicyRef?: ParentSelectionPolicy['ref'];
  sharedEpochs: NonNullable<GepaRecipeOptions['sharedEpochs']>;
}
export type GepaRound = { algorithm: ReturnType<typeof failureClusterGepaRecipe>; spec: CampaignSpec; options: GepaRecipeOptions }

const roundCaps = (options: GepaRecipeOptions): Record<string, number> => ({
  rolloutCells: options.settings.budgets.round.maxNewRolloutCells,
  repairCells: options.settings.budgets.round.maxRepairCells,
  diagnosisInputTokens: options.settings.budgets.round.maxDiagnosisInputTokens,
  diagnosisOutputTokens: options.settings.budgets.round.maxDiagnosisOutputTokens,
  generationTokens: options.settings.budgets.round.maxGenerationTokens ?? 0,
  generationRequests: options.settings.budgets.round.maxGenerationRequests ?? 0,
})

function plannedBudget(frozen: FrozenRound, options: GepaRecipeOptions): BudgetPlan {
  const caps = roundCaps(options)
  const next = Object.fromEntries(Object.entries(frozen.evolutionBudget).map(([dimension, plan]) => {
    const spent = frozen.cumulativeSpent[dimension] ?? 0
    const cap = caps[dimension]
    if (cap === undefined || !Number.isSafeInteger(spent) || spent < 0)
      throw new Error(`GEPA lineage budget invalid: ${dimension}`)
    if (spent > plan.limit) throw new Error(`GEPA evolution budget exceeded: ${dimension}`)
    const limit = Math.min(plan.limit - spent, cap)
    return [dimension, { ...plan, limit }]
  }))
  for (const [dimension, source] of Object.entries({ rolloutCells: 'gepa.evaluate', repairCells: 'gepa.evaluate',
    diagnosisInputTokens: 'gepa.diagnose', diagnosisOutputTokens: 'gepa.diagnose',
    generationTokens: 'gepa.generate', generationRequests: 'gepa.generate' })) {
    if (!next[dimension] || next[dimension].source !== source || next[dimension].capability !== 'stop')
      throw new Error(`GEPA ${dimension} requires a stop-capable ${source} budget`)
  }
  return next
}

/** Seal one round's science inputs and make its budget a capped view of the evolution ledger. */
export function createGepaRound(input: { campaignId: string; options: GepaRecipeOptions; evolutionBudget: BudgetPlan }): GepaRound {
  if (input.options.roundIndex !== 0)
    throw new Error('GEPA first-round factory requires round index zero')
  const { options } = input
  const frozen: FrozenRound = { recipe: 'failure-cluster-gepa', schemaVersion: 1, evolutionId: options.evolutionId,
    roundId: options.roundId, roundIndex: 0, maxCandidates: options.maxCandidates,
    seedRef: options.artifacts.putJson(options.seed as unknown as JsonValue, 'gepa.seed-universe.v1'),
    heldOutRef: options.artifacts.putJson(options.heldOut as unknown as JsonValue, 'gepa.held-out-universe.v1'),
    archiveRef: options.artifacts.putJson(options.archive as unknown as JsonValue, 'gepa.research-archive.v1'),
    anchorDigest: options.anchor.digest, settings: structuredClone(options.settings), bindingSchema: structuredClone(options.bindingSchema),
    snapshotBindings: structuredClone(options.snapshotBindings), deadlineAt: options.deadlineAt,
    evolutionBudget: structuredClone(input.evolutionBudget), cumulativeSpent: {},
    findings: structuredClone(options.findings ?? {}), sharedEpochs: structuredClone(options.sharedEpochs ?? {}),
    ...(options.parentPolicy ? { parentPolicyRef: structuredClone(options.parentPolicy.ref) } : {}) }
  const spec: CampaignSpec = { campaignId: input.campaignId, config: frozen as unknown as JsonValue,
    initialBindingSetRef: options.snapshotBindings[options.anchor.digest]!, budget: plannedBudget(frozen, options) }
  return { algorithm: failureClusterGepaRecipe(options), spec, options }
}

/** A completed campaign is the only source of the next archive, active parent, and cumulative usage. */
export function nextGepaRound(previous: CampaignState, artifacts: FileArtifactStore,
  input: { campaignId: string; roundId: string; deadlineAt: number; findings?: Record<string, ResearchFinding>;
    parentPolicy?: ParentSelectionPolicy }): GepaRound {
  if (previous.phase !== 'complete') throw new Error('GEPA next round requires a completed campaign')
  if (input.campaignId === previous.spec.campaignId) throw new Error('GEPA next round needs a fresh campaign ID')
  const old = previous.spec.config as unknown as FrozenRound
  if (!old || old.recipe !== 'failure-cluster-gepa' || old.schemaVersion !== 1
    || old.roundId === input.roundId || !Number.isSafeInteger(old.roundIndex) || old.roundIndex < 0)
    throw new Error('GEPA previous campaign has no valid frozen round lineage')
  if (!!old.parentPolicyRef !== !!input.parentPolicy || old.parentPolicyRef && input.parentPolicy
    && digestJson(old.parentPolicyRef) !== digestJson(input.parentPolicy.ref))
    throw new Error('GEPA parent policy changed between rounds')
  const state = previous.state as unknown as { archiveRef?: ArtifactRef; snapshotBindings?: GepaRecipeOptions['snapshotBindings'];
    sharedEpochs?: NonNullable<GepaRecipeOptions['sharedEpochs']> }
  if (!state.archiveRef || !state.snapshotBindings || !state.sharedEpochs)
    throw new Error('GEPA completed campaign lacks archive or shared-epoch lineage')
  const archive = artifacts.getJson(state.archiveRef) as unknown as ResearchArchive
  const seed = artifacts.getJson(old.seedRef) as unknown as TaskUniverse
  const heldOut = artifacts.getJson(old.heldOutRef) as unknown as TaskUniverse
  for (const item of [archive, seed, heldOut]) verifyDigest(item)
  if (archive.evolutionId !== old.evolutionId || archive.universeDigest !== seed.digest)
    throw new Error('GEPA archive lineage changed')
  const anchor = archive.snapshots.find((snapshot: Snapshot) =>
    state.snapshotBindings![snapshot.digest]?.digest === previous.activeBindingSetRef.digest)
  if (!anchor) throw new Error('GEPA active binding has no archived snapshot')
  const cumulativeSpent = { ...old.cumulativeSpent }
  for (const [dimension, amount] of Object.entries(previous.spent))
    cumulativeSpent[dimension] = (cumulativeSpent[dimension] ?? 0) + amount
  const findings = { ...old.findings, ...(input.findings ?? {}) }
  const options: GepaRecipeOptions = { evolutionId: old.evolutionId, roundId: input.roundId,
    roundIndex: old.roundIndex + 1, maxCandidates: old.maxCandidates, anchor, seed, heldOut, archive,
    settings: old.settings, bindingSchema: old.bindingSchema, snapshotBindings: state.snapshotBindings,
    artifacts, deadlineAt: input.deadlineAt, findings, sharedEpochs: state.sharedEpochs,
    ...(input.parentPolicy ? { parentPolicy: input.parentPolicy } : {}) }
  const frozen: FrozenRound = { ...old, roundId: input.roundId, roundIndex: options.roundIndex,
    archiveRef: state.archiveRef, anchorDigest: anchor.digest, snapshotBindings: state.snapshotBindings,
    deadlineAt: input.deadlineAt, cumulativeSpent, findings, sharedEpochs: state.sharedEpochs }
  const spec: CampaignSpec = { campaignId: input.campaignId, config: frozen as unknown as JsonValue,
    initialBindingSetRef: previous.activeBindingSetRef, budget: plannedBudget(frozen, options) }
  return { algorithm: failureClusterGepaRecipe(options), spec, options }
}
