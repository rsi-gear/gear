import { digestJson } from '../../src/state/digest.js'
import { defaultMultisignalPromotion, defaultSearchConfig } from '../../src/search/config.js'
import { seal, sorted } from '../../src/search/contracts.js'
import { consumptionReceipt } from '../../src/search/diagnosis.js'
import type { DiagnosisProvider, EvidenceCell, SearchProvider, SearchSettings, Snapshot, TaskUniverse } from '../../src/search/types.js'
import type { SearchExecutionHooks } from '../../src/search/engine.js'

export function universe(N = 100, partition: 'seed' | 'held-out' = 'seed', process = false): TaskUniverse {
  const contents = Array.from({ length: N }, (_, i) => digestJson([partition, i]))
  const contract = (channel: 'outcome' | 'process') => seal({ id: channel, revision: '1', channel, group: channel,
    evidenceKind: channel === 'outcome' ? 'final-outcome' as const : 'final-state-partial-credit' as const,
    granularity: 'trial' as const, direction: 'maximize' as const, range: { min: 0, max: 1 }, comparisonQuantum: 0.000001,
    repetitionReducer: 'mean' as const, applicableTaskSetDigest: digestJson(sorted(contents)) })
  const outcome = contract('outcome'), partial = contract('process')
  return seal({ partition, tasks: contents.map((contentDigest, i) => ({ id: `task-${i}`, contentDigest, outcome, ...(process ? { process: partial } : {}), successUtility: 1, weight: 1, stratum: `family-${i % 4}`, estimatedCost: 1 })),
    conditionDigest: digestJson(['condition', partition]), repetitions: [{ index: 0, seed: 0 }] })
}
export function snapshot(id: string, parentIds: string[] = [], sameTree?: string): Snapshot {
  return seal({ candidateId: id, commit: digestJson(id).slice(7, 47), tree: sameTree ?? digestJson([id, 'tree']).slice(7, 47), manifestDigest: digestJson([sameTree ?? id, 'manifest']), parentIds, findingRefs: [] })
}
export function settings(): SearchSettings {
  const budget = { maxNewRolloutCells: 10000, maxDiagnosisInputTokens: 100000, maxDiagnosisOutputTokens: 20000, maxGenerationTokens: 10000, maxGenerationRequests: 100, maxRepairCells: 20, timeoutMs: 600000 }
  return { search: structuredClone(defaultSearchConfig), promotion: structuredClone(defaultMultisignalPromotion), budgets: { round: { ...budget }, evolution: { ...budget } }, regression: { collectFailures: false, maxProposals: 50 } }
}
export function fixtures(N = 100, process = false) {
  const seed = universe(N, 'seed', process), heldOut = universe(Math.max(2, N / 10), 'held-out', process), anchor = snapshot('anchor')
  const executions: Array<{ participant: string; stage: string; count: number; key: string }> = []
  const generated: string[] = [], promotions: string[] = [], cache = new Map<string, EvidenceCell[]>()
  const provider: SearchProvider = {
    integrity: digestJson('fixture-provider'), capabilities: { taskSubsetPlans: true, batchIndependentCells: true, idempotentExecution: true },
    describe: async p => p === 'seed' ? seed : heldOut,
    verifyCell: (cell, expected) => cell.identity.snapshotDigest === expected.snapshotDigest,
    evaluate: async input => {
      const cached = cache.get(input.idempotencyKey); if (cached) return cached
      executions.push({ participant: input.snapshot.candidateId, stage: input.plan.stage, count: input.cells.length, key: input.idempotencyKey })
      const cells = input.cells.map(identity => {
        const value = input.snapshot.candidateId === 'anchor' ? (Number(identity.taskId.slice(5)) >= N * 0.8 && input.plan.partition === 'seed' ? 1 : 0) : 1
        const evidenceRef = `run-${digestJson(identity).slice(7, 25)}`
        return seal({ identity, status: 'available' as const, envelope: 'score-envelope-v2' as const, outcomeCertified: true,
          outcome: { status: 'available' as const, rawValue: value, contractDigest: identity.outcomeContractDigest, evidenceRef },
          ...(identity.processContractDigest ? { process: { status: 'available' as const, rawValue: input.snapshot.candidateId === 'anchor' ? 0.5 : 1, contractDigest: identity.processContractDigest, evidenceRef } } : {}),
          evidenceRef, completedAt: '2026-01-01T00:00:00.000Z' })
      })
      cache.set(input.idempotencyKey, cells); return cells
    },
  }
  const diagnosis: DiagnosisProvider = { integrity: digestJson('fixture-diagnosis'), sanitizationPolicyDigest: digestJson('fixture-sanitization'), diagnose: async input => ({
    facts: input.cells.filter(c => c.outcome.status === 'available' && c.outcome.rawValue < 1).map(c => ({ taskId: c.identity.taskId, evidenceRefs: [c.evidenceRef], status: 'supported-hypothesis' as const,
      familyId: `family-${Number(c.identity.taskId.slice(5)) % 4}`, hypothesis: `Repair workflow ${Number(c.identity.taskId.slice(5)) % 4}`, modificationPaths: ['harness'], mechanism: 'Explicit fixture feedback identifies omitted verification' })), inputTokens: 10, outputTokens: 10,
  }) }
  const hooks: SearchExecutionHooks = { verifySnapshot: async () => {}, generate: async ({ delivery, parent }) => {
    generated.push(delivery.workplan.candidateId)
    return seal({ snapshot: snapshot(delivery.workplan.candidateId, [parent.candidateId]), changedPaths: ['harness/main.ts'],
      receipt: consumptionReceipt(delivery, 'fixture-session', delivery.workplan.requiredDiagnosisRefs), sessionId: 'fixture-session', usage: { tokens: 10, requests: 1 } })
  }, commitChampion: async (_expected, next) => { if (!promotions.includes(next.commit)) promotions.push(next.commit) } }
  return { seed, heldOut, anchor, provider, diagnosis, hooks, executions, generated, promotions }
}
