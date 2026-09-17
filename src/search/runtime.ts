import { ComponentRegistry } from '../evolution/components.js'
import { digestJson } from '../state/digest.js'
import { digest, integrity, invariant, numeric, plannedCellCount, processTasks, repetitionsForTask, safeId, seal, sorted, utility, validateSettings, validateSnapshot, verifyDigest } from './contracts.js'
import { deliveredWorkplan, validateReceipt } from './diagnosis.js'
import { assertCell, cellIdentity, cellKey, completeEvidence, plannedCells, profile, reusableCells, validOutcome } from './evidence.js'
import { resolveParentPolicyRef } from './policies/parents.js'
import { budgetFailure, recoverExternal, resolvePendingOperation, searchDeadline } from './recovery.js'
import { resolveRegressionSettings } from './regression.js'
import { validateSearchSchema } from './schema.js'
import { SearchBudgetExceeded, zeroUsage, type SearchJournal } from './store.js'
import type { CandidateWorkPlan, DiagnosisDossier, DiagnosisProvider, EvaluationExecutionResult, EvaluationScope, EvaluationStageDecision, EvidenceCell, EvidenceConsumption, ExternalRecovery, PendingSearchOperation, ResearchArchive, ResearchFinding, SearchProgress, SearchProvider, SearchSettings, SearchStageFailure, Snapshot, StageEvaluationPlan, StageResult, TaskUniverse, WorkplanReceipt } from './types.js'

import type { CommitIntent, SearchRoundOutcome } from './engine.js'

export interface GeneratedCandidate {
  snapshot?: Snapshot
  changedPaths: string[]
  receipt?: WorkplanReceipt
  sessionId?: string
  reason?: string
  /** Missing fields mean unmeasured. A configured hard limit always requires an accounted value. */
  usage: { tokens?: number; requests?: number }
  digest: string
}
export interface SearchExecutionHooks {
  /** Verifies the exact commit/tree/manifest against the harness repository. */
  verifySnapshot(snapshot: Snapshot): Promise<void>
  /** Idempotent across restart; must settle all siblings before returning any rollout evidence. */
  generate(input: { delivery: ReturnType<typeof deliveredWorkplan>; parent: Snapshot; baseline: StageResult;
    baselineContext: { universe: TaskUniverse; plan: StageEvaluationPlan; scope: EvaluationScope; processMode: SearchSettings['search']['process']['mode'] };
    idempotencyKey: string; signal: AbortSignal }): Promise<GeneratedCandidate>
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
export interface PreparedWork {
  workplan: CandidateWorkPlan; dossier: DiagnosisDossier; scope: EvaluationScope; plan: StageEvaluationPlan; parent: Snapshot; baseline: StageResult
}
/** Executes validated operations; algorithm policies never receive this runtime or its store. */
export class SearchExecutionRuntime {
  constructor(readonly store: SearchJournal, readonly provider: SearchProvider, readonly diagnosis: DiagnosisProvider, readonly hooks: SearchExecutionHooks, readonly components: ComponentRegistry) {}

  async progress(roundId: string, phase: SearchProgress['phase'] | 'held-out'): Promise<void> {
    if (phase !== 'held-out') {
      const previous = await this.store.read<SearchProgress>(`rounds/${roundId}/progress`)
      await this.store.write(`rounds/${roundId}/progress`, { evaluations: [], decisions: [], ...previous, phase })
    }
    await this.hooks.progress?.(phase)
  }
  async evaluationProgress(roundId: string, universe: TaskUniverse, plan: StageEvaluationPlan, snapshot: Snapshot, mode: SearchSettings['search']['process']['mode'], result?: StageResult): Promise<void> {
    if (plan.stage === 'held-out') return
    const progress = await this.store.read<SearchProgress>(`rounds/${roundId}/progress`) ?? { phase: 'bootstrap' as const, evaluations: [], decisions: [] }
    const previous = progress.evaluations.find(e => e.stagePlanDigest === plan.digest && e.candidateId === snapshot.candidateId)
    if (!result && previous?.state === 'settled') return
    const p = result ? profile(universe, plan, snapshot, result, mode) : undefined
    const coverage = p ? { coverage: p.coverage, processCoverage: p.processCoverage, outcomeComplete: p.outcomeComplete,
      processComplete: p.processComplete, processTaskIds: p.processTaskIds, tasks: p.tasks, supportDigest: p.supportDigest } : undefined
    const next: SearchProgress['evaluations'][number] = { stage: plan.stage, stagePlanDigest: plan.digest, scopeDigest: plan.scopeDigest, candidateId: snapshot.candidateId,
      state: result ? 'settled' : 'running', plannedCells: plannedCellCount(universe, plan.taskIds),
      ...(coverage ? { profile: coverage } : {}), ...(result?.failure ? { failure: result.failure } : {}) }
    progress.evaluations = [...progress.evaluations.filter(e => e !== previous), next]
    await this.store.write(`rounds/${roundId}/progress`, progress)
  }
  async decisionProgress(roundId: string, decisions: EvaluationStageDecision[]): Promise<void> {
    const progress = await this.store.read<SearchProgress>(`rounds/${roundId}/progress`)
    invariant(progress, 'stage progress is unavailable')
    for (const decision of decisions) { verifyDigest(decision); await this.store.put(decision) }
    const byKey = new Map([...progress.decisions, ...decisions].map(d => [`${d.stagePlanDigest}/${d.candidateId}`, d]))
    progress.decisions = [...byKey.values()]
    await this.store.write(`rounds/${roundId}/progress`, progress)
  }

  private consumptionKey(planDigest: string, snapshotDigest: string): string {
    return `consumed-${digestJson([planDigest, snapshotDigest]).slice(7)}`
  }
  async consume(roundId: string, result: StageResult, consumer: EvidenceConsumption['consumer'], consumerDigest: string): Promise<void> {
    await this.store.freeze(roundId, this.consumptionKey(result.stagePlanDigest, result.snapshotDigest), () => seal({
      stagePlanDigest: result.stagePlanDigest, snapshotDigest: result.snapshotDigest, resultDigest: result.digest, consumer, consumerDigest,
    }))
  }

  async validate(admission: SearchAdmission): Promise<{ seed: TaskUniverse; heldOut: TaskUniverse; resolvedSettings: SearchSettings }> {
    invariant(Number.isSafeInteger(admission.roundIndex) && admission.roundIndex >= 0, 'invalid search round index')
    digest(this.provider.integrity); digest(this.diagnosis.integrity); digest(this.diagnosis.sanitizationPolicyDigest)
    const c = this.provider.capabilities
    invariant(c.taskSubsetPlans && c.batchIndependentCells && c.idempotentExecution, 'failure-cluster-gepa-v1 requires provider-verified subset plans, batch-independent cell reuse and idempotent execution')
    const [seed, heldOut] = await Promise.all([this.provider.describe('seed'), this.provider.describe('held-out')])
    const resolvedSettings = resolveRegressionSettings(admission.settings, seed, heldOut)
    validateSettings(resolvedSettings, seed, heldOut, admission.maxCandidates)
    this.components.parentSelectionPolicy(resolveParentPolicyRef(resolvedSettings.search))
    if (admission.settings.regression.suiteRef) {
      invariant(seed.regressionSuiteDigest === admission.settings.regression.suiteRef && await this.provider.verifyRegressionSuite?.(admission.settings.regression.suiteRef, seed), 'provider must verify the frozen regression suite was included at new admission')
    }
    validateSnapshot(admission.anchor); await this.hooks.verifySnapshot(admission.anchor)
    return { seed, heldOut, resolvedSettings }
  }
  async missingCost(universe: TaskUniverse, snapshots: Snapshot[], tasks: string[]): Promise<{ cells: number; repairCells: number }> {
    let cells = 0, repairCells = 0
    const seen = new Set<string>()
    for (const snapshot of snapshots) for (const taskId of tasks) for (const slot of repetitionsForTask(universe, taskId)) {
      const identity = cellIdentity(universe, taskId, slot.index, snapshot), key = cellKey(identity)
      if (seen.has(key)) continue
      seen.add(key)
      const pointer = await this.store.read<{ ref: string }>(`cells/${key.slice(7)}`)
      const cell = pointer ? await this.store.object<EvidenceCell>(pointer.ref) : undefined
      if (cell) { assertCell(cell, identity); invariant(await this.provider.verifyCell(cell, identity), 'provider cannot verify reusable cell provenance') }
      if (!cell || !validOutcome(cell)) { cells++; if (cell) repairCells++ }
    }
    return { cells, repairCells }
  }
  async evaluate(admission: SearchAdmission, startedAt: number, universe: TaskUniverse, plan: StageEvaluationPlan, snapshot: Snapshot, signal: AbortSignal, inspectionSignal: AbortSignal): Promise<StageResult> {
    inspectionSignal.throwIfAborted(); await this.hooks.verifySnapshot(snapshot); await this.store.put(plan); await this.store.put(snapshot)
    const binding = seal({ stagePlanDigest: plan.digest, participantId: snapshot.candidateId, sealedSnapshotDigest: snapshot.digest })
    const frozenBinding = await this.store.freeze(admission.roundId, `binding-${digestJson([plan.digest, snapshot.candidateId]).slice(7)}`, () => binding)
    validateSearchSchema('StageParticipantBinding', frozenBinding)
    invariant(frozenBinding.digest === binding.digest, 'stage participant is already bound to a different snapshot')
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

  /** Repairs this nonterminal round's unconsumed original stage result under its existing budget. */
  async repairEvaluation(roundId: string, repairId: string, originalRef: string, signal: AbortSignal): Promise<StageResult> {
    safeId(roundId); safeId(repairId); signal.throwIfAborted()
    invariant(!await this.store.read(`rounds/${roundId}/commit`), 'cannot repair after commit intent')
    invariant(!await this.store.read(`rounds/${roundId}/terminal`), 'cannot repair a terminal round')
    const saved = await this.store.read<{ ref: string }>(`rounds/${roundId}/admission`); invariant(saved, 'unknown search round')
    const admission = await this.store.object<SearchAdmission & { seed: TaskUniverse; heldOut: TaskUniverse; startedAt: number; providerIntegrity: string; algorithmIntegrity: string; digest: string }>(saved.ref)
    invariant(admission.providerIntegrity === this.provider.integrity, 'repair provider identity changed')
    invariant(admission.algorithmIntegrity === integrity, 'repair algorithm identity changed')
    const currentUniverses = await this.validate(admission)
    invariant(currentUniverses.seed.digest === admission.seed.digest && currentUniverses.heldOut.digest === admission.heldOut.digest, 'repair task universe changed')
    const original = await this.store.object<StageResult>(originalRef), plan = await this.store.object<StageEvaluationPlan>(original.stagePlanDigest)
    const snapshot = await this.store.object<Snapshot>(original.snapshotDigest)
    await this.hooks.verifySnapshot(snapshot)
    const consumer = plan.stage === 'held-out' ? undefined : plan.stage === 'baseline-probe' ? 'planning' : plan.stage === 'local' ? 'local' : plan.stage === 'bridge' ? 'nomination' : 'research'
    invariant(!consumer || !await this.store.read(`rounds/${roundId}/${consumer}`), 'stage already consumed; append an archive evidence completion instead')
    const universe = plan.partition === 'seed' ? admission.seed : admission.heldOut
    invariant(!await this.store.read(`rounds/${roundId}/${this.consumptionKey(plan.digest, snapshot.digest)}`), 'stage already consumed; append an archive evidence completion instead')
    const evaluation = await this.store.read<{ ref: string }>(`rounds/${roundId}/evaluation-${digestJson([plan.digest, snapshot.digest]).slice(7)}`)
    invariant(evaluation?.ref === originalRef, 'repair must reference this round\'s original evaluation')
    const active = await this.store.read<{ id: string }>(`rounds/${roundId}/active-repair`)
    invariant(!active || active.id === repairId || await this.store.read(`rounds/${roundId}/repair-result-${digestJson(active.id).slice(7)}`), 'another repair is unresolved; resume its original repair ID')
    signal.throwIfAborted()
    // Caller IDs cannot alias frozen input records or evidence revision pointers.
    const repairKey = digestJson(repairId).slice(7)
    const input = await this.store.freeze(roundId, `repair-input-${repairKey}`, async () => {
      const currentPointer = await this.store.read<{ ref: string }>(`rounds/${roundId}/repair-${original.digest.slice(7)}`)
      const current = currentPointer ? await this.store.object<StageResult>(currentPointer.ref) : original
      const identities = plannedCells(universe, plan, snapshot), cached = await reusableCells(this.store, this.provider, identities, current.cells)
      const missing = identities.filter(i => ![...current.cells, ...cached].some(c => cellKey(c.identity) === cellKey(i) && validOutcome(c)))
      return seal({ originalRef, current, cached, request: { plan, snapshot, cells: missing } })
    })
    invariant(input.originalRef === originalRef, 'repair ID reused for different evidence')
    const key = digestJson([roundId, repairId, input.current.digest])
    const previousOperation = await this.store.operation(roundId, key)
    const previousCells = previousOperation?.status === 'complete' ? (await this.store.object<EvaluationExecutionResult & { digest: string }>(previousOperation.outputDigest!)).cells : []
    const pending = await this.store.read<PendingSearchOperation | null>(`rounds/${roundId}/pending-operation`)
    invariant(!pending || [key, ...[...input.current.cells, ...input.cached, ...previousCells].map(c => digestJson([key, c.digest]))].includes(pending.operationKey), 'another external operation is unresolved; resume its original repair ID')
    // Persist ownership before external execution, including the crash window
    // before an uncertain response can produce a pending-operation marker.
    await this.store.write(`rounds/${roundId}/active-repair`, { id: repairId })
    return this.store.freeze(roundId, `repair-result-${repairKey}`, async () => {
      const budgetStart = (await this.store.read<{ startedAt: number }>('budget'))?.startedAt ?? admission.startedAt
      const deadline = Math.min(admission.startedAt + admission.settings.budgets.round.timeoutMs, budgetStart + admission.settings.budgets.evolution.timeoutMs)
      const inspectionSignal = signal, timed = searchDeadline(signal, deadline)
      signal = timed.signal
      try {
      const { current, request } = input, missing = request.cells
      const previouslyReserved = !!previousOperation
      let reservation, output: EvaluationExecutionResult = { cells: [] }
      try { reservation = await this.store.reserve(roundId, key, request, { ...zeroUsage(), cells: missing.length, repairCells: missing.length }, admission.settings.budgets, admission.startedAt) }
      catch (error) {
        if (!(error instanceof SearchBudgetExceeded)) throw error
        output.failure = budgetFailure(error.resource)
      }
      if (reservation?.status === 'complete') output = await this.store.object<EvaluationExecutionResult & { digest: string }>(reservation.outputDigest!)
      else if (reservation) {
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
      const cells = [...input.cached, ...output.cells]
      let failure = output.failure
      const processMode = ['held-out', 'global-seed', 'bridge'].includes(plan.stage) ? admission.settings.promotion.process.mode : admission.settings.search.process.mode
      const applicableProcess = new Set(processTasks(universe, processMode))
      const projectionSource = completeEvidence(current, cells)
      for (const cell of projectionSource.cells.filter(c => validOutcome(c) && applicableProcess.has(c.identity.taskId) && c.process?.status !== 'available')) {
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
  async diagnose(admission: SearchAdmission, startedAt: number, universe: TaskUniverse, snapshot: Snapshot, taskIds: string[], baseline: StageResult, signal: AbortSignal, inspectionSignal: AbortSignal): Promise<DiagnosisDossier> {
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
        const task = universe.tasks.find(t => t.id === fact.taskId)!
        if (fact.status === 'supported-hypothesis') invariant(fact.evidenceRefs.length && taskCells.some(c => validOutcome(c) && c.outcome.status === 'available'
          && numeric(utility(c.outcome.rawValue, task.outcome)) < task.successUtility), 'a failure cluster requires valid business failure evidence')
        if (fact.status === 'successful-control') invariant(fact.evidenceRefs.length && taskCells.length === repetitionsForTask(universe, fact.taskId).length
          && taskCells.every(c => validOutcome(c) && c.outcome.status === 'available' && numeric(utility(c.outcome.rawValue, task.outcome)) >= task.successUtility), 'successful control requires complete parent success evidence')
      }
      const facts = [...output.facts]
      for (const taskId of taskIds) if (!facts.some(f => f.taskId === taskId)) {
        const task = universe.tasks.find(t => t.id === taskId)!, cells = baseline.cells.filter(c => c.identity.taskId === taskId)
        const complete = cells.length === repetitionsForTask(universe, taskId).length && cells.every(validOutcome)
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
  async generate(admission: SearchAdmission, startedAt: number, settings: SearchSettings, seed: TaskUniverse, work: PreparedWork, signal: AbortSignal, inspectionSignal: AbortSignal): Promise<GeneratedCandidate> {
  const value = await this.store.freeze(admission.roundId, `generated-${work.workplan.candidateId}`, async () => {
    const handoff = await this.store.read<{ refs: string[] }>(`findings/${work.parent.digest.slice(7)}`)
    const findings = await Promise.all(sorted([...work.parent.findingRefs, ...(handoff?.refs ?? [])]).map(ref => this.store.object<ResearchFinding>(ref)))
    const delivery = deliveredWorkplan(work.workplan, work.dossier, findings, work.scope)
    const key = digestJson([admission.roundId, work.workplan.digest, 'generation'])
    const previouslyReserved = !!await this.store.operation(admission.roundId, key)
    let reservation
    try { reservation = await this.store.reserve(admission.roundId, key, delivery, { ...zeroUsage(), generationTokens: work.workplan.generationBudget.maxTokens ?? 0, generationRequests: work.workplan.generationBudget.maxModelRequests ?? 0 }, settings.budgets, startedAt) }
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
      run: () => this.hooks.generate({ delivery, parent: work.parent, baseline: work.baseline,
        baselineContext: { universe: seed, plan: work.plan, scope: work.scope, processMode: settings.search.process.mode }, idempotencyKey: key, signal }),
      ...(this.hooks.inspectGeneration ? { inspect: (signal: AbortSignal) => this.hooks.inspectGeneration!(key, signal) } : {}),
      failed: (failure) => seal({ changedPaths: [], reason: failure.message, usage: {
        ...(work.workplan.generationBudget.maxTokens === undefined ? {} : { tokens: reservation.reserved.generationTokens }),
        ...(work.workplan.generationBudget.maxModelRequests === undefined ? {} : { requests: reservation.reserved.generationRequests }),
      } }),
    })
    const value: GeneratedCandidate = recovered.notStarted ? seal({ changedPaths: [], reason: budgetFailure('time').message, usage: { tokens: 0, requests: 0 } }) : recovered.value
    verifyDigest(value)
    if (value.snapshot) {
      validateSnapshot(value.snapshot); await this.hooks.verifySnapshot(value.snapshot)
      invariant(value.snapshot.candidateId === work.workplan.candidateId && value.snapshot.parentIds.length === 1 && value.snapshot.parentIds[0] === work.parent.candidateId, 'generated snapshot has wrong code parent')
      invariant(value.receipt && value.sessionId, 'candidate must consume assigned dossier before sealing')
      validateReceipt(value.receipt, delivery, value.sessionId)
    }
    const boundedTokens = work.workplan.generationBudget.maxTokens !== undefined, boundedRequests = work.workplan.generationBudget.maxModelRequests !== undefined
    invariant(!boundedTokens || value.usage.tokens !== undefined, 'bounded generation requires token accounting')
    invariant(!boundedRequests || value.usage.requests !== undefined, 'bounded generation requires request accounting')
    await this.store.settle(reservation, value, { ...zeroUsage(), generationTokens: boundedTokens ? value.usage.tokens! : 0, generationRequests: boundedRequests ? value.usage.requests! : 0 })
    await resolvePendingOperation(this.store, admission.roundId, key)
    return value
  })
  validateSearchSchema('GeneratedCandidate', value)
    return value
  }
  async reconcile(roundId: string, intent: CommitIntent): Promise<SearchRoundOutcome> {
    validateSearchSchema('CommitIntent', intent)
    verifyDigest(intent)
    const next = await this.store.object<ResearchArchive>(intent.nextArchiveDigest)
    await this.store.casArchive(intent.expectedArchiveDigest, next)
    if (intent.nextChampion) await this.hooks.commitChampion(intent.expectedChampionRevisionDigest, intent.nextChampion, roundId)
    return this.recordTerminal(roundId, intent.outcome)
  }
  async recordTerminal(roundId: string, outcome: SearchRoundOutcome): Promise<SearchRoundOutcome> {
    validateSearchSchema('SearchRoundOutcome', outcome)
    await this.store.put(outcome); await this.store.write(`rounds/${roundId}/terminal`, { ref: outcome.digest })
    const advancing = await this.store.read<{ roundId: string | null }>('active-round')
    if (advancing?.roundId === roundId) await this.store.write('active-round', { roundId: null })
    return outcome
  }
}
