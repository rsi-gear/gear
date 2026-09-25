import { searchProtocolVersion } from './identity.js'
import { ComponentRegistry } from '../evolution/components.js'
import { digestJson } from '../state/digest.js'
import { buildArchive, passesExploration } from './archive.js'
import type { EvidenceCompletion } from './completion.js'
import { integrity, invariant, numeric, plannedCellCount, resolveSizing, safeId, scopeEquivalenceDigest, seal, sorted, utility } from './contracts.js'
import { clusters } from './diagnosis.js'
import { prepareScopeEpochs, scopeEpoch, type ScopeEpochPreparation } from './epochs.js'
import { profile, validOutcome } from './evidence.js'
import { objectiveProfile, scoringComplete, scoringValue } from './objective.js'
import type { ObjectiveBaseline } from '../objective/scoring.js'
import { parentSelectionInput, selectParentsWithPolicy } from './parent-selection.js'
import { resolveParentPolicyRef } from './policies/parents.js'
import type { PromotionInput } from './promotion.js'
import { assessGate, decideFinal, precheckSeed, rankProfiles } from './promotion.js'
import { searchDeadline } from './recovery.js'
import type { RegressionProposal } from './regression.js'
import { collectFailure, sanitizedRegressionPrompt } from './regression.js'
import { SearchExecutionRuntime, type GeneratedCandidate, type PreparedWork, type SearchAdmission, type SearchExecutionHooks } from './runtime.js'
import { validateSearchSchema } from './schema.js'
import { samplingEvidence } from './scope-sampling.js'
import { bridgeSelection, createScope, stagePlan } from './scopes.js'
import type { RemainingBudget } from './store.js'
import { SearchBudgetExceeded, type SearchJournal } from './store.js'
import type { BridgeSelectionDecision, CandidateWorkPlan, DiagnosisDossier, DiagnosisProvider, EvaluationScope, EvaluationStageDecision, GateDecision, ParentSelectionDecision, ResearchArchive, ResearchFinding, SearchProvider, Snapshot, StageEvaluationPlan, StageResult, TaskUniverse } from './types.js'
export type { GeneratedCandidate, SearchAdmission, SearchExecutionHooks } from './runtime.js'

export interface SearchEvolutionIdentity {
  protocolVersion?: 2
  evolutionId: string
  settingsDigest: string
  maxCandidates: number
  seedUniverseDigest: string
  heldOutUniverseDigest: string
  providerIntegrity: string
  diagnosisIntegrity: string
  sanitizationPolicyDigest: string
  algorithmIntegrity: string
  parentPolicy?: import('../types.js').ComponentRef<unknown>
  digest: string
}
export class SearchEvidencePending extends Error {
  constructor(readonly planDigest: string) { super(`search stage needs evidence repair: ${planDigest}`); this.name = 'SearchEvidencePending' }
}
export interface SearchRoundOutcome {
  schemaVersion: 2
  roundId: string
  /** Seed research artifact; an unsuccessful bootstrap is not installed as the parent archive. */
  archiveDigest: string
  championAnchorDigest: string
  nomineeId?: string
  promotion?: GateDecision
  championChanged: boolean
  advisory: boolean
  /** Preserves evidence provenance when research champion updates are authorized. */
  validationMode?: 'independent-held-out' | 'shared-set-research'
  reasonCodes: string[]
  findings: ResearchFinding[]
  research: {
    sizing: ReturnType<typeof resolveSizing>
    parents: ParentSelectionDecision
    workplans: CandidateWorkPlan[]
    scopeViews: ResearchArchive['scopeViews']
    parentProbabilities: Record<string, number>
    bridge: BridgeSelectionDecision & { digest: string }
    scopePreparation: ScopeEpochPreparation
    stageDecisions: EvaluationStageDecision[]
    candidates: Array<{ candidateId: string; scopeDigest: string; profile: ReturnType<typeof profile>; expansion: 'global-nominee' | 'not-selected-for-expansion' | 'requires-broader-evaluation' }>
    remainingBudget: RemainingBudget
  }
  digest: string
}
export interface CommitIntent {
  expectedArchiveDigest: string
  nextArchiveDigest: string
  expectedChampionRevisionDigest: string
  nextChampion?: Snapshot
  outcome: SearchRoundOutcome
  digest: string
}

/** The new search is a separate versioned driver; no legacy gate/selector runs here. */
export class FailureClusterSearch {
  constructor(readonly store: SearchJournal, readonly provider: SearchProvider, readonly diagnosis: DiagnosisProvider, readonly hooks: SearchExecutionHooks, readonly components = new ComponentRegistry()) {
    this.runtime = new SearchExecutionRuntime(store, provider, diagnosis, hooks, components)
  }
  private readonly runtime: SearchExecutionRuntime

  validate(admission: SearchAdmission) { return this.runtime.validate(admission) }
  repairEvaluation(roundId: string, repairId: string, originalRef: string, signal: AbortSignal) {
    return this.runtime.repairEvaluation(roundId, repairId, originalRef, signal)
  }

  private fullPlan(admission: SearchAdmission, universe: TaskUniverse, stage: StageEvaluationPlan['stage'], ids: string[], sizingDigest: string): StageEvaluationPlan {
    return stagePlan({ stage, partition: universe.partition, universeDigest: universe.digest, taskSetSizeResolutionDigest: sizingDigest,
      scopeDigest: digestJson([universe.digest, stage]), taskIds: universe.tasks.map(t => t.id), participantIds: ids, prerequisiteDecisionDigests: [], selectionRuleDigest: integrity })
  }
  async run(request: SearchAdmission, signal: AbortSignal): Promise<SearchRoundOutcome> {
    safeId(request.roundId)
    const parentPolicy = this.components.parentSelectionPolicy(resolveParentPolicyRef(request.settings.search))
    const saved = await this.store.read<{ ref: string }>(`rounds/${request.roundId}/admission`)
    if (saved) {
      const admission = await this.store.object<SearchAdmission & { digest: string }>(saved.ref)
      const { evolutionId, roundId, roundIndex, maxCandidates, anchor, championRevisionDigest, settings } = admission
      invariant(digestJson({ evolutionId, roundId, roundIndex, maxCandidates, anchor, championRevisionDigest, settings }) === digestJson(request), 'search round request changed on resume')
    }
    const terminal = await this.store.read<{ ref: string }>(`rounds/${request.roundId}/terminal`)
    if (terminal) {
      const outcome = await this.store.object<SearchRoundOutcome>(terminal.ref)
      validateSearchSchema('SearchRoundOutcome', outcome)
      const advancing = await this.store.read<{ roundId: string | null }>('active-round')
      if (advancing?.roundId === request.roundId) await this.store.write('active-round', { roundId: null })
      return outcome
    }
    if (saved) {
      const previous = await this.store.object<SearchAdmission & { algorithmIntegrity: string; parentPolicyRef?: import('../types.js').ComponentRef<unknown>; digest: string }>(saved.ref)
      invariant(previous.algorithmIntegrity === integrity, 'search algorithm identity changed; start a new evolution')
      invariant(previous.parentPolicyRef && digestJson(previous.parentPolicyRef) === digestJson(parentPolicy.ref), 'parent policy changed on resume')
    }
    const completion = await this.store.read<{ id: string }>('active-completion')
    invariant(!completion || await this.store.read(`rounds/${completion.id}/result`), 'search has an unresolved completion; resume its original completion ID')
    const repair = await this.store.read<{ id: string }>(`rounds/${request.roundId}/active-repair`)
    invariant(!repair || await this.store.read(`rounds/${request.roundId}/repair-result-${digestJson(repair.id).slice(7)}`), 'round has an unresolved repair; resume its original repair ID')
    const existingIntent = await this.store.read<{ ref: string }>(`rounds/${request.roundId}/commit`)
    if (existingIntent) return this.runtime.reconcile(request.roundId, await this.store.object<CommitIntent>(existingIntent.ref))
    signal.throwIfAborted()
    const current = await this.validate(request)
    signal.throwIfAborted()
    const owner = await this.store.freeze(request.roundId, 'operation-kind', () => seal({ kind: 'search-round' }))
    invariant(owner.kind === 'search-round', 'record ID belongs to a different operation kind')
    const identity: SearchEvolutionIdentity = seal({ protocolVersion: searchProtocolVersion, evolutionId: request.evolutionId, settingsDigest: digestJson(request.settings), maxCandidates: request.maxCandidates,
      seedUniverseDigest: current.seed.digest, heldOutUniverseDigest: current.heldOut.digest, providerIntegrity: this.provider.integrity,
      diagnosisIntegrity: this.diagnosis.integrity, sanitizationPolicyDigest: this.diagnosis.sanitizationPolicyDigest, algorithmIntegrity: integrity, parentPolicy: parentPolicy.ref })
    const frozenIdentity = await this.store.freezeEvolution('identity', () => identity)
    invariant(identity.digest === frozenIdentity.digest, 'search evolution identity changed; start a new evolution')
    const advancing = await this.store.read<{ roundId: string | null }>('active-round')
    invariant(!advancing?.roundId || advancing.roundId === request.roundId
      || await this.store.read(`rounds/${advancing.roundId}/terminal`), 'search has an unresolved round; recover it before starting another round')
    await this.store.write('active-round', { roundId: request.roundId })
    const admission = await this.store.freeze(request.roundId, 'admission', () => seal({ ...request, ...current, providerIntegrity: this.provider.integrity, diagnosisIntegrity: this.diagnosis.integrity, algorithmIntegrity: integrity, parentPolicyRef: parentPolicy.ref, startedAt: Date.now() }))
    invariant(admission.seed.digest === current.seed.digest && admission.heldOut.digest === current.heldOut.digest && admission.providerIntegrity === this.provider.integrity && admission.diagnosisIntegrity === this.diagnosis.integrity
      && admission.algorithmIntegrity === integrity && digestJson(admission.settings) === digestJson(request.settings) && admission.anchor.digest === request.anchor.digest
      && admission.maxCandidates === request.maxCandidates && admission.championRevisionDigest === request.championRevisionDigest, 'provider/task/settings identity changed on resume')
    const { seed, heldOut, startedAt, resolvedSettings: settings, anchor } = admission
    const budgetStart = (await this.store.read<{ startedAt: number }>('budget'))?.startedAt ?? startedAt
    const deadline = Math.min(startedAt + settings.budgets.round.timeoutMs, budgetStart + settings.budgets.evolution.timeoutMs)
    const inspectionSignal = signal, timed = searchDeadline(signal, deadline)
    signal = timed.signal
    try {
    const resolution = resolveSizing(seed, settings.search.taskSetSizing)
    const evaluate = async (u: TaskUniverse, p: StageEvaluationPlan, s: Snapshot) => {
      await this.runtime.evaluationProgress(request.roundId, u, p, s, settings.search.process.mode)
      const result = await this.runtime.evaluate(admission, startedAt, u, p, s, signal, inspectionSignal)
      await this.runtime.evaluationProgress(request.roundId, u, p, s, settings.search.process.mode, result)
      return result
    }
    const initialSnapshot = seed.objective ? await this.store.freezeEvolution('objective-initial-harness', () => anchor) : undefined
    const initialBaseline = async (universe: TaskUniverse, plan: StageEvaluationPlan): Promise<ObjectiveBaseline | undefined> => {
      if (!universe.objective?.constraints.some(c => c.rule === 'no_regression')) return undefined
      const name = `objective-initial-${digestJson([universe.digest, sorted(plan.taskIds)]).slice(7)}`
      return this.store.freezeEvolution(name, async () => {
        const { digest: ignored, ...body } = plan
        const referencePlan = seal({ ...body, participantIds: [initialSnapshot!.candidateId], prerequisiteDecisionDigests: [], selectionRuleDigest: digestJson('objective-initial-reference-v1') })
        const result = await evaluate(universe, referencePlan, initialSnapshot!)
        const projected = objectiveProfile(universe, plan.taskIds, result.cells)
        if (result.failure || !projected.objectiveComplete) {
          await this.store.write(`rounds/${request.roundId}/pending-evidence`, { planDigest: referencePlan.digest, resultRefs: [result.digest] })
          throw new SearchEvidencePending(referencePlan.digest)
        }
        return seal({ scopeDigest: projected.objectiveScore!.scopeDigest, metrics: projected.rawMetrics!, initialSnapshotDigest: initialSnapshot!.digest, resultDigest: result.digest })
      })
    }
    await this.runtime.progress(request.roundId, 'bootstrap')
    let archive = await this.store.archive()
    if (!archive) {
      const bootstrapTaskIds = sorted(seed.tasks.map(t => t.id))
      const bootstrapWeights = Object.fromEntries(bootstrapTaskIds.map(id => [id, 1 / seed.tasks.length]))
      const bootstrapScope: EvaluationScope = seal({ familyId: 'bootstrap', epoch: 0, universeDigest: seed.digest, taskSetSizeResolutionDigest: resolution.digest,
        buckets: { local: bootstrapTaskIds, shared: [], cross: [] }, taskIds: bootstrapTaskIds, weights: bootstrapWeights,
        guards: settings.search.explorationGuards, sampling: { local: { requested: seed.tasks.length, selected: seed.tasks.length, reasons: [] }, shared: { requested: 0, selected: 0, reasons: [] }, cross: { requested: 0, selected: 0, reasons: [] } },
        equivalenceDigest: scopeEquivalenceDigest({ universeDigest: seed.digest, taskIds: bootstrapTaskIds, weights: bootstrapWeights, guards: settings.search.explorationGuards }) })
      const plan = stagePlan({ ...this.fullPlan(admission, seed, 'baseline-probe', [anchor.candidateId], resolution.digest), scopeDigest: bootstrapScope.digest })
      // Strip the old digest before resealing a modified plan.
      const { digest: discarded, ...body } = plan
      const baselinePlan = seal(body)
      const result = await evaluate(seed, baselinePlan, anchor)
      const p = profile(seed, baselinePlan, anchor, result, settings.search.process.mode, bootstrapScope.weights)
      if (result.failure?.kind === 'execution-failure'
        || !result.failure && !(seed.objective ? p.objectiveComplete : p.outcomeComplete)) {
        // evaluate() may return a later repair, but every repair must target the
        // frozen original evaluation. Keep that reference stable while this
        // incomplete bootstrap blocks admission of the next round.
        const original = await this.store.read<{ ref: string }>(`rounds/${request.roundId}/evaluation-${digestJson([baselinePlan.digest, anchor.digest]).slice(7)}`)
        invariant(original, 'missing bootstrap evaluation')
        await this.store.write(`rounds/${request.roundId}/pending-evidence`, { planDigest: baselinePlan.digest, resultRefs: [original.ref] })
        throw new SearchEvidencePending(baselinePlan.digest)
      }
      if (result.failure) {
        // Frozen budget exhaustion still terminates the round, without installing
        // incomplete evidence as the parent archive.
        const research = buildArchive({ evolutionId: admission.evolutionId, universe: seed, snapshots: [anchor], scopes: [bootstrapScope],
          results: [result], plans: [baselinePlan], config: { ...settings.search, parentPolicy: parentPolicy.ref },
          championId: anchor.candidateId, includeChampion: parentPolicy.requiresChampion })
        const selectionInput = parentSelectionInput(research, request.roundId, admission.maxCandidates, settings.search.seed, anchor.candidateId)
        const reasonCodes = [`${result.failure.kind}:${result.failure.code}`, 'bootstrap-execution-unavailable']
        const parents: ParentSelectionDecision = seal({ archiveDigest: research.digest, algorithmRef: 'sha256-counter-v1' as const,
          randomSeed: selectionInput.randomSeed, batches: [], policy: { ref: parentPolicy.ref, inputDigest: digestJson(selectionInput), parentProbabilities: {}, reasonCodes } })
        const preparation: ScopeEpochPreparation = seal({ archiveCutoffDigest: research.digest, epoch: scopeEpoch(settings, request.roundIndex),
          sharedTaskIds: [], ruleDigest: digestJson(settings.search.scopeSampling), scopes: [], plans: [], results: [], decisions: [] })
        const decision: EvaluationStageDecision = seal({ stagePlanDigest: baselinePlan.digest, candidateId: anchor.candidateId,
          outcome: 'insufficient-evidence' as const, reasonCodes, supportDigest: result.digest })
        for (const record of [research, parents, preparation]) await this.store.put(record)
        await this.runtime.decisionProgress(request.roundId, [decision])
        const outcome: SearchRoundOutcome = seal({ schemaVersion: 2 as const, roundId: request.roundId, archiveDigest: research.digest,
          championAnchorDigest: anchor.digest, championChanged: false,
          advisory: settings.promotion.validationMode === 'shared-set-research' && settings.promotion.allowSharedSetPromotion !== true,
          validationMode: settings.promotion.validationMode, reasonCodes, findings: [],
          research: { sizing: resolution, parents, workplans: [], scopeViews: research.scopeViews, parentProbabilities: {},
            bridge: seal({ skipped: [], exclusions: [] }), scopePreparation: preparation, stageDecisions: [decision], candidates: [],
            remainingBudget: await this.store.remaining(request.roundId, settings.budgets) } })
        inspectionSignal.throwIfAborted()
        return this.runtime.recordTerminal(request.roundId, outcome)
      }
      invariant(passesExploration(bootstrapScope, p, seed), 'bootstrap baseline is incomplete or fails exploration guards')
      archive = buildArchive({ evolutionId: admission.evolutionId, universe: seed, snapshots: [anchor], scopes: [bootstrapScope], results: [result], plans: [baselinePlan], config: settings.search, championId: anchor.candidateId, includeChampion: parentPolicy.requiresChampion })
      await this.store.put(archive)
      await this.runtime.consume(admission.roundId, result, 'bootstrap-archive', archive.digest)
      await this.store.casArchive(undefined, archive)
    }
    const base = await this.store.freeze(request.roundId, 'archive-base', () => seal({ archiveDigest: archive!.digest }))
    archive = await this.store.object<ResearchArchive>(base.archiveDigest)
    const completionRefs = await this.store.freeze(request.roundId, 'completions', async () => seal(await this.store.read<{ refs: string[] }>('pending-completions') ?? { refs: [] }))
    const completions: StageResult[] = []
    for (const ref of completionRefs.refs) {
      const completion = await this.store.object<EvidenceCompletion>(ref)
      invariant(archive.results.some(r => r.digest === completion.originalResultDigest), 'completion does not reference existing archive evidence')
      completions.push(await this.store.object<StageResult>(completion.completedResultDigest))
    }
    if (parentPolicy.requiresChampion || completions.some(result => !archive!.results.some(saved => saved.digest === result.digest))) {
      // Freeze a seed-only selection view before drawing parents. The committed
      // archive stays unchanged until the round's original CAS succeeds.
      archive = await this.store.freeze(request.roundId, 'parent-archive', () => buildArchive({ evolutionId: admission.evolutionId,
        previous: archive!, universe: seed, snapshots: [anchor], scopes: [], plans: [], results: completions,
        config: settings.search, championId: anchor.candidateId, includeChampion: parentPolicy.requiresChampion }))
    }
    const parents = await this.store.freeze(request.roundId, 'parents', () => selectParentsWithPolicy(archive!, parentPolicy, admission.maxCandidates, admission.roundId, settings.search.seed, anchor.candidateId))
    validateSearchSchema('ParentSelectionDecision', parents)
    invariant(parents.policy && digestJson(parents.policy.ref) === digestJson(parentPolicy.ref), 'parent policy changed on resume')
    await this.runtime.progress(request.roundId, 'scope-preparation')
    const preparation = await this.store.freeze(request.roundId, 'scope-preparation', async () => {
      const prepared = await prepareScopeEpochs({ store: this.store, roundId: request.roundId, roundIndex: admission.roundIndex, settings,
        archive: archive!, universe: seed, anchor, parents, resolution,
        missingCost: (snapshots, tasks) => this.runtime.missingCost(seed, snapshots, tasks), evaluate: (plan, snapshot) => evaluate(seed, plan, snapshot) })
      await this.store.put(prepared)
      for (const result of prepared.results) await this.runtime.consume(admission.roundId, result, 'scope-preparation', prepared.digest)
      return prepared
    })
    await this.runtime.progress(request.roundId, 'diagnosis-planning')
    const planning = await this.store.freeze(request.roundId, 'planning', async () => {
      const works: PreparedWork[] = [], cancelled: string[] = [], scopes = [...archive!.scopes, ...preparation.scopes]
      const diagnosedClusters: import('./types.js').FailureCluster[] = []
      const baselineResults: StageResult[] = [], baselinePlans: StageEvaluationPlan[] = []
      const shared = preparation.sharedTaskIds
      const usedHypotheses = new Set<string>()
      for (const batch of parents.batches) {
        const parent = archive!.snapshots.find(s => s.digest === batch.parentSnapshotDigest)!
        const sourceScope = archive!.scopes.find(s => s.digest === batch.sourceScopeDigest)!
        const parentScope = preparation.scopes.find(s => s.familyId === sourceScope.familyId) ?? sourceScope
        const probe = stagePlan({ stage: 'baseline-probe', partition: 'seed', universeDigest: seed.digest, taskSetSizeResolutionDigest: resolution.digest,
          scopeDigest: parentScope.digest, taskIds: parentScope.taskIds, participantIds: [parent.candidateId], prerequisiteDecisionDigests: [parents.digest, preparation.digest], selectionRuleDigest: integrity })
        const baseline = await evaluate(seed, probe, parent)
        const p = profile(seed, probe, parent, baseline, settings.search.process.mode, parentScope.weights)
        if (seed.objective ? !scoringComplete(p) : !p.outcomeComplete) { cancelled.push('parent-baseline-incomplete'); continue }
        let dossier: DiagnosisDossier
        try { dossier = await this.runtime.diagnose(admission, startedAt, seed, parent, probe.taskIds, baseline, signal, inspectionSignal) }
        catch (error) {
          if (!(error instanceof SearchBudgetExceeded)) throw error
          cancelled.push(error.message); continue
        }
        await this.store.put(dossier)
        if (dossier.failure) { cancelled.push(`${dossier.failure.kind}:${dossier.failure.code}`); continue }
        const families = clusters(dossier, seed, settings.promotion.protectedTasks.filter(g => g.partition === 'seed').map(g => g.taskId))
        diagnosedClusters.push(...families)
        const cutoff = seal({ archiveDigest: archive!.digest, baselineDigest: baseline.digest })
        await this.store.put(cutoff)
        const sampler = samplingEvidence(seed, cutoff.digest, [...archive!.clusters, ...families], [...archive!.results, baseline])
        await this.store.put(sampler)
        if (!families.length) cancelled.push('no-actionable-cluster')
        let allocated = 0
        for (const cluster of families) {
          if (allocated >= batch.maxCandidateSlots) break
          const scope = scopes.filter(s => s.familyId === cluster.familyId).sort((a, b) => b.epoch - a.epoch)[0] ?? createScope(seed, resolution, settings.search, cluster, shared, preparation.epoch, sampler)
          if (!scope) { cancelled.push(`no-representative:${cluster.familyId}`); continue }
          await this.store.put(cluster)
          for (const hypothesis of cluster.hypotheses.slice(0, settings.search.diagnosis.candidatesPerFamily)) {
            if (allocated >= batch.maxCandidateSlots) break
            const hypothesisKey = digestJson([parent.digest, cluster.familyId, hypothesis])
            if (usedHypotheses.has(hypothesisKey)) continue
            const remaining = await this.store.remaining(admission.roundId, settings.budgets)
            const candidateCost = plannedCellCount(seed, scope.taskIds)
            if (remaining.cells < candidateCost + works.reduce((sum, w) => sum + plannedCellCount(seed, w.scope.taskIds), 0)
              || remaining.generationTokens !== null && remaining.generationTokens <= 0
              || remaining.generationRequests !== null && remaining.generationRequests <= 0) { cancelled.push('budget-exhausted'); continue }
            const candidateId = `${admission.roundId}-candidate-${works.length}`
            const localPlan = stagePlan({ stage: 'local', partition: 'seed', universeDigest: seed.digest, taskSetSizeResolutionDigest: resolution.digest,
              scopeDigest: scope.digest, taskIds: scope.taskIds, participantIds: [candidateId, parent.candidateId], prerequisiteDecisionDigests: [parents.digest], selectionRuleDigest: integrity })
            const localBaseline = await evaluate(seed, localPlan, parent)
            const parentProfile = profile(seed, localPlan, parent, localBaseline, settings.search.process.mode, scope.weights)
            if (!passesExploration(scope, parentProfile, seed) || !cluster.taskIds.some(id => parentProfile.tasks.some(t => t.taskId === id && (seed.objective ? t.objectiveScore?.score !== undefined : t.outcome! < seed.tasks.find(t => t.id === id)!.successUtility)))) { cancelled.push(`hypothesis-unconfirmed:${cluster.familyId}`); continue }
            const slots = Math.max(1, admission.maxCandidates - works.length)
            const availableTokens = remaining.generationTokens === null ? null : remaining.generationTokens - works.reduce((sum, w) => sum + (w.workplan.generationBudget.maxTokens ?? 0), 0)
            const availableRequests = remaining.generationRequests === null ? null : remaining.generationRequests - works.reduce((sum, w) => sum + (w.workplan.generationBudget.maxModelRequests ?? 0), 0)
            if (availableTokens !== null && availableTokens < slots || availableRequests !== null && availableRequests < slots) { cancelled.push('generation-budget-exhausted'); continue }
            const workplan: CandidateWorkPlan = seal({ candidateId, batchId: batch.batchId, parentSnapshotDigest: parent.digest, dossierDigest: dossier.digest,
              clusterDigest: cluster.digest, familyId: cluster.familyId, hypothesis, targetTaskIds: cluster.taskIds, requiredDiagnosisRefs: cluster.evidenceRefs,
              modificationPaths: cluster.modificationPaths, scopeDigest: scope.digest, localStagePlanDigest: localPlan.digest,
              modificationBoundaryRule: { requiredSeedTaskIds: sorted(seed.tasks.map(t => t.id)), onInsufficientScope: 'retain-research-only' },
              generationBudget: { ...(availableTokens === null ? {} : { maxTokens: Math.floor(availableTokens / slots) }),
                ...(availableRequests === null ? {} : { maxModelRequests: Math.floor(availableRequests / slots) }), deadlineAt: startedAt + settings.budgets.round.timeoutMs } })
            works.push({ workplan, dossier, scope, plan: localPlan, parent, baseline: localBaseline }); allocated++; usedHypotheses.add(hypothesisKey)
            if (!scopes.some(s => s.digest === scope.digest)) scopes.push(scope)
            baselineResults.push(localBaseline); baselinePlans.push(localPlan)
          }
        }
      }
      const planned = seal({ works, cancelled, scopes, baselineResults, baselinePlans, diagnosedClusters })
      await this.store.put(planned)
      for (const work of works) await this.runtime.consume(admission.roundId, work.baseline, 'workplans', planned.digest)
      return planned
    })
    await this.runtime.progress(request.roundId, 'generation')
    const generated: Array<{ work: PreparedWork; value: GeneratedCandidate }> = []
    for (const work of planning.works) {
      validateSearchSchema('CandidateWorkPlan', work.workplan)
      validateSearchSchema('DiagnosisDossier', work.dossier)
      invariant(digestJson(work.workplan.modificationBoundaryRule.requiredSeedTaskIds) === digestJson(sorted(seed.tasks.map(t => t.id))), 'broader modification rule must require the frozen full seed manifest')
      const value = await this.runtime.generate(admission, startedAt, settings, seed, work, signal, inspectionSignal)
      generated.push({ work, value })
    }
    await this.runtime.progress(request.roundId, 'local')
    const local = await this.store.freeze(request.roundId, 'local', async () => {
      const entries: Array<{ work: PreparedWork; snapshot: Snapshot; result: StageResult; outsideBoundary: boolean; broaderScopeSatisfied: boolean }> = []
      const reasons: string[] = []
      for (const { work, value } of generated) {
        if (!value.snapshot) { reasons.push(value.reason ?? 'generation-failed'); continue }
        {
          const result = await evaluate(seed, work.plan, value.snapshot)
          if (result.failure) reasons.push(`${result.failure.kind}:${result.failure.code}`)
          const outsideBoundary = value.changedPaths.some(path => !work.workplan.modificationPaths.some(root => path === root || path.startsWith(`${root}/`)))
          const broaderScopeSatisfied = work.workplan.modificationBoundaryRule.requiredSeedTaskIds.every(id => work.plan.taskIds.includes(id))
          if (outsideBoundary) reasons.push(`${broaderScopeSatisfied ? 'modification-boundary-full-seed-covered' : 'requires-broader-evaluation'}:${value.snapshot.candidateId}`)
          entries.push({ work, snapshot: value.snapshot, result, outsideBoundary, broaderScopeSatisfied })
        }
      }
      const decision = seal({ entries, reasons })
      await this.store.put(decision)
      for (const entry of entries) await this.runtime.consume(admission.roundId, entry.result, 'local-decision', decision.digest)
      return decision
    })
    const nominees = new Map<string, typeof local.entries[number]>()
    for (const scope of planning.scopes) {
      const eligible = local.entries.filter(e => e.work.scope.digest === scope.digest && (!e.outsideBoundary || e.broaderScopeSatisfied) && !e.result.failure)
      const ranks = rankProfiles(seed, eligible.map(e => ({ id: e.snapshot.candidateId, profile: profile(seed, e.work.plan, e.snapshot, e.result, settings.promotion.process.mode, scope.weights) })))
      if (ranks.length) nominees.set(scope.digest, eligible.find(e => e.snapshot.candidateId === ranks[0])!)
    }
    const expansion = await this.store.freeze(request.roundId, 'expansion', async () => {
      const remaining = await this.store.remaining(admission.roundId, settings.budgets)
      const bridge = await bridgeSelection(seed, resolution, settings.search, admission.roundIndex, [...nominees.values()].map(e => ({ candidateId: e.snapshot.candidateId, scope: e.work.scope })), anchor.candidateId,
        sorted([...settings.promotion.protectedTasks, ...settings.promotion.protectedAssertions].filter(g => g.partition === 'seed').map(g => g.taskId)),
        async (ids, tasks) => {
          const cost = await this.runtime.missingCost(seed, ids.map(id => id === anchor.candidateId ? anchor : local.entries.find(e => e.snapshot.candidateId === id)!.snapshot), tasks)
          return cost.cells <= remaining.cells && cost.repairCells <= remaining.repairCells
        })
      return seal(bridge)
    })
    const localDecisions = await this.store.freeze(request.roundId, 'local-stage-decisions', async () => {
      const decisions: EvaluationStageDecision[] = []
      for (const { work, value } of generated) {
        const entry = local.entries.find(e => e.snapshot.candidateId === work.workplan.candidateId)
        const p = entry ? profile(seed, work.plan, entry.snapshot, entry.result, settings.promotion.process.mode, work.scope.weights) : undefined
        const support = seal({ scopeDigest: work.scope.digest, generatedDigest: value.digest, baselineDigest: work.baseline.digest,
          ...(entry ? { resultDigest: entry.result.digest, profile: p } : {}) })
        await this.store.put(support)
        const advance = expansion.plan?.participantIds.includes(work.workplan.candidateId)
        const incomplete = entry && (!scoringComplete(p!) || entry.result.failure)
        const boundaryBlocked = entry?.outsideBoundary && !entry.broaderScopeSatisfied
        const exclusion = expansion.exclusions.find(e => e.candidateId === work.workplan.candidateId)?.reason
        decisions.push(seal({ stagePlanDigest: work.plan.digest, candidateId: work.workplan.candidateId,
          outcome: !entry || boundaryBlocked ? 'ineligible' as const : incomplete ? 'insufficient-evidence' as const : advance ? 'advance' as const : 'retained-local' as const,
          reasonCodes: !entry ? [value.reason ?? 'generation-failed'] : boundaryBlocked ? ['requires-broader-evaluation']
            : incomplete ? [entry.result.failure ? 'stage-execution-unavailable' : 'incomplete-local-evidence'] : advance ? ['selected-for-bridge'] : [exclusion ?? 'not-selected-within-scope'],
          supportDigest: support.digest, ...(advance ? { nextStagePlanDigest: expansion.plan!.digest } : {}) }))
      }
      return seal({ decisions })
    })
    await this.runtime.decisionProgress(request.roundId, localDecisions.decisions)
    const stageDecisions = [...localDecisions.decisions]
    const stages: StageEvaluationPlan[] = [], results: StageResult[] = [], reasons = [...planning.cancelled, ...local.reasons]
    let nominee: Snapshot | undefined, seedInput: PromotionInput | undefined, gate: GateDecision | undefined
    if (expansion.plan) {
      await this.runtime.progress(request.roundId, 'bridge')
      {
        const bp = expansion.plan, br = await evaluate(seed, bp, anchor)
        const reference = await initialBaseline(seed, bp)
        stages.push(bp); results.push(br)
        const rankings: Array<{ id: string; profile: ReturnType<typeof profile> }> = []
        const bridgeGates: Array<{ candidateId: string; gate: GateDecision; result: StageResult }> = []
        let incomplete = false
        for (const id of bp.participantIds.filter(id => id !== anchor.candidateId)) {
          const s = local.entries.find(e => e.snapshot.candidateId === id)!.snapshot, result = await evaluate(seed, bp, s)
          results.push(result)
          const g = assessGate({ universe: seed, plan: bp, anchor, candidate: s, baseline: br, result, initialBaseline: reference }, settings.promotion, false)
          bridgeGates.push({ candidateId: id, gate: g, result })
          if (g.outcome === 'eligible') rankings.push({ id, profile: profile(seed, bp, s, result, settings.promotion.process.mode) })
          else if (g.outcome === 'insufficient-evidence') incomplete = true
          if (result.failure) reasons.push(`${result.failure.kind}:${result.failure.code}`)
        }
        if (incomplete) reasons.push('incomplete-bridge-evidence')
        if (br.failure) reasons.push(`${br.failure.kind}:${br.failure.code}`)
        const nomination = await this.store.freeze(request.roundId, 'nomination', async () => {
          const candidateId = incomplete ? null : rankProfiles(seed, rankings)[0] ?? null
          const decisions: EvaluationStageDecision[] = []
          for (const entry of bridgeGates) {
            const support = seal({ scopeDigest: bp.scopeDigest, baselineDigest: br.digest, resultDigest: entry.result.digest, gate: entry.gate })
            await this.store.put(support)
            const advance = entry.candidateId === candidateId
            const insufficient = entry.gate.outcome === 'insufficient-evidence' || incomplete && entry.gate.outcome === 'eligible'
            decisions.push(seal({ stagePlanDigest: bp.digest, candidateId: entry.candidateId,
              outcome: advance ? 'advance' as const : insufficient ? 'insufficient-evidence' as const : entry.gate.outcome === 'eligible' ? 'retained-local' as const : 'ineligible' as const,
              reasonCodes: advance ? ['selected-for-global-seed'] : insufficient ? ['incomplete-bridge-evidence'] : entry.gate.outcome === 'eligible' ? ['not-selected-for-global-seed'] : entry.gate.reasonCodes,
              supportDigest: support.digest, ...(advance ? { nextStagePlanDigest: this.fullPlan(admission, seed, 'global-seed', [anchor.candidateId, entry.candidateId], resolution.digest).digest } : {}) }))
          }
          const decision = seal({ candidateId, bridgeDigest: bp.digest, decisions })
          await this.store.put(decision)
          for (const result of results.filter(r => r.stagePlanDigest === bp.digest)) await this.runtime.consume(admission.roundId, result, 'nomination', decision.digest)
          return decision
        })
        stageDecisions.push(...nomination.decisions)
        await this.runtime.decisionProgress(request.roundId, nomination.decisions)
        if (nomination.candidateId) {
          nominee = local.entries.find(e => e.snapshot.candidateId === nomination.candidateId)!.snapshot
          const gp = this.fullPlan(admission, seed, 'global-seed', [anchor.candidateId, nominee.candidateId], resolution.digest)
          await this.runtime.progress(request.roundId, 'global-seed')
          const baseline = await evaluate(seed, gp, anchor), result = await evaluate(seed, gp, nominee)
          stages.push(gp); results.push(baseline, result)
          seedInput = { universe: seed, plan: gp, anchor, candidate: nominee, baseline, result, initialBaseline: await initialBaseline(seed, gp) }
          gate = precheckSeed(seedInput, settings.promotion)
          for (const r of [baseline, result]) if (r.failure) reasons.push(`${r.failure.kind}:${r.failure.code}`)
        }
      }
    } else reasons.push('no-bridge-quota')
    const findings = local.entries.map(entry => {
      const parent = profile(seed, entry.work.plan, entry.work.parent, entry.work.baseline, settings.search.process.mode)
      const candidate = profile(seed, entry.work.plan, entry.snapshot, entry.result, settings.search.process.mode)
      return seal({ candidateId: entry.snapshot.candidateId, parentSnapshotDigest: entry.work.parent.digest, hypothesis: entry.work.workplan.hypothesis,
        scopeDigest: entry.work.scope.digest, changedPaths: generated.find(g => g.value.snapshot?.digest === entry.snapshot.digest)!.value.changedPaths,
        improvements: candidate.tasks.filter(t => scoringValue(t) !== undefined && scoringValue(t)! > (scoringValue(parent.tasks.find(p => p.taskId === t.taskId)!) ?? Infinity)).map(t => t.taskId),
        regressions: candidate.tasks.filter(t => scoringValue(t) !== undefined && scoringValue(t)! < (scoringValue(parent.tasks.find(p => p.taskId === t.taskId)!) ?? -Infinity)).map(t => t.taskId),
        unverifiedTaskIds: seed.tasks.filter(t => !entry.work.plan.taskIds.includes(t.id)).map(t => t.id), workflowAdoption: 'unknown' as const,
        supportDigest: candidate.supportDigest, nextSteps: ['Review observed regressions and unresolved seed failures before the next mutation.'] })
    })
    if (settings.regression.collectFailures) await this.store.freeze(request.roundId, 'regression-proposals', async () => {
      const existing = await this.store.read<{ proposals: RegressionProposal[] }>('regression/proposals') ?? { proposals: [] }
      const proposals = [...existing.proposals], reasons: string[] = []
      for (const cell of [...local.entries.flatMap(e => e.result.cells), ...results.flatMap(r => r.cells)]) {
        const task = seed.tasks.find(t => t.id === cell.identity.taskId)
        if (!task?.regressionTemplate || !validOutcome(cell) || cell.outcome.status !== 'available' || numeric(utility(cell.outcome.rawValue, task.outcome)) >= task.successUtility) continue
        const result = collectFailure({ ...task.regressionTemplate, source: { kind: 'seed-evaluation', evidenceRef: cell.evidenceRef }, outcome: 'business-failure' }, proposals, settings.regression)
        if (result.proposal) {
          await this.store.put(sanitizedRegressionPrompt(result.proposal.prompt)); await this.store.put(result.proposal)
          proposals.push(result.proposal)
        }
        if (result.reason) reasons.push(result.reason)
      }
      await this.store.write('regression/proposals', { proposals })
      return seal({ proposalDigests: proposals.map(p => p.digest), reasonCodes: reasons })
    })
    for (const finding of findings) {
      await this.store.put(finding)
      const snapshot = local.entries.find(e => e.snapshot.candidateId === finding.candidateId)!.snapshot
      await this.store.write(`findings/${snapshot.digest.slice(7)}`, { refs: [finding.digest] })
    }
    const research = await this.store.freeze(request.roundId, 'research', async () => {
      const evidence = [...completions, ...preparation.results, ...planning.baselineResults, ...local.entries.map(e => e.result), ...results]
      const update = buildArchive({ evolutionId: admission.evolutionId, previous: archive!, universe: seed,
        snapshots: [anchor, ...local.entries.map(e => e.snapshot)], scopes: planning.scopes,
        clusters: planning.diagnosedClusters, results: evidence, plans: [...preparation.plans, ...planning.baselinePlans, ...local.entries.map(e => e.work.plan), ...stages], config: settings.search, championId: anchor.candidateId, includeChampion: parentPolicy.requiresChampion })
      await this.store.put(update)
      for (const result of evidence) await this.runtime.consume(admission.roundId, result, 'research-archive', update.digest)
      return update
    })
    await this.runtime.progress(request.roundId, 'seed-research-complete')
    // The complete seed archive is frozen before any held-out outcome is requested.
    if (nominee && seedInput && gate?.outcome === 'eligible') {
      await this.runtime.progress(request.roundId, 'held-out')
      {
        const hp = this.fullPlan(admission, heldOut, 'held-out', [anchor.candidateId, nominee.candidateId], resolution.digest)
        const reference = await initialBaseline(heldOut, hp)
        const baseline = await evaluate(heldOut, hp, anchor), result = await evaluate(heldOut, hp, nominee)
        gate = decideFinal(seedInput, { universe: heldOut, plan: hp, anchor, candidate: nominee, baseline, result, initialBaseline: reference }, settings.promotion)
        for (const r of [baseline, result]) if (r.failure) reasons.push(`${r.failure.kind}:${r.failure.code}`)
        if (gate.outcome === 'insufficient-evidence' && !baseline.failure && !result.failure) {
          await this.store.write(`rounds/${request.roundId}/pending-evidence`, { planDigest: hp.digest, resultRefs: [baseline.digest, result.digest] })
          throw new SearchEvidencePending(hp.digest)
        }
      }
    }
    const championChanged = gate?.outcome === 'accepted'
      && (settings.promotion.validationMode === 'independent-held-out' || settings.promotion.allowSharedSetPromotion === true)
    const outcome: SearchRoundOutcome = seal({ schemaVersion: 2 as const, roundId: request.roundId, archiveDigest: research.digest, championAnchorDigest: anchor.digest,
      ...(nominee ? { nomineeId: nominee.candidateId } : {}), ...(gate ? { promotion: gate } : {}), championChanged,
      advisory: settings.promotion.validationMode === 'shared-set-research' && settings.promotion.allowSharedSetPromotion !== true,
      validationMode: settings.promotion.validationMode, reasonCodes: reasons, findings,
      research: { sizing: resolution, parents, workplans: planning.works.map(w => w.workplan), scopeViews: research.scopeViews, parentProbabilities: research.parentProbabilities, bridge: expansion, scopePreparation: preparation, stageDecisions,
        candidates: local.entries.map(e => ({ candidateId: e.snapshot.candidateId, scopeDigest: e.work.scope.digest,
          profile: profile(seed, e.work.plan, e.snapshot, e.result, settings.search.process.mode, e.work.scope.weights),
          expansion: e.outsideBoundary && !e.broaderScopeSatisfied ? 'requires-broader-evaluation' as const : nominee?.digest === e.snapshot.digest ? 'global-nominee' as const : 'not-selected-for-expansion' as const })),
        remainingBudget: await this.store.remaining(request.roundId, settings.budgets) } })
    inspectionSignal.throwIfAborted()
    const intent = await this.store.freeze(request.roundId, 'commit', () => seal({ expectedArchiveDigest: base.archiveDigest, nextArchiveDigest: research.digest,
      expectedChampionRevisionDigest: admission.championRevisionDigest, ...(championChanged && nominee ? { nextChampion: nominee } : {}), outcome }))
    return await this.runtime.reconcile(request.roundId, intent)
    } finally { timed.dispose() }
  }
}
