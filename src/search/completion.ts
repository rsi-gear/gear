import { digestJson } from '../state/digest.js'
import { integrity, invariant, processTasks, safeId, seal, verifyDigest } from './contracts.js'
import { assertCell, cellKey, completeEvidence, plannedCells, profile, reusableCells, validOutcome } from './evidence.js'
import { budgetFailure, recoverExternal, resolvePendingOperation, searchDeadline } from './recovery.js'
import { SearchBudgetExceeded, type SearchJournal, zeroUsage } from './store.js'
import type { EvaluationExecutionResult, SearchProvider, SearchSettings, SearchStageFailure, Snapshot, StageEvaluationPlan, StageResult, TaskUniverse } from './types.js'

export interface EvidenceCompletion {
  kind: 'archive-evidence-completion'
  id: string
  originalResultDigest: string
  completedResultDigest: string
  planDigest: string
  snapshotDigest: string
  digest: string
}
/** The caller holds the evolution writer lock. New completions wait for any active round to settle; completed results remain replayable. This API cannot generate code or promote a champion. */
export async function completeArchivedEvidence(input: { id: string; store: SearchJournal; provider: SearchProvider; universe: TaskUniverse; plan: StageEvaluationPlan; snapshot: Snapshot; original: StageResult; settings: SearchSettings; signal: AbortSignal }): Promise<EvidenceCompletion> {
  const { store, original, plan, snapshot, provider, universe } = input
  safeId(input.id); input.signal.throwIfAborted()
  invariant(universe.partition === 'seed' && plan.partition === 'seed', 'archive completion accepts seed evidence only')
  invariant(provider.capabilities.taskSubsetPlans && provider.capabilities.batchIndependentCells && provider.capabilities.idempotentExecution, 'completion requires subset plans, reusable cells and idempotent execution')
  invariant((await provider.describe('seed')).digest === universe.digest, 'completion task universe changed')
  verifyDigest(original); profile(universe, plan, snapshot, original, 'auto')
  const identity = await store.read<{ ref: string }>('evolution/identity')
  const archive = await store.archive()
  if (identity || archive) invariant(archive && archive.universeDigest === universe.digest
    && archive.results.some(r => r.digest === original.digest) && archive.plans.some(p => p.digest === plan.digest)
    && archive.snapshots.some(s => s.digest === snapshot.digest), 'completion must reference committed archive evidence')
  if (identity) {
    const frozen = await store.object<{ providerIntegrity: string; seedUniverseDigest: string; settingsDigest: string; algorithmIntegrity: string; digest: string }>(identity.ref)
    invariant(frozen.algorithmIntegrity === integrity && frozen.providerIntegrity === provider.integrity && frozen.seedUniverseDigest === universe.digest && frozen.settingsDigest === digestJson(input.settings), 'completion evolution identity changed')
  }
  const completionId = `completion-${input.id}`
  const requestIdentity = { id: input.id, originalResultDigest: original.digest, planDigest: plan.digest, snapshotDigest: snapshot.digest,
    providerIntegrity: provider.integrity, algorithmIntegrity: integrity, settingsDigest: digestJson(input.settings) }
  const saved = await store.read<{ ref: string }>(`rounds/${completionId}/request`)
  if (saved) {
    const { digest: ignored, startedAt: ignoredStart, ...previous } = await store.object<typeof requestIdentity & { digest: string; startedAt: number }>(saved.ref)
    invariant(digestJson(previous) === digestJson(requestIdentity), 'completion request identity changed')
    const completed = await store.read<{ ref: string }>(`rounds/${completionId}/result`)
    if (completed) return store.object<EvidenceCompletion>(completed.ref)
  }
  const advancing = await store.read<{ roundId: string | null }>('active-round')
  invariant(!advancing?.roundId || await store.read(`rounds/${advancing.roundId}/terminal`), 'search has an unresolved round; recover it before starting archive completion')
  const active = await store.read<{ id: string }>('active-completion')
  invariant(!active || active.id === completionId || await store.read(`rounds/${active.id}/result`), 'another completion is unresolved; resume its original ID')
  input.signal.throwIfAborted()
  const owner = await store.freeze(completionId, 'operation-kind', () => seal({ kind: 'archive-completion' }))
  invariant(owner.kind === 'archive-completion', 'record ID belongs to a different operation kind')
  const request = await store.freeze(completionId, 'request', () => seal({ ...requestIdentity, startedAt: Date.now() }))
  input.signal.throwIfAborted()
  await store.write('active-completion', { id: completionId })
  return store.freeze(completionId, 'result', async () => {
    const budgetStart = (await store.read<{ startedAt: number }>('budget'))?.startedAt ?? request.startedAt
    const deadline = Math.min(request.startedAt + input.settings.budgets.round.timeoutMs, budgetStart + input.settings.budgets.evolution.timeoutMs)
    const timed = searchDeadline(input.signal, deadline), signal = timed.signal
    try {
    input.signal.throwIfAborted()
    const identities = plannedCells(universe, plan, snapshot)
    const cellRequest = await store.freeze(completionId, 'cell-request', async () => {
      // A caller may still reference an older committed result. Follow both
      // committed and queued revisions before freezing this repair's base.
      const history = new Map((archive?.results ?? [original]).map(result => [result.digest, result]))
      const queue = await store.read<{ refs: string[] }>('pending-completions')
      for (const ref of queue?.refs ?? []) {
        const completion = await store.object<EvidenceCompletion>(ref)
        if (completion.planDigest === plan.digest && completion.snapshotDigest === snapshot.digest) {
          const result = await store.object<StageResult>(completion.completedResultDigest)
          history.set(result.digest, result)
        }
      }
      let current = original, found = false
      for (const result of history.values()) {
        if (result.digest === original.digest) { found = true; continue }
        if (!found || result.stagePlanDigest !== plan.digest || result.snapshotDigest !== snapshot.digest) continue
        invariant(result.supersedesEvidenceDigest === current.digest, 'completion evidence revisions must form a single history')
        completeEvidence(current, result.cells)
        current = result
      }
      const cached = await reusableCells(store, provider, identities, current.cells)
      const missing = identities.filter(i => ![...current.cells, ...cached].some(c => cellKey(c.identity) === cellKey(i) && validOutcome(c)))
      return seal({ current, cached, missing })
    })
    const { current, cached, missing } = cellRequest
    const key = digestJson([request.digest, 'repair'])
    let replacements: StageResult['cells'] = [...cached], failure: SearchStageFailure | undefined
    if (missing.length) {
      const previouslyReserved = !!await store.operation(completionId, key)
      let operation
      try { operation = await store.reserve(completionId, key, { requestDigest: request.digest, cellRequestDigest: cellRequest.digest }, { ...zeroUsage(), cells: missing.length, repairCells: missing.length }, input.settings.budgets, request.startedAt) }
      catch (error) {
        if (!(error instanceof SearchBudgetExceeded)) throw error
        failure = budgetFailure(error.resource)
      }
      if (operation) {
        let output: EvaluationExecutionResult
        if (operation.status === 'complete') output = await store.object<EvaluationExecutionResult & { digest: string }>(operation.outputDigest!)
        else {
          const recovered = await recoverExternal({ store, roundId: completionId,
            operation: { operationKey: key, kind: 'evaluation', partition: 'seed', stagePlanDigest: plan.digest, candidateId: snapshot.candidateId },
            signal, inspectionSignal: input.signal, previouslyReserved,
            run: async () => ({ cells: await provider.evaluate({ plan, snapshot, cells: missing, idempotencyKey: key, signal }) }),
            ...(provider.inspectEvaluation ? { inspect: (signal: AbortSignal) => provider.inspectEvaluation!({ plan, snapshot, cells: missing, idempotencyKey: key, signal }) } : {}),
            failed: (failure, cells): EvaluationExecutionResult => ({ cells, failure }),
          })
          output = recovered.value
          replacements = output.cells
          invariant(new Set(replacements.map(c => cellKey(c.identity))).size === replacements.length, 'completion returned duplicate slots')
          for (const cell of replacements) {
            const identity = missing.find(i => cellKey(i) === cellKey(cell.identity)); invariant(identity, 'completion returned an unplanned or valid slot')
            assertCell(cell, identity); invariant(await provider.verifyCell(cell, identity), 'completion provenance rejected')
          }
          await store.settle(operation, seal(output), recovered.notStarted ? zeroUsage() : operation.reserved)
        }
        replacements = [...cached, ...output.cells]; failure = output.failure
        await resolvePendingOperation(store, completionId, key)
      }
    }
    const applicableProcess = new Set(processTasks(universe, input.settings.search.process.mode))
    const projectionSource = completeEvidence(current, replacements)
    for (const cell of projectionSource.cells.filter(c => validOutcome(c) && applicableProcess.has(c.identity.taskId) && c.process?.status !== 'available')) {
      if (!provider.completeProcess) continue
      const projectionKey = digestJson([request.digest, cell.digest]), previouslyReserved = !!await store.operation(completionId, projectionKey)
      let operation
      try { operation = await store.reserve(completionId, projectionKey, cell, zeroUsage(), input.settings.budgets, request.startedAt) }
      catch (error) { if (!(error instanceof SearchBudgetExceeded)) throw error; failure = budgetFailure(error.resource); break }
      let output: EvaluationExecutionResult
      if (operation.status === 'complete') output = await store.object<EvaluationExecutionResult & { digest: string }>(operation.outputDigest!)
      else {
        const recovered = await recoverExternal({ store, roundId: completionId,
          operation: { operationKey: projectionKey, kind: 'evaluation', partition: 'seed', stagePlanDigest: plan.digest, candidateId: snapshot.candidateId },
          signal, inspectionSignal: input.signal, previouslyReserved,
          run: async () => ({ cells: [await provider.completeProcess!(cell, projectionKey, signal)] }),
          ...(provider.inspectProcess ? { inspect: (signal: AbortSignal) => provider.inspectProcess!(cell, projectionKey, signal) } : {}),
          failed: (failure, cells): EvaluationExecutionResult => ({ cells, failure }),
        })
        output = recovered.value
        invariant(output.cells.length <= 1, 'projection returned unexpected cells')
        for (const value of output.cells) {
          assertCell(value, cell.identity); invariant(await provider.verifyCell(value, cell.identity), 'process recovery provenance rejected')
          completeEvidence(current, [value])
        }
        await store.settle(operation, seal(output))
      }
      await resolvePendingOperation(store, completionId, projectionKey)
      replacements.push(...output.cells); failure ??= output.failure
    }
    const complete = completeEvidence(current, replacements)
    const { digest: ignored, ...body } = complete
    const proposed = failure ? seal({ ...body, failure }) : complete
    const { digest: priorDigest, supersedesEvidenceDigest: priorBase, ...priorContent } = current
    const { digest: nextDigest, supersedesEvidenceDigest: nextBase, ...nextContent } = proposed
    // Do not append a new revision when a different completion ID adds nothing.
    const completed = digestJson(priorContent) === digestJson(nextContent) ? current : proposed
    profile(universe, plan, snapshot, completed, 'auto')
    await store.put(completed)
    for (const cell of replacements.filter(validOutcome)) { await store.put(cell); await store.write(`cells/${cellKey(cell.identity).slice(7)}`, { ref: cell.digest }) }
    const result = seal({ kind: 'archive-evidence-completion' as const, id: input.id, originalResultDigest: original.digest, completedResultDigest: completed.digest, planDigest: plan.digest, snapshotDigest: snapshot.digest })
    await store.put(result)
    // Standalone evidence completion has no research admission to modify. Only
    // an existing archive may receive a revision for its next committed update.
    if (archive) {
      const queue = await store.read<{ refs: string[] }>('pending-completions') ?? { refs: [] }
      await store.write('pending-completions', { refs: [...new Set([...queue.refs, result.digest])] })
    }
    return result
    } finally { timed.dispose() }
  })
}
