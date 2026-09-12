import { digestJson } from '../state/digest.js'
import { buildArchive, passesExploration, selectParents } from './archive.js'
import { invariant, integrity, processTasks, resolveSizing, scopeEquivalenceDigest, seal, sorted, validateSettings, validateSnapshot, verifyDigest, SearchProtocolError, digest } from './contracts.js'
import { clusters, deliveredWorkplan, validateReceipt } from './diagnosis.js'
import { assertCell, cellIdentity, cellKey, plannedCells, profile, validOutcome, completeEvidence } from './evidence.js'
import { assessGate, decideFinal, precheckSeed, rankProfiles } from './promotion.js'
import type { PromotionInput } from './promotion.js'
import { bridgeSelection, createScope, sharedTasks, stagePlan } from './scopes.js'
import { SearchBudgetExceeded, SearchStore, zeroUsage } from './store.js'
import type { Usage } from './store.js'
import type { EvidenceCompletion } from './completion.js'
import { collectFailure } from './regression.js'
import type { RegressionProposal } from './regression.js'
import { numeric, utility } from './contracts.js'
import { budgetFailure, recoverExternal, resolvePendingOperation, searchDeadline } from './recovery.js'
import type { BridgeSelectionDecision, CandidateWorkPlan, DiagnosisDossier, DiagnosisProvider, EvidenceCell, EvidenceConsumption, EvaluationExecutionResult, ExternalRecovery, EvaluationScope, GateDecision, ParentSelectionDecision, ResearchArchive, ResearchFinding, SearchProvider, SearchSettings, Snapshot, StageEvaluationPlan, StageResult, TaskUniverse, WorkplanReceipt, SearchStageFailure, PendingSearchOperation } from './types.js'

export interface GeneratedCandidate {
  snapshot?: Snapshot
  changedPaths: string[]
  receipt?: WorkplanReceipt
  sessionId?: string
  reason?: string
  usage: { tokens: number; requests: number }
  digest: string
}
export interface SearchExecutionHooks {
  /** Verifies the exact commit/tree/manifest against the harness repository. */
  verifySnapshot(snapshot: Snapshot): Promise<void>
  /** Idempotent across restart; must settle all siblings before returning any rollout evidence. */
  generate(input: { delivery: ReturnType<typeof deliveredWorkplan>; parent: Snapshot; baseline: StageResult; idempotencyKey: string; signal: AbortSignal }): Promise<GeneratedCandidate>
  /** Read-only recovery; never start/restart a Meta generation from this hook. */
  inspectGeneration?(idempotencyKey: string, signal: AbortSignal): Promise<ExternalRecovery<GeneratedCandidate>>
  /** CAS compares the full revision identity, not just commit content. */
  commitChampion(expectedRevisionDigest: string, next: Snapshot, roundId: string): Promise<void>
  progress?(phase: string): Promise<void>
}
export interface SearchAdmission {
  evolutionId: string
  roundId: string
  roundIndex: number
  maxCandidates: number
  anchor: Snapshot
  championRevisionDigest: string
  settings: SearchSettings
}
export interface SearchEvolutionIdentity {
  evolutionId: string
  settingsDigest: string
  maxCandidates: number
  seedUniverseDigest: string
  heldOutUniverseDigest: string
  providerIntegrity: string
  diagnosisIntegrity: string
  sanitizationPolicyDigest: string
  algorithmIntegrity: string
  digest: string
}
export class SearchEvidencePending extends Error {
  constructor(readonly planDigest: string) { super(`search stage needs evidence repair: ${planDigest}`); this.name = 'SearchEvidencePending' }
}
interface PreparedWork {
  workplan: CandidateWorkPlan; dossier: DiagnosisDossier; scope: EvaluationScope; plan: StageEvaluationPlan; parent: Snapshot; baseline: StageResult
}
export interface SearchRoundOutcome {
  schemaVersion: 2
  roundId: string
  archiveDigest: string
  championAnchorDigest: string
  nomineeId?: string
  promotion?: GateDecision
  championChanged: boolean
  advisory: boolean
  reasonCodes: string[]
  findings: ResearchFinding[]
  research: {
    sizing: ReturnType<typeof resolveSizing>
    parents: ParentSelectionDecision
    workplans: CandidateWorkPlan[]
    scopeViews: ResearchArchive['scopeViews']
    parentProbabilities: Record<string, number>
    bridge: BridgeSelectionDecision & { digest: string }
    candidates: Array<{ candidateId: string; scopeDigest: string; profile: ReturnType<typeof profile>; expansion: 'global-nominee' | 'not-selected-for-expansion' | 'requires-broader-evaluation' }>
    remainingBudget: Usage
  }
  digest: string
}
interface CommitIntent {
  expectedArchiveDigest: string
  nextArchiveDigest: string
  expectedChampionRevisionDigest: string
  nextChampion?: Snapshot
  outcome: SearchRoundOutcome
  digest: string
}

/** The new search is a separate versioned driver; no legacy gate/selector runs here. */
export class FailureClusterSearch {
  constructor(readonly store: SearchStore, readonly provider: SearchProvider, readonly diagnosis: DiagnosisProvider, readonly hooks: SearchExecutionHooks) {}

  private consumptionKey(planDigest: string, snapshotDigest: string): string {
    return `consumed-${digestJson([planDigest, snapshotDigest]).slice(7)}`
  }
  private async consume(roundId: string, result: StageResult, consumer: EvidenceConsumption['consumer'], consumerDigest: string): Promise<void> {
    await this.store.freeze(roundId, this.consumptionKey(result.stagePlanDigest, result.snapshotDigest), () => seal({
      stagePlanDigest: result.stagePlanDigest, snapshotDigest: result.snapshotDigest, resultDigest: result.digest, consumer, consumerDigest,
    }))
  }

  async validate(admission: SearchAdmission): Promise<{ seed: TaskUniverse; heldOut: TaskUniverse }> {
    digest(this.provider.integrity); digest(this.diagnosis.integrity); digest(this.diagnosis.sanitizationPolicyDigest)
    const c = this.provider.capabilities
    invariant(c.taskSubsetPlans && c.batchIndependentCells && c.idempotentExecution, 'failure-cluster-gepa-v1 requires provider-verified subset plans, batch-independent cell reuse and idempotent execution')
    const [seed, heldOut] = await Promise.all([this.provider.describe('seed'), this.provider.describe('held-out')])
    validateSettings(admission.settings, seed, heldOut, admission.maxCandidates)
    if (admission.settings.regression.suiteRef) {
      invariant(seed.regressionSuiteDigest === admission.settings.regression.suiteRef && await this.provider.verifyRegressionSuite?.(admission.settings.regression.suiteRef, seed), 'provider must verify the frozen regression suite was included at new admission')
    }
    validateSnapshot(admission.anchor); await this.hooks.verifySnapshot(admission.anchor)
    return { seed, heldOut }
  }
  private async evaluate(admission: SearchAdmission, startedAt: number, universe: TaskUniverse, plan: StageEvaluationPlan, snapshot: Snapshot, signal: AbortSignal, inspectionSignal: AbortSignal): Promise<StageResult> {
    inspectionSignal.throwIfAborted(); await this.hooks.verifySnapshot(snapshot); await this.store.put(plan); await this.store.put(snapshot)
    const binding = seal({ stagePlanDigest: plan.digest, participantId: snapshot.candidateId, sealedSnapshotDigest: snapshot.digest })
    await this.store.freeze(admission.roundId, `binding-${digestJson([plan.digest, snapshot.candidateId]).slice(7)}`, () => binding)
    const identities = plannedCells(universe, plan, snapshot)
    const cached: EvidenceCell[] = []
    let repairCells = 0
    for (const identity of identities) {
      const entry = await this.store.read<{ ref: string }>(`cells/${cellKey(identity).slice(7)}`)
      if (!entry) continue
      const cell = await this.store.object<EvidenceCell>(entry.ref)
      assertCell(cell, identity); invariant(await this.provider.verifyCell(cell, identity), 'provider cannot verify reusable cell provenance')
      if (validOutcome(cell)) cached.push(cell)
      else repairCells++
    }
    const missing = identities.filter(i => !cached.some(c => cellKey(c.identity) === cellKey(i)))
    const name = `evaluation-${digestJson([plan.digest, snapshot.digest]).slice(7)}`
    // Freeze the cache split before execution: a crash may occur between writing
    // individual cell pointers and sealing the stage result.
    const input = await this.store.freeze(admission.roundId, `${name}-input`, () => seal({ request: { plan, snapshot, cells: missing }, cached, repairCells }))
    const request = input.request
    const original = await this.store.freeze(admission.roundId, name, async () => {
      let output: EvaluationExecutionResult = { cells: [] }
      if (request.cells.length) {
        const key = digestJson([admission.evolutionId, admission.roundId, name])
        const previouslyReserved = !!await this.store.operation(admission.roundId, key)
        let operation
        try {
          operation = await this.store.reserve(admission.roundId, key, request, { ...zeroUsage(), cells: request.cells.length, repairCells: input.repairCells }, admission.settings.budgets, startedAt)
        } catch (error) {
          if (!(error instanceof SearchBudgetExceeded)) throw error
          return seal({ stagePlanDigest: plan.digest, snapshotDigest: snapshot.digest, cells: input.cached, settled: true, failure: budgetFailure(error.resource) })
        }
        if (operation.status === 'complete') output = await this.store.object<EvaluationExecutionResult & { digest: string }>(operation.outputDigest!)
        else {
          const recovered = await recoverExternal({ store: this.store, roundId: admission.roundId,
            operation: { operationKey: key, kind: 'evaluation', partition: plan.partition, stagePlanDigest: plan.digest, candidateId: snapshot.candidateId },
            signal, inspectionSignal, previouslyReserved,
            run: async () => ({ cells: await this.provider.evaluate({ ...request, idempotencyKey: key, signal }) }),
            ...(this.provider.inspectEvaluation ? { inspect: (signal: AbortSignal) => this.provider.inspectEvaluation!({ ...request, idempotencyKey: key, signal }) } : {}),
            failed: (failure, cells): EvaluationExecutionResult => ({ cells, failure }),
          })
          output = recovered.value
          const seen = new Set<string>()
          for (const cell of output.cells) {
            const identity = request.cells.find(i => cellKey(i) === cellKey(cell.identity))
            invariant(identity && !seen.has(cellKey(identity)), 'provider returned duplicate/unrequested cells')
            assertCell(cell, identity); invariant(await this.provider.verifyCell(cell, identity), 'provider rejected cell provenance')
            seen.add(cellKey(identity))
          }
          if (output.failure) invariant(output.failure.code.length > 0 && output.failure.message.length > 0
            && (output.failure.kind === 'budget-exhausted' || output.failure.kind === 'execution-failure' && !!output.failure.evidenceRef), 'failure lacks terminal execution provenance')
          await this.store.settle(operation, seal(output), recovered.notStarted ? zeroUsage() : operation.reserved)
        }
        await resolvePendingOperation(this.store, admission.roundId, key)
        for (const cell of output.cells) {
          await this.store.put(cell)
          await this.store.write(`cells/${cellKey(cell.identity).slice(7)}`, { ref: cell.digest })
        }
      }
      return seal({ stagePlanDigest: plan.digest, snapshotDigest: snapshot.digest, cells: [...input.cached, ...output.cells], settled: true,
        ...(output.failure ? { failure: output.failure } : {}) })
    })
    const repair = await this.store.read<{ ref: string }>(`rounds/${admission.roundId}/repair-${original.digest.slice(7)}`)
    return repair ? this.store.object<StageResult>(repair.ref) : original
  }

  /** Repairs an unconsumed stage revision under the same round/evolution budget. */
  async repairEvaluation(roundId: string, repairId: string, originalRef: string, signal: AbortSignal): Promise<StageResult> {
    invariant(!await this.store.read(`rounds/${roundId}/commit`), 'cannot repair after commit intent')
    const saved = await this.store.read<{ ref: string }>(`rounds/${roundId}/admission`); invariant(saved, 'unknown search round')
    const admission = await this.store.object<SearchAdmission & { seed: TaskUniverse; heldOut: TaskUniverse; startedAt: number; providerIntegrity: string; digest: string }>(saved.ref)
    invariant(admission.providerIntegrity === this.provider.integrity, 'repair provider identity changed')
    const currentUniverses = await this.validate(admission)
    invariant(currentUniverses.seed.digest === admission.seed.digest && currentUniverses.heldOut.digest === admission.heldOut.digest, 'repair task universe changed')
    const original = await this.store.object<StageResult>(originalRef), plan = await this.store.object<StageEvaluationPlan>(original.stagePlanDigest)
    const snapshot = await this.store.object<Snapshot>(original.snapshotDigest)
    await this.hooks.verifySnapshot(snapshot)
    const consumer = plan.stage === 'held-out' ? undefined : plan.stage === 'baseline-probe' ? 'planning' : plan.stage === 'local' ? 'local' : plan.stage === 'bridge' ? 'nomination' : 'research'
    invariant(!consumer || !await this.store.read(`rounds/${roundId}/${consumer}`), 'stage already consumed; append an archive evidence completion instead')
    const universe = plan.partition === 'seed' ? admission.seed : admission.heldOut
    invariant(!await this.store.read(`rounds/${roundId}/${this.consumptionKey(plan.digest, snapshot.digest)}`), 'stage already consumed; append an archive evidence completion instead')
    const input = await this.store.freeze(roundId, `repair-${repairId}-input`, async () => {
      const currentPointer = await this.store.read<{ ref: string }>(`rounds/${roundId}/repair-${original.digest.slice(7)}`)
      const current = currentPointer ? await this.store.object<StageResult>(currentPointer.ref) : original
      const missing = plannedCells(universe, plan, snapshot).filter(i => !current.cells.some(c => cellKey(c.identity) === cellKey(i) && validOutcome(c)))
      return seal({ originalRef, current, request: { plan, snapshot, cells: missing } })
    })
    invariant(input.originalRef === originalRef, 'repair ID reused for different evidence')
    return this.store.freeze(roundId, `repair-${repairId}`, async () => {
      const budgetStart = (await this.store.read<{ startedAt: number }>('budget'))?.startedAt ?? admission.startedAt
      const deadline = Math.min(admission.startedAt + admission.settings.budgets.round.timeoutMs, budgetStart + admission.settings.budgets.evolution.timeoutMs)
      const inspectionSignal = signal, timed = searchDeadline(signal, deadline)
      signal = timed.signal
      try {
      const { current, request } = input, missing = request.cells
      const key = digestJson([roundId, repairId, current.digest])
      const pending = await this.store.read<PendingSearchOperation | null>(`rounds/${roundId}/pending-operation`)
      invariant(!pending || [key, ...current.cells.map(c => digestJson([key, c.digest]))].includes(pending.operationKey), 'another external operation is unresolved; resume its original repair ID')
      const previouslyReserved = !!await this.store.operation(roundId, key)
      const reservation = await this.store.reserve(roundId, key, request, { ...zeroUsage(), cells: missing.length, repairCells: missing.length }, admission.settings.budgets, admission.startedAt)
      let output: EvaluationExecutionResult
      if (reservation.status === 'complete') output = await this.store.object<EvaluationExecutionResult & { digest: string }>(reservation.outputDigest!)
      else {
        const recovered = await recoverExternal({ store: this.store, roundId,
          operation: { operationKey: key, kind: 'evaluation', partition: plan.partition, stagePlanDigest: plan.digest, candidateId: snapshot.candidateId },
          signal, inspectionSignal, previouslyReserved,
          run: async () => ({ cells: missing.length ? await this.provider.evaluate({ ...request, idempotencyKey: key, signal }) : [] }),
          ...(this.provider.inspectEvaluation ? { inspect: (signal: AbortSignal) => this.provider.inspectEvaluation!({ ...request, idempotencyKey: key, signal }) } : {}),
          failed: (failure, cells): EvaluationExecutionResult => ({ cells, failure }),
        })
        output = recovered.value
        invariant(new Set(output.cells.map(c => cellKey(c.identity))).size === output.cells.length, 'duplicate repair cells')
        for (const cell of output.cells) {
          const expected = missing.find(i => cellKey(i) === cellKey(cell.identity)); invariant(expected, 'repair attempted to replace a valid cell')
          assertCell(cell, expected); invariant(await this.provider.verifyCell(cell, expected), 'repair provenance rejected')
        }
        await this.store.settle(reservation, seal(output), recovered.notStarted ? zeroUsage() : reservation.reserved)
      }
      await resolvePendingOperation(this.store, roundId, key)
      const cells = [...output.cells]
      let failure = output.failure
      for (const cell of current.cells.filter(c => validOutcome(c) && c.identity.processContractDigest && c.process?.status !== 'available')) {
        if (!this.provider.completeProcess) continue
        const projectionKey = digestJson([key, cell.digest])
        const previousProjection = !!await this.store.operation(roundId, projectionKey)
        let projection
        try { projection = await this.store.reserve(roundId, projectionKey, cell, zeroUsage(), admission.settings.budgets, admission.startedAt) }
        catch (error) { if (!(error instanceof SearchBudgetExceeded)) throw error; failure = budgetFailure(error.resource); break }
        let projected: EvaluationExecutionResult
        if (projection.status === 'complete') projected = await this.store.object<EvaluationExecutionResult & { digest: string }>(projection.outputDigest!)
        else {
          const recovered = await recoverExternal({ store: this.store, roundId,
            operation: { operationKey: projectionKey, kind: 'evaluation', partition: plan.partition, stagePlanDigest: plan.digest, candidateId: snapshot.candidateId },
            signal, inspectionSignal, previouslyReserved: previousProjection,
            run: async () => ({ cells: [await this.provider.completeProcess!(cell, projectionKey, signal)] }),
            ...(this.provider.inspectProcess ? { inspect: (signal: AbortSignal) => this.provider.inspectProcess!(cell, projectionKey, signal) } : {}),
            failed: (failure, cells): EvaluationExecutionResult => ({ cells, failure }),
          })
          projected = recovered.value
          invariant(projected.cells.length <= 1, 'projection returned unexpected cells')
          for (const replacement of projected.cells) {
            assertCell(replacement, cell.identity); invariant(await this.provider.verifyCell(replacement, cell.identity), 'projection provenance rejected')
            completeEvidence(current, [replacement])
          }
          await this.store.settle(projection, seal(projected))
        }
        await resolvePendingOperation(this.store, roundId, projectionKey)
        cells.push(...projected.cells); failure ??= projected.failure
      }
      const complete = completeEvidence(current, cells)
      const { digest: ignored, ...body } = complete
      const result = failure ? seal({ ...body, failure }) : complete
      profile(universe, plan, snapshot, result, 'auto'); await this.store.put(result)
      for (const cell of result.cells.filter(validOutcome)) { invariant(await this.provider.verifyCell(cell, cell.identity), 'repair provenance rejected'); await this.store.put(cell); await this.store.write(`cells/${cellKey(cell.identity).slice(7)}`, { ref: cell.digest }) }
      await this.store.write(`rounds/${roundId}/repair-${original.digest.slice(7)}`, { ref: result.digest })
      return result
      } finally { timed.dispose() }
    })
  }
  private async diagnose(admission: SearchAdmission, startedAt: number, universe: TaskUniverse, snapshot: Snapshot, taskIds: string[], baseline: StageResult, signal: AbortSignal, inspectionSignal: AbortSignal): Promise<DiagnosisDossier> {
    const name = `diagnosis-${digestJson([snapshot.digest, baseline.digest, taskIds]).slice(7)}`
    return this.store.freeze(admission.roundId, name, async () => {
      const request = await this.store.freeze(admission.roundId, `${name}-input`, async () => {
        const remaining = await this.store.remaining(admission.roundId, admission.settings.budgets)
        if (remaining.diagnosisInputTokens === 0) throw new SearchBudgetExceeded('diagnosisInputTokens')
        if (remaining.diagnosisOutputTokens === 0) throw new SearchBudgetExceeded('diagnosisOutputTokens')
        return seal({ snapshot, universe, taskIds, cells: baseline.cells, maxInputTokens: remaining.diagnosisInputTokens, maxOutputTokens: remaining.diagnosisOutputTokens })
      })
      const key = digestJson([admission.roundId, name])
      const previouslyReserved = !!await this.store.operation(admission.roundId, key)
      const operation = await this.store.reserve(admission.roundId, key, request, { ...zeroUsage(), diagnosisInputTokens: request.maxInputTokens, diagnosisOutputTokens: request.maxOutputTokens }, admission.settings.budgets, startedAt)
      let output: Awaited<ReturnType<DiagnosisProvider['diagnose']>> & { failure?: SearchStageFailure }
      if (operation.status === 'complete') output = await this.store.object<Awaited<ReturnType<DiagnosisProvider['diagnose']>> & { digest: string }>(operation.outputDigest!)
      else {
        const recovered = await recoverExternal({ store: this.store, roundId: admission.roundId,
          operation: { operationKey: key, kind: 'diagnosis', partition: 'seed', stagePlanDigest: baseline.stagePlanDigest, candidateId: snapshot.candidateId },
          signal, inspectionSignal, previouslyReserved,
          run: () => this.diagnosis.diagnose({ ...request, idempotencyKey: key, signal }),
          ...(this.diagnosis.inspectDiagnosis ? { inspect: (signal: AbortSignal) => this.diagnosis.inspectDiagnosis!(key, signal) } : {}),
          failed: (failure) => ({ facts: [], failure, inputTokens: operation.reserved.diagnosisInputTokens, outputTokens: operation.reserved.diagnosisOutputTokens }),
        })
        output = recovered.notStarted ? { ...recovered.value, inputTokens: 0, outputTokens: 0 } : recovered.value
        await this.store.settle(operation, seal(output), { ...zeroUsage(), diagnosisInputTokens: output.inputTokens, diagnosisOutputTokens: output.outputTokens })
      }
      await resolvePendingOperation(this.store, admission.roundId, key)
      for (const fact of output.facts) {
        const taskCells = baseline.cells.filter(c => c.identity.taskId === fact.taskId)
        const refs = new Set(taskCells.flatMap(c => [c.evidenceRef, ...(c.outcome.status === 'available' ? [c.outcome.evidenceRef] : []), ...(c.process?.status === 'available' ? [c.process.evidenceRef] : [])]))
        invariant(taskIds.includes(fact.taskId) && fact.evidenceRefs.every(ref => refs.has(ref)), 'diagnosis fact lacks parent seed provenance')
        if (fact.status === 'supported-hypothesis') invariant(baseline.cells.some(c => c.identity.taskId === fact.taskId && validOutcome(c)), 'invalid infrastructure evidence cannot create a failure cluster')
      }
      const facts = [...output.facts]
      for (const taskId of taskIds) if (!facts.some(f => f.taskId === taskId)) {
        const task = universe.tasks.find(t => t.id === taskId)!, cells = baseline.cells.filter(c => c.identity.taskId === taskId)
        const complete = cells.length === universe.repetitions.length && cells.every(validOutcome)
        const successful = complete && cells.every(c => c.outcome.status === 'available' && numeric(utility(c.outcome.rawValue, task.outcome)) >= task.successUtility)
        facts.push({ taskId, evidenceRefs: sorted(cells.map(c => c.evidenceRef)), status: !complete ? 'infrastructure-invalid' : successful ? 'successful-control' : 'unresolved' })
      }
      const dossier = seal({ parentSnapshotDigest: snapshot.digest, universeDigest: universe.digest, taskIds,
        baselineEvidenceDigests: [baseline.digest], facts, ...(output.failure ? { failure: output.failure } : {}), classifierIntegrity: this.diagnosis.integrity, sanitizationPolicyDigest: this.diagnosis.sanitizationPolicyDigest })
      await this.store.put(dossier)
      await this.consume(admission.roundId, baseline, 'diagnosis', dossier.digest)
      return dossier
    })
  }
  private fullPlan(admission: SearchAdmission, universe: TaskUniverse, stage: StageEvaluationPlan['stage'], ids: string[], sizingDigest: string): StageEvaluationPlan {
    return stagePlan({ stage, partition: universe.partition, universeDigest: universe.digest, taskSetSizeResolutionDigest: sizingDigest,
      scopeDigest: digestJson([universe.digest, stage]), taskIds: universe.tasks.map(t => t.id), participantIds: ids, prerequisiteDecisionDigests: [], selectionRuleDigest: integrity })
  }
  async run(request: SearchAdmission, signal: AbortSignal): Promise<SearchRoundOutcome> {
    const saved = await this.store.read<{ ref: string }>(`rounds/${request.roundId}/admission`)
    if (saved) {
      const admission = await this.store.object<SearchAdmission & { digest: string }>(saved.ref)
      const { evolutionId, roundId, roundIndex, maxCandidates, anchor, championRevisionDigest, settings } = admission
      invariant(digestJson({ evolutionId, roundId, roundIndex, maxCandidates, anchor, championRevisionDigest, settings }) === digestJson(request), 'search round request changed on resume')
    }
    const terminal = await this.store.read<{ ref: string }>(`rounds/${request.roundId}/terminal`)
    if (terminal) return this.store.object<SearchRoundOutcome>(terminal.ref)
    const existingIntent = await this.store.read<{ ref: string }>(`rounds/${request.roundId}/commit`)
    if (existingIntent) return this.reconcile(request.roundId, await this.store.object<CommitIntent>(existingIntent.ref))
    const current = await this.validate(request)
    const identity: SearchEvolutionIdentity = seal({ evolutionId: request.evolutionId, settingsDigest: digestJson(request.settings), maxCandidates: request.maxCandidates,
      seedUniverseDigest: current.seed.digest, heldOutUniverseDigest: current.heldOut.digest, providerIntegrity: this.provider.integrity,
      diagnosisIntegrity: this.diagnosis.integrity, sanitizationPolicyDigest: this.diagnosis.sanitizationPolicyDigest, algorithmIntegrity: integrity })
    const frozenIdentity = await this.store.freezeEvolution('identity', () => identity)
    invariant(identity.digest === frozenIdentity.digest, 'search evolution identity changed; start a new evolution')
    const advancing = await this.store.read<{ roundId: string | null }>('active-round')
    invariant(!advancing?.roundId || advancing.roundId === request.roundId
      || await this.store.read(`rounds/${advancing.roundId}/terminal`), 'search has an unresolved round; recover it before starting another round')
    await this.store.write('active-round', { roundId: request.roundId })
    const admission = await this.store.freeze(request.roundId, 'admission', () => seal({ ...request, ...current, providerIntegrity: this.provider.integrity, diagnosisIntegrity: this.diagnosis.integrity, algorithmIntegrity: integrity, startedAt: Date.now() }))
    invariant(admission.seed.digest === current.seed.digest && admission.heldOut.digest === current.heldOut.digest && admission.providerIntegrity === this.provider.integrity && admission.diagnosisIntegrity === this.diagnosis.integrity
      && admission.algorithmIntegrity === integrity && digestJson(admission.settings) === digestJson(request.settings) && admission.anchor.digest === request.anchor.digest
      && admission.maxCandidates === request.maxCandidates && admission.championRevisionDigest === request.championRevisionDigest, 'provider/task/settings identity changed on resume')
    const { seed, heldOut, startedAt, settings, anchor } = admission
    const budgetStart = (await this.store.read<{ startedAt: number }>('budget'))?.startedAt ?? startedAt
    const deadline = Math.min(startedAt + settings.budgets.round.timeoutMs, budgetStart + settings.budgets.evolution.timeoutMs)
    const inspectionSignal = signal, timed = searchDeadline(signal, deadline)
    signal = timed.signal
    try {
    const resolution = resolveSizing(seed, settings.search.taskSetSizing)
    const evaluate = (u: TaskUniverse, p: StageEvaluationPlan, s: Snapshot) => this.evaluate(admission, startedAt, u, p, s, signal, inspectionSignal)
    await this.hooks.progress?.('bootstrap')
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
      invariant(passesExploration(bootstrapScope, p, seed), 'bootstrap baseline is incomplete or fails exploration guards')
      archive = buildArchive({ evolutionId: admission.evolutionId, universe: seed, snapshots: [anchor], scopes: [bootstrapScope], results: [result], plans: [baselinePlan], config: settings.search, championId: anchor.candidateId })
      await this.store.put(archive)
      await this.consume(admission.roundId, result, 'bootstrap-archive', archive.digest)
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
    const parents = await this.store.freeze(request.roundId, 'parents', () => selectParents(archive!, settings.search, admission.maxCandidates, admission.roundId))
    await this.hooks.progress?.('diagnosis-planning')
    const planning = await this.store.freeze(request.roundId, 'planning', async () => {
      const works: PreparedWork[] = [], cancelled: string[] = [], scopes = [...archive!.scopes]
      const baselineResults: StageResult[] = [], baselinePlans: StageEvaluationPlan[] = []
      let shared: string[] | undefined = scopes.find(s => s.familyId !== 'bootstrap')?.buckets.shared
      const usedHypotheses = new Set<string>()
      for (const batch of parents.batches) {
        const parent = archive!.snapshots.find(s => s.digest === batch.parentSnapshotDigest)!
        const parentScope = archive!.scopes.find(s => s.digest === batch.sourceScopeDigest)!
        const probe = stagePlan({ stage: 'baseline-probe', partition: 'seed', universeDigest: seed.digest, taskSetSizeResolutionDigest: resolution.digest,
          scopeDigest: parentScope.digest, taskIds: parentScope.taskIds, participantIds: [parent.candidateId], prerequisiteDecisionDigests: [parents.digest], selectionRuleDigest: integrity })
        const baseline = await evaluate(seed, probe, parent)
        const p = profile(seed, probe, parent, baseline, settings.search.process.mode, parentScope.weights)
        if (!p.outcomeComplete) { cancelled.push('parent-baseline-incomplete'); continue }
        let dossier: DiagnosisDossier
        try { dossier = await this.diagnose(admission, startedAt, seed, parent, probe.taskIds, baseline, signal, inspectionSignal) }
        catch (error) {
          if (!(error instanceof SearchBudgetExceeded)) throw error
          cancelled.push(error.message); continue
        }
        await this.store.put(dossier)
        if (dossier.failure) { cancelled.push(`${dossier.failure.kind}:${dossier.failure.code}`); continue }
        shared ??= sharedTasks(seed, resolution, settings.search, p.tasks.filter(t => t.outcome !== undefined && t.outcome >= seed.tasks.find(s => s.id === t.taskId)!.successUtility).map(t => t.taskId))
        const families = clusters(dossier, seed, settings.promotion.protectedTasks.filter(g => g.partition === 'seed').map(g => g.taskId))
        if (!families.length) cancelled.push('no-actionable-cluster')
        let allocated = 0
        for (const cluster of families) {
          if (allocated >= batch.maxCandidateSlots) break
          const scope = scopes.filter(s => s.familyId === cluster.familyId).sort((a, b) => b.epoch - a.epoch)[0] ?? createScope(seed, resolution, settings.search, cluster, shared)
          if (!scope) { cancelled.push(`no-representative:${cluster.familyId}`); continue }
          await this.store.put(cluster)
          for (const hypothesis of cluster.hypotheses.slice(0, settings.search.diagnosis.candidatesPerFamily)) {
            if (allocated >= batch.maxCandidateSlots) break
            const hypothesisKey = digestJson([parent.digest, cluster.familyId, hypothesis])
            if (usedHypotheses.has(hypothesisKey)) continue
            const remaining = await this.store.remaining(admission.roundId, settings.budgets)
            const candidateCost = scope.taskIds.length * seed.repetitions.length
            if (remaining.cells < candidateCost + works.reduce((sum, w) => sum + w.scope.taskIds.length * seed.repetitions.length, 0) || remaining.generationTokens <= 0 || remaining.generationRequests <= 0) { cancelled.push('budget-exhausted'); continue }
            const candidateId = `${admission.roundId}-candidate-${works.length}`
            const localPlan = stagePlan({ stage: 'local', partition: 'seed', universeDigest: seed.digest, taskSetSizeResolutionDigest: resolution.digest,
              scopeDigest: scope.digest, taskIds: scope.taskIds, participantIds: [candidateId, parent.candidateId], prerequisiteDecisionDigests: [parents.digest], selectionRuleDigest: integrity })
            const localBaseline = await evaluate(seed, localPlan, parent)
            const parentProfile = profile(seed, localPlan, parent, localBaseline, settings.search.process.mode, scope.weights)
            if (!passesExploration(scope, parentProfile, seed) || !cluster.taskIds.some(id => parentProfile.tasks.some(t => t.taskId === id && t.outcome! < seed.tasks.find(t => t.id === id)!.successUtility))) { cancelled.push(`hypothesis-unconfirmed:${cluster.familyId}`); continue }
            const slots = Math.max(1, admission.maxCandidates - works.length)
            const availableTokens = remaining.generationTokens - works.reduce((sum, w) => sum + w.workplan.generationBudget.maxTokens, 0)
            const availableRequests = remaining.generationRequests - works.reduce((sum, w) => sum + w.workplan.generationBudget.maxModelRequests, 0)
            if (availableTokens < slots || availableRequests < slots) { cancelled.push('generation-budget-exhausted'); continue }
            const workplan: CandidateWorkPlan = seal({ candidateId, batchId: batch.batchId, parentSnapshotDigest: parent.digest, dossierDigest: dossier.digest,
              clusterDigest: cluster.digest, familyId: cluster.familyId, hypothesis, targetTaskIds: cluster.taskIds, requiredDiagnosisRefs: cluster.evidenceRefs,
              modificationPaths: cluster.modificationPaths, scopeDigest: scope.digest, localStagePlanDigest: localPlan.digest,
              generationBudget: { maxTokens: Math.floor(availableTokens / slots), maxModelRequests: Math.floor(availableRequests / slots), deadlineAt: startedAt + settings.budgets.round.timeoutMs } })
            works.push({ workplan, dossier, scope, plan: localPlan, parent, baseline: localBaseline }); allocated++; usedHypotheses.add(hypothesisKey)
            if (!scopes.some(s => s.digest === scope.digest)) scopes.push(scope)
            baselineResults.push(localBaseline); baselinePlans.push(localPlan)
          }
        }
      }
      const planned = seal({ works, cancelled, scopes, baselineResults, baselinePlans })
      await this.store.put(planned)
      for (const work of works) await this.consume(admission.roundId, work.baseline, 'workplans', planned.digest)
      return planned
    })
    await this.hooks.progress?.('generation')
    const generated: Array<{ work: PreparedWork; value: GeneratedCandidate }> = []
    for (const work of planning.works) {
      const value = await this.store.freeze(request.roundId, `generated-${work.workplan.candidateId}`, async () => {
        const handoff = await this.store.read<{ refs: string[] }>(`findings/${work.parent.digest.slice(7)}`)
        const findings = await Promise.all(sorted([...work.parent.findingRefs, ...(handoff?.refs ?? [])]).map(ref => this.store.object<ResearchFinding>(ref)))
        const delivery = deliveredWorkplan(work.workplan, work.dossier, findings, work.scope)
        const key = digestJson([admission.roundId, work.workplan.digest, 'generation'])
        const previouslyReserved = !!await this.store.operation(admission.roundId, key)
        let reservation
        try { reservation = await this.store.reserve(admission.roundId, key, delivery, { ...zeroUsage(), generationTokens: work.workplan.generationBudget.maxTokens, generationRequests: work.workplan.generationBudget.maxModelRequests }, settings.budgets, startedAt) }
        catch (error) {
          if (!(error instanceof SearchBudgetExceeded)) throw error
          return seal({ changedPaths: [], reason: error.message, usage: { tokens: 0, requests: 0 } })
        }
        if (reservation.status === 'complete') {
          await resolvePendingOperation(this.store, admission.roundId, key)
          return this.store.object<GeneratedCandidate>(reservation.outputDigest!)
        }
        const recovered = await recoverExternal({ store: this.store, roundId: admission.roundId,
          operation: { operationKey: key, kind: 'generation', partition: 'seed', stagePlanDigest: work.plan.digest, candidateId: work.workplan.candidateId },
          signal, inspectionSignal, previouslyReserved,
          run: () => this.hooks.generate({ delivery, parent: work.parent, baseline: work.baseline, idempotencyKey: key, signal }),
          ...(this.hooks.inspectGeneration ? { inspect: (signal: AbortSignal) => this.hooks.inspectGeneration!(key, signal) } : {}),
          failed: (failure) => seal({ changedPaths: [], reason: failure.message, usage: { tokens: reservation.reserved.generationTokens, requests: reservation.reserved.generationRequests } }),
        })
        const value: GeneratedCandidate = recovered.notStarted ? seal({ changedPaths: [], reason: budgetFailure('time').message, usage: { tokens: 0, requests: 0 } }) : recovered.value
        verifyDigest(value)
        if (value.snapshot) {
          validateSnapshot(value.snapshot); await this.hooks.verifySnapshot(value.snapshot)
          invariant(value.snapshot.candidateId === work.workplan.candidateId && value.snapshot.parentIds.length === 1 && value.snapshot.parentIds[0] === work.parent.candidateId, 'generated snapshot has wrong code parent')
          invariant(value.receipt && value.sessionId, 'candidate must consume assigned dossier before sealing')
          validateReceipt(value.receipt, delivery, value.sessionId)
        }
        await this.store.settle(reservation, value, { ...zeroUsage(), generationTokens: value.usage.tokens, generationRequests: value.usage.requests })
        await resolvePendingOperation(this.store, admission.roundId, key)
        return value
      })
      generated.push({ work, value })
    }
    await this.hooks.progress?.('local')
    const local = await this.store.freeze(request.roundId, 'local', async () => {
      const entries: Array<{ work: PreparedWork; snapshot: Snapshot; result: StageResult; outsideBoundary: boolean }> = []
      const reasons: string[] = []
      for (const { work, value } of generated) {
        if (!value.snapshot) { reasons.push(value.reason ?? 'generation-failed'); continue }
        {
          const result = await evaluate(seed, work.plan, value.snapshot)
          if (result.failure) reasons.push(`${result.failure.kind}:${result.failure.code}`)
          const outsideBoundary = value.changedPaths.some(path => !work.workplan.modificationPaths.some(root => path === root || path.startsWith(`${root}/`)))
          if (outsideBoundary) reasons.push(`requires-broader-evaluation:${value.snapshot.candidateId}`)
          entries.push({ work, snapshot: value.snapshot, result, outsideBoundary })
        }
      }
      const decision = seal({ entries, reasons })
      await this.store.put(decision)
      for (const entry of entries) await this.consume(admission.roundId, entry.result, 'local-decision', decision.digest)
      return decision
    })
    const nominees = new Map<string, typeof local.entries[number]>()
    for (const scope of planning.scopes) {
      const eligible = local.entries.filter(e => e.work.scope.digest === scope.digest && !e.outsideBoundary)
      const ranks = rankProfiles(seed, eligible.map(e => ({ id: e.snapshot.candidateId, profile: profile(seed, e.work.plan, e.snapshot, e.result, settings.promotion.process.mode, scope.weights) })))
      if (ranks.length) nominees.set(scope.digest, eligible.find(e => e.snapshot.candidateId === ranks[0])!)
    }
    const expansion = await this.store.freeze(request.roundId, 'expansion', async () => {
      const remaining = await this.store.remaining(admission.roundId, settings.budgets)
      const cachedCosts = new Map<string, { cells: number; repairCells: number }>()
      const bridge = await bridgeSelection(seed, resolution, settings.search, admission.roundIndex, [...nominees.values()].map(e => ({ candidateId: e.snapshot.candidateId, scope: e.work.scope })), anchor.candidateId,
        sorted([...settings.promotion.protectedTasks, ...settings.promotion.protectedAssertions].filter(g => g.partition === 'seed').map(g => g.taskId)),
        async (ids, tasks) => {
          let cells = 0, repairCells = 0
          for (const id of ids) {
            const snapshot = id === anchor.candidateId ? anchor : local.entries.find(e => e.snapshot.candidateId === id)!.snapshot
            for (const taskId of tasks) for (const slot of seed.repetitions) {
              const identity = cellIdentity(seed, taskId, slot.index, snapshot), key = cellKey(identity)
              let cost = cachedCosts.get(key)
              if (!cost) {
                const pointer = await this.store.read<{ ref: string }>(`cells/${key.slice(7)}`)
                const cell = pointer ? await this.store.object<EvidenceCell>(pointer.ref) : undefined
                if (cell) {
                  assertCell(cell, identity)
                  invariant(await this.provider.verifyCell(cell, identity), 'provider cannot verify bridge cell provenance')
                }
                cost = { cells: cell && validOutcome(cell) ? 0 : 1, repairCells: cell && !validOutcome(cell) ? 1 : 0 }
                cachedCosts.set(key, cost)
              }
              cells += cost.cells; repairCells += cost.repairCells
            }
          }
          return cells <= remaining.cells && repairCells <= remaining.repairCells
        })
      return seal(bridge)
    })
    const stages: StageEvaluationPlan[] = [], results: StageResult[] = [], reasons = [...planning.cancelled, ...local.reasons]
    let nominee: Snapshot | undefined, seedInput: PromotionInput | undefined, gate: GateDecision | undefined
    if (expansion.plan) {
      await this.hooks.progress?.('bridge')
      {
        const bp = expansion.plan, br = await evaluate(seed, bp, anchor)
        stages.push(bp); results.push(br)
        const rankings: Array<{ id: string; profile: ReturnType<typeof profile> }> = []
        let incomplete = false
        for (const id of bp.participantIds.filter(id => id !== anchor.candidateId)) {
          const s = local.entries.find(e => e.snapshot.candidateId === id)!.snapshot, result = await evaluate(seed, bp, s)
          results.push(result)
          const g = assessGate({ universe: seed, plan: bp, anchor, candidate: s, baseline: br, result }, settings.promotion, false)
          if (g.outcome === 'eligible') rankings.push({ id, profile: profile(seed, bp, s, result, settings.promotion.process.mode) })
          else if (g.outcome === 'insufficient-evidence') incomplete = true
          if (result.failure) reasons.push(`${result.failure.kind}:${result.failure.code}`)
        }
        if (incomplete) reasons.push('incomplete-bridge-evidence')
        if (br.failure) reasons.push(`${br.failure.kind}:${br.failure.code}`)
        const nomination = await this.store.freeze(request.roundId, 'nomination', async () => {
          const decision = seal({ candidateId: incomplete ? null : rankProfiles(seed, rankings)[0] ?? null, bridgeDigest: bp.digest })
          await this.store.put(decision)
          for (const result of results.filter(r => r.stagePlanDigest === bp.digest)) await this.consume(admission.roundId, result, 'nomination', decision.digest)
          return decision
        })
        if (nomination.candidateId) {
          nominee = local.entries.find(e => e.snapshot.candidateId === nomination.candidateId)!.snapshot
          const gp = this.fullPlan(admission, seed, 'global-seed', [anchor.candidateId, nominee.candidateId], resolution.digest)
          await this.hooks.progress?.('global-seed')
          const baseline = await evaluate(seed, gp, anchor), result = await evaluate(seed, gp, nominee)
          stages.push(gp); results.push(baseline, result)
          seedInput = { universe: seed, plan: gp, anchor, candidate: nominee, baseline, result }
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
        improvements: candidate.tasks.filter(t => t.outcome !== undefined && t.outcome > (parent.tasks.find(p => p.taskId === t.taskId)?.outcome ?? Infinity)).map(t => t.taskId),
        regressions: candidate.tasks.filter(t => t.outcome !== undefined && t.outcome < (parent.tasks.find(p => p.taskId === t.taskId)?.outcome ?? -Infinity)).map(t => t.taskId),
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
        if (result.proposal) proposals.push(result.proposal)
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
      const evidence = [...completions, ...planning.baselineResults, ...local.entries.map(e => e.result), ...results]
      const update = buildArchive({ evolutionId: admission.evolutionId, previous: archive!, universe: seed,
        snapshots: [anchor, ...local.entries.map(e => e.snapshot)], scopes: planning.scopes,
        results: evidence, plans: [...planning.baselinePlans, ...local.entries.map(e => e.work.plan), ...stages], config: settings.search, championId: anchor.candidateId })
      await this.store.put(update)
      for (const result of evidence) await this.consume(admission.roundId, result, 'research-archive', update.digest)
      return update
    })
    // The complete seed archive is frozen before any held-out outcome is requested.
    if (nominee && seedInput && gate?.outcome === 'eligible') {
      await this.hooks.progress?.('held-out')
      {
        const hp = this.fullPlan(admission, heldOut, 'held-out', [anchor.candidateId, nominee.candidateId], resolution.digest)
        const baseline = await evaluate(heldOut, hp, anchor), result = await evaluate(heldOut, hp, nominee)
        gate = decideFinal(seedInput, { universe: heldOut, plan: hp, anchor, candidate: nominee, baseline, result }, settings.promotion)
        for (const r of [baseline, result]) if (r.failure) reasons.push(`${r.failure.kind}:${r.failure.code}`)
        if (gate.outcome === 'insufficient-evidence' && !baseline.failure && !result.failure) {
          await this.store.write(`rounds/${request.roundId}/pending-evidence`, { planDigest: hp.digest, resultRefs: [baseline.digest, result.digest] })
          throw new SearchEvidencePending(hp.digest)
        }
      }
    }
    const championChanged = gate?.outcome === 'accepted' && settings.promotion.validationMode === 'independent-held-out'
    const outcome: SearchRoundOutcome = seal({ schemaVersion: 2 as const, roundId: request.roundId, archiveDigest: research.digest, championAnchorDigest: anchor.digest,
      ...(nominee ? { nomineeId: nominee.candidateId } : {}), ...(gate ? { promotion: gate } : {}), championChanged,
      advisory: settings.promotion.validationMode === 'shared-set-research', reasonCodes: reasons, findings,
      research: { sizing: resolution, parents, workplans: planning.works.map(w => w.workplan), scopeViews: research.scopeViews, parentProbabilities: research.parentProbabilities, bridge: expansion,
        candidates: local.entries.map(e => ({ candidateId: e.snapshot.candidateId, scopeDigest: e.work.scope.digest,
          profile: profile(seed, e.work.plan, e.snapshot, e.result, settings.search.process.mode, e.work.scope.weights),
          expansion: e.outsideBoundary ? 'requires-broader-evaluation' as const : nominee?.digest === e.snapshot.digest ? 'global-nominee' as const : 'not-selected-for-expansion' as const })),
        remainingBudget: await this.store.remaining(request.roundId, settings.budgets) } })
    inspectionSignal.throwIfAborted()
    const intent = await this.store.freeze(request.roundId, 'commit', () => seal({ expectedArchiveDigest: archive!.digest, nextArchiveDigest: research.digest,
      expectedChampionRevisionDigest: admission.championRevisionDigest, ...(championChanged && nominee ? { nextChampion: nominee } : {}), outcome }))
    return await this.reconcile(request.roundId, intent)
    } finally { timed.dispose() }
  }
  private async reconcile(roundId: string, intent: CommitIntent): Promise<SearchRoundOutcome> {
    verifyDigest(intent)
    const next = await this.store.object<ResearchArchive>(intent.nextArchiveDigest)
    await this.store.casArchive(intent.expectedArchiveDigest, next)
    if (intent.nextChampion) await this.hooks.commitChampion(intent.expectedChampionRevisionDigest, intent.nextChampion, roundId)
    await this.store.put(intent.outcome); await this.store.write(`rounds/${roundId}/terminal`, { ref: intent.outcome.digest })
    const advancing = await this.store.read<{ roundId: string | null }>('active-round')
    if (advancing?.roundId === roundId) await this.store.write('active-round', { roundId: null })
    return intent.outcome
  }
}
