import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { digestJson } from '../../src/state/digest.js'
import { comparisonKey, rational, resolveSizing, scopeEquivalenceDigest, seal, sorted, validateSettings, verifyDigest } from '../../src/search/contracts.js'
import { buildArchive, selectParents } from '../../src/search/archive.js'
import { cellIdentity, completeEvidence, profile } from '../../src/search/evidence.js'
import { FailureClusterSearch } from '../../src/search/engine.js'
import { assessGate, decideFinal, precheckSeed } from '../../src/search/promotion.js'
import { stagePlan } from '../../src/search/scopes.js'
import { SearchStore } from '../../src/search/store.js'
import { collectFailure } from '../../src/search/regression.js'
import { fixtures, settings, snapshot, universe } from '../helpers/search-fixture.js'
import type { EvaluationScope, EvidenceCell, Snapshot, StageResult, TaskUniverse } from '../../src/search/types.js'

const roots: string[] = []
async function root() { const value = await mkdtemp(join(tmpdir(), 'gear-search-test-')); roots.push(value); return value }
afterEach(async () => { await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))) })

function scored(u: TaskUniverse, s: Snapshot, values: number[], process?: Array<number | undefined>, stage: 'local' | 'global-seed' | 'held-out' = 'local', ids = u.tasks.map(t => t.id)) {
  const scopeWeights = Object.fromEntries(ids.map(id => [id, 1 / ids.length]))
  const scope: EvaluationScope = seal({ familyId: 'group', epoch: 1, universeDigest: u.digest, taskSetSizeResolutionDigest: digestJson('sizing'), buckets: { local: ids, shared: [], cross: [] }, taskIds: sorted(ids),
    weights: scopeWeights, guards: [], sampling: { local: { requested: ids.length, selected: ids.length, reasons: [] }, shared: { requested: 0, selected: 0, reasons: [] }, cross: { requested: 0, selected: 0, reasons: [] } },
    equivalenceDigest: scopeEquivalenceDigest({ universeDigest: u.digest, taskIds: ids, weights: scopeWeights, guards: [] }) })
  const plan = stagePlan({ stage, partition: u.partition, universeDigest: u.digest, taskSetSizeResolutionDigest: digestJson('sizing'), scopeDigest: scope.digest, taskIds: ids, participantIds: ['A', 'B', 'C'], prerequisiteDecisionDigests: [], selectionRuleDigest: digestJson('rule') })
  const cells: EvidenceCell[] = ids.map((id, i) => seal({ identity: cellIdentity(u, id, 0, s), status: 'available' as const, envelope: 'score-envelope-v2' as const, outcomeCertified: true,
    outcome: { status: 'available' as const, rawValue: values[i]!, contractDigest: u.tasks.find(t => t.id === id)!.outcome.digest, evidenceRef: `${s.candidateId}-${id}` },
    ...(u.tasks.find(t => t.id === id)!.process ? { process: process?.[i] === undefined ? { status: 'missing' as const, contractDigest: u.tasks.find(t => t.id === id)!.process!.digest, reason: 'fixture missing' } : { status: 'available' as const, rawValue: process[i]!, contractDigest: u.tasks.find(t => t.id === id)!.process!.digest, evidenceRef: `${s.candidateId}-${id}` } } : {}),
    evidenceRef: `${s.candidateId}-${id}`, completedAt: '2026-01-01' }))
  const result: StageResult = seal({ stagePlanDigest: plan.digest, snapshotDigest: s.digest, cells, settled: true })
  return { scope, plan, result }
}

describe('task-scale and metric contracts', () => {
  it('scales all four sets by the full universe, with exact decimal ceil', () => {
    for (const [N, expected] of [[100, [8, 4, 3, 40]], [1000, [80, 40, 30, 400]], [1, [1, 1, 1, 1]]] as const) {
      const result = resolveSizing(universe(N), settings().search.taskSetSizing)
      expect(['local', 'shared', 'cross', 'bridge'].map(k => result.quantities[k as keyof typeof result.quantities].resolved)).toEqual(expected)
      verifyDigest(result)
    }
    const config = settings().search.taskSetSizing; config.local.ratio = 0.07
    expect(resolveSizing(universe(100), config).quantities.local.resolved).toBe(7)
  })
  it('rejects invalid ratios, conflicting limits, disabled positive minima and empty universes', () => {
    for (const ratio of [NaN, Infinity, -0.1, 1.1]) { const c = settings().search.taskSetSizing; c.local.ratio = ratio; expect(() => resolveSizing(universe(10), c)).toThrow() }
    const c = settings().search.taskSetSizing; c.local = { ratio: 0.9 }; c.shared = { ratio: 0.2 }; expect(() => resolveSizing(universe(), c)).toThrow('exceed')
    c.local = { ratio: 0.08, minTasks: 5, maxTasks: 3 }; expect(() => resolveSizing(universe(), c)).toThrow()
    c.local = { ratio: 0.08 }; c.shared = { ratio: 0, minTasks: 1 }; expect(() => resolveSizing(universe(), c)).toThrow()
    expect(() => resolveSizing(universe(0), settings().search.taskSetSizing)).toThrow('empty')
  })
  it('implements transitive ties including negative decimal half boundaries', () => {
    expect(comparisonKey(rational(0.145), 0.01)).toBe(15n)
    expect(comparisonKey(-0.145, 0.01)).toBe(-14n)
    expect(comparisonKey(0.1, 0.01)).toBe(10n)
  })
  it('rejects shared content across different dataset paths in independent validation', () => {
    const seed = universe(3), held = seal({ ...universe(3), partition: 'held-out' as const })
    const { digest: old, ...body } = held; const fixed = seal(body)
    expect(() => validateSettings(settings(), seed, fixed, 4)).toThrow('overlaps')
  })
})

describe('scope archive and process compatibility', () => {
  it('retains historical A/B specialists and samples membership 2/3 and 1/3', () => {
    const u = universe(3), a = snapshot('A'), b = snapshot('B'), c = snapshot('C')
    const rows = [scored(u, a, [0.9, 0.9, 0.4]), scored(u, b, [0.5, 0.5, 1]), scored(u, c, [0.8, 0.7, 0.3])]
    const archive = buildArchive({ evolutionId: 'test', universe: u, snapshots: [a, b, c], scopes: [rows[0]!.scope], results: rows.map(r => r.result), plans: [rows[0]!.plan], config: settings().search, championId: 'A' })
    expect(archive.activeParentIds).toEqual(['A', 'B']); expect(archive.parentProbabilities.A).toBeCloseTo(2 / 3); expect(archive.parentProbabilities.B).toBeCloseTo(1 / 3)
    const next = buildArchive({ evolutionId: 'test', previous: archive, universe: u, snapshots: [], scopes: [], results: [], plans: [], config: settings().search, championId: 'A' })
    expect(next.activeParentIds).toContain('B')
    expect(selectParents(next, settings().search, 4, 'round')).toEqual(selectParents(next, settings().search, 4, 'round'))
  })
  it('does not invent specialism for identical scores and keeps qualified champion fallback', () => {
    const u = universe(3), a = snapshot('A'), b = snapshot('B'), ar = scored(u, a, [0, 0, 0]), br = scored(u, b, [0, 0, 0])
    const archive = buildArchive({ evolutionId: 'test', universe: u, snapshots: [a, b], scopes: [ar.scope], results: [ar.result, br.result], plans: [ar.plan], config: settings().search, championId: 'B' })
    expect(archive.parentProbabilities).toEqual({ B: 1 }); expect(archive.scopeViews[0]!.fronts.every(f => !f.informative)).toBe(true)
  })
  it('treats 15/100 as a complete local scope with 85 unplanned cells', () => {
    const u = universe(), a = snapshot('A'), row = scored(u, a, Array(15).fill(1), undefined, 'local', u.tasks.slice(0, 15).map(t => t.id))
    const p = profile(u, row.plan, a, row.result, 'auto')
    expect(p.outcomeComplete).toBe(true); expect(p.coverage).toMatchObject({ planned: 15, available: 15, notEvaluated: 85, missing: 0 })
  })
  it('preserves independently certified outcome when process is missing, and never rescues legacy invalid', () => {
    const u = universe(2, 'seed', true), a = snapshot('A'), row = scored(u, a, [1, 0], [0, undefined])
    const p = profile(u, row.plan, a, row.result, 'auto')
    expect(p.outcomeComplete).toBe(true); expect(p.processComplete).toBe(false); expect(p.tasks[0]!.process).toBe(0)
    expect(profile(u, row.plan, a, row.result, 'off').processComplete).toBe(true)
    const { digest: ignored, ...body } = row.result.cells[1]!; const legacy = seal({ ...body, envelope: 'legacy-v1' as const })
    const result = seal({ stagePlanDigest: row.plan.digest, snapshotDigest: a.digest, cells: [row.result.cells[0]!, legacy], settled: true })
    expect(() => profile(u, row.plan, a, result, 'off')).toThrow('legacy invalid')
  })
  it('forbids completion from replacing a valid zero or replaying its process lottery', () => {
    const u = universe(1, 'seed', true), a = snapshot('A'), row = scored(u, a, [0], [undefined])
    const newer = scored(u, a, [1], [1]).result.cells
    expect(() => completeEvidence(row.result, newer)).toThrow('valid outcome')
  })
})

describe('multisignal gates', () => {
  it('requires outcome and process non-regression, and allows either strict gain', () => {
    const u = universe(2, 'seed', true), a = snapshot('A'), b = snapshot('B'), base = scored(u, a, [1, 0], [0.5, 0.5], 'global-seed')
    const run = (values: number[], partial: number[]) => precheckSeed({ universe: u, plan: base.plan, anchor: a, candidate: b, baseline: base.result, result: scored(u, b, values, partial, 'global-seed').result }, settings().promotion)
    expect(run([1, 0], [0.6, 0.6]).outcome).toBe('eligible')
    expect(run([0, 0], [1, 1]).reasonCodes).toContain('outcome-regression')
    expect(run([1, 1], [0.4, 0.4]).reasonCodes).toContain('process-regression:process')
    expect(run([1, 0], [0.4, 0.4]).reasonCodes).toContain('process-regression:process')
  })
  it('requires strict improvement with outcome only, preserving legacy gates separately', () => {
    const u = universe(2), a = snapshot('A'), b = snapshot('B'), ar = scored(u, a, [0, 0], undefined, 'global-seed')
    const input = { universe: u, plan: ar.plan, anchor: a, candidate: b, baseline: ar.result, result: scored(u, b, [0, 0], undefined, 'global-seed').result }
    expect(precheckSeed(input, settings().promotion).outcome).toBe('rejected')
    expect(precheckSeed({ ...input, result: scored(u, b, [1, 0], undefined, 'global-seed').result }, settings().promotion).outcome).toBe('eligible')
  })
  it('keeps missing process as insufficient evidence unless explicitly off', () => {
    const u = universe(1, 'seed', true), a = snapshot('A'), b = snapshot('B'), ar = scored(u, a, [0], [1], 'global-seed'), br = scored(u, b, [1], [undefined], 'global-seed')
    const input = { universe: u, plan: ar.plan, anchor: a, candidate: b, baseline: ar.result, result: br.result }
    expect(precheckSeed(input, settings().promotion).outcome).toBe('insufficient-evidence')
    const policy = settings().promotion; policy.process.mode = 'off'; expect(precheckSeed(input, policy).outcome).toBe('eligible')
  })
})

describe('durable staged search', () => {
  for (const process of [false, true]) it(`runs full 4→2→1 search with ${process ? 'process' : 'outcome-only'} evidence and reuses valid cells`, async () => {
    const f = fixtures(), journal = new SearchStore(await root())
    const fixture = process ? fixtures(100, true) : f
    const engine = new FailureClusterSearch(journal, fixture.provider, fixture.diagnosis, fixture.hooks)
    const request = { evolutionId: 'experiment', roundId: 'round-1', roundIndex: 0, maxCandidates: 4, anchor: fixture.anchor, championRevisionDigest: digestJson('champion-revision'), settings: settings() }
    const result = await engine.run(request, new AbortController().signal)
    expect(result.championChanged).toBe(true); expect(fixture.generated).toHaveLength(4)
    expect(fixture.executions.filter(e => e.participant !== 'anchor' && e.stage !== 'held-out').reduce((sum, e) => sum + e.count, 0)).toBe(170)
    expect(fixture.promotions).toHaveLength(1)
    const before = fixture.executions.length
    expect((await engine.run(request, new AbortController().signal)).digest).toBe(result.digest)
    expect(fixture.executions.length).toBe(before); expect(fixture.generated).toHaveLength(4)
    const archive = await journal.archive(); expect(archive!.plans.every(p => p.partition === 'seed')).toBe(true)
  })
  it('rejects unsupported providers before any evaluation or generation', async () => {
    const f = fixtures(); f.provider.capabilities.taskSubsetPlans = false
    const engine = new FailureClusterSearch(new SearchStore(await root()), f.provider, f.diagnosis, f.hooks)
    await expect(engine.run({ evolutionId: 'test', roundId: 'r', roundIndex: 0, maxCandidates: 4, anchor: f.anchor, championRevisionDigest: digestJson('r'), settings: settings() }, new AbortController().signal)).rejects.toThrow('subset')
    expect(f.executions).toHaveLength(0); expect(f.generated).toHaveLength(0)
  })
  it('commits local research when bridge is disabled without publishing', async () => {
    const f = fixtures(), config = settings(); config.search.taskSetSizing.bridge.ratio = 0
    const journal = new SearchStore(await root()), engine = new FailureClusterSearch(journal, f.provider, f.diagnosis, f.hooks)
    const result = await engine.run({ evolutionId: 'test', roundId: 'r', roundIndex: 0, maxCandidates: 4, anchor: f.anchor, championRevisionDigest: digestJson('r'), settings: config }, new AbortController().signal)
    expect(result.championChanged).toBe(false); expect(result.reasonCodes).toContain('no-bridge-quota'); expect(f.executions.every(e => e.stage !== 'held-out')).toBe(true)
    expect((await journal.archive())!.snapshots).toHaveLength(5)
  })
  it('recovers an archive CAS followed by a champion CAS crash without repeated rollouts', async () => {
    const f = fixtures(); let fail = true
    const hooks = { ...f.hooks, commitChampion: async (...args: Parameters<typeof f.hooks.commitChampion>) => { if (fail) { fail = false; throw new Error('crash') } await f.hooks.commitChampion(...args) } }
    const journal = new SearchStore(await root()), engine = new FailureClusterSearch(journal, f.provider, f.diagnosis, hooks)
    const request = { evolutionId: 'test', roundId: 'r', roundIndex: 0, maxCandidates: 4, anchor: f.anchor, championRevisionDigest: digestJson('r'), settings: settings() }
    await expect(engine.run(request, new AbortController().signal)).rejects.toThrow('crash')
    const calls = f.executions.length
    expect((await engine.run(request, new AbortController().signal)).championChanged).toBe(true)
    expect(f.executions.length).toBe(calls); expect(f.generated).toHaveLength(4)
  })
  for (const point of ['cell-pointer', 'diagnosis-pointer'] as const) it(`recovers a settled operation interrupted at ${point} with its original request`, async () => {
    const f = fixtures(20), journal = new SearchStore(await root()), write = journal.write.bind(journal)
    const diagnose = f.diagnosis.diagnose.bind(f.diagnosis)
    let diagnosisCalls = 0, fail = true
    f.diagnosis.diagnose = async input => { diagnosisCalls++; return diagnose(input) }
    journal.write = async (name, value) => {
      if (fail && point === 'diagnosis-pointer' && /^rounds\/r\/diagnosis-[a-f0-9]+$/u.test(name)) { fail = false; throw new Error('injected crash') }
      await write(name, value)
      if (fail && point === 'cell-pointer' && name.startsWith('cells/')) { fail = false; throw new Error('injected crash') }
    }
    const engine = new FailureClusterSearch(journal, f.provider, f.diagnosis, f.hooks)
    const request = { evolutionId: 'test', roundId: 'r', roundIndex: 0, maxCandidates: 1, anchor: f.anchor, championRevisionDigest: digestJson('r'), settings: settings() }
    await expect(engine.run(request, new AbortController().signal)).rejects.toThrow('injected crash')
    expect((await engine.run(request, new AbortController().signal)).championChanged).toBe(true)
    expect(f.executions.filter(e => e.participant === 'anchor' && e.stage !== 'held-out').reduce((sum, e) => sum + e.count, 0)).toBe(20)
    expect(diagnosisCalls).toBe(1); expect(f.generated).toHaveLength(1)
  })
})

it('failure collection leaves prompt-only proposals unmaterialized and excludes held-out and credentials', () => {
  const base = { source: { kind: 'online-feedback' as const, evidenceRef: 'observed-failure' }, outcome: 'business-failure' as const, prompt: 'Fix empty token handling', fixtureRefs: [], expectedBehavior: 'Reject empty tokens', failureCategory: 'validation' }
  const config = { collectFailures: true, maxProposals: 50 }
  expect(collectFailure(base, [], config).proposal?.status).toBe('needs-fixture')
  expect(collectFailure({ ...base, source: { ...base.source, kind: 'held-out' } }, [], config).reason).toBe('held-out-isolation')
  expect(collectFailure({ ...base, prompt: 'api_key=abc12345' }, [], config).reason).toBe('sensitive-content')
})

it('scales the full staged fixture to 1,000 seed tasks and exactly 1,700 candidate seed cells', async () => {
  const f = fixtures(1000), config = settings()
  const engine = new FailureClusterSearch(new SearchStore(await root()), f.provider, f.diagnosis, f.hooks)
  const result = await engine.run({ evolutionId: 'large', roundId: 'r', roundIndex: 0, maxCandidates: 4, anchor: f.anchor, championRevisionDigest: digestJson('revision'), settings: config }, new AbortController().signal)
  expect(result.championChanged).toBe(true)
  expect(f.executions.filter(e => e.participant !== 'anchor' && e.stage !== 'held-out').reduce((sum, e) => sum + e.count, 0)).toBe(1700)
  expect(Object.values(result.research.parentProbabilities).every(Number.isFinite)).toBe(true)
}, 90_000)

it('completes only the invalid historical slot without changing valid zero outcomes or old snapshots', async () => {
  const { completeArchivedEvidence } = await import('../../src/search/completion.js')
  const u = universe(2), a = snapshot('A'), row = scored(u, a, [0, 0])
  const { digest: discarded, ...cell } = row.result.cells[1]!
  const invalid = seal({ ...cell, status: 'invalid' as const, outcomeCertified: false, outcome: { status: 'invalid' as const, contractDigest: cell.identity.outcomeContractDigest, reason: 'infrastructure' } })
  const original = seal({ stagePlanDigest: row.plan.digest, snapshotDigest: a.digest, cells: [row.result.cells[0]!, invalid], settled: true })
  const before = JSON.stringify(original), f = fixtures(2), journal = new SearchStore(await root())
  const result = await completeArchivedEvidence({ id: 'repair', store: journal, provider: f.provider, universe: u, plan: row.plan, snapshot: a, original, settings: settings(), signal: new AbortController().signal })
  const completed = await journal.object<StageResult>(result.completedResultDigest)
  expect(completed.cells[0]).toEqual(original.cells[0]); expect(JSON.stringify(original)).toBe(before)
  expect(completed.supersedesEvidenceDigest).toBe(original.digest)
  expect(f.executions.reduce((sum, e) => sum + e.count, 0)).toBe(1)
  expect(profile(u, row.plan, a, completed, 'auto').outcomeComplete).toBe(true)
  f.provider.integrity = digestJson('changed-provider')
  await expect(completeArchivedEvidence({ id: 'repair', store: journal, provider: f.provider, universe: u, plan: row.plan, snapshot: a, original, settings: settings(), signal: new AbortController().signal })).rejects.toThrow('identity changed')
})

it('repairs only held-out invalid cells after research freeze, retaining finalist and seed archive', async () => {
  const f = fixtures(20), journal = new SearchStore(await root()), originalEvaluate = f.provider.evaluate.bind(f.provider)
  let invalidate = true
  f.provider.evaluate = async input => {
    const cells = await originalEvaluate(input)
    if (invalidate && input.plan.partition === 'held-out' && input.snapshot.candidateId !== 'anchor') {
      invalidate = false
      const { digest: old, ...first } = cells[0]!
      return [seal({ ...first, status: 'invalid' as const, outcomeCertified: false, outcome: { status: 'invalid' as const, reason: 'temporary infrastructure failure', contractDigest: first.identity.outcomeContractDigest } }), ...cells.slice(1)]
    }
    return cells
  }
  const engine = new FailureClusterSearch(journal, f.provider, f.diagnosis, f.hooks)
  const request = { evolutionId: 'held-repair', roundId: 'r', roundIndex: 0, maxCandidates: 1, anchor: f.anchor, championRevisionDigest: digestJson('revision'), settings: settings() }
  await expect(engine.run(request, new AbortController().signal)).rejects.toThrow('needs evidence repair')
  const research = await journal.read<{ ref: string }>('rounds/r/research')
  const pending = await journal.read<{ resultRefs: string[] }>('rounds/r/pending-evidence')
  const before = f.executions.filter(e => e.stage !== 'held-out').length
  const providerIntegrity = f.provider.integrity
  f.provider.integrity = digestJson('changed-provider')
  await expect(engine.repairEvaluation('r', 'retry-1', pending!.resultRefs[1]!, new AbortController().signal)).rejects.toThrow('provider identity changed')
  f.provider.integrity = providerIntegrity
  const write = journal.write.bind(journal)
  let fail = true
  journal.write = async (name, value) => {
    await write(name, value)
    if (fail && /^rounds\/r\/repair-[a-f0-9]{64}$/u.test(name)) { fail = false; throw new Error('repair pointer crash') }
  }
  await expect(engine.repairEvaluation('r', 'retry-1', pending!.resultRefs[1]!, new AbortController().signal)).rejects.toThrow('repair pointer crash')
  const repairedCalls = f.executions.length
  await engine.repairEvaluation('r', 'retry-1', pending!.resultRefs[1]!, new AbortController().signal)
  expect(f.executions).toHaveLength(repairedCalls)
  await expect(engine.repairEvaluation('r', 'retry-1', pending!.resultRefs[0]!, new AbortController().signal)).rejects.toThrow('repair ID reused')
  const outcome = await engine.run(request, new AbortController().signal)
  expect(outcome.championChanged).toBe(true); expect(outcome.archiveDigest).toBe(research!.ref)
  expect(f.executions.filter(e => e.stage !== 'held-out')).toHaveLength(before)
  expect(f.generated).toHaveLength(1)
  expect(f.executions.filter(e => e.stage === 'held-out').at(-1)!.count).toBe(1)
})

it('resolves opt-in config without admitting legacy policy fields into the v2 schema', async () => {
  const { resolveSearchSettings } = await import('../../src/search/config.js')
  const config = settings()
  const resolved = resolveSearchSettings({ search: config.search, budgets: config.budgets, promotion: { ...config.promotion, minimumCandidateScore: 0.7, minimumAbsoluteGain: 0.1, requireNoRegression: true, maxHeldOutRegression: 0, maxRequiredRegressions: 0 } })!
  expect(() => validateSettings(resolved, universe(10), universe(2, 'held-out'), 4)).not.toThrow()
  expect(resolveSearchSettings({ promotion: {} })).toBeUndefined()
})

it('keeps shared-set validation advisory and never changes champion', async () => {
  const f = fixtures(20), config = settings(); config.promotion.validationMode = 'shared-set-research'
  const engine = new FailureClusterSearch(new SearchStore(await root()), f.provider, f.diagnosis, f.hooks)
  const result = await engine.run({ evolutionId: 'advisory', roundId: 'r', roundIndex: 0, maxCandidates: 1, anchor: f.anchor, championRevisionDigest: digestJson('revision'), settings: config }, new AbortController().signal)
  expect(result.promotion?.outcome).toBe('accepted'); expect(result.advisory).toBe(true); expect(result.championChanged).toBe(false); expect(f.promotions).toEqual([])
})

it('updates a shared-set research champion only with explicit promotion authorization', async () => {
  const { resolveSearchSettings } = await import('../../src/search/config.js')
  const f = fixtures(20), config = settings()
  config.promotion.validationMode = 'shared-set-research'
  config.promotion.allowSharedSetPromotion = true
  const resolved = resolveSearchSettings(config)!
  expect(resolved.promotion.allowSharedSetPromotion).toBe(true)
  const engine = new FailureClusterSearch(new SearchStore(await root()), f.provider, f.diagnosis, f.hooks)
  const request = { evolutionId: 'research-promotion', roundId: 'r', roundIndex: 0, maxCandidates: 1, anchor: f.anchor, championRevisionDigest: digestJson('revision'), settings: resolved }
  const result = await engine.run(request, new AbortController().signal)
  expect(result.promotion?.outcome).toBe('accepted')
  expect(result.advisory).toBe(false)
  expect(result.validationMode).toBe('shared-set-research')
  expect(result.championChanged).toBe(true)
  expect(f.promotions).toHaveLength(1)
  expect(await engine.run(request, new AbortController().signal)).toEqual(result)
  expect(f.promotions).toHaveLength(1)
})

it('keeps operator promotion details and held-out repair refs out of research status', async () => {
  const { seedOnlyStatus } = await import('../../src/search/public-status.js')
  const publicStatus = seedOnlyStatus({ searchPendingOperation: { operationKey: 'private-key', kind: 'evaluation', partition: 'held-out', stagePlanDigest: 'private-plan', candidateId: 'private-candidate', state: 'running', handle: 'private-handle', reason: 'private-reason' }, evolutionId: 'test', batchId: 'batch', roundId: 'r', status: 'accepted',
    searchPendingEvidence: { planDigest: 'held-out-private', resultRefs: ['held-out-results'] },
    search: { promotion: { secretHeldOutValue: 0.6 }, research: { remainingBudget: { cells: 7 }, parentProbabilities: { A: 1 } } } as never })
  expect(publicStatus).toEqual({ evolutionId: 'test', batchId: 'batch', roundId: 'r', status: 'accepted', research: { parentProbabilities: { A: 1 } } })
})
