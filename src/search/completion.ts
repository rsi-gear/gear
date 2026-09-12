import { digestJson } from '../state/digest.js'
import { invariant, seal, verifyDigest } from './contracts.js'
import { assertCell, cellKey, completeEvidence, plannedCells, profile, validOutcome } from './evidence.js'
import { SearchBudgetExceeded, SearchStore, zeroUsage } from './store.js'
import type { SearchProvider, SearchSettings, Snapshot, StageEvaluationPlan, StageResult, TaskUniverse } from './types.js'

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
export async function completeArchivedEvidence(input: { id: string; store: SearchStore; provider: SearchProvider; universe: TaskUniverse; plan: StageEvaluationPlan; snapshot: Snapshot; original: StageResult; settings: SearchSettings; signal: AbortSignal }): Promise<EvidenceCompletion> {
  const { store, original, plan, snapshot, provider, universe } = input
  invariant(universe.partition === 'seed' && plan.partition === 'seed', 'archive completion accepts seed evidence only')
  invariant(provider.capabilities.taskSubsetPlans && provider.capabilities.batchIndependentCells && provider.capabilities.idempotentExecution, 'completion requires subset plans, reusable cells and idempotent execution')
  invariant((await provider.describe('seed')).digest === universe.digest, 'completion task universe changed')
  verifyDigest(original); profile(universe, plan, snapshot, original, 'auto')
  const completionId = `completion-${input.id}`
  const request = await store.freeze(completionId, 'request', () => seal({ id: input.id, originalResultDigest: original.digest, planDigest: plan.digest, snapshotDigest: snapshot.digest, providerIntegrity: provider.integrity, settingsDigest: digestJson(input.settings), startedAt: Date.now() }))
  invariant(request.originalResultDigest === original.digest && request.planDigest === plan.digest && request.snapshotDigest === snapshot.digest && request.providerIntegrity === provider.integrity && request.settingsDigest === digestJson(input.settings), 'completion request identity changed')
  return store.freeze(completionId, 'result', async () => {
    const budgetStart = (await store.read<{ startedAt: number }>('budget'))?.startedAt ?? request.startedAt
    const deadline = Math.min(request.startedAt + input.settings.budgets.round.timeoutMs, budgetStart + input.settings.budgets.evolution.timeoutMs)
    if (Date.now() >= deadline) throw new SearchBudgetExceeded('time')
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))])
    signal.throwIfAborted()
    const identities = plannedCells(universe, plan, snapshot)
    const missing = identities.filter(i => !original.cells.some(c => cellKey(c.identity) === cellKey(i) && validOutcome(c)))
    const key = digestJson([request.digest, 'repair'])
    let replacements: StageResult['cells'] = []
    if (missing.length) {
      const operation = await store.reserve(completionId, key, request, { ...zeroUsage(), cells: missing.length, repairCells: missing.length }, input.settings.budgets, request.startedAt)
      if (operation.status === 'complete') replacements = (await store.object<{ cells: StageResult['cells']; digest: string }>(operation.outputDigest!)).cells
      else {
        replacements = await provider.evaluate({ plan, snapshot, cells: missing, idempotencyKey: key, signal })
        invariant(new Set(replacements.map(c => cellKey(c.identity))).size === replacements.length, 'completion returned duplicate slots')
        for (const cell of replacements) {
          const identity = missing.find(i => cellKey(i) === cellKey(cell.identity)); invariant(identity, 'completion returned an unplanned or valid slot')
          assertCell(cell, identity); invariant(await provider.verifyCell(cell, identity), 'completion provenance rejected')
        }
        await store.settle(operation, seal({ cells: replacements }))
      }
    }
    for (const cell of original.cells.filter(c => validOutcome(c) && c.identity.processContractDigest && c.process?.status !== 'available')) {
      if (!provider.completeProcess) continue
      const value = await store.freeze(completionId, `process-${cell.digest.slice(7)}`, async () => {
        const recovered = await provider.completeProcess!(cell, digestJson([request.digest, cell.digest]), signal)
        assertCell(recovered, cell.identity); invariant(await provider.verifyCell(recovered, cell.identity), 'process recovery provenance rejected')
        // This rejects changed outcome, assertion, run ID, timestamp, or preexisting valid process.
        completeEvidence(original, [recovered])
        return recovered
      })
      replacements.push(value)
    }
    const completed = completeEvidence(original, replacements)
    profile(universe, plan, snapshot, completed, 'auto')
    await store.put(completed)
    for (const cell of replacements.filter(validOutcome)) { await store.put(cell); await store.write(`cells/${cellKey(cell.identity).slice(7)}`, { ref: cell.digest }) }
    const result = seal({ kind: 'archive-evidence-completion' as const, id: input.id, originalResultDigest: original.digest, completedResultDigest: completed.digest, planDigest: plan.digest, snapshotDigest: snapshot.digest })
    await store.put(result)
    const queue = await store.read<{ refs: string[] }>('pending-completions') ?? { refs: [] }
    await store.write('pending-completions', { refs: [...new Set([...queue.refs, result.digest])] })
    return result
  })
}
