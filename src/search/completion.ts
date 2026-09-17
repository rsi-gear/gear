import { digestJson } from '../state/digest.js'
import { integrity, invariant, processTasks, seal, verifyDigest } from './contracts.js'
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
/** The caller holds the evolution writer lock. This API cannot generate code or promote a champion. */
export async function completeArchivedEvidence(input: { id: string; store: SearchJournal; provider: SearchProvider; universe: TaskUniverse; plan: StageEvaluationPlan; snapshot: Snapshot; original: StageResult; settings: SearchSettings; signal: AbortSignal }): Promise<EvidenceCompletion> {
  const { store, original, plan, snapshot, provider, universe } = input
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
  const active = await store.read<{ id: string }>('active-completion')
  invariant(!active || active.id === completionId || await store.read(`rounds/${active.id}/result`), 'another completion is unresolved; resume its original ID')
  await store.write('active-completion', { id: completionId })
  const request = await store.freeze(completionId, 'request', () => seal({ id: input.id, originalResultDigest: original.digest, planDigest: plan.digest, snapshotDigest: snapshot.digest, providerIntegrity: provider.integrity, algorithmIntegrity: integrity, settingsDigest: digestJson(input.settings), startedAt: Date.now() }))
  invariant(request.originalResultDigest === original.digest && request.planDigest === plan.digest && request.snapshotDigest === snapshot.digest && request.providerIntegrity === provider.integrity && request.algorithmIntegrity === integrity && request.settingsDigest === digestJson(input.settings), 'completion request identity changed')
  return store.freeze(completionId, 'result', async () => {
    const budgetStart = (await store.read<{ startedAt: number }>('budget'))?.startedAt ?? request.startedAt
    const deadline = Math.min(request.startedAt + input.settings.budgets.round.timeoutMs, budgetStart + input.settings.budgets.evolution.timeoutMs)
    const timed = searchDeadline(input.signal, deadline), signal = timed.signal
    try {
    input.signal.throwIfAborted()
    const identities = plannedCells(universe, plan, snapshot)
    const cellRequest = await store.freeze(completionId, 'cell-request', async () => {
      const cached = await reusableCells(store, provider, identities, original.cells)
      const missing = identities.filter(i => ![...original.cells, ...cached].some(c => cellKey(c.identity) === cellKey(i) && validOutcome(c)))
      return seal({ cached, missing })
    })
    const { cached, missing } = cellRequest
    const key = digestJson([request.digest, 'repair'])
    let replacements: StageResult['cells'] = [...cached], failure: SearchStageFailure | undefined
    if (missing.length) {
      const previouslyReserved = !!await store.operation(completionId, key)
      const operation = await store.reserve(completionId, key, { requestDigest: request.digest, cellRequestDigest: cellRequest.digest }, { ...zeroUsage(), cells: missing.length, repairCells: missing.length }, input.settings.budgets, request.startedAt)
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
    const applicableProcess = new Set(processTasks(universe, input.settings.search.process.mode))
    const projectionSource = completeEvidence(original, replacements)
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
          completeEvidence(original, [value])
        }
        await store.settle(operation, seal(output))
      }
      await resolvePendingOperation(store, completionId, projectionKey)
      replacements.push(...output.cells); failure ??= output.failure
    }
    const complete = completeEvidence(original, replacements)
    const { digest: ignored, ...body } = complete
    const completed = failure ? seal({ ...body, failure }) : complete
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
