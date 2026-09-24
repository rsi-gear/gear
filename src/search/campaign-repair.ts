import type { ArtifactRef, OperationEnvelope, OperationIntent, OperationOutcome } from '../algorithm/contracts.js'
import { AlgorithmRuntime } from '../algorithm/runtime/engine.js'
import { ProviderProtocolError } from '../algorithm/provider-errors.js'
import type { JsonValue } from '../algorithm/schema.js'
import { implementationClosureDigest } from '../algorithm/data/identity.js'
import { digestJson } from '../state/digest.js'
import { campaignSearchId } from './campaign-identity.js'
import { invariant, processTasks, safeId, seal, SearchProtocolError, validateSnapshot, verifyDigest } from './contracts.js'
import { assertCell, cellKey, completeEvidence, plannedCells, profile, reusableCells, validOutcome, verifyCells } from './evidence.js'
import { budgetFailure, pendingOperation, resolvePendingOperation } from './recovery.js'
import type { SearchAdmission, SearchExecutionRuntime } from './runtime.js'
import { usageLimit, type Ledger, type SearchJournal } from './store.js'
import type { EvidenceCell, PendingSearchOperation, Snapshot, StageEvaluationPlan, StageResult, TaskUniverse } from './types.js'

type FrozenAdmission = SearchAdmission & { seed: TaskUniverse; heldOut: TaskUniverse;
  startedAt: number; providerIntegrity: string; diagnosisIntegrity: string;
  algorithmIntegrity: string; campaignDriver: string; digest: string }

export type PreparedCampaignRepair = {
  roundId: string; repairId: string; repairKey: string; groupId: string;
  admission: FrozenAdmission; original: StageResult; current: StageResult;
  plan: StageEvaluationPlan; snapshot: Snapshot; universe: TaskUniverse;
  cached: EvidenceCell[]; missing: ReturnType<typeof plannedCells>;
  externalKey: string; deadlineAt: number;
}

/** Performs all old public repair ownership checks before reserving a Campaign operation. */
export async function prepareCampaignRepair(options: {
  store: SearchJournal; validator: SearchExecutionRuntime; runtime: AlgorithmRuntime;
  roundId: string; repairId: string; originalRef: string; signal: AbortSignal;
}): Promise<PreparedCampaignRepair> {
  const { store, validator, runtime, roundId, repairId, originalRef, signal } = options
  safeId(roundId); safeId(repairId); signal.throwIfAborted()
  invariant(!await store.read(`rounds/${roundId}/commit`), 'cannot repair after commit intent')
  invariant(!await store.read(`rounds/${roundId}/terminal`), 'cannot repair a terminal round')
  const admissionPointer = await store.read<{ ref: string }>(`rounds/${roundId}/admission`)
  invariant(admissionPointer, 'unknown search round')
  const admission = await store.object<FrozenAdmission>(admissionPointer.ref)
  invariant(admission.campaignDriver === 'failure-cluster-campaign-v1',
    'existing legacy repair must resume with its original engine')
  invariant(admission.roundId === roundId && admission.providerIntegrity === validator.provider.integrity
    && admission.diagnosisIntegrity === validator.diagnosis.integrity, 'repair provider identity changed')
  await runtime.hydrate()
  const campaign = runtime.snapshot()
  invariant(campaign && campaign.phase === 'running' && campaign.spec.campaignId === campaignSearchId(roundId),
    'repair requires this active Campaign')
  const config = campaign.spec.config
  invariant(config && !Array.isArray(config) && typeof config === 'object'
    && Object.hasOwn(config, 'request')
    && digestJson(config.request) === digestJson({ evolutionId: admission.evolutionId,
      roundId: admission.roundId, roundIndex: admission.roundIndex,
      maxCandidates: admission.maxCandidates, anchor: admission.anchor,
      championRevisionDigest: admission.championRevisionDigest, settings: admission.settings }),
  'repair Campaign admission changed')
  invariant(admission.algorithmIntegrity === runtime.algorithm.describe().implementationDigest,
    'repair algorithm identity changed')
  const { seed, heldOut } = await validator.validate(admission)
  invariant(seed.digest === admission.seed.digest && heldOut.digest === admission.heldOut.digest,
    'repair task universe changed')
  signal.throwIfAborted()
  const original = await store.object<StageResult>(originalRef)
  const plan = await store.object<StageEvaluationPlan>(original.stagePlanDigest)
  const snapshot = await store.object<Snapshot>(original.snapshotDigest)
  await validator.hooks.verifySnapshot(snapshot)
  const consumer = plan.stage === 'held-out' ? undefined : plan.stage === 'baseline-probe' ? 'planning'
    : plan.stage === 'local' ? 'local' : plan.stage === 'bridge' ? 'nomination' : 'research'
  invariant(!consumer || !await store.read(`rounds/${roundId}/${consumer}`),
    'stage already consumed; append an archive evidence completion instead')
  const consumed = `consumed-${digestJson([plan.digest, snapshot.digest]).slice(7)}`
  invariant(!await store.read(`rounds/${roundId}/${consumed}`),
    'stage already consumed; append an archive evidence completion instead')
  const evaluation = await store.read<{ ref: string }>(
    `rounds/${roundId}/evaluation-${digestJson([plan.digest, snapshot.digest]).slice(7)}`)
  invariant(evaluation?.ref === originalRef, "repair must reference this round's original evaluation")
  const active = await store.read<{ id: string }>(`rounds/${roundId}/active-repair`)
  invariant(!active || active.id === repairId
    || await store.read(`rounds/${roundId}/repair-result-${digestJson(active.id).slice(7)}`),
  'another repair is unresolved; resume its original repair ID')
  signal.throwIfAborted()

  const repairKey = digestJson(repairId).slice(7)
  const universe = plan.partition === 'seed' ? admission.seed : admission.heldOut
  const repairImplementationDigest = implementationClosureDigest(['../search/campaign-repair'], {})
  const frozen = await store.freeze(roundId, `repair-input-${repairKey}`, async () => {
    const currentPointer = await store.read<{ ref: string }>(
      `rounds/${roundId}/repair-${original.digest.slice(7)}`)
    const current = currentPointer ? await store.object<StageResult>(currentPointer.ref) : original
    const identities = plannedCells(universe, plan, snapshot)
    const cached = await reusableCells(store, validator.provider, identities, current.cells)
    const available = new Set([...current.cells, ...cached].filter(validOutcome).map(cell => cellKey(cell.identity)))
    const missing = identities.filter(identity => !available.has(cellKey(identity)))
    return seal({ originalRef, current, cached, request: { plan, snapshot, cells: missing },
      repairImplementationDigest })
  })
  invariant(frozen.originalRef === originalRef, 'repair ID reused for different evidence')
  invariant(frozen.repairImplementationDigest === repairImplementationDigest,
    'repair implementation identity changed')
  verifyDigest(frozen.current)
  verifyDigest(frozen.request.plan); validateSnapshot(frozen.request.snapshot)
  invariant(frozen.current.stagePlanDigest === plan.digest && frozen.current.snapshotDigest === snapshot.digest,
    'repair revision changed plan or snapshot')
  const identities = plannedCells(universe, plan, snapshot)
  const cachedKeys = new Set(frozen.cached.map(cell => cellKey(cell.identity)))
  invariant(cachedKeys.size === frozen.cached.length
    && frozen.cached.every(cell => validOutcome(cell) && identities.some(identity => cellKey(identity) === cellKey(cell.identity))),
  'repair cached evidence invalid')
  for (const cell of frozen.cached) assertCell(cell, identities.find(identity => cellKey(identity) === cellKey(cell.identity))!)
  invariant(await verifyCells(validator.provider, frozen.cached.map(cell => ({ cell, identity: cell.identity }))),
    'cached completion provenance rejected')
  const missing = identities.filter(identity => ![...frozen.current.cells, ...frozen.cached]
    .some(cell => cellKey(cell.identity) === cellKey(identity) && validOutcome(cell)))
  invariant(digestJson(missing) === digestJson(frozen.request.cells)
    && digestJson(frozen.request.plan) === digestJson(plan)
    && digestJson(frozen.request.snapshot) === digestJson(snapshot),
  'repair frozen request drift')
  const budgetStart = (await store.read<{ startedAt: number }>('budget'))?.startedAt ?? admission.startedAt
  const deadlineAt = Math.min(admission.startedAt + admission.settings.budgets.round.timeoutMs,
    budgetStart + admission.settings.budgets.evolution.timeoutMs)
  const externalKey = digestJson([roundId, repairId, frozen.current.digest])
  const pending = await store.read<PendingSearchOperation | null>(`rounds/${roundId}/pending-operation`)
  if (pending) {
    const owned = new Set([externalKey])
    for (const group of Object.values(campaign.auxiliaryOperations ?? {})) for (const record of Object.values(group)) {
      if (record.envelope.kind !== 'gepa.process-complete') continue
      const input = record.envelope.input as unknown as { repairId: string; baseKey: string; cellRef: ArtifactRef }
      if (input.repairId !== repairId || input.baseKey !== externalKey) continue
      const cell = runtime.artifacts.getJson(input.cellRef) as unknown as EvidenceCell
      verifyDigest(cell)
      owned.add(digestJson([externalKey, cell.digest]))
    }
    invariant(owned.has(pending.operationKey), 'another external operation is unresolved; resume its original repair ID')
  }
  return { roundId, repairId, repairKey, groupId: `repair-${repairKey}`, admission,
    original, current: frozen.current, plan, snapshot, universe, cached: frozen.cached, missing,
    externalKey, deadlineAt }
}

/** The ownership marker precedes the first auxiliary physical intent. */
export async function claimCampaignRepair(store: SearchJournal, prepared: PreparedCampaignRepair): Promise<void> {
  const active = await store.read<{ id: string }>(`rounds/${prepared.roundId}/active-repair`)
  invariant(!active || active.id === prepared.repairId
    || await store.read(`rounds/${prepared.roundId}/repair-result-${digestJson(active.id).slice(7)}`),
  'another repair is unresolved; resume its original repair ID')
  await store.write(`rounds/${prepared.roundId}/active-repair`, { id: prepared.repairId })
}

export function sealRepairInputs(runtime: AlgorithmRuntime, prepared: PreparedCampaignRepair): {
  originalRef: ArtifactRef; currentRef: ArtifactRef; cachedRef: ArtifactRef;
} {
  const artifacts = runtime.artifacts
  return {
    originalRef: artifacts.putJson(prepared.original as unknown as JsonValue, 'gepa.stage-result.v1'),
    currentRef: artifacts.putJson(prepared.current as unknown as JsonValue, 'gepa.stage-result.v1'),
    cachedRef: artifacts.putJson({ schemaVersion: 1, cells: prepared.cached } as unknown as JsonValue,
      'gepa.cached-cells.v1'),
  }
}

async function exhaustedRepairResource(store: SearchJournal, prepared: PreparedCampaignRepair): Promise<string> {
  const ledger = await store.read<Ledger>('budget')
  if (ledger) verifyDigest(ledger)
  for (const kind of ['round', 'evolution'] as const) {
    const limits = usageLimit(prepared.admission.settings.budgets[kind])
    const selected = ledger?.operations.filter(operation => kind === 'evolution'
      || operation.roundId === prepared.roundId) ?? []
    for (const resource of ['cells', 'repairCells'] as const) {
      const used = selected.reduce((sum, operation) => sum + (operation.actual ?? operation.reserved)[resource], 0)
      if (used + prepared.missing.length > limits[resource]) return `${kind}.${resource}`
    }
  }
  throw new Error('Campaign rejected repair reservation without a projected resource limit')
}

function executionRef(outcome: OperationOutcome | undefined): ArtifactRef {
  invariant(outcome?.kind === 'result' && outcome.value && typeof outcome.value === 'object'
    && !Array.isArray(outcome.value), 'repair operation did not seal physical evidence')
  const ref = (outcome.value as Record<string, unknown>).executionRef as ArtifactRef | undefined
  invariant(ref?.kind === 'artifact' && ref.schemaId === 'gepa.physical-evaluation.v1',
    'repair physical evidence reference invalid')
  return ref
}

function physicalEvidence(runtime: AlgorithmRuntime, outcome: OperationOutcome | undefined): {
  cells: EvidenceCell[]; failure?: StageResult['failure'];
} {
  const value = runtime.artifacts.getJson(executionRef(outcome)) as unknown as {
    schemaVersion: number; cells: EvidenceCell[]; failure?: StageResult['failure'] }
  invariant(value?.schemaVersion === 1 && Array.isArray(value.cells), 'repair physical evidence schema invalid')
  return value
}

async function runRepairGroup(options: { runtime: AlgorithmRuntime; store: SearchJournal;
  prepared: PreparedCampaignRepair; groupId: string; intents: OperationIntent[]; signal: AbortSignal;
  repairProvider: CampaignRepairPendingProvider; processProvider?: CampaignRepairPendingProvider | undefined;
}): Promise<Record<string, OperationOutcome>> {
  const { runtime, store, prepared, groupId, intents, signal } = options
  signal.throwIfAborted()
  await runtime.enqueueAuxiliary(groupId, intents)
  let status: Awaited<ReturnType<AlgorithmRuntime['runAuxiliaryUntilBlocked']>>
  try { status = await runtime.runAuxiliaryUntilBlocked(groupId) }
  catch (error) {
    if (error instanceof ProviderProtocolError) throw new SearchProtocolError(error.message)
    throw error
  }
  if (status !== 'complete') {
    const group = runtime.snapshot()?.auxiliaryOperations?.[groupId]
    const pending = Object.values(group ?? {}).find(record =>
      record.status !== 'completed' && !(record.status === 'cancelled' && record.released))
    invariant(pending, 'repair auxiliary group is incomplete without an operation')
    const pendingKey = pending.envelope.kind === 'gepa.repair-evaluate' ? prepared.externalKey : (() => {
      const ref = (pending.envelope.input as unknown as { cellRef: ArtifactRef }).cellRef
      const cell = runtime.artifacts.getJson(ref) as unknown as EvidenceCell
      verifyDigest(cell)
      return digestJson([prepared.externalKey, cell.digest])
    })()
    const provider = pending.envelope.kind === 'gepa.repair-evaluate'
      ? options.repairProvider : options.processProvider
    invariant(provider, 'repair pending provider is unavailable')
    const legacy = await provider.legacyPending(pending.envelope)
    invariant(legacy, 'repair provider reports no pending physical operation')
    await pendingOperation(store, prepared.roundId, {
      operationKey: pendingKey,
      kind: 'evaluation', partition: prepared.plan.partition,
      stagePlanDigest: prepared.plan.digest, candidateId: prepared.snapshot.candidateId,
      state: legacy.state,
      ...(legacy.handle ? { handle: legacy.handle } : {}),
      reason: Date.now() >= prepared.deadlineAt
        ? 'deadline reached while external execution was unresolved' : legacy.reason,
    })
  }
  const complete = runtime.snapshot()?.auxiliaryOperations?.[groupId]
  invariant(complete, 'repair auxiliary group disappeared')
  const outcomes: Record<string, OperationOutcome> = {}
  for (const [key, record] of Object.entries(complete)) {
    invariant(record.status === 'completed' && record.released && record.outcome,
      'repair auxiliary operation has no settled outcome')
    outcomes[key] = record.outcome
  }
  await resolvePendingOperation(store, prepared.roundId, prepared.externalKey)
  for (const intent of intents) if (intent.kind === 'gepa.process-complete') {
    const cellRef = (intent.input as unknown as { cellRef: ArtifactRef }).cellRef
    const cell = runtime.artifacts.getJson(cellRef) as unknown as EvidenceCell
    verifyDigest(cell)
    await resolvePendingOperation(store, prepared.roundId,
      digestJson([prepared.externalKey, cell.digest]))
  }
  return outcomes
}

type CampaignRepairPendingProvider = {
  legacyPending(envelope: OperationEnvelope): Promise<{
    state: PendingSearchOperation['state']; reason: string; handle?: string;
  } | null>
}

/** Repairs one frozen StageResult through the same Campaign budget, without reducing science. */
export async function repairCampaignEvaluation(options: {
  store: SearchJournal; validator: SearchExecutionRuntime; runtime: AlgorithmRuntime;
  repairProvider: CampaignRepairPendingProvider & { beginLegacyInvocation(): void };
  processProvider?: CampaignRepairPendingProvider & { beginLegacyInvocation(): void };
  roundId: string; repairId: string; originalRef: string; signal: AbortSignal;
}): Promise<StageResult> {
  const { store, runtime, signal } = options
  const prepared = await prepareCampaignRepair(options)
  const saved = await store.read<{ ref: string }>(
    `rounds/${prepared.roundId}/repair-result-${prepared.repairKey}`)
  if (saved) {
    const result = await store.object<StageResult>(saved.ref)
    invariant(result.stagePlanDigest === prepared.plan.digest
      && result.snapshotDigest === prepared.snapshot.digest, 'repair result identity drift')
    const revisionPath = `rounds/${prepared.roundId}/repair-${prepared.original.digest.slice(7)}`
    invariant(await store.read(revisionPath), 'repair result lacks its published evidence revision')
    return result
  }
  options.repairProvider.beginLegacyInvocation()
  options.processProvider?.beginLegacyInvocation()
  await claimCampaignRepair(store, prepared)
  const refs = sealRepairInputs(runtime, prepared)
  const harness = runtime.artifacts.putJson({ commitOid: prepared.snapshot.commit,
    manifestDigest: prepared.snapshot.manifestDigest }, 'harness.directory.v1')
  const state = runtime.snapshot()
  invariant(state, 'repair Campaign disappeared')
  const bindingSetRef = runtime.bindings.derive(state.initialBindingSetRef, { harness })
  const evaluationKey = 'evaluation'
  const evaluationIntent: OperationIntent = { localKey: evaluationKey, kind: 'gepa.repair-evaluate',
    input: { roundIdentity: { evolutionId: prepared.admission.evolutionId, roundId: prepared.roundId },
      repairId: prepared.repairId, ...refs, plan: prepared.plan, snapshot: prepared.snapshot,
      universe: prepared.universe, missing: prepared.missing,
      deadlineAt: prepared.deadlineAt } as unknown as JsonValue,
    bindingSetRef, limits: { rolloutCells: prepared.missing.length, repairCells: prepared.missing.length } }
  const evalGroupId = `${prepared.groupId}-evaluation`
  const alreadyReserved = !!runtime.snapshot()?.auxiliaryOperations?.[evalGroupId]
  let physical: ReturnType<typeof physicalEvidence> | undefined
  let evaluationProof: { evaluationRef: ArtifactRef; evaluationOperationId: string } | undefined
  if (Date.now() >= prepared.deadlineAt && !alreadyReserved) {
    physical = { cells: [], failure: budgetFailure('time') }
  } else {
    let evaluation: Record<string, OperationOutcome>
    try { evaluation = await runRepairGroup({ runtime, store, prepared,
      groupId: evalGroupId, intents: [evaluationIntent], signal,
      repairProvider: options.repairProvider, processProvider: options.processProvider }) }
    catch (error) {
      if (!(error instanceof Error) || !/^Budget exceeded: (rolloutCells|repairCells)$/.test(error.message)) throw error
      physical = { cells: [], failure: budgetFailure(await exhaustedRepairResource(store, prepared)) }
      evaluation = {}
    }
    if (!physical) {
      const record = runtime.snapshot()?.auxiliaryOperations?.[evalGroupId]?.[evaluationKey]
      invariant(record?.status === 'completed', 'repair evaluation completion disappeared')
      evaluationProof = { evaluationRef: executionRef(evaluation[evaluationKey]),
        evaluationOperationId: record.envelope.operationId }
      physical = physicalEvidence(runtime, evaluation[evaluationKey])
    }
  }
  invariant(physical, 'repair has no physical evidence or terminal failure')
  const expected = new Map(prepared.missing.map(identity => [cellKey(identity), identity]))
  const seen = new Set<string>()
  for (const cell of physical.cells) {
    const key = cellKey(cell.identity), identity = expected.get(key)
    invariant(identity && !seen.has(key), 'repair returned unplanned or duplicate cell')
    seen.add(key); assertCell(cell, identity)
  }
  invariant(await verifyCells(options.validator.provider, physical.cells.map(cell =>
    ({ cell, identity: expected.get(cellKey(cell.identity))! }))), 'repair provenance rejected')
  let failure = physical.failure
  const processMode = ['held-out', 'global-seed', 'bridge'].includes(prepared.plan.stage)
    ? prepared.admission.settings.promotion.process.mode : prepared.admission.settings.search.process.mode
  const applicable = new Set(processTasks(prepared.universe, processMode))
  const source = completeEvidence(prepared.current, [...prepared.cached, ...physical.cells])
  const projections = source.cells.filter(cell => validOutcome(cell)
    && applicable.has(cell.identity.taskId) && cell.process?.status !== 'available')
  const projected: EvidenceCell[] = []
  if (options.validator.provider.completeProcess) {
    // The old repair loop stops at the first unresolved cell. Keep each original
    // projection key in its own auxiliary group so later physical cells do not start.
    for (const base of projections) {
      const processGroupId = `process-${digestJson([prepared.repairId, base.digest]).slice(7)}`
      if (Date.now() >= prepared.deadlineAt
        && !runtime.snapshot()?.auxiliaryOperations?.[processGroupId]) {
        failure ??= budgetFailure('time')
        break
      }
      const cellRef = runtime.artifacts.putJson(base as unknown as JsonValue, 'gepa.evidence-cell.v1')
      const intent: OperationIntent = { localKey: 'projection', kind: 'gepa.process-complete',
        input: { roundIdentity: { evolutionId: prepared.admission.evolutionId, roundId: prepared.roundId },
          repairId: prepared.repairId, currentRef: refs.currentRef, cachedRef: refs.cachedRef,
          ...(evaluationProof ?? {}), baseKey: prepared.externalKey,
          cellRef, deadlineAt: prepared.deadlineAt } as unknown as JsonValue,
        bindingSetRef, limits: {} }
      const outcomes = await runRepairGroup({ runtime, store, prepared,
        groupId: processGroupId, intents: [intent], signal,
        repairProvider: options.repairProvider, processProvider: options.processProvider })
      const result = physicalEvidence(runtime, outcomes.projection)
      invariant(result.cells.length <= 1, 'projection returned unexpected cells')
      for (const replacement of result.cells) {
        assertCell(replacement, base.identity)
        invariant(await verifyCells(options.validator.provider, [{ cell: replacement, identity: base.identity }]),
          'projection provenance rejected')
        completeEvidence(source, [replacement])
      }
      projected.push(...result.cells)
      failure ??= result.failure
    }
  }
  const complete = completeEvidence(prepared.current, [...prepared.cached, ...physical.cells, ...projected])
  const { digest: _ignored, ...body } = complete
  const result: StageResult = failure ? seal({ ...body, failure }) : complete
  profile(prepared.universe, prepared.plan, prepared.snapshot, result, 'auto')
  const valid = result.cells.filter(validOutcome)
  invariant(await verifyCells(options.validator.provider, valid.map(cell => ({ cell, identity: cell.identity }))),
    'repair provenance rejected')
  await store.put(result)
  for (const cell of valid) {
    await store.put(cell)
    await store.write(`cells/${cellKey(cell.identity).slice(7)}`, { ref: cell.digest })
  }
  await store.write(`rounds/${prepared.roundId}/repair-${prepared.original.digest.slice(7)}`,
    { ref: result.digest })
  const frozen = await store.freeze(prepared.roundId, `repair-result-${prepared.repairKey}`, () => result)
  invariant(frozen.digest === result.digest, 'repair result changed during publication')
  return frozen
}
