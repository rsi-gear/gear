import { digestJson } from '../../src/state/digest.js'
import { defaultMultisignalPromotion, defaultSearchConfig } from '../../src/search/config.js'
import { scopeEquivalenceDigest, seal, sorted } from '../../src/search/contracts.js'
import { cellIdentity, cellKey } from '../../src/search/evidence.js'
import { stagePlan } from '../../src/search/scopes.js'
import { consumptionReceipt } from '../../src/search/diagnosis.js'
import type { DiagnosisProvider, EvaluationScope, EvidenceCell, SearchProvider, SearchSettings, Snapshot, Stage, TaskGuard, TaskUniverse } from '../../src/search/types.js'
import type { GeneratedCandidate, SearchExecutionHooks } from '../../src/search/engine.js'

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
export function revise<T extends { digest: string }>(record: T, patch: Partial<Omit<T, 'digest'>>): T {
  const { digest: ignored, ...body } = record
  return seal({ ...body, ...patch }) as T
}
export function scopeFixture(u: TaskUniverse, ids: string[], familyId = 'family', epoch = 1, guards: TaskGuard[] = []): EvaluationScope {
  const taskIds = sorted([...ids, ...guards.map(g => g.taskId)])
  const weights = Object.fromEntries(taskIds.map(id => [id, ids.includes(id) ? 1 / ids.length : 0]))
  return seal({ familyId, epoch, universeDigest: u.digest, taskSetSizeResolutionDigest: 'sha256:' + '1'.repeat(64), taskIds, weights, guards,
    buckets: { local: sorted(ids), shared: [], cross: [] },
    sampling: { local: { requested: ids.length, selected: ids.length, reasons: [] }, shared: { requested: 0, selected: 0, reasons: [] }, cross: { requested: 0, selected: 0, reasons: [] } },
    equivalenceDigest: scopeEquivalenceDigest({ universeDigest: u.digest, taskIds, weights, guards }) })
}
export function evaluatedFixture(u: TaskUniverse, scope: EvaluationScope, s: Snapshot,
  score: (taskId: string, repetition: number) => { outcome: number; process?: number; invalid?: boolean; assertions?: EvidenceCell['assertions'] } | undefined,
  options: { stage?: Stage; participants?: string[]; taskIds?: string[]; completedAt?: string } = {}) {
  const plan = stagePlan({ stage: options.stage ?? 'local', partition: u.partition, universeDigest: u.digest,
    scopeDigest: scope.digest, taskSetSizeResolutionDigest: scope.taskSetSizeResolutionDigest,
    taskIds: options.taskIds ?? scope.taskIds, participantIds: options.participants ?? [s.candidateId], prerequisiteDecisionDigests: [], selectionRuleDigest: digestJson('fixture') })
  const cells = plan.taskIds.flatMap(taskId => u.repetitions.flatMap(slot => {
    const value = score(taskId, slot.index)
    if (!value) return []
    const identity = cellIdentity(u, taskId, slot.index, s), evidenceRef = `fixture:${digestJson(identity)}`
    const cell: EvidenceCell = seal({ identity, status: value.invalid ? 'invalid' as const : 'available' as const,
      envelope: 'score-envelope-v2' as const, outcomeCertified: !value.invalid,
      outcome: value.invalid ? { status: 'invalid' as const, contractDigest: identity.outcomeContractDigest, reason: 'fixture infrastructure failure' }
        : { status: 'available' as const, rawValue: value.outcome, contractDigest: identity.outcomeContractDigest, evidenceRef },
      ...(identity.processContractDigest ? { process: value.process === undefined
        ? { status: 'missing' as const, contractDigest: identity.processContractDigest, reason: 'fixture unavailable' }
        : { status: 'available' as const, rawValue: value.process, contractDigest: identity.processContractDigest, evidenceRef } } : {}),
      ...(value.assertions ? { assertions: value.assertions } : {}), evidenceRef, completedAt: options.completedAt ?? '2026-01-01T00:00:00Z' })
    return [cell]
  }))
  return { scope, plan, result: seal({ stagePlanDigest: plan.digest, snapshotDigest: s.digest, cells, settled: true }) }
}
export function fixtures(N = 100, process = false) {
  const seed = universe(N, 'seed', process), heldOut = universe(Math.max(2, N / 10), 'held-out', process), anchor = snapshot('anchor')
  const executions: Array<{ participant: string; stage: string; count: number; key: string }> = []
  const generated: string[] = [], promotions: string[] = [], cache = new Map<string, EvidenceCell[]>()
  const generations = new Map<string, GeneratedCandidate>()
  const diagnoses = new Map<string, Awaited<ReturnType<DiagnosisProvider['diagnose']>>>()
  const provider: SearchProvider = {
    integrity: digestJson('fixture-provider'), capabilities: { taskSubsetPlans: true, batchIndependentCells: true, idempotentExecution: true },
    describe: async p => p === 'seed' ? seed : heldOut,
    verifyCell: (cell, expected) => cellKey(cell.identity) === cellKey(expected),
    inspectEvaluation: async input => cache.has(input.idempotencyKey) ? { status: 'complete', result: { cells: cache.get(input.idempotencyKey)! } } : { status: 'not-started' },
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
  const diagnosis: DiagnosisProvider = { integrity: digestJson('fixture-diagnosis'), sanitizationPolicyDigest: digestJson('fixture-sanitization'),
    inspectDiagnosis: async key => diagnoses.has(key) ? { status: 'complete', result: diagnoses.get(key)! } : { status: 'not-started' },
    diagnose: async input => {
    if (diagnoses.has(input.idempotencyKey)) return diagnoses.get(input.idempotencyKey)!
    const result = {
    facts: input.cells.filter(c => c.outcome.status === 'available' && c.outcome.rawValue < 1).map(c => ({ taskId: c.identity.taskId, evidenceRefs: [c.evidenceRef], status: 'supported-hypothesis' as const,
      familyId: `family-${Number(c.identity.taskId.slice(5)) % 4}`, hypothesis: `Repair workflow ${Number(c.identity.taskId.slice(5)) % 4}`, modificationPaths: ['harness'], mechanism: 'Explicit fixture feedback identifies omitted verification' })), inputTokens: 10, outputTokens: 10,
  }; diagnoses.set(input.idempotencyKey, result); return result } }
  const hooks: SearchExecutionHooks = { verifySnapshot: async () => {},
    inspectGeneration: async key => generations.has(key) ? { status: 'complete', result: generations.get(key)! } : { status: 'not-started' },
    generate: async ({ delivery, parent, idempotencyKey }) => {
    if (generations.has(idempotencyKey)) return generations.get(idempotencyKey)!
    generated.push(delivery.workplan.candidateId)
    const result = seal({ snapshot: snapshot(delivery.workplan.candidateId, [parent.candidateId]), changedPaths: ['harness/main.ts'],
      receipt: consumptionReceipt(delivery, 'fixture-session', delivery.workplan.requiredDiagnosisRefs), sessionId: 'fixture-session', usage: { tokens: 10, requests: 1 } })
    generations.set(idempotencyKey, result); return result
  }, commitChampion: async (_expected, next) => { if (!promotions.includes(next.commit)) promotions.push(next.commit) } }
  return { seed, heldOut, anchor, provider, diagnosis, hooks, executions, generated, promotions }
}
