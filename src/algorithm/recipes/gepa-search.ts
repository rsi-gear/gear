import type { Algorithm, AlgorithmDecision, ArtifactRef, BindingSchema, BindingSetRef, BudgetSnapshot,
  DecisionContext, OperationIntent, OperationOutcome, ReduceContext } from '../contracts.js'
import { ALGORITHM_API_VERSION } from '../contracts.js'
import { FileArtifactStore } from '../artifacts.js'
import { task } from '../steps.js'
import type { JsonValue } from '../schema.js'
import { implementationClosureDigest } from '../data/identity.js'
import { digestJson } from '../../state/digest.js'
import { buildArchive, passesExploration } from '../../search/archive.js'
import { integrity, numeric, plannedCellCount, resolveSizing, scopeEquivalenceDigest, seal, sorted, utility,
  validateSnapshot, verifyDigest } from '../../search/contracts.js'
import { scopeEpoch, type ScopeEpochPreparation } from '../../search/epochs.js'
import { profile, plannedCells, validOutcome } from '../../search/evidence.js'
import { collectFailure, type RegressionProposal } from '../../search/regression.js'
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
import type { GepaSharedEpoch, GepaWork } from './gepa-policy.js'
import type { GepaBudgetCut } from './gepa-budget.js'

type ScienceStage = 'parents' | 'scope-preparation' | 'planning' | 'local' | 'nomination'
type Phase = 'objective-initial-harness' | 'bootstrap' | 'bootstrap-failure-progress' | 'bootstrap-publication' | 'archive-view-checkpoint' |
  'science-checkpoint' | 'research' | 'seed-research-checkpoint' | 'terminal-publication' | 'complete'
type InnerState = { phase: string; works: unknown[]; archiveRef: ArtifactRef | null; parents: ParentSelectionDecision;
  sharedEpochs: Record<string, GepaSharedEpoch>;
  preparation: ScopeEpochPreparation | null; baselines: Record<string, { plan: StageEvaluationPlan; result: StageResult }>;
  localBaselines: Record<string, StageResult>;
  locals: Array<{ work: GepaWork; snapshot: Snapshot; result: StageResult;
    outsideBoundary: boolean; broaderScopeSatisfied: boolean }>;
  bridgePlan: StageEvaluationPlan | null; bridgeResults: Record<string, StageResult>;
  globalPlan: StageEvaluationPlan | null; globalResults: Record<string, StageResult>;
  reasons: string[]; bridge: BridgeSelectionDecision | null; snapshotBindings: Record<string, BindingSetRef>;
  plannedWorks: GepaWork[]; diagnosedClusters: import('../../search/types.js').FailureCluster[];
  plannedScopes: EvaluationScope[]; generatedAttempts: Record<string, { digest: string; reason?: string }>;
  stageDecisions: EvaluationStageDecision[]; findings: ResearchFinding[];
  supportObjects: Array<{ digest: string; [key: string]: unknown }>;
  nomineeId: string | null; finalGate: GateDecision | null }
type State = { phase: Phase; bootstrapScope: EvaluationScope | null; bootstrapPlan: StageEvaluationPlan | null;
  bootstrapResultRef: ArtifactRef | null; initialArchiveRef: ArtifactRef | null;
  inner: JsonValue | null; outcomeRef: ArtifactRef | null; finalArchiveRef: ArtifactRef | null;
  scienceCheckpointed: ScienceStage[]; deferredOperations: OperationIntent[] | null;
  pendingScienceStage: ScienceStage | null; planningReasonsCount: number; localDecisionCount: number }

export type CampaignFailureClusterRecipeOptions = {
  admission: SearchAdmission; seed: TaskUniverse; heldOut: TaskUniverse; settings: SearchSettings;
  artifacts: FileArtifactStore; bindingSchema: BindingSchema; anchorBindingSetRef: BindingSetRef;
  deadlineAt: number; parentPolicy: ParentSelectionPolicy;
  findings?: Record<string, ResearchFinding>; handoffFindingDigests?: Record<string, string[]>;
  sharedEpochs?: Record<string, GepaSharedEpoch>;
  startingRegressionProposals?: RegressionProposal[];
  initialSnapshot?: Snapshot; initialSnapshotBindingSetRef?: BindingSetRef;
  budgetCut?: GepaBudgetCut; roundStartedAt?: number;
  archiveStart?: { baseArchiveRef: ArtifactRef; parentArchiveRef: ArtifactRef;
    completionRefs: string[]; publishParentView: boolean;
    snapshotBindings: Record<string, BindingSetRef> };
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
    heldOut: structuredClone(input.heldOut), settings: structuredClone(input.settings),
    budgetCut: input.budgetCut ? structuredClone(input.budgetCut) : undefined,
    startingRegressionProposals: structuredClone(input.startingRegressionProposals ?? []) }
  validateSnapshot(options.admission.anchor); verifyDigest(options.seed); verifyDigest(options.heldOut)
  if (digestJson(options.parentPolicy.ref) !== digestJson(resolveParentPolicyRef(options.settings.search)))
    throw new Error('Campaign parent policy differs from frozen search settings')
  if ((options.budgetCut === undefined) !== (options.roundStartedAt === undefined))
    throw new Error('Campaign frozen budget cut and round start must be provided together')
  if (options.budgetCut) {
    verifyDigest(options.budgetCut)
    if (options.budgetCut.roundId !== options.admission.roundId
      || !Number.isSafeInteger(options.roundStartedAt) || options.roundStartedAt! < 0)
      throw new Error('Campaign frozen budget admission drift')
  }
  const resolution = resolveSizing(options.seed, options.settings.search.taskSetSizing)
  const implementationDigest = implementationClosureDigest(['recipes/gepa-search'], {
    admission: options.admission, seedDigest: options.seed.digest, heldOutDigest: options.heldOut.digest,
    settings: options.settings, bindingSchema: options.bindingSchema,
    anchorBindingSetRef: options.anchorBindingSetRef, deadlineAt: options.deadlineAt,
    parentPolicyRef: options.parentPolicy.ref, findings: options.findings ?? {},
    handoffFindingDigests: options.handoffFindingDigests ?? {}, sharedEpochs: options.sharedEpochs ?? {},
    startingRegressionProposals: options.startingRegressionProposals,
    initialSnapshotDigest: options.initialSnapshot?.digest ?? options.admission.anchor.digest,
    initialSnapshotBindingSetRef: options.initialSnapshotBindingSetRef ?? options.anchorBindingSetRef,
    archiveStart: options.archiveStart ?? null,
    budgetCut: options.budgetCut ?? null, roundStartedAt: options.roundStartedAt ?? null,
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
  const innerRecipes = new Map<string, Algorithm>()
  const innerRecipe = (initialArchiveRef: ArtifactRef): Algorithm => {
    const cached = innerRecipes.get(initialArchiveRef.digest)
    if (cached) return cached
    const archive = options.artifacts.getJson(initialArchiveRef) as unknown as ResearchArchive
    verifyDigest(archive)
    const innerOptions: GepaRecipeOptions = { evolutionId: options.admission.evolutionId,
      roundId: options.admission.roundId, roundIndex: options.admission.roundIndex,
      maxCandidates: options.admission.maxCandidates, anchor: options.admission.anchor,
      seed: options.seed, heldOut: options.heldOut, archive, settings: options.settings,
      bindingSchema: options.bindingSchema,
      snapshotBindings: options.archiveStart?.snapshotBindings
        ?? { [options.admission.anchor.digest]: options.anchorBindingSetRef },
      artifacts: options.artifacts, deadlineAt: options.deadlineAt, parentPolicy: options.parentPolicy,
      findings: options.findings ?? {}, handoffFindingDigests: options.handoffFindingDigests ?? {},
      sharedEpochs: options.sharedEpochs ?? {},
      initialSnapshot: options.initialSnapshot ?? options.admission.anchor,
      initialSnapshotBindingSetRef: options.initialSnapshotBindingSetRef ?? options.anchorBindingSetRef,
      preserveLegacyExternalKeys: true,
      ...(options.budgetCut ? { budgetCut: options.budgetCut, roundStartedAt: options.roundStartedAt! } : {}) }
    const recipe = failureClusterGepaRecipe(innerOptions)
    innerRecipes.set(initialArchiveRef.digest, recipe)
    return recipe
  }
  const seedProgress = (state: State, inner: InnerState): SearchProgress => {
    const evaluations: SearchProgress['evaluations'] = []
    const add = (plan: StageEvaluationPlan, snapshot: Snapshot, result: StageResult): void => {
      // The legacy public progress projection uses the search process contract
      // even when the promotion gate requested a different physical process mode.
      const p = profile(options.seed, plan, snapshot, result, options.settings.search.process.mode)
      evaluations.push({ stage: plan.stage as SearchProgress['evaluations'][number]['stage'],
        stagePlanDigest: plan.digest, scopeDigest: plan.scopeDigest, candidateId: snapshot.candidateId,
        state: 'settled', plannedCells: plannedCellCount(options.seed, plan.taskIds),
        profile: { coverage: p.coverage, processCoverage: p.processCoverage,
          outcomeComplete: p.outcomeComplete, processComplete: p.processComplete,
          processTaskIds: p.processTaskIds, tasks: p.tasks, supportDigest: p.supportDigest,
          ...(p.objectiveScore ? { objectiveScore: p.objectiveScore, rawMetrics: p.rawMetrics!, objectiveComplete: p.objectiveComplete! } : {}) },
        ...(result.failure ? { failure: result.failure } : {}) })
    }
    if (state.bootstrapPlan && state.bootstrapResultRef) {
      const bootstrap = options.artifacts.getJson(state.bootstrapResultRef) as unknown as StageResult
      add(state.bootstrapPlan, options.admission.anchor, bootstrap)
    }
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
        roundId: options.admission.roundId,
        expectedArchiveDigest: options.archiveStart
          ? (options.artifacts.getJson(options.archiveStart.baseArchiveRef) as unknown as ResearchArchive).digest
          : initial.digest,
        nextArchiveRef: inner.archiveRef,
        expectedChampionRevisionDigest: options.admission.championRevisionDigest,
        ...(championChanged && nominee ? { nextChampion: nominee } : {}),
        outcomeRef: state.outcomeRef } as unknown as JsonValue)] }
  }
  const scienceCheckpoint = (state: State, inner: InnerState, stage: ScienceStage): OperationIntent => {
    const initial = options.artifacts.getJson(state.initialArchiveRef!) as unknown as ResearchArchive
    verifyDigest(initial)
    const preparedWork = (work: GepaWork) => ({ workplan: work.workplan, dossier: work.dossier,
      scope: work.scope, plan: work.plan, parent: work.parent, baseline: work.parentBaseline })
    let objects: Array<{ name: string; value: { digest: string } }>
    let results: StageResult[] = []
    let supportDigests: string[] = []
    if (stage === 'parents') objects = [{ name: 'parents', value: inner.parents }]
    else if (stage === 'scope-preparation') {
      if (!inner.preparation) throw new Error('GEPA scope preparation is not settled')
      objects = [{ name: 'scope-preparation', value: inner.preparation }]
      results = inner.preparation.results
    } else if (stage === 'planning') {
      if (!inner.preparation) throw new Error('GEPA planning lacks scope preparation')
      const scopes = [...initial.scopes, ...inner.preparation.scopes]
      for (const work of inner.plannedWorks) if (!scopes.some(scope => scope.digest === work.scope.digest))
        scopes.push(work.scope)
      const planning = seal({ works: inner.plannedWorks.map(preparedWork),
        cancelled: inner.reasons.filter(reason => reason !== 'no-bridge-quota'),
        scopes, baselineResults: inner.plannedWorks.map(work => work.parentBaseline),
        baselinePlans: inner.plannedWorks.map(work => work.plan), diagnosedClusters: inner.diagnosedClusters })
      objects = [{ name: 'planning', value: planning }]
      results = inner.plannedWorks.map(work => work.parentBaseline)
      state.planningReasonsCount = inner.reasons.length
    } else if (stage === 'local') {
      const local = seal({ entries: inner.locals.map(entry => ({ work: preparedWork(entry.work),
        snapshot: entry.snapshot, result: entry.result, outsideBoundary: entry.outsideBoundary,
        broaderScopeSatisfied: entry.broaderScopeSatisfied })),
      reasons: inner.reasons.slice(state.planningReasonsCount).filter(reason => reason !== 'no-bridge-quota') })
      objects = [{ name: 'local', value: local }, { name: 'expansion',
        value: inner.bridge ? seal(inner.bridge) : seal({ skipped: [], exclusions: [] }) },
        { name: 'local-stage-decisions', value: seal({ decisions: inner.stageDecisions }) }]
      supportDigests = inner.stageDecisions.map(decision => decision.supportDigest)
      results = inner.locals.map(entry => entry.result)
      state.localDecisionCount = inner.stageDecisions.length
    } else {
      if (!inner.bridgePlan) throw new Error('GEPA nomination lacks its bridge plan')
      const nomination = seal({ candidateId: inner.nomineeId, bridgeDigest: inner.bridgePlan.digest,
        decisions: inner.stageDecisions.slice(state.localDecisionCount) })
      objects = [{ name: 'nomination', value: nomination }]
      supportDigests = nomination.decisions.map(decision => decision.supportDigest)
      results = Object.values(inner.bridgeResults)
    }
    const owner = objects.find(row => row.name === (stage === 'local' ? 'local' : stage))!
    return task(`checkpoint-science-${stage}`, 'gepa.science-checkpoint', {
      roundId: options.admission.roundId, stage,
      objects: objects.map(row => ({ name: row.name,
        ref: options.artifacts.putJson(row.value as unknown as JsonValue, 'gepa.legacy-journal-object.v1') })),
      supportRefs: supportDigests.map(digest => {
        const support = inner.supportObjects.find(row => row.digest === digest)
        if (!support) throw new Error('GEPA science checkpoint decision support is missing')
        return options.artifacts.putJson(support as unknown as JsonValue, 'gepa.legacy-journal-object.v1')
      }),
      consumptions: results.map(result => ({ resultRef: options.artifacts.putJson(result as unknown as JsonValue,
        'gepa.stage-result.v1'), consumerDigest: owner.value.digest })),
    } as unknown as JsonValue)
  }
  const checkpointStage = (state: State, inner: InnerState): ScienceStage | null => {
    const done = new Set(state.scienceCheckpointed)
    if (!done.has('parents')) return 'parents'
    if (!done.has('scope-preparation') && inner.preparation) return 'scope-preparation'
    if (!done.has('planning') && ['generation', 'local', 'bridge', 'global-seed', 'seed-research'].includes(inner.phase))
      return 'planning'
    if (!done.has('local') && ['bridge', 'global-seed', 'seed-research'].includes(inner.phase))
      return 'local'
    if (!done.has('nomination') && inner.bridgePlan && ['global-seed', 'seed-research'].includes(inner.phase))
      return 'nomination'
    return null
  }
  const regressionCheckpoint = (inner: InnerState): { regressionRef: ArtifactRef;
    regressionCheckpointRef: ArtifactRef } | null => {
    if (!options.settings.regression.collectFailures) return null
    const proposals = [...options.startingRegressionProposals], reasons: string[] = []
    const cells = [...inner.locals.flatMap(entry => entry.result.cells),
      ...Object.values(inner.bridgeResults).flatMap(result => result.cells),
      ...Object.values(inner.globalResults).flatMap(result => result.cells)]
    for (const cell of cells) {
      const selected = options.seed.tasks.find(task => task.id === cell.identity.taskId)
      if (!selected?.regressionTemplate || !validOutcome(cell) || cell.outcome.status !== 'available'
        || numeric(utility(cell.outcome.rawValue, selected.outcome)) >= selected.successUtility) continue
      const collected = collectFailure({ ...selected.regressionTemplate,
        source: { kind: 'seed-evaluation', evidenceRef: cell.evidenceRef }, outcome: 'business-failure' },
      proposals, options.settings.regression)
      if (collected.proposal) proposals.push(collected.proposal)
      if (collected.reason) reasons.push(collected.reason)
    }
    const checkpoint = seal({ proposalDigests: proposals.map(proposal => proposal.digest), reasonCodes: reasons })
    return { regressionRef: options.artifacts.putJson({ proposals } as unknown as JsonValue,
      'gepa.regression-proposals.v1'),
    regressionCheckpointRef: options.artifacts.putJson(checkpoint as unknown as JsonValue,
      'gepa.regression-checkpoint.v1') }
  }
  const wrapInner = (state: State, decision: AlgorithmDecision, budget: BudgetSnapshot | undefined): AlgorithmDecision => {
    if (decision.complete) return finishResearch(state, decision, budget)
    const inner = decision.nextState as unknown as InnerState
    state.inner = decision.nextState
    const stage = checkpointStage(state, inner)
    if (stage) {
      state.deferredOperations = decision.operations ?? []
      state.pendingScienceStage = stage
      state.phase = 'science-checkpoint'
      return { nextState: state as unknown as JsonValue, operations: [scienceCheckpoint(state, inner, stage)] }
    }
    if (inner.phase === 'seed-research') {
      if (!inner.archiveRef) throw new Error('Campaign seed research archive is missing')
      const progressRef = options.artifacts.putJson(seedProgress(state, inner) as unknown as JsonValue, 'gepa.seed-progress.v1')
      const findings = inner.findings.map(finding => {
        const snapshot = inner.locals.find(item => item.snapshot.candidateId === finding.candidateId)?.snapshot
        if (!snapshot) throw new Error('Campaign finding has no seed snapshot')
        return { snapshotDigest: snapshot.digest,
          findingRef: options.artifacts.putJson(finding as unknown as JsonValue, 'gepa.research-finding.v1') }
      })
      const supportRefs = [...new Map(inner.supportObjects.map(support => [support.digest,
        options.artifacts.putJson(support as unknown as JsonValue, 'gepa.science-support.v1')])).values()]
      const researchResultRefs = Object.values(inner.globalResults).map(result =>
        options.artifacts.putJson(result as unknown as JsonValue, 'gepa.stage-result.v1'))
      const regression = regressionCheckpoint(inner)
      state.phase = 'seed-research-checkpoint'
      const epoch = inner.preparation?.epoch
      const sharedEpoch = epoch === undefined ? undefined : inner.sharedEpochs[String(epoch)]
      return { nextState: state as unknown as JsonValue,
        operations: [task('checkpoint-seed-research', 'gepa.research-checkpoint', {
          roundId: options.admission.roundId, archiveRef: inner.archiveRef, findings, progressRef,
          supportRefs, researchResultRefs,
          ...(regression ?? {}),
          ...(sharedEpoch ? { sharedEpoch } : {}),
        } as unknown as JsonValue)] }
    }
    state.phase = 'research'
    return { nextState: state as unknown as JsonValue, operations: decision.operations ?? [] }
  }
  const startCampaign = (context: DecisionContext): AlgorithmDecision => {
      if (context.activeBindingSetRef.digest !== options.anchorBindingSetRef.digest)
        throw new Error('Campaign search anchor binding changed')
      if (options.archiveStart) {
        const state: State = { phase: 'archive-view-checkpoint', bootstrapScope: null, bootstrapPlan: null,
          bootstrapResultRef: null, initialArchiveRef: options.archiveStart.parentArchiveRef,
          inner: null, outcomeRef: null, finalArchiveRef: null, scienceCheckpointed: [],
          deferredOperations: null, pendingScienceStage: null, planningReasonsCount: 0, localDecisionCount: 0 }
        return { nextState: state as unknown as JsonValue,
          operations: [task('checkpoint-archive-view', 'gepa.archive-view', {
            roundId: options.admission.roundId, baseArchiveRef: options.archiveStart.baseArchiveRef,
            parentArchiveRef: options.archiveStart.parentArchiveRef,
            completionRefs: options.archiveStart.completionRefs,
            publishParentView: options.archiveStart.publishParentView,
          } as unknown as JsonValue)] }
      }
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
        bootstrapResultRef: null, initialArchiveRef: null, inner: null, outcomeRef: null, finalArchiveRef: null,
        scienceCheckpointed: [], deferredOperations: null, pendingScienceStage: null,
        planningReasonsCount: 0, localDecisionCount: 0 }
      return { nextState: state as unknown as JsonValue, operations: [{ ...task('bootstrap-evaluate', 'gepa.evaluate', {
        roundIdentity: { evolutionId: options.admission.evolutionId, roundId: options.admission.roundId },
        universe: options.seed, plan, snapshot: anchor, processMode: options.settings.search.process.mode,
        progressProcessMode: options.settings.search.process.mode,
        ...(options.budgetCut ? { budgetCut: options.budgetCut, roundStartedAt: options.roundStartedAt! } : {}),
        projectionPolicy: 'defer',
      } as unknown as JsonValue, { bindingSetRef: options.anchorBindingSetRef,
        limits: { rolloutCells: Math.min(plannedCells(options.seed, plan, anchor).length,
          context.budget?.dimensions.rolloutCells?.remaining ?? options.settings.budgets.round.maxNewRolloutCells),
          repairCells: 0 } }), startsBudgetClock: true }] }
  }
  return {
    describe: () => ({ id: 'failure-cluster-campaign', apiVersion: ALGORITHM_API_VERSION,
      implementationDigest, stateSchema: { type: 'object', additionalProperties: true },
      configSchema: { type: 'object', additionalProperties: true }, bindingSchema: options.bindingSchema,
      requiredOperationKinds: ['gepa.evaluate', 'gepa.diagnose', 'gepa.generate', 'gepa.publish',
        'gepa.research-checkpoint', 'gepa.science-checkpoint', 'gepa.await-repair', 'gepa.archive-view',
        ...(options.seed.objective ? ['gepa.objective-reference'] : [])] }),
    initialize(context: DecisionContext) {
      if (options.seed.objective) {
        const state: State = { phase: 'objective-initial-harness', bootstrapScope: null, bootstrapPlan: null,
          bootstrapResultRef: null, initialArchiveRef: null, inner: null, outcomeRef: null,
          finalArchiveRef: null, scienceCheckpointed: [], deferredOperations: null,
          pendingScienceStage: null, planningReasonsCount: 0, localDecisionCount: 0 }
        const snapshot = options.initialSnapshot ?? options.admission.anchor
        return { nextState: state as unknown as JsonValue,
          operations: [task('freeze-objective-initial-harness', 'gepa.objective-reference', {
            roundId: options.admission.roundId, mode: 'anchor',
            snapshotRef: options.artifacts.putJson(snapshot as unknown as JsonValue,
              'gepa.objective-initial-snapshot.v1') } as unknown as JsonValue,
          { bindingSetRef: options.initialSnapshotBindingSetRef ?? options.anchorBindingSetRef })] }
      }
      return startCampaign(context)
    },
    async reduce(context: ReduceContext) {
      const state = context.state as unknown as State
      if (state.phase === 'objective-initial-harness') {
        if (context.completed['freeze-objective-initial-harness']?.kind !== 'result')
          throw new Error('Campaign initial objective harness is not durable')
        return startCampaign(context)
      }
      if (state.phase === 'science-checkpoint') {
        const stage = state.pendingScienceStage
        if (!stage || context.completed[`checkpoint-science-${stage}`]?.kind !== 'result' || !state.inner)
          throw new Error('Campaign science checkpoint is unconfirmed')
        state.scienceCheckpointed.push(stage)
        state.pendingScienceStage = null
        const operations = state.deferredOperations ?? []
        state.deferredOperations = null
        return wrapInner(state, { nextState: state.inner, operations }, context.budget)
      }
      if (state.phase === 'archive-view-checkpoint') {
        if (context.completed['checkpoint-archive-view']?.kind !== 'result' || !state.initialArchiveRef)
          throw new Error('Campaign parent archive view is not durable')
        return wrapInner(state, await innerRecipe(state.initialArchiveRef).initialize(context), context.budget)
      }
      if (state.phase === 'bootstrap') {
        const { ref, value: result } = stageResult(options.artifacts, context.completed['bootstrap-evaluate'],
          state.bootstrapPlan!, options.admission.anchor.digest)
        state.bootstrapResultRef = ref
        const archive = buildArchive({ evolutionId: options.admission.evolutionId, universe: options.seed,
          snapshots: [options.admission.anchor], scopes: [state.bootstrapScope!], results: [result],
          plans: [state.bootstrapPlan!], config: result.failure
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
          const decision = seal({ stagePlanDigest: state.bootstrapPlan!.digest,
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
          const p = profile(options.seed, state.bootstrapPlan!, options.admission.anchor, result,
            options.settings.search.process.mode)
          const progress: SearchProgress = { phase: 'bootstrap', evaluations: [{ stage: 'baseline-probe',
            stagePlanDigest: state.bootstrapPlan!.digest, scopeDigest: state.bootstrapPlan!.scopeDigest,
            candidateId: options.admission.anchor.candidateId, state: 'settled',
            plannedCells: plannedCellCount(options.seed, state.bootstrapPlan!.taskIds),
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
        const p = profile(options.seed, state.bootstrapPlan!, options.admission.anchor, result,
          options.settings.search.process.mode, state.bootstrapScope!.weights)
        if (!passesExploration(state.bootstrapScope!, p, options.seed))
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
        state.phase = 'archive-view-checkpoint'
        return { nextState: state as unknown as JsonValue,
          operations: [task('checkpoint-archive-view', 'gepa.archive-view', {
            roundId: options.admission.roundId, baseArchiveRef: state.initialArchiveRef,
            parentArchiveRef: state.initialArchiveRef, completionRefs: [],
            publishParentView: options.parentPolicy.requiresChampion,
          } as unknown as JsonValue)] }
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
