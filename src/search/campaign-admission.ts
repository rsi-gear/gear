import type { BudgetPlan } from '../algorithm/contracts.js'
import { assertJson } from '../algorithm/schema.js'
import { ComponentRegistry } from '../evolution/components.js'
import { digestJson } from '../state/digest.js'
import { integrity, invariant, safeId, seal, verifyDigest } from './contracts.js'
import type { SearchEvolutionIdentity, SearchRoundOutcome, CommitIntent } from './engine.js'
import { searchProtocolVersion } from './identity.js'
import { resolveParentPolicyRef } from './policies/parents.js'
import type { RegressionProposal } from './regression.js'
import type { SearchAdmission } from './runtime.js'
import { validateSearchSchema } from './schema.js'
import type { SearchJournal } from './store.js'
import type { SearchSettings, TaskUniverse } from './types.js'

/** Frozen once at first admission. A resume consumes these fields, never live global cuts. */
export interface CampaignAdmissionExtensions {
  startingArchiveDigest: string | null
  completionRefs: string[]
  sharedEpochs: Record<string, unknown>
  handoffFindingDigests: Record<string, string[]>
  campaignBudget: BudgetPlan
  startingRegressionProposals: RegressionProposal[]
  roundRecipeIdentity: string
}

export type FrozenCampaignAdmission<E extends CampaignAdmissionExtensions = CampaignAdmissionExtensions> =
  SearchAdmission & E & {
    digest: string
    requestDigest: string
    seed: TaskUniverse
    heldOut: TaskUniverse
    resolvedSettings: SearchSettings
    providerIntegrity: string
    diagnosisIntegrity: string
    algorithmIntegrity: string
    parentPolicyRef: ReturnType<ComponentRegistry['parentSelectionPolicy']>['ref']
    startedAt: number
    campaignDriver: 'failure-cluster-campaign-v1'
  }

type Policy = ReturnType<ComponentRegistry['parentSelectionPolicy']>
export type CampaignAdmissionContinue<E extends CampaignAdmissionExtensions = CampaignAdmissionExtensions> = {
  kind: 'continue'
  policy: Policy
  savedAdmission: FrozenCampaignAdmission<E> | null
  requestDigest: string
}
export type CampaignAdmissionInspection<E extends CampaignAdmissionExtensions = CampaignAdmissionExtensions> =
  | { kind: 'terminal'; outcome: SearchRoundOutcome }
  | { kind: 'commit'; intent: CommitIntent }
  | CampaignAdmissionContinue<E>

function assertFrozenExtensions(value: CampaignAdmissionExtensions): void {
  // Admission's legacy settings may contain omitted optional properties. The
  // new extension itself must be fully serializable and complete.
  assertJson({ startingArchiveDigest: value.startingArchiveDigest,
    completionRefs: value.completionRefs, sharedEpochs: value.sharedEpochs,
    handoffFindingDigests: value.handoffFindingDigests,
    campaignBudget: value.campaignBudget,
    startingRegressionProposals: value.startingRegressionProposals,
    roundRecipeIdentity: value.roundRecipeIdentity })
  invariant(typeof value.roundRecipeIdentity === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value.roundRecipeIdentity),
    'round recipe identity changed on resume')
  invariant(value.startingArchiveDigest === null || /^sha256:[a-f0-9]{64}$/u.test(value.startingArchiveDigest),
    'campaign starting archive identity changed')
  invariant(Array.isArray(value.completionRefs) && new Set(value.completionRefs).size === value.completionRefs.length
    && value.completionRefs.every(ref => /^sha256:[a-f0-9]{64}$/u.test(ref)),
  'campaign completion cut changed')
  invariant(value.sharedEpochs !== null && typeof value.sharedEpochs === 'object' && !Array.isArray(value.sharedEpochs),
    'campaign shared epoch cut changed')
  invariant(value.handoffFindingDigests !== null && typeof value.handoffFindingDigests === 'object'
    && !Array.isArray(value.handoffFindingDigests)
    && Object.values(value.handoffFindingDigests).every(refs => Array.isArray(refs)
      && refs.every(ref => /^sha256:[a-f0-9]{64}$/u.test(ref))),
  'campaign finding handoff cut changed')
  invariant(value.campaignBudget !== null && typeof value.campaignBudget === 'object'
    && !Array.isArray(value.campaignBudget), 'campaign budget cut changed')
  invariant(Array.isArray(value.startingRegressionProposals), 'campaign regression cut changed')
  for (const proposal of value.startingRegressionProposals) {
    validateSearchSchema('RegressionProposal', proposal)
    verifyDigest(proposal)
  }
}

/** Mirrors the old pre-admission recovery gates; it deliberately ignores caller abort. */
export async function inspectCampaignRun<E extends CampaignAdmissionExtensions = CampaignAdmissionExtensions>(options: {
  store: SearchJournal; request: SearchAdmission; components: ComponentRegistry; signal: AbortSignal
}): Promise<CampaignAdmissionInspection<E>> {
  const { store, request, components } = options
  safeId(request.roundId)
  const policy = components.parentSelectionPolicy(resolveParentPolicyRef(request.settings.search))
  const pointer = await store.read<{ ref: string }>(`rounds/${request.roundId}/admission`)
  const saved = pointer ? await store.object<FrozenCampaignAdmission<E>>(pointer.ref) : null
  const requestDigest = digestJson(request)
  if (saved) {
    const frozenRequestDigest = saved.requestDigest ?? digestJson({ evolutionId: saved.evolutionId,
      roundId: saved.roundId, roundIndex: saved.roundIndex, maxCandidates: saved.maxCandidates,
      anchor: saved.anchor, championRevisionDigest: saved.championRevisionDigest,
      settings: saved.settings })
    invariant(frozenRequestDigest === requestDigest, 'search round request changed on resume')
  }
  const terminal = await store.read<{ ref: string }>(`rounds/${request.roundId}/terminal`)
  if (terminal) {
    const outcome = await store.object<SearchRoundOutcome>(terminal.ref)
    validateSearchSchema('SearchRoundOutcome', outcome)
    const advancing = await store.read<{ roundId: string | null }>('active-round')
    if (advancing?.roundId === request.roundId) await store.write('active-round', { roundId: null })
    return { kind: 'terminal', outcome }
  }
  if (saved) invariant(saved.campaignDriver === 'failure-cluster-campaign-v1',
    'Existing legacy search round must resume with its original engine and operation keys')
  if (saved) {
    invariant(saved.algorithmIntegrity === integrity, 'search algorithm identity changed; start a new evolution')
    invariant(saved.parentPolicyRef && digestJson(saved.parentPolicyRef) === digestJson(policy.ref),
      'parent policy changed on resume')
    assertFrozenExtensions(saved)
  }
  const completion = await store.read<{ id: string }>('active-completion')
  invariant(!completion || await store.read(`rounds/${completion.id}/result`),
    'search has an unresolved completion; resume its original completion ID')
  const repair = await store.read<{ id: string }>(`rounds/${request.roundId}/active-repair`)
  invariant(!repair || await store.read(`rounds/${request.roundId}/repair-result-${digestJson(repair.id).slice(7)}`),
    'round has an unresolved repair; resume its original repair ID')
  const commit = await store.read<{ ref: string }>(`rounds/${request.roundId}/commit`)
  if (commit) return { kind: 'commit', intent: await store.object<CommitIntent>(commit.ref) }
  return { kind: 'continue', policy, savedAdmission: saved, requestDigest }
}

const reserved = new Set(['digest', 'evolutionId', 'roundId', 'roundIndex', 'maxCandidates', 'anchor',
  'championRevisionDigest', 'settings', 'requestDigest', 'seed', 'heldOut', 'resolvedSettings',
  'providerIntegrity', 'diagnosisIntegrity', 'algorithmIntegrity', 'parentPolicyRef', 'startedAt',
  'campaignDriver'])

/** Claims a round only after validation; no mutable global cut is read on resume. */
export async function claimCampaignRun<E extends CampaignAdmissionExtensions, P = undefined>(options: {
  store: SearchJournal
  request: SearchAdmission
  signal: AbortSignal
  inspected: CampaignAdmissionContinue<E>
  providerIntegrity: string
  diagnosisIntegrity: string
  sanitizationPolicyDigest: string
  validate: () => Promise<{ seed: TaskUniverse; heldOut: TaskUniverse; resolvedSettings: SearchSettings }>
  /** Pure admission precomputation after ownership/identity gates, before the single round clock capture. */
  prepareBeforeClock?: (current: { seed: TaskUniverse; heldOut: TaskUniverse;
    resolvedSettings: SearchSettings }) => Promise<P> | P
  prepareExtensions: (current: { seed: TaskUniverse; heldOut: TaskUniverse;
    resolvedSettings: SearchSettings }, startedAt: number, precomputed: P) => Promise<E> | E
  verifyFrozenRecipe: (admission: FrozenCampaignAdmission<E>, current: {
    seed: TaskUniverse; heldOut: TaskUniverse; resolvedSettings: SearchSettings }) => Promise<void> | void
}): Promise<{ admission: FrozenCampaignAdmission<E>; current: {
  seed: TaskUniverse; heldOut: TaskUniverse; resolvedSettings: SearchSettings } }> {
  const { store, request, signal, inspected } = options
  invariant(inspected.requestDigest === digestJson(request), 'search round request changed on resume')
  signal.throwIfAborted()
  const current = await options.validate()
  signal.throwIfAborted()
  const owner = await store.freeze(request.roundId, 'operation-kind', () => seal({ kind: 'search-round' }))
  invariant(owner.kind === 'search-round', 'record ID belongs to a different operation kind')
  const identity: SearchEvolutionIdentity = seal({ protocolVersion: searchProtocolVersion,
    evolutionId: request.evolutionId, settingsDigest: digestJson(request.settings),
    maxCandidates: request.maxCandidates, seedUniverseDigest: current.seed.digest,
    heldOutUniverseDigest: current.heldOut.digest, providerIntegrity: options.providerIntegrity,
    diagnosisIntegrity: options.diagnosisIntegrity,
    sanitizationPolicyDigest: options.sanitizationPolicyDigest,
    algorithmIntegrity: integrity, parentPolicy: inspected.policy.ref })
  const frozenIdentity = await store.freezeEvolution('identity', () => identity)
  invariant(identity.digest === frozenIdentity.digest, 'search evolution identity changed; start a new evolution')
  const advancing = await store.read<{ roundId: string | null }>('active-round')
  invariant(!advancing?.roundId || advancing.roundId === request.roundId
    || await store.read(`rounds/${advancing.roundId}/terminal`),
  'search has an unresolved round; recover it before starting another round')
  if (inspected.savedAdmission) await options.verifyFrozenRecipe(inspected.savedAdmission, current)
  await store.write('active-round', { roundId: request.roundId })
  const admission = await store.freeze(request.roundId, 'admission', async () => {
    // Only a new admission computes these immutable cuts. A resumed round uses
    // its sealed extension and never re-reads mutable global inputs.
    const precomputed = options.prepareBeforeClock
      ? await options.prepareBeforeClock(current) : undefined as P
    const startedAt = Date.now()
    const extensions = await options.prepareExtensions(current, startedAt, precomputed)
    for (const key of Object.keys(extensions)) invariant(!reserved.has(key), 'campaign admission extension overrides identity')
    assertFrozenExtensions(extensions)
    return seal({ ...request, ...current, ...extensions,
      requestDigest: inspected.requestDigest, providerIntegrity: options.providerIntegrity,
      diagnosisIntegrity: options.diagnosisIntegrity, algorithmIntegrity: integrity,
      parentPolicyRef: inspected.policy.ref, startedAt,
      campaignDriver: 'failure-cluster-campaign-v1' as const })
  }) as FrozenCampaignAdmission<E>
  invariant(admission.seed.digest === current.seed.digest && admission.heldOut.digest === current.heldOut.digest
    && admission.providerIntegrity === options.providerIntegrity
    && admission.diagnosisIntegrity === options.diagnosisIntegrity
    && admission.algorithmIntegrity === integrity
    && digestJson(admission.parentPolicyRef) === digestJson(inspected.policy.ref)
    && admission.requestDigest === inspected.requestDigest
    && digestJson(admission.settings) === digestJson(request.settings)
    && digestJson(admission.resolvedSettings) === digestJson(current.resolvedSettings)
    && admission.anchor.digest === request.anchor.digest
    && admission.maxCandidates === request.maxCandidates
    && admission.championRevisionDigest === request.championRevisionDigest,
  'provider/task/settings identity changed on resume')
  assertFrozenExtensions(admission)
  return { admission, current }
}
