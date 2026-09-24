import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { FileArtifactStore } from '../algorithm/artifacts.js'
import { BindingStore } from '../algorithm/bindings.js'
import type { BindingSchema, BudgetPlan, CampaignSpec } from '../algorithm/contracts.js'
import { GepaDiagnosisProvider, GepaEvaluationProvider, GepaGenerationProvider } from '../algorithm/providers/gepa-operations.js'
import { GepaPublicationProvider } from '../algorithm/providers/gepa-publication.js'
import { GepaResearchCheckpointProvider } from '../algorithm/providers/gepa-research-checkpoint.js'
import { GepaAwaitRepairProvider } from '../algorithm/providers/gepa-await-repair.js'
import { GepaRepairEvaluationProvider } from '../algorithm/providers/gepa-repair-evaluation.js'
import { GepaProcessCompletionProvider } from '../algorithm/providers/gepa-process-completion.js'
import { GepaArchiveViewProvider } from '../algorithm/providers/gepa-archive-view.js'
import { GepaScienceCheckpointProvider } from '../algorithm/providers/gepa-science-checkpoint.js'
import { ProviderProtocolError, ProviderReconcileError } from '../algorithm/provider-errors.js'
import { projectGepaCampaignBudget } from '../algorithm/providers/gepa-budget-projection.js'
import { campaignFailureClusterRecipe } from '../algorithm/recipes/gepa-search.js'
import { AlgorithmRuntime, type CampaignState } from '../algorithm/runtime/engine.js'
import { JournalArtifactStore, JournalCampaignStore, SearchJournalProviderRecordBackend } from '../algorithm/runtime/persistence.js'
import type { JsonValue } from '../algorithm/schema.js'
import { implementationClosureDigest } from '../algorithm/data/identity.js'
import { ComponentRegistry } from '../evolution/components.js'
import { digestJson } from '../state/digest.js'
import { integrity, invariant, safeId, seal, SearchProtocolError, verifyDigest } from './contracts.js'
import { buildArchive } from './archive.js'
import { scopeEpoch } from './epochs.js'
import type { GepaSharedEpoch } from '../algorithm/recipes/gepa-policy.js'
import type { EvidenceCompletion } from './completion.js'
import type { RegressionProposal } from './regression.js'
import { resolveParentPolicyRef } from './policies/parents.js'
import { SearchExecutionRuntime, type SearchAdmission, type SearchExecutionHooks } from './runtime.js'
import { validateSearchSchema } from './schema.js'
import { SearchStore, type RemainingBudget, type SearchJournal } from './store.js'
import type { DiagnosisProvider, SearchProvider } from './types.js'
import { SearchEvidencePending, type SearchRoundOutcome } from './engine.js'
import { repairCampaignEvaluation } from './campaign-repair.js'
import { pendingOperation } from './recovery.js'
import { campaignSearchDirectory, campaignSearchId } from './campaign-identity.js'
import { claimCampaignRun, inspectCampaignRun, type CampaignAdmissionExtensions,
  type FrozenCampaignAdmission } from './campaign-admission.js'
import type { PendingSearchOperation, ResearchArchive, ResearchFinding, StageResult } from './types.js'

/** Optional local cache root. Campaign state/artifacts/intent records are durably stored in SearchJournal. */
export type CampaignSearchHost = { root?: string; hookImplementationDigest?: string }

type SearchCampaignExtensions = CampaignAdmissionExtensions & {
  sharedEpochs: Record<string, GepaSharedEpoch>
}
type SearchCampaignAdmission = FrozenCampaignAdmission<SearchCampaignExtensions>
type ValidatedSearch = Awaited<ReturnType<SearchExecutionRuntime['validate']>>

export class CampaignSearchPending extends Error {
  constructor(readonly roundId: string) {
    super(`Campaign search round ${roundId} is awaiting an existing operation; resume the same round`)
    this.name = 'CampaignSearchPending'
  }
}

const harnessBindingSchema: BindingSchema = { id: 'campaign-search-harness-v1',
  slots: { harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true } } }

function roundHasLimit(settings: SearchAdmission['settings'], key: 'maxGenerationTokens' | 'maxGenerationRequests'): boolean {
  return settings.budgets.round[key] !== undefined || settings.budgets.evolution[key] !== undefined
}

function budget(admission: SearchAdmission, starting?: RemainingBudget): BudgetPlan {
  const round = admission.settings.budgets.round, evolution = admission.settings.budgets.evolution
  const cap = (a: number, b: number): number => Math.min(a, b)
  const available = (dimension: keyof RemainingBudget, fallback: number): number =>
    starting?.[dimension] ?? fallback
  return {
    rolloutCells: { unit: 'cells', limit: available('cells', cap(round.maxNewRolloutCells, evolution.maxNewRolloutCells)),
      source: 'gepa.evaluate', capability: 'stop' },
    repairCells: { unit: 'cells', limit: available('repairCells', cap(round.maxRepairCells, evolution.maxRepairCells)),
      source: 'gepa.evaluate', capability: 'stop' },
    diagnosisInputTokens: { unit: 'tokens', limit: available('diagnosisInputTokens', cap(round.maxDiagnosisInputTokens, evolution.maxDiagnosisInputTokens)),
      source: 'gepa.diagnose', capability: 'stop' },
    diagnosisOutputTokens: { unit: 'tokens', limit: available('diagnosisOutputTokens', cap(round.maxDiagnosisOutputTokens, evolution.maxDiagnosisOutputTokens)),
      source: 'gepa.diagnose', capability: 'stop' },
    ...(round.maxGenerationTokens === undefined && evolution.maxGenerationTokens === undefined ? {} : {
      generationTokens: { unit: 'tokens', limit: available('generationTokens', cap(round.maxGenerationTokens ?? Number.MAX_SAFE_INTEGER,
        evolution.maxGenerationTokens ?? Number.MAX_SAFE_INTEGER)), source: 'gepa.generate', capability: 'stop' as const } }),
    ...(round.maxGenerationRequests === undefined && evolution.maxGenerationRequests === undefined ? {} : {
      generationRequests: { unit: 'requests', limit: available('generationRequests', cap(round.maxGenerationRequests ?? Number.MAX_SAFE_INTEGER,
        evolution.maxGenerationRequests ?? Number.MAX_SAFE_INTEGER)), source: 'gepa.generate', capability: 'stop' as const } }),
  }
}

const inMemoryRoots = new WeakMap<SearchJournal, string>()
function campaignRoot(store: SearchJournal, roundId: string, host: CampaignSearchHost): string {
  if (host.root) {
    if (!isAbsolute(host.root)) throw new Error('Campaign search host root must be absolute')
    return join(resolve(host.root), campaignSearchDirectory(roundId))
  }
  if (store instanceof SearchStore) return join(resolve(store.root), 'campaigns', campaignSearchDirectory(roundId))
  if (store.constructor.name === 'MemorySearchStore') {
    let root = inMemoryRoots.get(store)
    if (!root) { root = mkdtempSync(join(tmpdir(), 'gear-memory-search-campaign-')); inMemoryRoots.set(store, root) }
    return join(root, campaignSearchDirectory(roundId))
  }
  // A custom journal carries the authoritative state; this directory is only
  // a verified local artifact cache and may be replaced on a new process.
  return join(mkdtempSync(join(tmpdir(), 'gear-search-campaign-cache-')), campaignSearchDirectory(roundId))
}

/** Parallel migration facade. The public FailureClusterSearch switches only after all paths reach parity. */
export class CampaignFailureClusterSearch {
  private readonly validator: SearchExecutionRuntime
  constructor(readonly store: SearchJournal, readonly provider: SearchProvider, readonly diagnosis: DiagnosisProvider,
    readonly hooks: SearchExecutionHooks, readonly components = new ComponentRegistry(), readonly host: CampaignSearchHost = {}) {
    this.validator = new SearchExecutionRuntime(store, provider, diagnosis, hooks, components)
  }

  validate(admission: SearchAdmission) { return this.validator.validate(admission) }

  async repairEvaluation(roundId: string, repairId: string, originalRef: string, signal: AbortSignal): Promise<StageResult> {
    safeId(roundId); safeId(repairId); signal.throwIfAborted()
    const pointer = await this.store.read<{ ref: string }>(`rounds/${roundId}/admission`)
    if (!pointer) throw new Error('unknown search round')
    const frozen = await this.store.object<SearchAdmission & { digest: string;
      requestedSettings?: SearchAdmission['settings']; campaignDriver?: string }>(pointer.ref)
    if (frozen.campaignDriver !== 'failure-cluster-campaign-v1')
      throw new Error('Existing legacy search repair must resume with its original engine')
    const request: SearchAdmission = { evolutionId: frozen.evolutionId, roundId: frozen.roundId,
      roundIndex: frozen.roundIndex, maxCandidates: frozen.maxCandidates, anchor: frozen.anchor,
      championRevisionDigest: frozen.championRevisionDigest, settings: frozen.requestedSettings ?? frozen.settings }
    const { runtime, repairProvider, processProvider } = await this.openCampaignSearchRuntime(request)
    return repairCampaignEvaluation({ store: this.store, validator: this.validator, runtime,
      repairProvider, processProvider, roundId, repairId, originalRef, signal })
  }

  /** Rebuilds the exact frozen Campaign host for the public run and auxiliary repair entrypoints. */
  async openCampaignSearchRuntime(request: SearchAdmission, options: {
    current?: ValidatedSearch; frozenAdmission?: SearchCampaignAdmission;
    startedAt?: number; preview?: boolean } = {}) {
    safeId(request.roundId)
    const { seed, heldOut, resolvedSettings } = options.current ?? await this.validate(request)
    const admitted: SearchAdmission = { ...request, settings: resolvedSettings }
    const root = campaignRoot(this.store, request.roundId, this.host)
    const artifacts = new JournalArtifactStore(join(root, 'artifacts'), this.store, request.roundId)
    const bindings = new BindingStore(artifacts, harnessBindingSchema)
    const harness = artifacts.putJson({ commitOid: request.anchor.commit,
      manifestDigest: request.anchor.manifestDigest }, 'harness.directory.v1')
    const anchorBindingSetRef = bindings.create({ harness })
    const policy = this.components.parentSelectionPolicy(resolveParentPolicyRef(resolvedSettings.search))
    const savedAdmission = await this.store.read<{ ref: string }>(`rounds/${request.roundId}/admission`)
    const frozenAdmission = options.frozenAdmission ?? (savedAdmission
      ? await this.store.object<SearchCampaignAdmission>(savedAdmission.ref) : null)
    if (savedAdmission) {
      const frozen = frozenAdmission!
      if (frozen.campaignDriver !== 'failure-cluster-campaign-v1')
        throw new Error('Existing legacy search round must resume with its original engine and operation keys')
      if (digestJson({ evolutionId: frozen.evolutionId, roundId: frozen.roundId,
        roundIndex: frozen.roundIndex, maxCandidates: frozen.maxCandidates, anchor: frozen.anchor,
        championRevisionDigest: frozen.championRevisionDigest, settings: frozen.settings })
        !== digestJson(request)) throw new Error('Campaign search request changed on resume')
    }
    const startedAt = options.startedAt ?? frozenAdmission?.startedAt ?? Date.now()
    const installedArchive = frozenAdmission
      ? (frozenAdmission.startingArchiveDigest
        ? await this.store.object<ResearchArchive>(frozenAdmission.startingArchiveDigest) : null)
      : await this.store.archive() ?? null
    const completionRefs = frozenAdmission?.completionRefs
      ?? (installedArchive ? (await this.store.read<{ refs: string[] }>('pending-completions'))?.refs ?? [] : [])
    if (new Set(completionRefs).size !== completionRefs.length)
      throw new Error('Campaign search completion queue has duplicate references')
    const completedEvidence: StageResult[] = []
    for (const ref of completionRefs) {
      const completion = await this.store.object<EvidenceCompletion>(ref)
      if (!installedArchive?.results.some(row => row.digest === completion.originalResultDigest))
        throw new Error('Campaign completion does not reference installed archive evidence')
      completedEvidence.push(await this.store.object<StageResult>(completion.completedResultDigest))
    }
    const parentArchive = installedArchive && (policy.requiresChampion
      || completedEvidence.some(row => !installedArchive.results.some(saved => saved.digest === row.digest)))
      ? buildArchive({ evolutionId: request.evolutionId, previous: installedArchive, universe: seed,
        snapshots: [request.anchor], scopes: [], plans: [], results: completedEvidence,
        config: resolvedSettings.search, championId: request.anchor.candidateId,
        includeChampion: policy.requiresChampion }) : installedArchive
    const startingBudget = frozenAdmission?.campaignBudget
      ?? budget(admitted, await this.store.remaining(request.roundId, resolvedSettings.budgets))
    const deadlineAt = startedAt + resolvedSettings.budgets.round.timeoutMs
    const epoch = scopeEpoch(resolvedSettings, request.roundIndex)
    const sharedPointer = frozenAdmission ? null
      : await this.store.read<{ ref: string }>(`evolution/shared-epoch-${epoch}`)
    const sharedEpoch = sharedPointer
      ? await this.store.object<{ digest: string; epoch: number; archiveCutoffDigest: string;
        parentSnapshotDigest: string; taskIds: string[] }>(sharedPointer.ref) : null
    const sharedEpochs = frozenAdmission?.sharedEpochs ?? (sharedEpoch ? { [String(epoch)]: { epoch: sharedEpoch.epoch,
      archiveCutoffDigest: sharedEpoch.archiveCutoffDigest,
      parentSnapshotDigest: sharedEpoch.parentSnapshotDigest, taskIds: sharedEpoch.taskIds } } : {})
    const findings: Record<string, ResearchFinding> = {}
    const handoffFindingDigests: Record<string, string[]> = {}
    for (const snapshot of parentArchive?.snapshots ?? [request.anchor]) {
      const handoff = frozenAdmission ? null
        : await this.store.read<{ refs: string[] }>(`findings/${snapshot.digest.slice(7)}`)
      const refs = frozenAdmission
        ? frozenAdmission.handoffFindingDigests?.[snapshot.digest] ?? [] : handoff?.refs ?? []
      if (!Array.isArray(refs) || refs.some(ref => typeof ref !== 'string'))
        throw new Error('Campaign search parent finding handoff is invalid')
      handoffFindingDigests[snapshot.digest] = refs
      for (const ref of [...snapshot.findingRefs, ...refs]) {
        const finding = await this.store.object<ResearchFinding>(ref)
        if (finding.digest !== ref) throw new Error('Campaign search parent finding digest drift')
        findings[ref] = finding
      }
    }
    const archiveStart = installedArchive && parentArchive ? (() => {
      const snapshotBindings: Record<string, import('../algorithm/contracts.js').BindingSetRef> = {}
      for (const snapshot of parentArchive.snapshots) {
        const snapshotHarness = artifacts.putJson({ commitOid: snapshot.commit,
          manifestDigest: snapshot.manifestDigest }, 'harness.directory.v1')
        snapshotBindings[snapshot.digest] = bindings.create({ harness: snapshotHarness })
      }
      return { baseArchiveRef: artifacts.putJson(installedArchive as unknown as JsonValue, 'gepa.research-archive.v1'),
        parentArchiveRef: artifacts.putJson(parentArchive as unknown as JsonValue, 'gepa.research-archive.v1'),
        completionRefs, publishParentView: policy.requiresChampion
          || completedEvidence.some(row => !installedArchive.results.some(saved => saved.digest === row.digest)),
        snapshotBindings }
    })() : undefined
    const startingRegressionProposals = frozenAdmission?.startingRegressionProposals
      ?? (await this.store.read<{ proposals: RegressionProposal[] }>('regression/proposals'))?.proposals ?? []
    for (const proposal of startingRegressionProposals) {
      validateSearchSchema('RegressionProposal', proposal)
      verifyDigest(proposal)
    }
    const recipe = campaignFailureClusterRecipe({ admission: admitted, seed, heldOut, settings: resolvedSettings,
      artifacts, bindingSchema: harnessBindingSchema, anchorBindingSetRef, deadlineAt, parentPolicy: policy,
      findings, handoffFindingDigests, sharedEpochs, startingRegressionProposals,
      ...(archiveStart ? { archiveStart } : {}) })
    const spec: CampaignSpec = { campaignId: campaignSearchId(request.roundId),
      config: { request: admitted, seedDigest: seed.digest, heldOutDigest: heldOut.digest, deadlineAt,
        trustedHostIdentity: this.host.hookImplementationDigest ?? null } as unknown as JsonValue,
      initialBindingSetRef: anchorBindingSetRef, budget: startingBudget }
    const operationRoot = join(root, 'operations')
    const providerIdentity = this.host.hookImplementationDigest ?? implementationClosureDigest(['../search/campaign-engine'], {
      trustedHost: true, providerIntegrity: this.provider.integrity, diagnosisIntegrity: this.diagnosis.integrity,
      sanitizationPolicyDigest: this.diagnosis.sanitizationPolicyDigest, policyRef: policy.ref,
      algorithmIntegrity: recipe.describe().implementationDigest })
    const records = new SearchJournalProviderRecordBackend(this.store, request.roundId)
    const projectorIdentityDigest = implementationClosureDigest(['providers/gepa-budget-projection'], {
      roundId: request.roundId, settings: resolvedSettings.budgets })
    const campaignStore = new JournalCampaignStore<JsonValue>(this.store, request.roundId, {
      projectorIdentityDigest, afterCommit: async value => {
        await projectGepaCampaignBudget(this.store, request.roundId, value as unknown as CampaignState, startedAt)
      } })
    const evaluationProvider = new GepaEvaluationProvider(operationRoot, artifacts, bindings,
      this.provider, undefined, records, this.store)
    const diagnosisProvider = new GepaDiagnosisProvider(operationRoot, artifacts, bindings, this.diagnosis, records)
    const generationProvider = new GepaGenerationProvider(operationRoot, artifacts, bindings,
      this.hooks, providerIdentity, records, {
        generationTokens: roundHasLimit(resolvedSettings, 'maxGenerationTokens'),
        generationRequests: roundHasLimit(resolvedSettings, 'maxGenerationRequests') }, this.store)
    const repairProvider = new GepaRepairEvaluationProvider(operationRoot, artifacts, bindings,
      this.provider, records)
    const processProvider = new GepaProcessCompletionProvider(operationRoot, artifacts, bindings,
      this.provider, records, this.store)
    let runtime!: AlgorithmRuntime
    runtime = new AlgorithmRuntime(root, recipe, [
      evaluationProvider, diagnosisProvider, generationProvider,
      new GepaPublicationProvider(operationRoot, artifacts, this.store, this.hooks,
        { hookIdentityDigest: providerIdentity, records,
          beforePublication: () => runtime.hydrate(), publicationBarrierIdentityDigest: projectorIdentityDigest }),
      new GepaResearchCheckpointProvider(operationRoot, artifacts, this.store, records),
      new GepaScienceCheckpointProvider(operationRoot, artifacts, this.store, records),
      new GepaAwaitRepairProvider(this.store, operationRoot, records),
      new GepaArchiveViewProvider(operationRoot, artifacts, this.store, records),
      repairProvider,
      processProvider,
    ], spec, { store: campaignStore, artifacts })
    if (!options.preview) await runtime.hydrate()
    return { runtime, validator: this.validator, artifacts, admitted, seed, heldOut, resolvedSettings,
      recipe, policy, startedAt, savedAdmission, installedArchive, completionRefs, startingBudget,
      sharedEpochs, handoffFindingDigests, startingRegressionProposals,
      roundRecipeIdentity: digestJson(recipe.describe()),
      legacyProviders: [evaluationProvider, diagnosisProvider, generationProvider] as const,
      repairProvider, processProvider }
  }

  async run(request: SearchAdmission, signal: AbortSignal): Promise<SearchRoundOutcome> {
    const inspected = await inspectCampaignRun<SearchCampaignExtensions>({ store: this.store,
      request, components: this.components, signal })
    if (inspected.kind === 'terminal') return inspected.outcome
    // Publication's commit intent is frozen only after Campaign's budget
    // projection barrier. The old single-purpose reconcile replays this exact
    // archive/champion tuple without admitting a new run or invoking science.
    if (inspected.kind === 'commit') return this.validator.reconcile(request.roundId, inspected.intent)
    const claimed = await claimCampaignRun<SearchCampaignExtensions>({ store: this.store,
      request, signal, inspected, providerIntegrity: this.provider.integrity,
      diagnosisIntegrity: this.diagnosis.integrity,
      sanitizationPolicyDigest: this.diagnosis.sanitizationPolicyDigest,
      validate: () => this.validate(request),
      prepareExtensions: async (current, startedAt) => {
        const prepared = await this.openCampaignSearchRuntime(request, { current, startedAt, preview: true })
        return { startingArchiveDigest: prepared.installedArchive?.digest ?? null,
          completionRefs: prepared.completionRefs, sharedEpochs: prepared.sharedEpochs,
          handoffFindingDigests: prepared.handoffFindingDigests,
          campaignBudget: prepared.startingBudget,
          startingRegressionProposals: prepared.startingRegressionProposals,
          roundRecipeIdentity: prepared.roundRecipeIdentity }
      },
      verifyFrozenRecipe: async (admission, current) => {
        const prepared = await this.openCampaignSearchRuntime(request, { current,
          frozenAdmission: admission, preview: true })
        invariant(prepared.roundRecipeIdentity === admission.roundRecipeIdentity,
          'campaign round recipe identity changed on resume')
      } })
    const { runtime, artifacts, resolvedSettings, startedAt, legacyProviders } = await this.openCampaignSearchRuntime(request, {
        current: claimed.current, frozenAdmission: claimed.admission })
    const budgetStart = (await this.store.read<{ startedAt: number }>('budget'))?.startedAt ?? startedAt
    const deadlineAt = Math.min(startedAt + resolvedSettings.budgets.round.timeoutMs,
      budgetStart + resolvedSettings.budgets.evolution.timeoutMs)
    const dispose = legacyProviders.map(provider => provider.beginLegacyInvocation({ callerSignal: signal, deadlineAt }))
    try {
    let status: Awaited<ReturnType<AlgorithmRuntime['tick']>>
    do {
      signal.throwIfAborted(); status = await runtime.tick()
      if (status === 'advanced') {
        // A reducer advances only after the preceding physical group settled;
        // the old compatibility pointer can then be cleared before the next key.
        const prior = await this.store.read<PendingSearchOperation | null>(`rounds/${request.roundId}/pending-operation`)
        if (prior) await this.store.write(`rounds/${request.roundId}/pending-operation`, null)
      }
    } while (status === 'advanced')
    if (status !== 'complete') {
      const pendingRepair = Object.values(runtime.snapshot()?.operations ?? {}).find(record =>
        record.envelope.kind === 'gepa.await-repair' && record.status !== 'completed')
      if (pendingRepair) {
        const input = pendingRepair.envelope.input as unknown as { plan: { digest: string } }
        throw new SearchEvidencePending(input.plan.digest)
      }
      const pendingPhysical = Object.values(runtime.snapshot()?.operations ?? {}).find(record =>
        ['gepa.evaluate', 'gepa.diagnose', 'gepa.generate'].includes(record.envelope.kind)
        && record.status !== 'completed' && record.status !== 'cancelled')
      if (pendingPhysical) {
        const envelope = pendingPhysical.envelope
        const provider = legacyProviders.find(item => item.describe().kind === envelope.kind)!
        const inspected = await provider.legacyPending(envelope)
        if (inspected) {
          const input = envelope.input as Record<string, unknown>
          let operation: Omit<PendingSearchOperation, 'state' | 'reason' | 'handle'>
          if (envelope.kind === 'gepa.evaluate') {
            const plan = input.plan as { digest: string; partition: 'seed' | 'held-out' }
            const snapshot = input.snapshot as { digest: string; candidateId: string }
            operation = { operationKey: digestJson([request.evolutionId, request.roundId,
              `evaluation-${digestJson([plan.digest, snapshot.digest]).slice(7)}`]),
            kind: 'evaluation', partition: plan.partition, stagePlanDigest: plan.digest,
            candidateId: snapshot.candidateId }
          } else if (envelope.kind === 'gepa.diagnose') {
            const snapshot = input.snapshot as { digest: string; candidateId: string }
            const baseline = input.baseline as { digest: string; stagePlanDigest: string }
            const taskIds = input.taskIds as string[]
            operation = { operationKey: digestJson([request.roundId,
              `diagnosis-${digestJson([snapshot.digest, baseline.digest, taskIds]).slice(7)}`]),
            kind: 'diagnosis', partition: 'seed', stagePlanDigest: baseline.stagePlanDigest,
            candidateId: snapshot.candidateId }
          } else {
            const workplan = input.workplan as { digest: string; candidateId: string }
            const plan = input.plan as { digest: string }
            operation = { operationKey: digestJson([request.roundId, workplan.digest, 'generation']),
              kind: 'generation', partition: 'seed', stagePlanDigest: plan.digest,
              candidateId: workplan.candidateId }
          }
          await pendingOperation(this.store, request.roundId, { ...operation, state: inspected.state,
            reason: inspected.reason, ...(inspected.handle ? { handle: inspected.handle } : {}) })
        }
      }
      throw new CampaignSearchPending(request.roundId)
    }
    const priorPending = await this.store.read<PendingSearchOperation | null>(`rounds/${request.roundId}/pending-operation`)
    if (priorPending) await this.store.write(`rounds/${request.roundId}/pending-operation`, null)
    const state = runtime.snapshot()?.state as { outcomeRef?: import('../algorithm/contracts.js').ArtifactRef } | undefined
    if (!state?.outcomeRef) throw new Error('Campaign search completed without an outcome reference')
    const outcome = artifacts.getJson(state.outcomeRef) as unknown as SearchRoundOutcome
    validateSearchSchema('SearchRoundOutcome', outcome)
    if (outcome.roundId !== request.roundId) throw new Error('Campaign search terminal round mismatch')
    return outcome
    } catch (error) {
      if (error instanceof ProviderReconcileError && error.cause instanceof Error) throw error.cause
      if (error instanceof ProviderProtocolError && error.cause instanceof SearchProtocolError) throw error.cause
      throw error
    } finally {
      for (const release of dispose.reverse()) release()
    }
  }
}
