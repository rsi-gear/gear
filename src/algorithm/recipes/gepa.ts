import type { Algorithm, AlgorithmDecision, ArtifactRef, BindingSchema, BindingSetRef, DecisionContext,
  BudgetSnapshot, OperationIntent, OperationOutcome, ReduceContext } from '../contracts.js'
import { ALGORITHM_API_VERSION } from '../contracts.js'
import { FileArtifactStore } from '../artifacts.js'
import { BindingStore } from '../bindings.js'
import { task } from '../steps.js'
import { type JsonValue } from '../schema.js'
import { implementationClosureDigest } from '../data/identity.js'
import { digestJson } from '../../state/digest.js'
import { passesExploration } from '../../search/archive.js'
import { clusters } from '../../search/diagnosis.js'
import { cellKey, plannedCells, profile, validOutcome } from '../../search/evidence.js'
import { scoringComplete, scoringValue } from '../../search/objective.js'
import { assessGate, decideFinal, precheckSeed, rankProfiles, type PromotionInput } from '../../search/promotion.js'
import { integrity, plannedCellCount, repetitionsForTask, resolveSizing, seal, sorted, verifyDigest, validateSettings,
  validateSnapshot } from '../../search/contracts.js'
import { resolveParentPolicyRef, scopedFrontierPolicy, championGepaPolicy } from '../../search/policies/parents.js'
import { createScope, stagePlan } from '../../search/scopes.js'
import { samplingEvidence } from '../../search/scope-sampling.js'
import type { ScopeEpochPreparation } from '../../search/epochs.js'
import type { ObjectiveBaseline } from '../../objective/scoring.js'
import type { ParentSelectionPolicy } from '../../search/parent-selection.js'
import type { BridgeSelectionDecision, CandidateWorkPlan, DiagnosisDossier, EvaluationScope, FailureCluster, GateDecision,
  EvaluationStageDecision, ParentSelectionDecision, ResearchArchive, ResearchFinding, SearchSettings, Snapshot, StageEvaluationPlan,
  StageResult, TaskUniverse } from '../../search/types.js'
import { chooseGepaBridge, chooseGepaParents, completeGepaScopePreparation, planGepaScopePreparation,
  updateGepaArchive, type GepaBaseline, type GepaLocal, type GepaPreparationPlan, type GepaWork } from './gepa-policy.js'
import type { GepaSharedEpoch } from './gepa-policy.js'

type Phase = 'scope-preparation' | 'parent-probe' | 'diagnosis' | 'planning-probe' | 'generation' | 'local'
  | 'bridge-reference-lookup' | 'bridge-reference-resolve' | 'bridge-reference' | 'bridge-reference-checkpoint' | 'bridge'
  | 'global-seed' | 'global-reference-lookup' | 'global-reference' | 'global-reference-checkpoint'
  | 'seed-research' | 'held-out' | 'held-out-reference-lookup' | 'held-out-reference' | 'held-out-reference-checkpoint'
  | 'await-repair' | 'done'
type Generated = { snapshot: Snapshot; candidateSetRef: BindingSetRef; changedPaths: string[]; digest: string }
type Proposal = { batchId: string; parent: Snapshot; dossier: DiagnosisDossier; cluster: FailureCluster;
  scope: EvaluationScope; hypothesis: string }
type PendingProbe = { key: string; proposal: Proposal; plan: StageEvaluationPlan; candidateId: string }
type State = { phase: Phase; parents: ParentSelectionDecision; scopePlan: GepaPreparationPlan;
  queuedOperations: OperationIntent[]; queuedCompleted: Record<string, OperationOutcome>;
  sharedEpochs: Record<string, GepaSharedEpoch>;
  preparation: ScopeEpochPreparation | null; baselines: Record<string, GepaBaseline>;
  dossiers: Record<string, DiagnosisDossier>; works: GepaWork[]; plannedWorks: GepaWork[];
  localBaselines: Record<string, StageResult>;
  batchIndex: number; batchFamilies: FailureCluster[]; familyIndex: number; hypothesisIndex: number;
  familyScope: EvaluationScope | null; probeIndex: number; pendingProbe: PendingProbe | null;
  usedHypotheses: string[]; plannedScopes: EvaluationScope[]; diagnosedClusters: FailureCluster[];
  generated: Record<string, Generated>; generatedAttempts: Record<string, { digest: string; reason?: string }>;
  locals: GepaLocal[]; bridge: BridgeSelectionDecision | null;
  bridgePlan: StageEvaluationPlan | null; bridgeResults: Record<string, StageResult>;
  globalPlan: StageEvaluationPlan | null; globalResults: Record<string, StageResult>;
  heldOutPlan: StageEvaluationPlan | null; heldOutResults: Record<string, StageResult>;
  heldOutOriginalRefs: [string, string] | null;
  nomineeId: string | null; seedGate: GateDecision | null; finalGate: GateDecision | null;
  archiveRef: ArtifactRef | null; reasons: string[]; snapshotBindings: Record<string, BindingSetRef>;
  stageDecisions: EvaluationStageDecision[]; findings: ResearchFinding[];
  supportObjects: Array<{ digest: string; [key: string]: unknown }>;
  objectiveReferences: Record<string, ObjectiveBaseline> }

export type GepaRecipeOptions = { evolutionId: string; roundId: string; roundIndex: number; maxCandidates: number;
  anchor: Snapshot; seed: TaskUniverse; heldOut: TaskUniverse; archive: ResearchArchive; settings: SearchSettings;
  bindingSchema: BindingSchema; snapshotBindings: Record<string, BindingSetRef>; artifacts: FileArtifactStore;
  deadlineAt: number; parentPolicy?: ParentSelectionPolicy; findings?: Record<string, ResearchFinding>;
  handoffFindingDigests?: Record<string, string[]>;
  sharedEpochs?: Record<string, GepaSharedEpoch>; preserveLegacyExternalKeys?: boolean;
  initialSnapshot?: Snapshot; initialSnapshotBindingSetRef?: BindingSetRef;
  objectiveReferences?: Record<string, ObjectiveBaseline> }

function resultRef(outcome: OperationOutcome | undefined, field: string): ArtifactRef | null {
  if (outcome?.kind !== 'result' || !outcome.value || typeof outcome.value !== 'object' || Array.isArray(outcome.value)) return null
  const ref = (outcome.value as Record<string, unknown>)[field] as ArtifactRef | undefined
  return ref?.kind === 'artifact' && typeof ref.digest === 'string' ? ref : null
}
function bindingRef(outcome: OperationOutcome | undefined, field: string): BindingSetRef | null {
  if (outcome?.kind !== 'result' || !outcome.value || typeof outcome.value !== 'object' || Array.isArray(outcome.value)) return null
  const ref = (outcome.value as Record<string, unknown>)[field] as BindingSetRef | undefined
  return ref?.kind === 'binding-set' && typeof ref.digest === 'string' ? ref : null
}
function readOld<T extends { digest: string }>(artifacts: FileArtifactStore, ref: ArtifactRef): T {
  const value = artifacts.getJson(ref) as unknown as T
  verifyDigest(value)
  return value
}
function unique(intents: OperationIntent[]): OperationIntent[] {
  const keys = new Set(intents.map(intent => intent.localKey))
  if (keys.size !== intents.length) throw new Error('GEPA operation keys collided')
  return intents
}
const clocked = (intent: OperationIntent): OperationIntent => ({ ...intent, startsBudgetClock: true })

/** One GEPA round in the common campaign journal. Old policy functions remain the source of scientific decisions. */
export function failureClusterGepaRecipe(input: GepaRecipeOptions): Algorithm {
  const options = { ...input, anchor: structuredClone(input.anchor), seed: structuredClone(input.seed), heldOut: structuredClone(input.heldOut),
    archive: structuredClone(input.archive), settings: structuredClone(input.settings),
    snapshotBindings: structuredClone(input.snapshotBindings), findings: structuredClone(input.findings ?? {}),
    handoffFindingDigests: structuredClone(input.handoffFindingDigests ?? {}),
    sharedEpochs: structuredClone(input.sharedEpochs ?? {}),
    initialSnapshot: structuredClone(input.initialSnapshot ?? input.anchor),
    initialSnapshotBindingSetRef: input.initialSnapshotBindingSetRef ?? input.snapshotBindings[input.anchor.digest],
    objectiveReferences: structuredClone(input.objectiveReferences ?? {}) }
  validateSnapshot(options.anchor); verifyDigest(options.seed); verifyDigest(options.heldOut); verifyDigest(options.archive)
  validateSnapshot(options.initialSnapshot)
  const initialSnapshotBindingSetRef = options.initialSnapshotBindingSetRef
  if (!initialSnapshotBindingSetRef) throw new Error('GEPA initial objective snapshot binding is missing')
  validateSettings(options.settings, options.seed, options.heldOut, options.maxCandidates)
  if (options.archive.universeDigest !== options.seed.digest || !options.archive.snapshots.some(item => item.digest === options.anchor.digest))
    throw new Error('GEPA archive must contain the frozen seed anchor')
  if (!Number.isSafeInteger(options.deadlineAt) || options.deadlineAt < 0) throw new Error('GEPA deadline must be frozen at admission')
  const policyRef = resolveParentPolicyRef(options.settings.search)
  const policy = input.parentPolicy ?? (options.settings.search.parentSampling === 'epsilon-greedy-gepa-v1'
    ? championGepaPolicy(policyRef) : scopedFrontierPolicy(policyRef))
  if (digestJson(policy.ref) !== digestJson(policyRef)) throw new Error('GEPA parent policy differs from frozen settings')
  const bindings = new BindingStore(options.artifacts, options.bindingSchema)
  const initialHarnessRef = bindings.read(initialSnapshotBindingSetRef).slots.harness
  if (!initialHarnessRef) throw new Error('GEPA initial objective snapshot lacks a harness binding')
  const initialHarness = options.artifacts.getJson(initialHarnessRef) as Record<string, unknown>
  if (initialHarness.commitOid !== options.initialSnapshot.commit
    || initialHarness.manifestDigest !== options.initialSnapshot.manifestDigest)
    throw new Error('GEPA initial objective snapshot binding drift')
  for (const snapshot of options.archive.snapshots) {
    const ref = options.snapshotBindings[snapshot.digest]
    if (!ref) throw new Error(`GEPA parent binding missing: ${snapshot.candidateId}`)
    const harnessRef = bindings.read(ref).slots.harness
    if (!harnessRef) throw new Error('GEPA requires a harness binding for every archive snapshot')
    const value = options.artifacts.getJson(harnessRef) as Record<string, unknown>
    if (value.commitOid !== snapshot.commit || value.manifestDigest !== snapshot.manifestDigest)
      throw new Error('GEPA parent binding does not match its frozen snapshot')
    for (const findingRef of sorted([...snapshot.findingRefs,
      ...(options.handoffFindingDigests[snapshot.digest] ?? [])])) {
      const finding = options.findings[findingRef]
      if (!finding || finding.digest !== findingRef) throw new Error(`GEPA parent finding unavailable: ${findingRef}`)
      verifyDigest(finding)
    }
  }
  const implementationDigest = implementationClosureDigest(['recipes/gepa'], {
    evolutionId: options.evolutionId, roundId: options.roundId, roundIndex: options.roundIndex,
    maxCandidates: options.maxCandidates, anchorDigest: options.anchor.digest, seedDigest: options.seed.digest,
    heldOutDigest: options.heldOut.digest, archiveDigest: options.archive.digest, settings: options.settings,
    bindingSchema: options.bindingSchema, snapshotBindings: options.snapshotBindings, deadlineAt: options.deadlineAt,
    policyRef: policy.ref, findings: options.findings,
    handoffFindingDigests: options.handoffFindingDigests, sharedEpochs: options.sharedEpochs,
    preserveLegacyExternalKeys: options.preserveLegacyExternalKeys === true,
    initialSnapshotDigest: options.initialSnapshot.digest,
    initialSnapshotBindingSetRef,
    objectiveReferences: options.objectiveReferences })
  const resolution = resolveSizing(options.seed, options.settings.search.taskSetSizing)
  const reference = (state: State, snapshot: Snapshot): BindingSetRef => {
    const found = state.snapshotBindings[snapshot.digest]
    if (!found) throw new Error(`GEPA snapshot binding missing: ${snapshot.candidateId}`)
    return found
  }
  const knownCells = (state: State) => [...options.archive.results, ...(state.preparation?.results ?? []),
    ...Object.values(state.baselines).map(item => item.result), ...Object.values(state.localBaselines),
    ...state.locals.map(item => item.result), ...Object.values(state.bridgeResults),
    ...Object.values(state.globalResults), ...Object.values(state.heldOutResults)].flatMap(item => item.cells)
  const evaluation = (key: string, universe: TaskUniverse, plan: StageEvaluationPlan, snapshot: Snapshot,
    state: State): OperationIntent => {
    const known = new Map(knownCells(state).map(cell => [cellKey(cell.identity), cell]))
    const missing = plannedCells(universe, plan, snapshot).filter(identity => {
      const cell = known.get(cellKey(identity))
      return !cell || !validOutcome(cell)
    })
    const repairCells = missing.filter(identity => known.has(cellKey(identity))).length
    const processMode = ['bridge', 'global-seed', 'held-out'].includes(plan.stage)
      ? options.settings.promotion.process.mode : options.settings.search.process.mode
    return clocked(task(key, 'gepa.evaluate', {
      ...(options.preserveLegacyExternalKeys ? { roundIdentity: { evolutionId: options.evolutionId, roundId: options.roundId } } : {}),
      ...(options.preserveLegacyExternalKeys ? { projectionPolicy: 'defer' } : {}),
      ...(options.preserveLegacyExternalKeys ? { progressProcessMode: options.settings.search.process.mode } : {}),
      universe, plan, snapshot, processMode } as unknown as JsonValue,
      { bindingSetRef: reference(state, snapshot), limits: { rolloutCells: missing.length, repairCells } }))
  }
  const result = (completed: Record<string, OperationOutcome>, key: string, plan: StageEvaluationPlan, snapshot: Snapshot): StageResult | null => {
    const ref = resultRef(completed[key], 'resultRef')
    if (!ref) return null
    const value = readOld<StageResult>(options.artifacts, ref)
    if (value.stagePlanDigest !== plan.digest || value.snapshotDigest !== snapshot.digest || !value.settled)
      throw new Error('GEPA stage result does not match its frozen plan/snapshot')
    profile(plan.partition === 'seed' ? options.seed : options.heldOut, plan, snapshot, value,
      ['bridge', 'global-seed', 'held-out'].includes(plan.stage) ? options.settings.promotion.process.mode : options.settings.search.process.mode)
    return value
  }
  const basePlan = (universe: TaskUniverse, stage: StageEvaluationPlan['stage'], scopeDigest: string,
    taskIds: string[], ids: string[], prerequisites: string[] = []): StageEvaluationPlan => stagePlan({ stage,
      partition: universe.partition, universeDigest: universe.digest, taskSetSizeResolutionDigest: resolution.digest,
      scopeDigest, taskIds, participantIds: ids, prerequisiteDecisionDigests: prerequisites, selectionRuleDigest: integrity })
  const fullPlan = (universe: TaskUniverse, stage: StageEvaluationPlan['stage'], ids: string[]): StageEvaluationPlan =>
    basePlan(universe, stage, digestJson([universe.digest, stage]), universe.tasks.map(task => task.id), ids)
  const referenceKey = (universe: TaskUniverse, plan: StageEvaluationPlan): string =>
    digestJson([universe.digest, sorted(plan.taskIds)])
  const needsInitialReference = (universe: TaskUniverse, state: State, plan: StageEvaluationPlan): boolean =>
    !!universe.objective?.constraints.some(constraint => constraint.rule === 'no_regression')
    && !state.objectiveReferences[referenceKey(universe, plan)]
  const initialReferencePlan = (plan: StageEvaluationPlan): StageEvaluationPlan => {
    const { digest: ignored, ...body } = plan
    return seal({ ...body, participantIds: [options.initialSnapshot.candidateId],
      prerequisiteDecisionDigests: [], selectionRuleDigest: digestJson('objective-initial-reference-v1') })
  }
  const referenceEvaluation = (key: string, universe: TaskUniverse, plan: StageEvaluationPlan,
    state: State): OperationIntent => evaluation(key, universe, initialReferencePlan(plan), options.initialSnapshot, state)
  const lookupReference = (key: string, universe: TaskUniverse, plan: StageEvaluationPlan): OperationIntent =>
    task(key, 'gepa.objective-reference', { roundId: options.roundId, mode: 'lookup', universe, plan } as unknown as JsonValue,
      { bindingSetRef: initialSnapshotBindingSetRef })
  const consumeLookup = (key: string, universe: TaskUniverse, plan: StageEvaluationPlan,
    completed: Record<string, OperationOutcome>, state: State): boolean => {
    const outcome = completed[key]
    if (outcome?.kind !== 'result' || !outcome.value || typeof outcome.value !== 'object'
      || Array.isArray(outcome.value)) throw new Error('GEPA objective baseline lookup has no sealed result')
    const found = (outcome.value as Record<string, unknown>).found
    if (typeof found !== 'boolean') throw new Error('GEPA objective baseline lookup is malformed')
    if (!found) return false
    const ref = resultRef(outcome, 'ref')
    if (!ref || ref.schemaId !== 'gepa.objective-baseline.v1')
      throw new Error('GEPA objective baseline lookup lacks its sealed reference')
    const baseline = readOld<ObjectiveBaseline & { initialSnapshotDigest: string }>(options.artifacts, ref)
    if (baseline.initialSnapshotDigest !== options.initialSnapshot.digest)
      throw new Error('GEPA objective baseline lookup changed its initial harness')
    state.objectiveReferences[referenceKey(universe, plan)] = baseline
    return true
  }
  const freezeReference = (key: string, universe: TaskUniverse, plan: StageEvaluationPlan,
    completed: Record<string, OperationOutcome>): OperationIntent => {
    const ref = resultRef(completed[key], 'resultRef')
    if (!ref) throw new Error('GEPA initial objective reference evaluation is unavailable')
    return task(`${key}-freeze`, 'gepa.objective-reference', { roundId: options.roundId,
      mode: 'baseline', universe, plan, referencePlan: initialReferencePlan(plan), resultRef: ref } as unknown as JsonValue,
    { bindingSetRef: initialSnapshotBindingSetRef })
  }
  const consumeReference = (key: string, universe: TaskUniverse, plan: StageEvaluationPlan,
    completed: Record<string, OperationOutcome>, state: State): ObjectiveBaseline => {
    const ref = resultRef(completed[`${key}-freeze`], 'ref')
    if (!ref || ref.schemaId !== 'gepa.objective-baseline.v1')
      throw new Error('GEPA initial objective baseline is unconfirmed')
    const baseline = readOld<ObjectiveBaseline>(options.artifacts, ref)
    state.objectiveReferences[referenceKey(universe, plan)] = baseline
    return baseline
  }
  const output = (state: State, operations: OperationIntent[] = [], complete = false, transition?: BindingSetRef,
    budget?: BudgetSnapshot): AlgorithmDecision => {
    if (!complete) {
      const exhausted = Object.entries(budget?.dimensions ?? {}).find(([, value]) => value.spent > value.limit)
      if (exhausted) { state.reasons.push(`budget-exceeded:${exhausted[0]}`); return finish(state) }
    }
    unique(operations)
    // A physical cell can occur in several stage plans. Execute one frozen
    // operation at a time so the next provider can observe the prior cell cache.
    if (complete) state.queuedOperations = []
    else if (operations.length > 1) {
      state.queuedOperations = operations.slice(1)
      operations = operations.slice(0, 1)
    }
    const remaining = Object.fromEntries(Object.entries(budget?.dimensions ?? {}).map(([dimension, value]) => [dimension, value.remaining]))
    const bounded = operations.map(operation => {
      const limits = Object.fromEntries(Object.entries(operation.limits ?? {}).map(([dimension, requested]) => {
        const available = remaining[dimension] ?? requested
        const granted = Math.max(0, Math.min(requested, available))
        remaining[dimension] = available - granted
        return [dimension, granted]
      }))
      return { ...operation, limits }
    })
    return { nextState: state as unknown as JsonValue, operations: bounded, ...(complete ? { complete: true } : {}),
      ...(transition ? { bindingTransition: transition } : {}) }
  }
  const probeOperation = (state: State, index: number): OperationIntent => {
    const batch = state.parents.batches[index]!
    const parent = options.archive.snapshots.find(snapshot => snapshot.digest === batch.parentSnapshotDigest)!
    const sourceScope = options.archive.scopes.find(item => item.digest === batch.sourceScopeDigest)!
    const scope = state.preparation?.scopes.find(item => item.familyId === sourceScope.familyId) ?? sourceScope
    const plan = basePlan(options.seed, 'baseline-probe', scope.digest, scope.taskIds, [parent.candidateId],
      [state.parents.digest, ...(state.preparation ? [state.preparation.digest] : [])])
    return evaluation(`parent-${index}`, options.seed, plan, parent, state)
  }
  const generationOperations = (state: State): OperationIntent[] => state.works.map((work, index) =>
    clocked(task(`generate-${index}`, 'gepa.generate', {
      ...(options.preserveLegacyExternalKeys ? { roundIdentity: { evolutionId: options.evolutionId, roundId: options.roundId } } : {}),
      workplan: work.workplan, dossier: work.dossier, scope: work.scope, parent: work.parent,
      plan: work.plan, baseline: state.localBaselines[work.workplan.candidateId], universe: options.seed,
      ...(options.preserveLegacyExternalKeys ? {
        handoffFindingDigests: options.handoffFindingDigests[work.parent.digest] ?? [] } : {}),
      findings: sorted([...work.parent.findingRefs,
        ...(options.handoffFindingDigests[work.parent.digest] ?? [])]).map(ref => options.findings[ref]!),
      processMode: options.settings.search.process.mode } as unknown as JsonValue,
    { bindingSetRef: reference(state, work.parent), limits: {
      ...(work.workplan.generationBudget.maxTokens === undefined ? {} : { generationTokens: work.workplan.generationBudget.maxTokens }),
      ...(work.workplan.generationBudget.maxModelRequests === undefined ? {} : { generationRequests: work.workplan.generationBudget.maxModelRequests }) } })))
  const remaining = (budget: BudgetSnapshot | undefined, dimension: string, roundLimit: number | undefined,
    evolutionLimit: number | undefined): number | null => {
    const recorded = budget?.dimensions[dimension]
    if (recorded) return recorded.remaining
    if (roundLimit === undefined && evolutionLimit === undefined) return null
    return Math.min(roundLimit ?? Number.MAX_SAFE_INTEGER, evolutionLimit ?? Number.MAX_SAFE_INTEGER)
  }
  const finishHeldOut = (state: State, context: ReduceContext): AlgorithmDecision => {
    const plan = state.heldOutPlan!, nominee = state.locals.find(item => item.snapshot.candidateId === state.nomineeId)!.snapshot
    const baseline = state.heldOutResults[options.anchor.candidateId]!
    const observed = state.heldOutResults[nominee.candidateId]!
    const seedInput: PromotionInput = { universe: options.seed, plan: state.globalPlan!, anchor: options.anchor,
      candidate: nominee, baseline: state.globalResults[options.anchor.candidateId]!,
      result: state.globalResults[nominee.candidateId]!,
      initialBaseline: state.objectiveReferences[referenceKey(options.seed, state.globalPlan!)] }
    const heldInput: PromotionInput = { universe: options.heldOut, plan, anchor: options.anchor,
      candidate: nominee, baseline, result: observed,
      initialBaseline: state.objectiveReferences[referenceKey(options.heldOut, plan)] }
    state.finalGate = decideFinal(seedInput, heldInput, options.settings.promotion)
    if (options.preserveLegacyExternalKeys && state.finalGate.outcome === 'insufficient-evidence'
      && !baseline.failure && !observed.failure) {
      state.heldOutOriginalRefs ??= [baseline.digest, observed.digest]
      state.phase = 'await-repair'
      return output(state, [task('await-held-out-repair', 'gepa.await-repair', {
        roundId: options.roundId, plan, snapshots: [options.anchor, nominee],
        originalResultRefs: state.heldOutOriginalRefs,
        currentResultDigests: [baseline.digest, observed.digest],
      } as unknown as JsonValue)], false, undefined, context.budget)
    }
    return finish(state)
  }
  const completeGlobalSeed = (state: State): AlgorithmDecision => {
    const plan = state.globalPlan!, nominee = state.locals.find(item => item.snapshot.candidateId === state.nomineeId)!.snapshot
    const baseline = state.globalResults[options.anchor.candidateId]
    const observed = state.globalResults[nominee.candidateId]
    if (!baseline || !observed) { state.reasons.push('global-seed-evidence-unavailable'); return finish(state) }
    for (const row of [baseline, observed]) if (row.failure) state.reasons.push(`${row.failure.kind}:${row.failure.code}`)
    const seedInput: PromotionInput = { universe: options.seed, plan, anchor: options.anchor,
      candidate: nominee, baseline, result: observed,
      initialBaseline: state.objectiveReferences[referenceKey(options.seed, plan)] }
    state.seedGate = precheckSeed(seedInput, options.settings.promotion)
    if (state.seedGate.outcome !== 'eligible') state.finalGate = state.seedGate
    return finish(state)
  }
  const startBatch = (state: State, context: DecisionContext): AlgorithmDecision => {
    if (state.batchIndex >= state.parents.batches.length) {
      state.phase = 'generation'
      const operations = generationOperations(state)
      if (!operations.length) { state.reasons.push('no-bridge-quota'); return finish(state) }
      return output(state, operations, false, undefined, context.budget)
    }
    state.phase = 'parent-probe'
    return output(state, [probeOperation(state, state.batchIndex)], false, undefined, context.budget)
  }
  const nextPlanning = (state: State, context: ReduceContext): AlgorithmDecision => {
    const batch = state.parents.batches[state.batchIndex]!
    const parent = options.archive.snapshots.find(snapshot => snapshot.digest === batch.parentSnapshotDigest)!
    const dossier = state.dossiers[batch.batchId]!
    const baseline = state.baselines[batch.batchId]!.result
    while (state.familyIndex < state.batchFamilies.length
      && state.plannedWorks.length < options.maxCandidates
      && state.plannedWorks.filter(work => work.batchId === batch.batchId).length < batch.maxCandidateSlots) {
      const cluster = state.batchFamilies[state.familyIndex]!
      if (!state.familyScope) {
        const known = [...options.archive.scopes, ...(state.preparation?.scopes ?? []), ...state.plannedScopes]
        const cutoff = seal({ archiveDigest: options.archive.digest, baselineDigest: baseline.digest })
        const sampler = samplingEvidence(options.seed, cutoff.digest,
          [...options.archive.clusters, ...state.batchFamilies], [...options.archive.results, baseline])
        state.familyScope = known.filter(scope => scope.familyId === cluster.familyId)
          .sort((a, b) => b.epoch - a.epoch)[0]
          ?? createScope(options.seed, resolution, options.settings.search, cluster,
            state.preparation!.sharedTaskIds, state.preparation!.epoch, sampler) ?? null
        if (!state.familyScope) {
          state.reasons.push(`no-representative:${cluster.familyId}`)
          state.familyIndex++; state.hypothesisIndex = 0; continue
        }
      }
      const hypotheses = cluster.hypotheses.slice(0, options.settings.search.diagnosis.candidatesPerFamily)
      if (state.hypothesisIndex >= hypotheses.length) {
        state.familyIndex++; state.hypothesisIndex = 0; state.familyScope = null; continue
      }
      const hypothesis = hypotheses[state.hypothesisIndex++]!
      const proposal: Proposal = { batchId: batch.batchId, parent, dossier, cluster,
        scope: state.familyScope, hypothesis }
      const hypothesisKey = digestJson([parent.digest, cluster.familyId, hypothesis])
      if (state.usedHypotheses.includes(hypothesisKey)) continue
      const cells = remaining(context.budget, 'rolloutCells', options.settings.budgets.round.maxNewRolloutCells,
        options.settings.budgets.evolution.maxNewRolloutCells)!
      const candidateCost = plannedCellCount(options.seed, proposal.scope.taskIds)
      if (cells < candidateCost + state.plannedWorks.reduce((sum, work) => sum + plannedCellCount(options.seed, work.scope.taskIds), 0)
        || remaining(context.budget, 'generationTokens', options.settings.budgets.round.maxGenerationTokens,
          options.settings.budgets.evolution.maxGenerationTokens) === 0
        || remaining(context.budget, 'generationRequests', options.settings.budgets.round.maxGenerationRequests,
          options.settings.budgets.evolution.maxGenerationRequests) === 0) {
        state.reasons.push('budget-exhausted'); continue
      }
      const candidateId = `${options.roundId}-candidate-${state.plannedWorks.length}`
      const plan = stagePlan({ stage: 'local', partition: 'seed', universeDigest: options.seed.digest,
        taskSetSizeResolutionDigest: resolution.digest, scopeDigest: proposal.scope.digest,
        taskIds: proposal.scope.taskIds, participantIds: [candidateId, parent.candidateId],
        prerequisiteDecisionDigests: [state.parents.digest], selectionRuleDigest: integrity })
      const key = `local-parent-${state.probeIndex++}`
      state.pendingProbe = { key, proposal, plan, candidateId }
      state.phase = 'planning-probe'
      return output(state, [evaluation(key, options.seed, plan, parent, state)], false, undefined, context.budget)
    }
    state.pendingProbe = null; state.batchFamilies = []; state.familyIndex = 0
    state.hypothesisIndex = 0; state.familyScope = null; state.batchIndex++
    return startBatch(state, context)
  }
  const finish = (state: State): AlgorithmDecision => {
    if (!state.archiveRef) {
      state.findings = state.locals.map(entry => {
        const parent = profile(options.seed, entry.work.plan, entry.work.parent, entry.work.parentBaseline,
          options.settings.search.process.mode)
        const candidate = profile(options.seed, entry.work.plan, entry.snapshot, entry.result,
          options.settings.search.process.mode)
        return seal({ candidateId: entry.snapshot.candidateId,
          parentSnapshotDigest: entry.work.parent.digest, hypothesis: entry.work.workplan.hypothesis,
          scopeDigest: entry.work.scope.digest,
          changedPaths: state.generated[entry.snapshot.candidateId]!.changedPaths,
          improvements: candidate.tasks.filter(task => scoringValue(task) !== undefined
            && scoringValue(task)! > (scoringValue(parent.tasks.find(previous => previous.taskId === task.taskId)!) ?? Infinity))
            .map(task => task.taskId),
          regressions: candidate.tasks.filter(task => scoringValue(task) !== undefined
            && scoringValue(task)! < (scoringValue(parent.tasks.find(previous => previous.taskId === task.taskId)!) ?? -Infinity))
            .map(task => task.taskId),
          unverifiedTaskIds: options.seed.tasks.filter(task => !entry.work.plan.taskIds.includes(task.id)).map(task => task.id),
          workflowAdoption: 'unknown' as const, supportDigest: candidate.supportDigest,
          nextSteps: ['Review observed regressions and unresolved seed failures before the next mutation.'] })
      })
      const stagePlans: StageEvaluationPlan[] = []
      const beforeLocalResults: StageResult[] = [...(state.preparation?.results ?? [])]
      const afterLocalResults: StageResult[] = []
      for (const work of state.plannedWorks) {
        const baseline = state.localBaselines[work.workplan.candidateId]
        if (baseline) { stagePlans.push(work.plan); beforeLocalResults.push(baseline) }
      }
      for (const plan of [state.bridgePlan, state.globalPlan]) if (plan) {
        stagePlans.push(plan); afterLocalResults.push(...Object.values(plan.stage === 'bridge' ? state.bridgeResults : state.globalResults))
      }
      const archive = updateGepaArchive({ previous: options.archive, seed: options.seed, settings: options.settings,
        anchor: options.anchor, championId: options.anchor.candidateId, locals: state.locals, works: state.plannedWorks,
        clusters: state.diagnosedClusters, scopes: [...new Map([
          ...(state.preparation?.scopes ?? []), ...state.plannedScopes].map(scope => [scope.digest, scope])).values()],
        parentBaselines: [], stagePlans: [...(state.preparation?.plans ?? []), ...stagePlans],
        stageResultsBeforeLocal: beforeLocalResults, stageResultsAfterLocal: afterLocalResults,
        evolutionId: options.evolutionId })
      state.archiveRef = options.artifacts.putJson(archive as unknown as JsonValue, 'gepa.research-archive.v1')
      state.phase = 'seed-research'
      return output(state)
    }
    state.phase = 'done'
    const winner = state.locals.find(item => item.snapshot.candidateId === state.nomineeId)
    const accepted = state.finalGate?.outcome === 'accepted'
      && (options.settings.promotion.validationMode === 'independent-held-out'
        || options.settings.promotion.allowSharedSetPromotion === true)
    return output(state, [], true, accepted && winner ? reference(state, winner.snapshot) : undefined)
  }
  async function advance(state: State, completed: Record<string, OperationOutcome>, context: ReduceContext): Promise<AlgorithmDecision> {
    switch (state.phase) {
      case 'scope-preparation': {
        const results: Record<string, StageResult> = {}
        for (const [index, proposal] of state.scopePlan.pending.entries()) for (const [participantIndex, snapshot] of proposal.participants.entries()) {
          const key = `prepare-${index}-${participantIndex}`
          const observed = result(completed, key, proposal.plan, snapshot)
          if (observed) results[key] = observed
        }
        state.preparation = completeGepaScopePreparation(state.scopePlan, results, options.seed, options.settings)
        return startBatch(state, context)
      }
      case 'parent-probe': {
        const index = state.batchIndex, batch = state.parents.batches[index]!
        const parent = options.archive.snapshots.find(snapshot => snapshot.digest === batch.parentSnapshotDigest)!
        const sourceScope = options.archive.scopes.find(item => item.digest === batch.sourceScopeDigest)!
        const scope = state.preparation?.scopes.find(item => item.familyId === sourceScope.familyId) ?? sourceScope
        const plan = basePlan(options.seed, 'baseline-probe', scope.digest, scope.taskIds, [parent.candidateId],
          [state.parents.digest, ...(state.preparation ? [state.preparation.digest] : [])])
        const observed = result(completed, `parent-${index}`, plan, parent)
        if (!observed) { state.reasons.push('parent-baseline-incomplete'); state.batchIndex++; return startBatch(state, context) }
        state.baselines[batch.batchId] = { plan, result: observed }
        const parentProfile = profile(options.seed, plan, parent, observed,
          options.settings.search.process.mode, scope.weights)
        if (options.seed.objective ? !scoringComplete(parentProfile) : !parentProfile.outcomeComplete) {
          state.reasons.push('parent-baseline-incomplete'); state.batchIndex++; return startBatch(state, context)
        }
        state.phase = 'diagnosis'
        return output(state, [clocked(task(`diagnose-${index}`, 'gepa.diagnose', {
          ...(options.preserveLegacyExternalKeys ? { roundIdentity: { evolutionId: options.evolutionId, roundId: options.roundId } } : {}),
          snapshot: parent, universe: options.seed, taskIds: plan.taskIds, baseline: observed } as unknown as JsonValue,
        { bindingSetRef: reference(state, parent), limits: {
          diagnosisInputTokens: options.settings.budgets.round.maxDiagnosisInputTokens,
          diagnosisOutputTokens: options.settings.budgets.round.maxDiagnosisOutputTokens } }))], false, undefined, context.budget)
      }
      case 'diagnosis': {
        const index = state.batchIndex, batch = state.parents.batches[index]!
        const ref = resultRef(completed[`diagnose-${index}`], 'dossierRef')
        if (!ref) {
          const outcome = completed[`diagnose-${index}`]
          state.reasons.push(outcome?.kind === 'no-result' ? outcome.reason ?? 'diagnosis-unavailable' : 'diagnosis-unavailable')
          state.batchIndex++; return startBatch(state, context)
        }
        const dossier = readOld<DiagnosisDossier>(options.artifacts, ref)
        state.dossiers[batch.batchId] = dossier
        if (dossier.failure) {
          state.reasons.push(`${dossier.failure.kind}:${dossier.failure.code}`)
          state.batchIndex++; return startBatch(state, context)
        }
        const protectedTaskIds = options.settings.promotion.protectedTasks
          .filter(guard => guard.partition === 'seed').map(guard => guard.taskId)
        state.batchFamilies = clusters(dossier, options.seed, protectedTaskIds)
        state.diagnosedClusters.push(...state.batchFamilies)
        if (!state.batchFamilies.length) state.reasons.push('no-actionable-cluster')
        state.familyIndex = 0; state.hypothesisIndex = 0; state.familyScope = null
        return nextPlanning(state, context)
      }
      case 'planning-probe': {
        const pending = state.pendingProbe
        if (!pending) throw new Error('GEPA planning probe state is missing')
        const { proposal, plan, candidateId } = pending
        const baseline = result(completed, pending.key, plan, proposal.parent)
        if (baseline) {
          const parentProfile = profile(options.seed, plan, proposal.parent, baseline,
            options.settings.search.process.mode, proposal.scope.weights)
          const confirmed = proposal.cluster.taskIds.some(id => parentProfile.tasks.some(task => task.taskId === id
            && (options.seed.objective ? task.objectiveScore?.score !== undefined
              : task.outcome !== undefined && task.outcome < options.seed.tasks.find(item => item.id === id)!.successUtility)))
          if (!passesExploration(proposal.scope, parentProfile, options.seed) || !confirmed) {
            state.reasons.push(`hypothesis-unconfirmed:${proposal.cluster.familyId}`)
          } else {
            const slots = Math.max(1, options.maxCandidates - state.plannedWorks.length)
            const tokens = remaining(context.budget, 'generationTokens', options.settings.budgets.round.maxGenerationTokens,
              options.settings.budgets.evolution.maxGenerationTokens)
            const requests = remaining(context.budget, 'generationRequests', options.settings.budgets.round.maxGenerationRequests,
              options.settings.budgets.evolution.maxGenerationRequests)
            const availableTokens = tokens === null ? null : tokens - state.plannedWorks.reduce((sum, work) =>
              sum + (work.workplan.generationBudget.maxTokens ?? 0), 0)
            const availableRequests = requests === null ? null : requests - state.plannedWorks.reduce((sum, work) =>
              sum + (work.workplan.generationBudget.maxModelRequests ?? 0), 0)
            if (availableTokens !== null && availableTokens < slots || availableRequests !== null && availableRequests < slots)
              state.reasons.push('generation-budget-exhausted')
            else {
              const workplan: CandidateWorkPlan = seal({ candidateId, batchId: proposal.batchId,
                parentSnapshotDigest: proposal.parent.digest, dossierDigest: proposal.dossier.digest,
                clusterDigest: proposal.cluster.digest, familyId: proposal.cluster.familyId,
                hypothesis: proposal.hypothesis, targetTaskIds: proposal.cluster.taskIds,
                requiredDiagnosisRefs: proposal.cluster.evidenceRefs,
                modificationPaths: proposal.cluster.modificationPaths, scopeDigest: proposal.scope.digest,
                localStagePlanDigest: plan.digest,
                modificationBoundaryRule: { requiredSeedTaskIds: sorted(options.seed.tasks.map(task => task.id)),
                  onInsufficientScope: 'retain-research-only' as const },
                generationBudget: { ...(availableTokens === null ? {} : { maxTokens: Math.floor(availableTokens / slots) }),
                  ...(availableRequests === null ? {} : { maxModelRequests: Math.floor(availableRequests / slots) }),
                  deadlineAt: options.deadlineAt } })
              const work: GepaWork = { batchId: proposal.batchId, parent: proposal.parent, dossier: proposal.dossier,
                cluster: proposal.cluster, scope: proposal.scope, plan, workplan, parentBaseline: baseline }
              state.works.push(work); state.plannedWorks.push(work)
              state.localBaselines[candidateId] = baseline
              state.usedHypotheses.push(digestJson([proposal.parent.digest, proposal.cluster.familyId, proposal.hypothesis]))
              if (!state.plannedScopes.some(scope => scope.digest === proposal.scope.digest))
                state.plannedScopes.push(proposal.scope)
            }
          }
        } else state.reasons.push(`hypothesis-unconfirmed:${proposal.cluster.familyId}`)
        state.pendingProbe = null
        return nextPlanning(state, context)
      }
      case 'generation': {
        const generated: GepaWork[] = []
        for (const [index, work] of state.works.entries()) {
          const outcome = completed[`generate-${index}`]
          const ref = resultRef(outcome, 'generatedRef'), candidateSetRef = bindingRef(outcome, 'candidateSetRef')
          if (!ref) {
            state.reasons.push(outcome?.kind === 'no-result' ? outcome.reason ?? 'generation-failed' : 'generation-unavailable')
            continue
          }
          const value = readOld<{ digest: string; snapshot?: Snapshot; changedPaths: string[]; reason?: string }>(options.artifacts, ref)
          state.generatedAttempts[work.workplan.candidateId] = { digest: value.digest,
            ...(value.reason === undefined ? {} : { reason: value.reason }) }
          if (!value.snapshot) { state.reasons.push(value.reason ?? 'generation-failed'); continue }
          if (!candidateSetRef) throw new Error('GEPA generated snapshot lacks its sealed harness binding')
          const { snapshot, changedPaths } = value
          validateSnapshot(snapshot)
          if (snapshot.candidateId !== work.workplan.candidateId || snapshot.parentIds.length !== 1
            || snapshot.parentIds[0] !== work.parent.candidateId) throw new Error('GEPA generated snapshot parent/id drift')
          const candidate = bindings.read(candidateSetRef).slots.harness
          if (!candidate) throw new Error('GEPA generated candidate lacks a harness binding')
          const sealed = options.artifacts.getJson(candidate) as Record<string, unknown>
          if (sealed.commitOid !== snapshot.commit || sealed.manifestDigest !== snapshot.manifestDigest)
            throw new Error('GEPA generated snapshot/binding mismatch')
          state.generated[work.workplan.candidateId] = { snapshot, candidateSetRef, changedPaths, digest: value.digest }
          state.snapshotBindings[snapshot.digest] = candidateSetRef
          generated.push(work)
        }
        state.works = generated; state.phase = 'local'
        const operations = generated.map((work, index) => evaluation(`local-candidate-${index}`, options.seed, work.plan,
          state.generated[work.workplan.candidateId]!.snapshot, state))
        if (!operations.length) return advance(state, completed, context)
        return output(state, operations, false, undefined, context.budget)
      }
      case 'local': {
        for (const [index, work] of state.works.entries()) {
          const generated = state.generated[work.workplan.candidateId]!
          const observed = result(completed, `local-candidate-${index}`, work.plan, generated.snapshot)
          if (!observed) { state.reasons.push(`local-evidence-unavailable:${work.workplan.candidateId}`); continue }
          if (observed.failure) state.reasons.push(`${observed.failure.kind}:${observed.failure.code}`)
          const outsideBoundary = generated.changedPaths.some(path => !work.workplan.modificationPaths.some(root => path === root || path.startsWith(`${root}/`)))
          const broaderScopeSatisfied = work.workplan.modificationBoundaryRule.requiredSeedTaskIds.every(id => work.plan.taskIds.includes(id))
          if (outsideBoundary) state.reasons.push(`${broaderScopeSatisfied ? 'modification-boundary-full-seed-covered' : 'requires-broader-evaluation'}:${generated.snapshot.candidateId}`)
          state.locals.push({ work, snapshot: generated.snapshot, result: observed, changedPaths: generated.changedPaths,
            outsideBoundary, broaderScopeSatisfied })
        }
        state.bridge = await chooseGepaBridge({ locals: state.locals, anchor: options.anchor, seed: options.seed,
          settings: options.settings, roundIndex: options.roundIndex,
          remainingCells: context.budget?.dimensions.rolloutCells?.remaining ?? options.settings.budgets.round.maxNewRolloutCells,
          remainingRepairCells: context.budget?.dimensions.repairCells?.remaining ?? options.settings.budgets.round.maxRepairCells,
          knownCells: knownCells(state) })
        for (const work of state.plannedWorks) {
          const generated = state.generated[work.workplan.candidateId]
          const entry = state.locals.find(item => item.work.workplan.candidateId === work.workplan.candidateId)
          const p = entry ? profile(options.seed, work.plan, entry.snapshot, entry.result,
            options.settings.promotion.process.mode, work.scope.weights) : undefined
          const support = seal({ scopeDigest: work.scope.digest,
            generatedDigest: state.generatedAttempts[work.workplan.candidateId]?.digest
              ?? digestJson([work.workplan.digest, 'no-candidate']),
            baselineDigest: work.parentBaseline.digest,
            ...(entry ? { resultDigest: entry.result.digest, profile: p } : {}) })
          state.supportObjects.push(support)
          const advance = state.bridge.plan?.participantIds.includes(work.workplan.candidateId) ?? false
          const incomplete = entry && (!scoringComplete(p!) || !!entry.result.failure)
          const boundaryBlocked = entry?.outsideBoundary && !entry.broaderScopeSatisfied
          const exclusion = state.bridge.exclusions.find(item => item.candidateId === work.workplan.candidateId)?.reason
          state.stageDecisions.push(seal({ stagePlanDigest: work.plan.digest,
            candidateId: work.workplan.candidateId,
            outcome: !entry || boundaryBlocked ? 'ineligible' as const : incomplete ? 'insufficient-evidence' as const
              : advance ? 'advance' as const : 'retained-local' as const,
            reasonCodes: !entry ? [state.generatedAttempts[work.workplan.candidateId]?.reason ?? 'generation-failed']
              : boundaryBlocked ? ['requires-broader-evaluation']
              : incomplete ? [entry.result.failure ? 'stage-execution-unavailable' : 'incomplete-local-evidence']
                : advance ? ['selected-for-bridge'] : [exclusion ?? 'not-selected-within-scope'],
            supportDigest: support.digest, ...(advance ? { nextStagePlanDigest: state.bridge.plan!.digest } : {}) }))
        }
        if (!state.bridge.plan) { state.reasons.push('no-bridge-quota'); return finish(state) }
        state.bridgePlan = state.bridge.plan
        if (needsInitialReference(options.seed, state, state.bridgePlan)) {
          state.phase = 'bridge-reference-lookup'
          return output(state, [evaluation('bridge-0', options.seed, state.bridgePlan, options.anchor, state)],
            false, undefined, context.budget)
        }
        state.phase = 'bridge'
        // The frozen plan lists selected candidates before the anchor. The old
        // execution order evaluates the anchor first, then each participant.
        const snapshots = [options.anchor, ...state.bridge.plan.participantIds
          .filter(id => id !== options.anchor.candidateId)
          .map(id => state.locals.find(item => item.snapshot.candidateId === id)!.snapshot)]
        return output(state, snapshots.map((snapshot, index) => evaluation(`bridge-${index}`, options.seed, state.bridgePlan!, snapshot, state)), false, undefined, context.budget)
      }
      case 'bridge-reference-lookup': {
        const plan = state.bridgePlan!
        const baseline = result(completed, 'bridge-0', plan, options.anchor)
        if (!baseline) throw new Error('GEPA bridge anchor evidence is unavailable')
        state.bridgeResults[options.anchor.candidateId] = baseline
        state.phase = 'bridge-reference-resolve'
        return output(state, [lookupReference('bridge-reference-lookup', options.seed, plan)],
          false, undefined, context.budget)
      }
      case 'bridge-reference-resolve': {
        const plan = state.bridgePlan!
        if (consumeLookup('bridge-reference-lookup', options.seed, plan, completed, state)) {
          state.phase = 'bridge'
          const candidates = plan.participantIds.filter(id => id !== options.anchor.candidateId)
            .map(id => state.locals.find(item => item.snapshot.candidateId === id)!.snapshot)
          return output(state, candidates.map((snapshot, index) => evaluation(`bridge-${index + 1}`,
            options.seed, plan, snapshot, state)), false, undefined, context.budget)
        }
        state.phase = 'bridge-reference'
        return output(state, [referenceEvaluation('bridge-reference', options.seed, plan, state)],
          false, undefined, context.budget)
      }
      case 'bridge-reference': {
        const plan = state.bridgePlan!
        const referenceResult = result(completed, 'bridge-reference', initialReferencePlan(plan), options.initialSnapshot)
        if (!referenceResult) throw new Error('GEPA bridge objective reference evidence is unavailable')
        state.phase = 'bridge-reference-checkpoint'
        return output(state, [freezeReference('bridge-reference', options.seed, plan, completed)], false, undefined, context.budget)
      }
      case 'bridge-reference-checkpoint': {
        const plan = state.bridgePlan!
        consumeReference('bridge-reference', options.seed, plan, completed, state)
        state.phase = 'bridge'
        const candidates = plan.participantIds.filter(id => id !== options.anchor.candidateId)
          .map(id => state.locals.find(item => item.snapshot.candidateId === id)!.snapshot)
        return output(state, candidates.map((snapshot, index) => evaluation(`bridge-${index + 1}`,
          options.seed, plan, snapshot, state)), false, undefined, context.budget)
      }
      case 'bridge': {
        const plan = state.bridgePlan!
        const snapshots = [options.anchor, ...plan.participantIds
          .filter(id => id !== options.anchor.candidateId)
          .map(id => state.locals.find(item => item.snapshot.candidateId === id)!.snapshot)]
        for (const [index, snapshot] of snapshots.entries()) {
          const observed = result(completed, `bridge-${index}`, plan, snapshot)
          if (observed) state.bridgeResults[snapshot.candidateId] = observed
        }
        const baseline = state.bridgeResults[options.anchor.candidateId]
        if (!baseline) { state.reasons.push('bridge-baseline-unavailable'); return finish(state) }
        const gates = snapshots.filter(snapshot => snapshot.candidateId !== options.anchor.candidateId).flatMap(snapshot => {
          const observed = state.bridgeResults[snapshot.candidateId]
          if (!observed) return []
          const gate = assessGate({ universe: options.seed, plan, anchor: options.anchor, candidate: snapshot,
            baseline, result: observed,
            initialBaseline: state.objectiveReferences[referenceKey(options.seed, plan)] }, options.settings.promotion, false)
          if (observed.failure) state.reasons.push(`${observed.failure.kind}:${observed.failure.code}`)
          return [{ snapshot, result: observed, gate }]
        })
        if (gates.some(item => item.gate.outcome === 'insufficient-evidence')) state.reasons.push('incomplete-bridge-evidence')
        if (baseline.failure) state.reasons.push(`${baseline.failure.kind}:${baseline.failure.code}`)
        const eligible = gates.filter(item => item.gate.outcome === 'eligible').map(item => ({ id: item.snapshot.candidateId,
          profile: profile(options.seed, plan, item.snapshot, item.result, options.settings.promotion.process.mode) }))
        state.nomineeId = gates.some(item => item.gate.outcome === 'insufficient-evidence') ? null
          : rankProfiles(options.seed, eligible)[0] ?? null
        for (const item of gates) {
          const support = seal({ scopeDigest: plan.scopeDigest, baselineDigest: baseline.digest,
            resultDigest: item.result.digest, gate: item.gate })
          state.supportObjects.push(support)
          const advance = item.snapshot.candidateId === state.nomineeId
          const insufficient = item.gate.outcome === 'insufficient-evidence'
            || state.nomineeId === null && item.gate.outcome === 'eligible'
              && gates.some(row => row.gate.outcome === 'insufficient-evidence')
          const nextPlan = advance ? fullPlan(options.seed, 'global-seed',
            [options.anchor.candidateId, item.snapshot.candidateId]) : null
          state.stageDecisions.push(seal({ stagePlanDigest: plan.digest, candidateId: item.snapshot.candidateId,
            outcome: advance ? 'advance' as const : insufficient ? 'insufficient-evidence' as const
              : item.gate.outcome === 'eligible' ? 'retained-local' as const : 'ineligible' as const,
            reasonCodes: advance ? ['selected-for-global-seed'] : insufficient ? ['incomplete-bridge-evidence']
              : item.gate.outcome === 'eligible' ? ['not-selected-for-global-seed'] : item.gate.reasonCodes,
            supportDigest: support.digest, ...(nextPlan ? { nextStagePlanDigest: nextPlan.digest } : {}) }))
        }
        if (!state.nomineeId) return finish(state)
        const nominee = state.locals.find(item => item.snapshot.candidateId === state.nomineeId)!.snapshot
        state.globalPlan = fullPlan(options.seed, 'global-seed', [options.anchor.candidateId, nominee.candidateId])
        state.phase = 'global-seed'
        return output(state, [evaluation('global-anchor', options.seed, state.globalPlan, options.anchor, state),
          evaluation('global-nominee', options.seed, state.globalPlan, nominee, state)], false, undefined, context.budget)
      }
      case 'global-seed': {
        const plan = state.globalPlan!, nominee = state.locals.find(item => item.snapshot.candidateId === state.nomineeId)!.snapshot
        const baseline = result(completed, 'global-anchor', plan, options.anchor)
        const observed = result(completed, 'global-nominee', plan, nominee)
        if (baseline) state.globalResults[options.anchor.candidateId] = baseline
        if (observed) state.globalResults[nominee.candidateId] = observed
        if (!baseline || !observed) { state.reasons.push('global-seed-evidence-unavailable'); return finish(state) }
        if (needsInitialReference(options.seed, state, plan)) {
          state.phase = 'global-reference-lookup'
          return output(state, [lookupReference('global-reference-lookup', options.seed, plan)],
            false, undefined, context.budget)
        }
        return completeGlobalSeed(state)
      }
      case 'global-reference-lookup': {
        const plan = state.globalPlan!
        if (consumeLookup('global-reference-lookup', options.seed, plan, completed, state))
          return completeGlobalSeed(state)
        state.phase = 'global-reference'
        return output(state, [referenceEvaluation('global-reference', options.seed, plan, state)],
          false, undefined, context.budget)
      }
      case 'global-reference': {
        const plan = state.globalPlan!
        if (!result(completed, 'global-reference', initialReferencePlan(plan), options.initialSnapshot))
          throw new Error('GEPA global seed objective reference evidence is unavailable')
        state.phase = 'global-reference-checkpoint'
        return output(state, [freezeReference('global-reference', options.seed, plan, completed)],
          false, undefined, context.budget)
      }
      case 'global-reference-checkpoint': {
        consumeReference('global-reference', options.seed, state.globalPlan!, completed, state)
        return completeGlobalSeed(state)
      }
      case 'seed-research': {
        if (state.seedGate?.outcome !== 'eligible' || !state.nomineeId) return finish(state)
        const nominee = state.locals.find(item => item.snapshot.candidateId === state.nomineeId)!.snapshot
        state.heldOutPlan = fullPlan(options.heldOut, 'held-out', [options.anchor.candidateId, nominee.candidateId])
        if (needsInitialReference(options.heldOut, state, state.heldOutPlan)) {
          state.phase = 'held-out-reference-lookup'
          return output(state, [lookupReference('held-out-reference-lookup', options.heldOut,
            state.heldOutPlan)], false, undefined, context.budget)
        }
        state.phase = 'held-out'
        return output(state, [evaluation('held-out-anchor', options.heldOut, state.heldOutPlan, options.anchor, state),
          evaluation('held-out-nominee', options.heldOut, state.heldOutPlan, nominee, state)], false, undefined, context.budget)
      }
      case 'held-out': {
        const plan = state.heldOutPlan!, nominee = state.locals.find(item => item.snapshot.candidateId === state.nomineeId)!.snapshot
        const baseline = result(completed, 'held-out-anchor', plan, options.anchor)
        const observed = result(completed, 'held-out-nominee', plan, nominee)
        if (baseline) state.heldOutResults[options.anchor.candidateId] = baseline
        if (observed) state.heldOutResults[nominee.candidateId] = observed
        if (!baseline || !observed) { state.reasons.push('held-out-evidence-unavailable'); return finish(state) }
        for (const row of [baseline, observed]) if (row.failure) state.reasons.push(`${row.failure.kind}:${row.failure.code}`)
        return finishHeldOut(state, context)
      }
      case 'held-out-reference-lookup': {
        const plan = state.heldOutPlan!, nominee = state.locals.find(item => item.snapshot.candidateId === state.nomineeId)!.snapshot
        if (consumeLookup('held-out-reference-lookup', options.heldOut, plan, completed, state)) {
          state.phase = 'held-out'
          return output(state, [evaluation('held-out-anchor', options.heldOut, plan, options.anchor, state),
            evaluation('held-out-nominee', options.heldOut, plan, nominee, state)], false, undefined, context.budget)
        }
        state.phase = 'held-out-reference'
        return output(state, [referenceEvaluation('held-out-reference', options.heldOut, plan, state)],
          false, undefined, context.budget)
      }
      case 'held-out-reference': {
        const plan = state.heldOutPlan!
        if (!result(completed, 'held-out-reference', initialReferencePlan(plan), options.initialSnapshot))
          throw new Error('GEPA held-out objective reference evidence is unavailable')
        state.phase = 'held-out-reference-checkpoint'
        return output(state, [freezeReference('held-out-reference', options.heldOut, plan, completed)],
          false, undefined, context.budget)
      }
      case 'held-out-reference-checkpoint': {
        const plan = state.heldOutPlan!, nominee = state.locals.find(item => item.snapshot.candidateId === state.nomineeId)!.snapshot
        consumeReference('held-out-reference', options.heldOut, plan, completed, state)
        state.phase = 'held-out'
        return output(state, [evaluation('held-out-anchor', options.heldOut, plan, options.anchor, state),
          evaluation('held-out-nominee', options.heldOut, plan, nominee, state)], false, undefined, context.budget)
      }
      case 'await-repair': {
        const outcome = completed['await-held-out-repair']
        if (outcome?.kind !== 'result' || !outcome.value || typeof outcome.value !== 'object'
          || Array.isArray(outcome.value)) throw new Error('GEPA repair barrier lacks revised evidence')
        const revisions = (outcome.value as { revisions?: Array<{ originalRef: string; result: StageResult }> }).revisions
        if (!Array.isArray(revisions) || revisions.length !== 2 || !state.heldOutOriginalRefs)
          throw new Error('GEPA repair barrier revision list invalid')
        const nominee = state.locals.find(item => item.snapshot.candidateId === state.nomineeId)!.snapshot
        for (const [index, snapshot] of [options.anchor, nominee].entries()) {
          const revision = revisions[index]!
          verifyDigest(revision.result)
          if (revision.originalRef !== state.heldOutOriginalRefs[index]
            || revision.result.stagePlanDigest !== state.heldOutPlan!.digest
            || revision.result.snapshotDigest !== snapshot.digest)
            throw new Error('GEPA repair barrier revision identity drift')
          state.heldOutResults[snapshot.candidateId] = revision.result
          if (revision.result.failure)
            state.reasons.push(`${revision.result.failure.kind}:${revision.result.failure.code}`)
        }
        return finishHeldOut(state, context)
      }
      case 'done': return output(state, [], true)
    }
  }
  return {
    describe: () => ({ id: 'failure-cluster-gepa', apiVersion: ALGORITHM_API_VERSION, implementationDigest,
      stateSchema: { type: 'object', additionalProperties: true }, configSchema: { type: 'object', additionalProperties: true },
      bindingSchema: options.bindingSchema, requiredOperationKinds: ['gepa.evaluate', 'gepa.diagnose', 'gepa.generate',
        ...(options.seed.objective || options.heldOut.objective ? ['gepa.objective-reference'] : []),
        ...(options.preserveLegacyExternalKeys ? ['gepa.await-repair'] : [])] }),
    initialize(context: DecisionContext) {
      if (context.activeBindingSetRef.digest !== options.snapshotBindings[options.anchor.digest]?.digest)
        throw new Error('GEPA active binding is not the frozen anchor')
      const parents = chooseGepaParents(options.archive, policy, options.roundId, options.maxCandidates,
        options.settings.search.seed, options.anchor.candidateId)
      const scopePlan = planGepaScopePreparation({ archive: options.archive, parents, anchor: options.anchor,
        seed: options.seed, settings: options.settings, roundIndex: options.roundIndex,
        remainingCells: context.budget?.dimensions.rolloutCells?.remaining ?? options.settings.budgets.round.maxNewRolloutCells,
        remainingRepairCells: context.budget?.dimensions.repairCells?.remaining ?? options.settings.budgets.round.maxRepairCells,
        sharedEpochs: options.sharedEpochs })
      const firstParent = options.archive.snapshots.find(snapshot => snapshot.digest === parents.batches[0]?.parentSnapshotDigest)
        ?? options.anchor
      const sharedEpochs = { ...options.sharedEpochs,
        [String(scopePlan.base.epoch)]: options.sharedEpochs[String(scopePlan.base.epoch)] ?? {
          epoch: scopePlan.base.epoch, archiveCutoffDigest: options.archive.digest,
          parentSnapshotDigest: firstParent.digest, taskIds: scopePlan.base.sharedTaskIds } }
      const state: State = { phase: scopePlan.pending.length ? 'scope-preparation' : 'parent-probe', parents,
        scopePlan, queuedOperations: [], queuedCompleted: {}, sharedEpochs,
        preparation: scopePlan.pending.length ? null : completeGepaScopePreparation(scopePlan, {}, options.seed, options.settings),
        baselines: {}, dossiers: {}, works: [], plannedWorks: [], localBaselines: {},
        batchIndex: 0, batchFamilies: [], familyIndex: 0, hypothesisIndex: 0,
        familyScope: null, probeIndex: 0, pendingProbe: null, usedHypotheses: [],
        plannedScopes: [], diagnosedClusters: [],
        generated: {}, generatedAttempts: {}, locals: [], bridge: null, bridgePlan: null, bridgeResults: {}, globalPlan: null,
        globalResults: {}, heldOutPlan: null, heldOutResults: {}, heldOutOriginalRefs: null,
        nomineeId: null, seedGate: null, finalGate: null,
        archiveRef: null, reasons: [], snapshotBindings: { ...options.snapshotBindings,
          [options.initialSnapshot.digest]: initialSnapshotBindingSetRef },
        stageDecisions: [], findings: [], supportObjects: [],
        objectiveReferences: { ...options.objectiveReferences } }
      const operations = scopePlan.pending.length ? scopePlan.pending.flatMap((proposal, index) =>
        proposal.participants.map((snapshot, participantIndex) => evaluation(`prepare-${index}-${participantIndex}`,
          options.seed, proposal.plan, snapshot, state))) : []
      return operations.length ? output(state, operations, false, undefined, context.budget) : startBatch(state, context)
    },
    async reduce(context: ReduceContext) {
      const state = context.state as unknown as State
      const completed = { ...state.queuedCompleted, ...context.completed }
      if (state.queuedOperations.length) {
        const next = state.queuedOperations.shift()!
        state.queuedCompleted = completed
        return output(state, [next], false, undefined, context.budget)
      }
      state.queuedCompleted = {}
      const decision = await advance(state, completed, context)
      // The hosted legacy facade publishes seed research at this pure boundary.
      // A directly hosted GEPA recipe advances the same state machine without
      // emitting an empty nonterminal kernel decision.
      if (!options.preserveLegacyExternalKeys && state.phase === 'seed-research'
        && !decision.complete && !decision.operations?.length)
        return advance(state, {}, context)
      return decision
    },
  }
}
