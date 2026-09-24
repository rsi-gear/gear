import type { Algorithm, AlgorithmDecision, ArtifactRef, BindingSchema, BindingSetRef, BudgetSnapshot,
  DecisionContext, OperationIntent, OperationOutcome, ReduceContext } from '../contracts.js'
import { ALGORITHM_API_VERSION } from '../contracts.js'
import { FileArtifactStore } from '../artifacts.js'
import { task } from '../steps.js'
import type { JsonValue } from '../schema.js'
import { implementationClosureDigest } from '../data/identity.js'
import { digestJson } from '../../state/digest.js'
import { buildArchive, passesExploration } from '../../search/archive.js'
import { integrity, plannedCellCount, resolveSizing, scopeEquivalenceDigest, seal, sorted, validateSnapshot, verifyDigest } from '../../search/contracts.js'
import { scopeEpoch, type ScopeEpochPreparation } from '../../search/epochs.js'
import { profile, plannedCells } from '../../search/evidence.js'
import { parentSelectionInput } from '../../search/parent-selection.js'
import { resolveParentPolicyRef } from '../../search/policies/parents.js'
import { stagePlan } from '../../search/scopes.js'
import { usageLimit, type RemainingBudget } from '../../search/store.js'
import type { SearchAdmission } from '../../search/runtime.js'
import type { SearchRoundOutcome } from '../../search/engine.js'
import type { ParentSelectionPolicy } from '../../search/parent-selection.js'
import type { BridgeSelectionDecision, EvaluationScope, EvaluationStageDecision, GateDecision, ResearchFinding,
  ParentSelectionDecision, ResearchArchive, SearchProgress, SearchSettings, Snapshot,
  StageEvaluationPlan, StageResult, TaskUniverse } from '../../search/types.js'
import { failureClusterGepaRecipe, type GepaRecipeOptions } from './gepa.js'

type Phase = 'bootstrap' | 'bootstrap-failure-progress' | 'bootstrap-publication' | 'research' | 'seed-research-checkpoint' | 'terminal-publication' | 'complete'
type InnerState = { phase: string; works: unknown[]; archiveRef: ArtifactRef | null; parents: ParentSelectionDecision;
  preparation: ScopeEpochPreparation | null; baselines: Record<string, { plan: StageEvaluationPlan; result: StageResult }>;
  localBaselines: Record<string, StageResult>;
  locals: Array<{ work: { plan: StageEvaluationPlan }; snapshot: Snapshot; result: StageResult;
    outsideBoundary: boolean; broaderScopeSatisfied: boolean }>;
  bridgePlan: StageEvaluationPlan | null; bridgeResults: Record<string, StageResult>;
  globalPlan: StageEvaluationPlan | null; globalResults: Record<string, StageResult>;
  reasons: string[]; bridge: BridgeSelectionDecision | null; snapshotBindings: Record<string, BindingSetRef>;
  plannedWorks: Array<{ plan: StageEvaluationPlan; parent: Snapshot; scope: EvaluationScope;
    workplan: import('../../search/types.js').CandidateWorkPlan }>;
  stageDecisions: EvaluationStageDecision[]; findings: ResearchFinding[];
  nomineeId: string | null; finalGate: GateDecision | null }
type State = { phase: Phase; bootstrapScope: EvaluationScope; bootstrapPlan: StageEvaluationPlan;
  bootstrapResultRef: ArtifactRef | null; initialArchiveRef: ArtifactRef | null;
  inner: JsonValue | null; outcomeRef: ArtifactRef | null; finalArchiveRef: ArtifactRef | null }

export type CampaignFailureClusterRecipeOptions = {
  admission: SearchAdmission; seed: TaskUniverse; heldOut: TaskUniverse; settings: SearchSettings;
  artifacts: FileArtifactStore; bindingSchema: BindingSchema; anchorBindingSetRef: BindingSetRef;
  deadlineAt: number; parentPolicy: ParentSelectionPolicy;
  findings?: Record<string, ResearchFinding>; handoffFindingDigests?: Record<string, string[]>;
}

function stageResult(artifacts: FileArtifactStore, outcome: OperationOutcome | undefined,
  plan: StageEvaluationPlan, snapshotDigest: string): { ref: ArtifactRef; value: StageResult } {
  if (outcome?.kind !== 'result' || !outcome.value || typeof outcome.value !== 'object' || Array.isArray(outcome.value))
    throw new Error('Campaign bootstrap evaluation has no sealed stage result; recovery/repair is required')
  const ref = (outcome.value as Record<string, unknown>).resultRef as ArtifactRef | undefined
  if (ref?.kind !== 'artifact' || ref.schemaId !== 'gepa.stage-result.v1') throw new Error('Campaign bootstrap result ref is invalid')
  const value = artifacts.getJson(ref) as unknown as StageResult
  verifyDigest(value)
  if (value.stagePlanDigest !== plan.digest || value.snapshotDigest !== snapshotDigest || value.settled !== true)
    throw new Error('Campaign bootstrap result does not match its frozen plan')
  return { ref, value }
}

function remainingBudget(snapshot: BudgetSnapshot | undefined, settings: SearchSettings): RemainingBudget {
  const round = usageLimit(settings.budgets.round), evolution = usageLimit(settings.budgets.evolution)
  const remaining = (dimension: string, oldRound: number, oldEvolution: number): number =>
    snapshot?.dimensions[dimension]?.remaining ?? Math.min(oldRound, oldEvolution)
  return {
    cells: remaining('rolloutCells', round.cells, evolution.cells),
    repairCells: remaining('repairCells', round.repairCells, evolution.repairCells),
    diagnosisInputTokens: remaining('diagnosisInputTokens', round.diagnosisInputTokens, evolution.diagnosisInputTokens),
    diagnosisOutputTokens: remaining('diagnosisOutputTokens', round.diagnosisOutputTokens, evolution.diagnosisOutputTokens),
    generationTokens: snapshot?.dimensions.generationTokens?.remaining
      ?? (round.generationTokens === null && evolution.generationTokens === null ? null
        : Math.min(round.generationTokens ?? Number.MAX_SAFE_INTEGER,
          evolution.generationTokens ?? Number.MAX_SAFE_INTEGER)),
    generationRequests: snapshot?.dimensions.generationRequests?.remaining
      ?? (round.generationRequests === null && evolution.generationRequests === null ? null
        : Math.min(round.generationRequests ?? Number.MAX_SAFE_INTEGER,
          evolution.generationRequests ?? Number.MAX_SAFE_INTEGER)),
  }
}

/** The public search reducer owns bootstrap and publication; each physical step remains a Campaign operation. */
export function campaignFailureClusterRecipe(input: CampaignFailureClusterRecipeOptions): Algorithm {
  const options = { ...input, admission: structuredClone(input.admission), seed: structuredClone(input.seed),
    heldOut: structuredClone(input.heldOut), settings: structuredClone(input.settings) }
  validateSnapshot(options.admission.anchor); verifyDigest(options.seed); verifyDigest(options.heldOut)
  if (digestJson(options.parentPolicy.ref) !== digestJson(resolveParentPolicyRef(options.settings.search)))
    throw new Error('Campaign parent policy differs from frozen search settings')
  const resolution = resolveSizing(options.seed, options.settings.search.taskSetSizing)
  const implementationDigest = implementationClosureDigest(['recipes/gepa-search'], {
    admission: options.admission, seedDigest: options.seed.digest, heldOutDigest: options.heldOut.digest,
    settings: options.settings, bindingSchema: options.bindingSchema,
    anchorBindingSetRef: options.anchorBindingSetRef, deadlineAt: options.deadlineAt,
    parentPolicyRef: options.parentPolicy.ref, findings: options.findings ?? {},
    handoffFindingDigests: options.handoffFindingDigests ?? {},
  })
  const archiveRef = (archive: ResearchArchive): ArtifactRef =>
    options.artifacts.putJson(archive as unknown as JsonValue, 'gepa.research-archive.v1')
  const outcomeRef = (outcome: SearchRoundOutcome): ArtifactRef =>
    options.artifacts.putJson(outcome as unknown as JsonValue, 'gepa.round-outcome.v1')
  const publication = (key: string, expectedArchiveDigest: string | null, nextArchiveRef: ArtifactRef,
    reference: ArtifactRef, publishArchive = true): OperationIntent[] => [task(key, 'gepa.publish', {
      roundId: options.admission.roundId, expectedArchiveDigest, nextArchiveRef,
      expectedChampionRevisionDigest: options.admission.championRevisionDigest, outcomeRef: reference,
      ...(publishArchive ? {} : { publishArchive: false }),
    } as unknown as JsonValue)]
  const innerRecipe = (initialArchiveRef: ArtifactRef): Algorithm => {
    const archive = options.artifacts.getJson(initialArchiveRef) as unknown as ResearchArchive
    verifyDigest(archive)
    const innerOptions: GepaRecipeOptions = { evolutionId: options.admission.evolutionId,
      roundId: options.admission.roundId, roundIndex: options.admission.roundIndex,
      maxCandidates: options.admission.maxCandidates, anchor: options.admission.anchor,
      seed: options.seed, heldOut: options.heldOut, archive, settings: options.settings,
      bindingSchema: options.bindingSchema,
      snapshotBindings: { [options.admission.anchor.digest]: options.anchorBindingSetRef },
      artifacts: options.artifacts, deadlineAt: options.deadlineAt, parentPolicy: options.parentPolicy,
      findings: options.findings ?? {}, handoffFindingDigests: options.handoffFindingDigests ?? {},
      preserveLegacyExternalKeys: true }
    return failureClusterGepaRecipe(innerOptions)
  }
  const seedProgress = (state: State, inner: InnerState): SearchProgress => {
    if (!state.bootstrapResultRef) throw new Error('Campaign seed progress lacks bootstrap result')
    const bootstrap = options.artifacts.getJson(state.bootstrapResultRef) as unknown as StageResult
    const evaluations: SearchProgress['evaluations'] = []
    const add = (plan: StageEvaluationPlan, snapshot: Snapshot, result: StageResult): void => {
      const p = profile(options.seed, plan, snapshot, result,
        ['bridge', 'global-seed'].includes(plan.stage) ? options.settings.promotion.process.mode : options.settings.search.process.mode)
      evaluations.push({ stage: plan.stage as SearchProgress['evaluations'][number]['stage'],
        stagePlanDigest: plan.digest, scopeDigest: plan.scopeDigest, candidateId: snapshot.candidateId,
        state: 'settled', plannedCells: plannedCellCount(options.seed, plan.taskIds),
        profile: { coverage: p.coverage, processCoverage: p.processCoverage,
          outcomeComplete: p.outcomeComplete, processComplete: p.processComplete,
          processTaskIds: p.processTaskIds, tasks: p.tasks, supportDigest: p.supportDigest,
          ...(p.objectiveScore ? { objectiveScore: p.objectiveScore, rawMetrics: p.rawMetrics!, objectiveComplete: p.objectiveComplete! } : {}) },
        ...(result.failure ? { failure: result.failure } : {}) })
    }
    add(state.bootstrapPlan, options.admission.anchor, bootstrap)
    for (const plan of inner.preparation?.plans ?? []) for (const result of inner.preparation?.results ?? []) {
      if (result.stagePlanDigest !== plan.digest) continue
      const snapshot = [options.admission.anchor, ...inner.plannedWorks.map(work => work.parent)]
        .find(candidate => candidate.digest === result.snapshotDigest)
      if (snapshot) add(plan, snapshot, result)
    }
    for (const batch of inner.parents.batches) {
      const row = inner.baselines[batch.batchId]
      if (!row) continue
      const snapshot = [options.admission.anchor, ...inner.plannedWorks.map(work => work.parent)]
        .find(candidate => candidate.digest === row.result.snapshotDigest)
      if (snapshot) add(row.plan, snapshot, row.result)
    }
    for (const work of inner.plannedWorks) {
      const result = inner.localBaselines[work.workplan.candidateId]
      if (result) add(work.plan, work.parent, result)
    }
    for (const local of inner.locals) add(local.work.plan, local.snapshot, local.result)
    for (const [plan, results] of [[inner.bridgePlan, inner.bridgeResults], [inner.globalPlan, inner.globalResults]] as const) {
      if (!plan) continue
      for (const result of Object.values(results)) {
        const snapshot = [options.admission.anchor, ...inner.locals.map(local => local.snapshot)]
          .find(candidate => candidate.digest === result.snapshotDigest)
        if (snapshot) add(plan, snapshot, result)
      }
    }
    const byKey = new Map(evaluations.map(row => [`${row.stagePlanDigest}/${row.candidateId}`, row]))
    return { phase: 'seed-research-complete', evaluations: [...byKey.values()], decisions: inner.stageDecisions }
  }
  const finishResearch = (state: State, decision: AlgorithmDecision, budget: BudgetSnapshot | undefined): AlgorithmDecision => {
    const inner = decision.nextState as unknown as InnerState
    if (!inner.archiveRef || !inner.preparation || !state.initialArchiveRef)
      throw new Error('Campaign search no-candidate result is incomplete')
    const archive = options.artifacts.getJson(inner.archiveRef) as unknown as ResearchArchive
    verifyDigest(archive)
    const initial = options.artifacts.getJson(state.initialArchiveRef) as unknown as ResearchArchive
    verifyDigest(initial)
    const nominee = inner.nomineeId ? inner.locals.find(item => item.snapshot.candidateId === inner.nomineeId)?.snapshot : undefined
    const championChanged = inner.finalGate?.outcome === 'accepted'
      && (options.settings.promotion.validationMode === 'independent-held-out'
        || options.settings.promotion.allowSharedSetPromotion === true)
    const outcome: SearchRoundOutcome = seal({ schemaVersion: 2 as const, roundId: options.admission.roundId,
      archiveDigest: archive.digest, championAnchorDigest: options.admission.anchor.digest,
      ...(nominee ? { nomineeId: nominee.candidateId } : {}),
      ...(inner.finalGate ? { promotion: inner.finalGate } : {}),
      championChanged, advisory: options.settings.promotion.validationMode === 'shared-set-research'
        && options.settings.promotion.allowSharedSetPromotion !== true,
      validationMode: options.settings.promotion.validationMode, reasonCodes: inner.reasons, findings: inner.findings,
      research: { sizing: resolution, parents: inner.parents, workplans: inner.plannedWorks.map(work => work.workplan),
        scopeViews: archive.scopeViews, parentProbabilities: archive.parentProbabilities,
        bridge: seal(inner.bridge ?? { skipped: [], exclusions: [] }),
        scopePreparation: inner.preparation, stageDecisions: inner.stageDecisions,
        candidates: inner.locals.map(item => ({ candidateId: item.snapshot.candidateId,
          scopeDigest: inner.plannedWorks.find(work => work.workplan.candidateId === item.snapshot.candidateId)!.scope.digest,
          profile: profile(options.seed, item.work.plan, item.snapshot, item.result,
            options.settings.search.process.mode,
            inner.plannedWorks.find(work => work.workplan.candidateId === item.snapshot.candidateId)!.scope.weights),
          expansion: item.outsideBoundary && !item.broaderScopeSatisfied ? 'requires-broader-evaluation' as const
            : inner.nomineeId === item.snapshot.candidateId ? 'global-nominee' as const
            : 'not-selected-for-expansion' as const })),
        remainingBudget: remainingBudget(budget, options.settings) } })
    state.inner = decision.nextState; state.finalArchiveRef = inner.archiveRef; state.outcomeRef = outcomeRef(outcome)
    state.phase = 'terminal-publication'
    return { nextState: state as unknown as JsonValue,
      operations: [task('publish-final', 'gepa.publish', {
        roundId: options.admission.roundId, expectedArchiveDigest: initial.digest,
        nextArchiveRef: inner.archiveRef,
        expectedChampionRevisionDigest: options.admission.championRevisionDigest,
        ...(championChanged && nominee ? { nextChampion: nominee } : {}),
        outcomeRef: state.outcomeRef } as unknown as JsonValue)] }
  }
  const wrapInner = (state: State, decision: AlgorithmDecision, budget: BudgetSnapshot | undefined): AlgorithmDecision => {
    if (decision.complete) return finishResearch(state, decision, budget)
    const inner = decision.nextState as unknown as InnerState
    state.inner = decision.nextState
    if (inner.phase === 'seed-research') {
      if (!inner.archiveRef) throw new Error('Campaign seed research archive is missing')
      const progressRef = options.artifacts.putJson(seedProgress(state, inner) as unknown as JsonValue, 'gepa.seed-progress.v1')
      const findings = inner.findings.map(finding => {
        const snapshot = inner.locals.find(item => item.snapshot.candidateId === finding.candidateId)?.snapshot
        if (!snapshot) throw new Error('Campaign finding has no seed snapshot')
        return { snapshotDigest: snapshot.digest,
          findingRef: options.artifacts.putJson(finding as unknown as JsonValue, 'gepa.research-finding.v1') }
      })
      state.phase = 'seed-research-checkpoint'
      return { nextState: state as unknown as JsonValue,
        operations: [task('checkpoint-seed-research', 'gepa.research-checkpoint', {
          roundId: options.admission.roundId, archiveRef: inner.archiveRef, findings, progressRef,
        } as unknown as JsonValue)] }
    }
    state.phase = 'research'
    return { nextState: state as unknown as JsonValue, operations: decision.operations ?? [] }
  }
  return {
    describe: () => ({ id: 'failure-cluster-campaign', apiVersion: ALGORITHM_API_VERSION,
      implementationDigest, stateSchema: { type: 'object', additionalProperties: true },
      configSchema: { type: 'object', additionalProperties: true }, bindingSchema: options.bindingSchema,
      requiredOperationKinds: ['gepa.evaluate', 'gepa.diagnose', 'gepa.generate', 'gepa.publish',
        'gepa.research-checkpoint', 'gepa.await-repair'] }),
    initialize(context: DecisionContext) {
      if (context.activeBindingSetRef.digest !== options.anchorBindingSetRef.digest)
        throw new Error('Campaign search anchor binding changed')
      const anchor = options.admission.anchor
      const taskIds = sorted(options.seed.tasks.map(task => task.id))
      const weights = Object.fromEntries(taskIds.map(id => [id, 1 / options.seed.tasks.length]))
      const scope: EvaluationScope = seal({ familyId: 'bootstrap', epoch: 0,
        universeDigest: options.seed.digest, taskSetSizeResolutionDigest: resolution.digest,
        buckets: { local: taskIds, shared: [], cross: [] }, taskIds, weights,
        guards: options.settings.search.explorationGuards,
        sampling: { local: { requested: options.seed.tasks.length, selected: options.seed.tasks.length, reasons: [] },
          shared: { requested: 0, selected: 0, reasons: [] }, cross: { requested: 0, selected: 0, reasons: [] } },
        equivalenceDigest: scopeEquivalenceDigest({ universeDigest: options.seed.digest, taskIds, weights,
          guards: options.settings.search.explorationGuards }) })
      const plan = stagePlan({ stage: 'baseline-probe', partition: 'seed', universeDigest: options.seed.digest,
        taskSetSizeResolutionDigest: resolution.digest, scopeDigest: scope.digest, taskIds,
        participantIds: [anchor.candidateId], prerequisiteDecisionDigests: [], selectionRuleDigest: integrity })
      const state: State = { phase: 'bootstrap', bootstrapScope: scope, bootstrapPlan: plan,
        bootstrapResultRef: null, initialArchiveRef: null, inner: null, outcomeRef: null, finalArchiveRef: null }
      return { nextState: state as unknown as JsonValue, operations: [task('bootstrap-evaluate', 'gepa.evaluate', {
        roundIdentity: { evolutionId: options.admission.evolutionId, roundId: options.admission.roundId },
        universe: options.seed, plan, snapshot: anchor, processMode: options.settings.search.process.mode,
        projectionPolicy: 'defer',
      } as unknown as JsonValue, { bindingSetRef: options.anchorBindingSetRef,
        limits: { rolloutCells: Math.min(plannedCells(options.seed, plan, anchor).length,
          context.budget?.dimensions.rolloutCells?.remaining ?? options.settings.budgets.round.maxNewRolloutCells),
          repairCells: 0 } })] }
    },
    async reduce(context: ReduceContext) {
      const state = context.state as unknown as State
      if (state.phase === 'bootstrap') {
        const { ref, value: result } = stageResult(options.artifacts, context.completed['bootstrap-evaluate'],
          state.bootstrapPlan, options.admission.anchor.digest)
        state.bootstrapResultRef = ref
        const archive = buildArchive({ evolutionId: options.admission.evolutionId, universe: options.seed,
          snapshots: [options.admission.anchor], scopes: [state.bootstrapScope], results: [result],
          plans: [state.bootstrapPlan], config: result.failure
            ? { ...options.settings.search, parentPolicy: options.parentPolicy.ref } : options.settings.search,
          championId: options.admission.anchor.candidateId, includeChampion: options.parentPolicy.requiresChampion })
        const next = archiveRef(archive); state.initialArchiveRef = next
        if (result.failure) {
          const selection = parentSelectionInput(archive, options.admission.roundId,
            options.admission.maxCandidates, options.settings.search.seed, options.admission.anchor.candidateId)
          const reasonCodes = [`${result.failure.kind}:${result.failure.code}`, 'bootstrap-execution-unavailable']
          const parents: ParentSelectionDecision = seal({ archiveDigest: archive.digest, algorithmRef: 'sha256-counter-v1' as const,
            randomSeed: selection.randomSeed, batches: [], policy: { ref: options.parentPolicy.ref,
              inputDigest: digestJson(selection), parentProbabilities: {}, reasonCodes } })
          const preparation: ScopeEpochPreparation = seal({ archiveCutoffDigest: archive.digest,
            epoch: scopeEpoch(options.settings, options.admission.roundIndex), sharedTaskIds: [],
            ruleDigest: digestJson(options.settings.search.scopeSampling), scopes: [], plans: [], results: [], decisions: [] })
          const decision = seal({ stagePlanDigest: state.bootstrapPlan.digest,
            candidateId: options.admission.anchor.candidateId, outcome: 'insufficient-evidence' as const,
            reasonCodes, supportDigest: result.digest })
          const outcome: SearchRoundOutcome = seal({ schemaVersion: 2 as const, roundId: options.admission.roundId,
            archiveDigest: archive.digest, championAnchorDigest: options.admission.anchor.digest,
            championChanged: false, advisory: options.settings.promotion.validationMode === 'shared-set-research'
              && options.settings.promotion.allowSharedSetPromotion !== true,
            validationMode: options.settings.promotion.validationMode, reasonCodes, findings: [],
            research: { sizing: resolution, parents, workplans: [], scopeViews: archive.scopeViews,
              parentProbabilities: {}, bridge: seal({ skipped: [], exclusions: [] }),
              scopePreparation: preparation, stageDecisions: [decision], candidates: [],
              remainingBudget: remainingBudget(context.budget, options.settings) } })
          const p = profile(options.seed, state.bootstrapPlan, options.admission.anchor, result,
            options.settings.search.process.mode)
          const progress: SearchProgress = { phase: 'bootstrap', evaluations: [{ stage: 'baseline-probe',
            stagePlanDigest: state.bootstrapPlan.digest, scopeDigest: state.bootstrapPlan.scopeDigest,
            candidateId: options.admission.anchor.candidateId, state: 'settled',
            plannedCells: plannedCellCount(options.seed, state.bootstrapPlan.taskIds),
            profile: { coverage: p.coverage, processCoverage: p.processCoverage,
              outcomeComplete: p.outcomeComplete, processComplete: p.processComplete,
              processTaskIds: p.processTaskIds, tasks: p.tasks, supportDigest: p.supportDigest,
              ...(p.objectiveScore ? { objectiveScore: p.objectiveScore, rawMetrics: p.rawMetrics!,
                objectiveComplete: p.objectiveComplete! } : {}) }, failure: result.failure }], decisions: [decision] }
          const progressRef = options.artifacts.putJson(progress as unknown as JsonValue, 'gepa.seed-progress.v1')
          state.outcomeRef = outcomeRef(outcome); state.phase = 'bootstrap-failure-progress'
          return { nextState: state as unknown as JsonValue,
            operations: [task('checkpoint-bootstrap-failure', 'gepa.research-checkpoint', {
              roundId: options.admission.roundId, publishResearch: false,
              archiveRef: next, findings: [], progressRef } as unknown as JsonValue)] }
        }
        const p = profile(options.seed, state.bootstrapPlan, options.admission.anchor, result,
          options.settings.search.process.mode, state.bootstrapScope.weights)
        if (!passesExploration(state.bootstrapScope, p, options.seed))
          throw new Error('bootstrap baseline is incomplete or fails exploration guards')
        const checkpoint = options.artifacts.putJson({ schemaVersion: 1, kind: 'bootstrap-archive',
          roundId: options.admission.roundId, archiveDigest: archive.digest }, 'gepa.bootstrap-publication.v1')
        state.outcomeRef = checkpoint; state.phase = 'bootstrap-publication'
        return { nextState: state as unknown as JsonValue,
          operations: publication('publish-bootstrap', null, next, checkpoint) }
      }
      if (state.phase === 'bootstrap-publication') {
        if (context.completed['publish-bootstrap']?.kind !== 'result' || !state.initialArchiveRef)
          throw new Error('Campaign bootstrap archive publication is unconfirmed')
        return wrapInner(state, await innerRecipe(state.initialArchiveRef).initialize(context), context.budget)
      }
      if (state.phase === 'bootstrap-failure-progress') {
        if (context.completed['checkpoint-bootstrap-failure']?.kind !== 'result' || !state.initialArchiveRef || !state.outcomeRef)
          throw new Error('Campaign failed-bootstrap progress is unconfirmed')
        state.phase = 'terminal-publication'
        return { nextState: state as unknown as JsonValue,
          operations: publication('publish-bootstrap-failure', null, state.initialArchiveRef, state.outcomeRef, false) }
      }
      if (state.phase === 'research') {
        if (!state.initialArchiveRef || !state.inner) throw new Error('Campaign research state is incomplete')
        return wrapInner(state, await innerRecipe(state.initialArchiveRef).reduce({ ...context, state: state.inner }), context.budget)
      }
      if (state.phase === 'seed-research-checkpoint') {
        if (context.completed['checkpoint-seed-research']?.kind !== 'result' || !state.initialArchiveRef || !state.inner)
          throw new Error('Campaign seed research checkpoint is unconfirmed')
        return wrapInner(state, await innerRecipe(state.initialArchiveRef).reduce({ ...context, state: state.inner }), context.budget)
      }
      if (state.phase === 'terminal-publication') {
        const key = state.bootstrapResultRef && !state.finalArchiveRef ? 'publish-bootstrap-failure' : 'publish-final'
        if (context.completed[key]?.kind !== 'result' || !state.outcomeRef)
          throw new Error('Campaign terminal publication is unconfirmed')
        state.phase = 'complete'
        return { nextState: state as unknown as JsonValue, complete: true }
      }
      throw new Error(`Unexpected Campaign search phase ${state.phase}`)
    },
  }
}
