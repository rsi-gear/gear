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
import { cellKey, plannedCells, profile, validOutcome } from '../../search/evidence.js'
import { assessGate, decideFinal, precheckSeed, rankProfiles, type PromotionInput } from '../../search/promotion.js'
import { integrity, resolveSizing, seal, verifyDigest, validateSettings,
  validateSnapshot } from '../../search/contracts.js'
import { resolveParentPolicyRef, scopedFrontierPolicy, championGepaPolicy } from '../../search/policies/parents.js'
import { stagePlan } from '../../search/scopes.js'
import type { ScopeEpochPreparation } from '../../search/epochs.js'
import type { ParentSelectionPolicy } from '../../search/parent-selection.js'
import type { BridgeSelectionDecision, DiagnosisDossier, GateDecision, ParentSelectionDecision, ResearchArchive,
  ResearchFinding, SearchSettings, Snapshot, StageEvaluationPlan, StageResult, TaskUniverse } from '../../search/types.js'
import { chooseGepaBridge, chooseGepaParents, completeGepaScopePreparation, planGepaScopePreparation,
  planGepaWorks, updateGepaArchive, type GepaBaseline, type GepaLocal, type GepaPreparationPlan, type GepaWork } from './gepa-policy.js'
import type { GepaSharedEpoch } from './gepa-policy.js'

type Phase = 'scope-preparation' | 'parent-probe' | 'diagnosis' | 'local-baseline' | 'generation' | 'local' | 'bridge' | 'global-seed' | 'held-out' | 'done'
type Generated = { snapshot: Snapshot; candidateSetRef: BindingSetRef; changedPaths: string[] }
type State = { phase: Phase; parents: ParentSelectionDecision; scopePlan: GepaPreparationPlan;
  queuedOperations: OperationIntent[]; queuedCompleted: Record<string, OperationOutcome>;
  sharedEpochs: Record<string, GepaSharedEpoch>;
  preparation: ScopeEpochPreparation | null; baselines: Record<string, GepaBaseline>;
  dossiers: Record<string, DiagnosisDossier>; works: GepaWork[]; localBaselines: Record<string, StageResult>;
  generated: Record<string, Generated>; locals: GepaLocal[]; bridge: BridgeSelectionDecision | null;
  bridgePlan: StageEvaluationPlan | null; bridgeResults: Record<string, StageResult>;
  globalPlan: StageEvaluationPlan | null; globalResults: Record<string, StageResult>;
  heldOutPlan: StageEvaluationPlan | null; heldOutResults: Record<string, StageResult>;
  nomineeId: string | null; seedGate: GateDecision | null; finalGate: GateDecision | null;
  archiveRef: ArtifactRef | null; reasons: string[]; snapshotBindings: Record<string, BindingSetRef> }

export type GepaRecipeOptions = { evolutionId: string; roundId: string; roundIndex: number; maxCandidates: number;
  anchor: Snapshot; seed: TaskUniverse; heldOut: TaskUniverse; archive: ResearchArchive; settings: SearchSettings;
  bindingSchema: BindingSchema; snapshotBindings: Record<string, BindingSetRef>; artifacts: FileArtifactStore;
  deadlineAt: number; parentPolicy?: ParentSelectionPolicy; findings?: Record<string, ResearchFinding>;
  sharedEpochs?: Record<string, GepaSharedEpoch> }

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

/** One GEPA round in the common campaign journal. Old policy functions remain the source of scientific decisions. */
export function failureClusterGepaRecipe(input: GepaRecipeOptions): Algorithm {
  const options = { ...input, anchor: structuredClone(input.anchor), seed: structuredClone(input.seed), heldOut: structuredClone(input.heldOut),
    archive: structuredClone(input.archive), settings: structuredClone(input.settings),
    snapshotBindings: structuredClone(input.snapshotBindings), findings: structuredClone(input.findings ?? {}),
    sharedEpochs: structuredClone(input.sharedEpochs ?? {}) }
  validateSnapshot(options.anchor); verifyDigest(options.seed); verifyDigest(options.heldOut); verifyDigest(options.archive)
  validateSettings(options.settings, options.seed, options.heldOut, options.maxCandidates)
  if (options.settings.budgets.round.maxGenerationTokens === undefined
    || options.settings.budgets.round.maxGenerationRequests === undefined)
    throw new Error('GEPA common-operation recipe requires finite generation reservations')
  if (options.archive.universeDigest !== options.seed.digest || !options.archive.snapshots.some(item => item.digest === options.anchor.digest))
    throw new Error('GEPA archive must contain the frozen seed anchor')
  if (!Number.isSafeInteger(options.deadlineAt) || options.deadlineAt < 0) throw new Error('GEPA deadline must be frozen at admission')
  const policyRef = resolveParentPolicyRef(options.settings.search)
  const policy = input.parentPolicy ?? (options.settings.search.parentSampling === 'epsilon-greedy-gepa-v1'
    ? championGepaPolicy(policyRef) : scopedFrontierPolicy(policyRef))
  if (digestJson(policy.ref) !== digestJson(policyRef)) throw new Error('GEPA parent policy differs from frozen settings')
  const bindings = new BindingStore(options.artifacts, options.bindingSchema)
  for (const snapshot of options.archive.snapshots) {
    const ref = options.snapshotBindings[snapshot.digest]
    if (!ref) throw new Error(`GEPA parent binding missing: ${snapshot.candidateId}`)
    const harnessRef = bindings.read(ref).slots.harness
    if (!harnessRef) throw new Error('GEPA requires a harness binding for every archive snapshot')
    const value = options.artifacts.getJson(harnessRef) as Record<string, unknown>
    if (value.commitOid !== snapshot.commit || value.manifestDigest !== snapshot.manifestDigest)
      throw new Error('GEPA parent binding does not match its frozen snapshot')
    for (const findingRef of snapshot.findingRefs) {
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
    policyRef: policy.ref, findings: options.findings, sharedEpochs: options.sharedEpochs })
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
    return task(key, 'gepa.evaluate', { universe, plan, snapshot, processMode } as unknown as JsonValue,
      { bindingSetRef: reference(state, snapshot), limits: { rolloutCells: missing.length, repairCells } })
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
  const probeOperations = (state: State): OperationIntent[] => state.parents.batches.map((batch, index) => {
    const parent = options.archive.snapshots.find(snapshot => snapshot.digest === batch.parentSnapshotDigest)!
    const sourceScope = options.archive.scopes.find(item => item.digest === batch.sourceScopeDigest)!
    const scope = state.preparation?.scopes.find(item => item.familyId === sourceScope.familyId) ?? sourceScope
    const plan = basePlan(options.seed, 'baseline-probe', scope.digest, scope.taskIds, [parent.candidateId],
      [state.parents.digest, ...(state.preparation ? [state.preparation.digest] : [])])
    return evaluation(`parent-${index}`, options.seed, plan, parent, state)
  })
  const finish = (state: State): AlgorithmDecision => {
    const stagePlans: StageEvaluationPlan[] = []
    const stageResults: StageResult[] = []
    for (const work of state.works) {
      const baseline = state.localBaselines[work.workplan.candidateId]
      if (baseline) { stagePlans.push(work.plan); stageResults.push(baseline) }
    }
    for (const plan of [state.bridgePlan, state.globalPlan]) if (plan) {
      stagePlans.push(plan); stageResults.push(...Object.values(plan.stage === 'bridge' ? state.bridgeResults : state.globalResults))
    }
    const archive = updateGepaArchive({ previous: options.archive, seed: options.seed, settings: options.settings,
      anchor: options.anchor, championId: options.anchor.candidateId, locals: state.locals, works: state.works,
      clusters: state.works.map(work => work.cluster), scopes: [...new Map([
        ...(state.preparation?.scopes ?? []), ...state.works.map(work => work.scope)].map(scope => [scope.digest, scope])).values()],
      parentBaselines: Object.values(state.baselines), stagePlans: [...(state.preparation?.plans ?? []), ...stagePlans],
      stageResults: [...(state.preparation?.results ?? []), ...stageResults], evolutionId: options.evolutionId })
    state.archiveRef = options.artifacts.putJson(archive as unknown as JsonValue, 'gepa.research-archive.v1')
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
        state.phase = 'parent-probe'
        const operations = probeOperations(state)
        return operations.length ? output(state, operations, false, undefined, context.budget) : finish(state)
      }
      case 'parent-probe': {
        for (const [index, batch] of state.parents.batches.entries()) {
          const parent = options.archive.snapshots.find(snapshot => snapshot.digest === batch.parentSnapshotDigest)!
          const sourceScope = options.archive.scopes.find(item => item.digest === batch.sourceScopeDigest)!
          const scope = state.preparation?.scopes.find(item => item.familyId === sourceScope.familyId) ?? sourceScope
          const plan = basePlan(options.seed, 'baseline-probe', scope.digest, scope.taskIds, [parent.candidateId],
            [state.parents.digest, ...(state.preparation ? [state.preparation.digest] : [])])
          const observed = result(completed, `parent-${index}`, plan, parent)
          if (observed) state.baselines[batch.batchId] = { plan, result: observed }
        }
        state.phase = 'diagnosis'
        const operations = state.parents.batches.flatMap((batch, index) => {
          const record = state.baselines[batch.batchId]
          if (!record || record.result.failure) return []
          const parent = options.archive.snapshots.find(snapshot => snapshot.digest === batch.parentSnapshotDigest)!
          return [task(`diagnose-${index}`, 'gepa.diagnose', { snapshot: parent, universe: options.seed,
            taskIds: record.plan.taskIds, baseline: record.result } as unknown as JsonValue,
          { bindingSetRef: reference(state, parent), limits: {
            diagnosisInputTokens: options.settings.budgets.round.maxDiagnosisInputTokens,
            diagnosisOutputTokens: options.settings.budgets.round.maxDiagnosisOutputTokens } })]
        })
        return operations.length ? output(state, operations, false, undefined, context.budget) : advance(state, {}, context)
      }
      case 'diagnosis': {
        for (const [index, batch] of state.parents.batches.entries()) {
          const ref = resultRef(completed[`diagnose-${index}`], 'dossierRef')
          if (ref) state.dossiers[batch.batchId] = readOld<DiagnosisDossier>(options.artifacts, ref)
        }
        const planned = planGepaWorks({ archive: options.archive, parents: state.parents, baselines: state.baselines,
          dossiers: state.dossiers, preparation: state.preparation!, seed: options.seed, settings: options.settings, roundId: options.roundId,
          roundIndex: options.roundIndex, maxCandidates: options.maxCandidates, deadlineAt: options.deadlineAt,
          remainingGenerationTokens: context.budget?.dimensions.generationTokens?.remaining ?? options.settings.budgets.round.maxGenerationTokens!,
          remainingGenerationRequests: context.budget?.dimensions.generationRequests?.remaining ?? options.settings.budgets.round.maxGenerationRequests! })
        state.works = planned.works; state.reasons.push(...planned.reasons)
        state.phase = 'local-baseline'
        const operations = state.works.map((work, index) => evaluation(`local-parent-${index}`, options.seed, work.plan, work.parent, state))
        return operations.length ? output(state, operations, false, undefined, context.budget) : finish(state)
      }
      case 'local-baseline': {
        const eligible: GepaWork[] = []
        for (const [index, work] of state.works.entries()) {
          const baseline = result(completed, `local-parent-${index}`, work.plan, work.parent)
          if (!baseline || baseline.failure) { state.reasons.push(`local-parent-unavailable:${work.workplan.candidateId}`); continue }
          state.localBaselines[work.workplan.candidateId] = baseline
          const parent = profile(options.seed, work.plan, work.parent, baseline, options.settings.search.process.mode, work.scope.weights)
          const confirmed = work.cluster.taskIds.some(id => parent.tasks.some(task => task.taskId === id
            && (options.seed.objective ? task.objectiveScore?.score !== undefined
              : task.outcome !== undefined && task.outcome < options.seed.tasks.find(item => item.id === id)!.successUtility)))
          if (!passesExploration(work.scope, parent, options.seed) || !confirmed) {
            state.reasons.push(`hypothesis-unconfirmed:${work.cluster.familyId}`); continue
          }
          eligible.push(work)
        }
        state.works = eligible; state.phase = 'generation'
        const operations = eligible.map((work, index) => task(`generate-${index}`, 'gepa.generate', {
          workplan: work.workplan, dossier: work.dossier, scope: work.scope, parent: work.parent,
          plan: work.plan, baseline: state.localBaselines[work.workplan.candidateId], universe: options.seed,
          findings: work.parent.findingRefs.map(ref => options.findings[ref]!),
          processMode: options.settings.search.process.mode } as unknown as JsonValue,
        { bindingSetRef: reference(state, work.parent), limits: {
          ...(work.workplan.generationBudget.maxTokens === undefined ? {} : { generationTokens: work.workplan.generationBudget.maxTokens }),
          ...(work.workplan.generationBudget.maxModelRequests === undefined ? {} : { generationRequests: work.workplan.generationBudget.maxModelRequests }) } }))
        return operations.length ? output(state, operations, false, undefined, context.budget) : finish(state)
      }
      case 'generation': {
        const generated: GepaWork[] = []
        for (const [index, work] of state.works.entries()) {
          const outcome = completed[`generate-${index}`]
          const ref = resultRef(outcome, 'generatedRef'), candidateSetRef = bindingRef(outcome, 'candidateSetRef')
          if (!ref || !candidateSetRef) { state.reasons.push(`generation-unavailable:${work.workplan.candidateId}`); continue }
          const value = readOld<{ digest: string; snapshot: Snapshot; changedPaths: string[] }>(options.artifacts, ref)
          const { snapshot, changedPaths } = value
          validateSnapshot(snapshot)
          if (snapshot.candidateId !== work.workplan.candidateId || snapshot.parentIds.length !== 1
            || snapshot.parentIds[0] !== work.parent.candidateId) throw new Error('GEPA generated snapshot parent/id drift')
          const candidate = bindings.read(candidateSetRef).slots.harness
          if (!candidate) throw new Error('GEPA generated candidate lacks a harness binding')
          const sealed = options.artifacts.getJson(candidate) as Record<string, unknown>
          if (sealed.commitOid !== snapshot.commit || sealed.manifestDigest !== snapshot.manifestDigest)
            throw new Error('GEPA generated snapshot/binding mismatch')
          state.generated[work.workplan.candidateId] = { snapshot, candidateSetRef, changedPaths }
          state.snapshotBindings[snapshot.digest] = candidateSetRef
          generated.push(work)
        }
        state.works = generated; state.phase = 'local'
        const operations = generated.map((work, index) => evaluation(`local-candidate-${index}`, options.seed, work.plan,
          state.generated[work.workplan.candidateId]!.snapshot, state))
        return operations.length ? output(state, operations, false, undefined, context.budget) : finish(state)
      }
      case 'local': {
        for (const [index, work] of state.works.entries()) {
          const generated = state.generated[work.workplan.candidateId]!
          const observed = result(completed, `local-candidate-${index}`, work.plan, generated.snapshot)
          if (!observed) { state.reasons.push(`local-evidence-unavailable:${work.workplan.candidateId}`); continue }
          const outsideBoundary = generated.changedPaths.some(path => !work.workplan.modificationPaths.some(root => path === root || path.startsWith(`${root}/`)))
          const broaderScopeSatisfied = work.workplan.modificationBoundaryRule.requiredSeedTaskIds.every(id => work.plan.taskIds.includes(id))
          state.locals.push({ work, snapshot: generated.snapshot, result: observed, changedPaths: generated.changedPaths,
            outsideBoundary, broaderScopeSatisfied })
        }
        state.bridge = await chooseGepaBridge({ locals: state.locals, anchor: options.anchor, seed: options.seed,
          settings: options.settings, roundIndex: options.roundIndex,
          remainingCells: context.budget?.dimensions.rolloutCells?.remaining ?? options.settings.budgets.round.maxNewRolloutCells,
          remainingRepairCells: context.budget?.dimensions.repairCells?.remaining ?? options.settings.budgets.round.maxRepairCells,
          knownCells: knownCells(state) })
        if (!state.bridge.plan) { state.reasons.push('no-bridge-quota'); return finish(state) }
        state.bridgePlan = state.bridge.plan; state.phase = 'bridge'
        const snapshots = state.bridge.plan.participantIds.map(id => id === options.anchor.candidateId ? options.anchor
          : state.locals.find(item => item.snapshot.candidateId === id)!.snapshot)
        return output(state, snapshots.map((snapshot, index) => evaluation(`bridge-${index}`, options.seed, state.bridgePlan!, snapshot, state)), false, undefined, context.budget)
      }
      case 'bridge': {
        const plan = state.bridgePlan!
        const snapshots = plan.participantIds.map(id => id === options.anchor.candidateId ? options.anchor
          : state.locals.find(item => item.snapshot.candidateId === id)!.snapshot)
        for (const [index, snapshot] of snapshots.entries()) {
          const observed = result(completed, `bridge-${index}`, plan, snapshot)
          if (observed) state.bridgeResults[snapshot.candidateId] = observed
        }
        const baseline = state.bridgeResults[options.anchor.candidateId]
        if (!baseline) { state.reasons.push('bridge-baseline-unavailable'); return finish(state) }
        const eligible = snapshots.filter(snapshot => snapshot.candidateId !== options.anchor.candidateId).flatMap(snapshot => {
          const observed = state.bridgeResults[snapshot.candidateId]
          if (!observed) return []
          const gate = assessGate({ universe: options.seed, plan, anchor: options.anchor, candidate: snapshot,
            baseline, result: observed }, options.settings.promotion, false)
          return gate.outcome === 'eligible' ? [{ id: snapshot.candidateId,
            profile: profile(options.seed, plan, snapshot, observed, options.settings.promotion.process.mode) }] : []
        })
        state.nomineeId = rankProfiles(options.seed, eligible)[0] ?? null
        if (!state.nomineeId) { state.reasons.push('no-eligible-bridge-nominee'); return finish(state) }
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
        const seedInput: PromotionInput = { universe: options.seed, plan, anchor: options.anchor, candidate: nominee, baseline, result: observed }
        state.seedGate = precheckSeed(seedInput, options.settings.promotion)
        if (state.seedGate.outcome !== 'eligible') { state.finalGate = state.seedGate; return finish(state) }
        state.heldOutPlan = fullPlan(options.heldOut, 'held-out', [options.anchor.candidateId, nominee.candidateId])
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
        const seedInput: PromotionInput = { universe: options.seed, plan: state.globalPlan!, anchor: options.anchor, candidate: nominee,
          baseline: state.globalResults[options.anchor.candidateId]!, result: state.globalResults[nominee.candidateId]! }
        const heldInput: PromotionInput = { universe: options.heldOut, plan, anchor: options.anchor, candidate: nominee, baseline, result: observed }
        state.finalGate = decideFinal(seedInput, heldInput, options.settings.promotion)
        return finish(state)
      }
      case 'done': return output(state, [], true)
    }
  }
  return {
    describe: () => ({ id: 'failure-cluster-gepa', apiVersion: ALGORITHM_API_VERSION, implementationDigest,
      stateSchema: { type: 'object', additionalProperties: true }, configSchema: { type: 'object', additionalProperties: true },
      bindingSchema: options.bindingSchema, requiredOperationKinds: ['gepa.evaluate', 'gepa.diagnose', 'gepa.generate'] }),
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
        baselines: {}, dossiers: {}, works: [], localBaselines: {},
        generated: {}, locals: [], bridge: null, bridgePlan: null, bridgeResults: {}, globalPlan: null,
        globalResults: {}, heldOutPlan: null, heldOutResults: {}, nomineeId: null, seedGate: null, finalGate: null,
        archiveRef: null, reasons: [], snapshotBindings: { ...options.snapshotBindings } }
      const operations = scopePlan.pending.length ? scopePlan.pending.flatMap((proposal, index) =>
        proposal.participants.map((snapshot, participantIndex) => evaluation(`prepare-${index}-${participantIndex}`,
          options.seed, proposal.plan, snapshot, state))) : probeOperations(state)
      return operations.length ? output(state, operations, false, undefined, context.budget) : finish(state)
    },
    reduce(context: ReduceContext) {
      const state = context.state as unknown as State
      const completed = { ...state.queuedCompleted, ...context.completed }
      if (state.queuedOperations.length) {
        const next = state.queuedOperations.shift()!
        state.queuedCompleted = completed
        return output(state, [next], false, undefined, context.budget)
      }
      state.queuedCompleted = {}
      return advance(state, completed, context)
    },
  }
}
