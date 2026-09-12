import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { digestJson } from '../../src/state/digest.js'
import { buildArchive, selectParents } from '../../src/search/archive.js'
import { cellIdentity, cellKey, completeEvidence, profile } from '../../src/search/evidence.js'
import { FailureClusterSearch } from '../../src/search/engine.js'
import { SearchStore } from '../../src/search/store.js'
import { resolveSizing, sorted, validateSettings } from '../../src/search/contracts.js'
import { bridgeSelection } from '../../src/search/scopes.js'
import type { ResearchArchive, TaskUniverse } from '../../src/search/types.js'
import { evaluatedFixture, fixtures, revise, scopeFixture, settings, snapshot, universe } from '../helpers/search-fixture.js'

type Row = ReturnType<typeof evaluatedFixture>
const config = () => settings().search
function archive(u: TaskUniverse, snapshots: ReturnType<typeof snapshot>[], rows: Row[], championId = 'A', previous?: ResearchArchive) {
  return buildArchive({ evolutionId: 'acceptance', ...(previous ? { previous } : {}), universe: u, snapshots,
    scopes: rows.map(r => r.scope), plans: rows.map(r => r.plan), results: rows.map(r => r.result), config: config(), championId })
}
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('archive acceptance: immutable scope evidence', () => {
  it('[A02] removes joint redundancy while preserving every informative frontier', () => {
    const u = universe(3), scope = scopeFixture(u, u.tasks.map(t => t.id))
    const candidates = ['A', 'B', 'C', 'D'].map(id => snapshot(id))
    const values = [[1, 1, 0], [1, 0, 1], [0, 1, 1], [0.7, 0.7, 0.7]]
    const rows = candidates.map((s, c) => evaluatedFixture(u, scope, s, id => ({ outcome: values[c]![Number(id.slice(5))]! })))
    const result = archive(u, candidates, rows)
    expect(result.activeParentIds).toEqual(['B', 'C'])
    expect(result.parentProbabilities).toEqual({ B: 0.5, C: 0.5 })
    expect(result.scopeViews[0]!.prunedIds).toEqual(['A', 'D'])
    for (const front of result.scopeViews[0]!.fronts.filter(f => f.informative)) expect(front.candidateIds.some(id => result.activeParentIds.includes(id))).toBe(true)
    expect(archive(u, candidates, rows).digest).toBe(result.digest)
  })

  for (const value of [0, 1, 0.5]) it(`[A03] uses qualified champion fallback at constant ${value}`, () => {
    const u = universe(2), scope = scopeFixture(u, u.tasks.map(t => t.id)), a = snapshot('A'), b = snapshot('B')
    const rows = [a, b].map(s => evaluatedFixture(u, scope, s, () => ({ outcome: value })))
    const result = archive(u, [a, b], rows, 'B')
    expect(result.parentProbabilities).toEqual({ B: 1 })
    expect(result.scopeViews[0]!.fronts.every(f => !f.informative)).toBe(true)
  })
  it('[A03,M05] uses canonical ID after aggregate quantization, without a raw-float fallback', () => {
    const u = universe(2), scope = scopeFixture(u, u.tasks.map(t => t.id)), a = snapshot('A'), b = snapshot('B')
    const rows = [evaluatedFixture(u, scope, a, () => ({ outcome: 0.5 })), evaluatedFixture(u, scope, b, () => ({ outcome: 0.5000001 }))]
    expect(archive(u, [a, b], rows, 'champion-outside-scope').parentProbabilities).toEqual({ A: 1 })
  })

  it('[A03,A08] never bypasses an exploration guard to invent an eligible parent', async () => {
    const u = universe(2), a = snapshot('A')
    const scope = scopeFixture(u, ['task-0'], 'protected', 1, [{ taskId: 'task-1', partition: 'seed', rule: 'must-pass' }])
    const result = archive(u, [a], [evaluatedFixture(u, scope, a, () => ({ outcome: 0 }))])
    expect(result.activeParentIds).toEqual([])
    expect(() => selectParents(result, config(), 1, 'r')).toThrow('blocked-no-eligible-parent')
    const f = fixtures(20), limits = settings()
    limits.search.explorationGuards = [{ taskId: 'task-0', partition: 'seed', rule: 'must-pass' }]
    const root = await mkdtemp(join(tmpdir(), 'gear-acceptance-')); roots.push(root)
    const engine = new FailureClusterSearch(new SearchStore(root), f.provider, f.diagnosis, f.hooks)
    await expect(engine.run({ evolutionId: 'guarded', roundId: 'r', roundIndex: 0, maxCandidates: 1, anchor: f.anchor,
      championRevisionDigest: digestJson('revision'), settings: limits }, new AbortController().signal)).rejects.toThrow('bootstrap baseline')
    expect(f.generated).toEqual([]); expect(f.promotions).toEqual([])
  })

  it('[A06] retains both lineages but never selects the better random score of an identical tree', () => {
    const u = universe(2), scope = scopeFixture(u, u.tasks.map(t => t.id)), tree = 'a'.repeat(40)
    const a = snapshot('A', [], tree), b = snapshot('B', ['A'], tree), c = snapshot('C')
    const rows = [evaluatedFixture(u, scope, a, () => ({ outcome: 0 })), evaluatedFixture(u, scope, b, () => ({ outcome: 1 }), { completedAt: '2026-01-02T00:00:00Z' }),
      evaluatedFixture(u, scope, c, () => ({ outcome: 0.5 }))]
    const result = archive(u, [a, b, c], rows)
    expect(result.scopeViews[0]!.representatives.B).toBe('A')
    expect(result.activeParentIds).toEqual(['C'])
    expect(result.snapshots.find(s => s.candidateId === 'B')).toEqual(b)
    expect(result.results).toContainEqual(rows[1]!.result)
  })

  it('[A10,A11] keeps outer family weight independent of scope size, difficulty and extra evaluations', () => {
    const u = universe(4), a = snapshot('A'), b = snapshot('B')
    const hard = scopeFixture(u, ['task-0', 'task-1'], 'hard'), easy = scopeFixture(u, ['task-2'], 'easy')
    const rows = [evaluatedFixture(u, hard, a, () => ({ outcome: 0.1 })), evaluatedFixture(u, hard, b, () => ({ outcome: 0.2 })),
      evaluatedFixture(u, easy, a, () => ({ outcome: 1 })), evaluatedFixture(u, easy, b, () => ({ outcome: 0 }))]
    const first = archive(u, [a, b], rows)
    expect(first.parentProbabilities).toEqual({ A: 0.5, B: 0.5 })
    expect(Object.values(first.scopeProbabilities)).toEqual([0.5, 0.5])
    const full = evaluatedFixture(u, scopeFixture(u, u.tasks.map(t => t.id), 'global'), a,
      id => ({ outcome: id === 'task-2' || id === 'task-3' ? 1 : 0.1 }), { stage: 'global-seed' })
    const next = buildArchive({ evolutionId: 'acceptance', previous: first, universe: u, snapshots: [], scopes: [], results: [full.result], plans: [full.plan], config: config(), championId: 'A' })
    expect(next.parentProbabilities).toEqual(first.parentProbabilities)
    expect(next.scopeProbabilities).toEqual(first.scopeProbabilities)
  })

  it('[A11] merges renamed equivalent scopes and their evidence without increasing outer weight', () => {
    const u = universe(2), a = snapshot('A'), b = snapshot('B')
    const original = scopeFixture(u, ['task-0', 'task-1'], 'original')
    const alias = revise(original, { familyId: 'renamed' })
    const first = evaluatedFixture(u, original, a, id => ({ outcome: id === 'task-0' ? 1 : 0 }))
    const second = evaluatedFixture(u, alias, b, id => ({ outcome: id === 'task-1' ? 1 : 0 }))
    const result = archive(u, [a, b], [first, second])
    expect(Object.values(result.scopeProbabilities)).toEqual([1])
    expect(result.parentProbabilities).toEqual({ A: 0.5, B: 0.5 })
    expect(result.scopeViews.every(v => v.outcomeEligibleIds.length === 2)).toBe(true)
    const forged = revise(alias, { equivalenceDigest: digestJson('invented-equivalence') })
    expect(() => archive(u, [a], [evaluatedFixture(u, forged, a, () => ({ outcome: 1 }))])).toThrow('equivalence identity')
  })

  it('[A09,A11] rejects a shortened plan masquerading as a complete scope', () => {
    const u = universe(3), a = snapshot('A'), scope = scopeFixture(u, ['task-0', 'task-1', 'task-2'])
    const row = evaluatedFixture(u, scope, a, () => ({ outcome: 1 }), { taskIds: ['task-0'] })
    expect(profile(u, row.plan, a, row.result, 'auto').outcomeComplete).toBe(true)
    expect(() => archive(u, [a], [row])).toThrow('does not cover its complete scope')
  })

  it('[A06,R10] rejects conflicting valid outcomes across different immutable plans', () => {
    const u = universe(2), a = snapshot('A'), scope = scopeFixture(u, ['task-0'])
    const first = evaluatedFixture(u, scope, a, () => ({ outcome: 0 }))
    const second = evaluatedFixture(u, scope, a, () => ({ outcome: 1 }), { participants: ['A', 'B'] })
    expect(() => archive(u, [a], [first, second])).toThrow('replace a valid outcome')
  })
  it('[M04,R07,R10] retains a complete process revision when an older incomplete view is also archived', () => {
    const u = universe(2, 'seed', true), a = snapshot('A'), scope = scopeFixture(u, ['task-0', 'task-1'])
    const missing = evaluatedFixture(u, scope, a, () => ({ outcome: 0 }))
    const available = evaluatedFixture(u, scope, a, () => ({ outcome: 0, process: 0.5 }))
    const completed = { ...missing, result: completeEvidence(missing.result, available.result.cells) }
    const first = archive(u, [a], [missing, completed]), bytes = JSON.stringify(first)
    const oldView = evaluatedFixture(u, scope, a, () => ({ outcome: 0 }), { participants: ['A', 'B'] })
    const next = archive(u, [], [oldView], 'A', first)
    expect(next.scopeViews[0]!.processEligibleIds).toEqual(['A'])
    expect(next.scopeViews[0]!.pendingEvidenceIds).toEqual([])
    expect(next.results).toContainEqual(oldView.result)
    expect(next.results).toContainEqual(completed.result)
    expect(JSON.stringify(first)).toBe(bytes)
  })

  it('[A12] preserves the old epoch until new evidence qualifies, then activates only one epoch', () => {
    const u = universe(3), a = snapshot('A')
    const old = evaluatedFixture(u, scopeFixture(u, ['task-0'], 'family', 1), a, () => ({ outcome: 1 }))
    const pending = evaluatedFixture(u, scopeFixture(u, ['task-1', 'task-2'], 'family', 2), a, () => undefined)
    const first = archive(u, [a], [old]), bytes = JSON.stringify(first)
    const second = archive(u, [], [pending], 'A', first)
    expect(Object.keys(second.scopeProbabilities)).toEqual([old.scope.digest])
    const cells = evaluatedFixture(u, pending.scope, a, () => ({ outcome: 0.5 })).result.cells
    const completed = { ...pending, result: completeEvidence(pending.result, cells) }
    const third = archive(u, [], [completed], 'A', second)
    expect(Object.keys(third.scopeProbabilities)).toEqual([pending.scope.digest])
    expect(third.scopes).toHaveLength(2); expect(third.results).toContainEqual(pending.result)
    expect(JSON.stringify(first)).toBe(bytes)
    const rewrittenEpoch = revise(pending.scope, { sampling: { ...pending.scope.sampling, local: { ...pending.scope.sampling.local, reasons: ['rewritten'] } } })
    expect(() => archive(u, [], [{ ...pending, scope: rewrittenEpoch }], 'A', second)).toThrow('epoch manifest changed')
  })
})

describe('expansion acceptance: common plans and exact remaining budget', () => {
  it('[E02,E04] admits two bridge candidates using only their missing cells at the exact budget limit', async () => {
    const f = fixtures(100), limits = settings(), root = await mkdtemp(join(tmpdir(), 'gear-bridge-acceptance-')); roots.push(root)
    limits.budgets.round.maxNewRolloutCells = 210
    const evaluate = f.provider.evaluate.bind(f.provider), bridgePlans: string[][] = []
    f.provider.evaluate = async input => {
      if (input.plan.stage === 'bridge') {
        bridgePlans.push(input.plan.taskIds)
        expect(input.plan.participantIds).toHaveLength(3)
        expect(input.plan.participantIds).toContain('anchor')
      }
      return evaluate(input)
    }
    const journal = new SearchStore(root), engine = new FailureClusterSearch(journal, f.provider, f.diagnosis, f.hooks)
    const result = await engine.run({ evolutionId: 'tight-budget', roundId: 'r', roundIndex: 0, maxCandidates: 4,
      anchor: f.anchor, championRevisionDigest: digestJson('revision'), settings: limits }, new AbortController().signal)
    const bridge = f.executions.filter(e => e.stage === 'bridge' && e.participant !== 'anchor')
    expect(bridge.map(e => e.count)).toEqual([25, 25])
    expect(bridgePlans).toHaveLength(2); expect(bridgePlans[0]).toHaveLength(40); expect(bridgePlans[1]).toEqual(bridgePlans[0])
    expect(f.executions.reduce((sum, e) => sum + e.count, 0)).toBe(210)
    expect(result.reasonCodes).toContain('budget-exhausted:round.cells')
    expect(result.championChanged).toBe(false); expect(f.promotions).toEqual([])
    expect(result.nomineeId).toBeDefined()
    expect(f.executions.every(e => e.stage !== 'held-out')).toBe(true)
    expect((await journal.archive())!.snapshots).toHaveLength(5)
    expect(result.research.bridge.exclusions.filter(e => e.reason === 'group-quota')).toHaveLength(2)
  })

  it('[E03,E11] reduces group quota to fit the full scope union and retains every required guard', async () => {
    const u = universe(10), c = config(); c.taskSetSizing.bridge.ratio = 0.5
    const a = scopeFixture(u, ['task-0', 'task-1', 'task-2'], 'a'), b = scopeFixture(u, ['task-3', 'task-4', 'task-5'], 'b')
    const before = JSON.stringify([a, b]), costs: Array<{ ids: string[]; tasks: string[] }> = []
    const result = await bridgeSelection(u, resolveSizing(u, c.taskSetSizing), c, 0, [{ candidateId: 'A', scope: a }, { candidateId: 'B', scope: b }], 'anchor', ['task-9'], (ids, tasks) => { costs.push({ ids, tasks }); return true })
    expect(result.plan!.participantIds).toEqual(['A', 'anchor'])
    expect(result.plan!.taskIds).toHaveLength(5)
    for (const id of [...a.taskIds, 'task-9']) expect(result.plan!.taskIds).toContain(id)
    expect(result.exclusions).toEqual([{ candidateId: 'B', scopeDigest: b.digest, reason: 'bridge-capacity' }])
    expect(costs).toHaveLength(1); expect(JSON.stringify([a, b])).toBe(before)
    const noCapacity = await bridgeSelection(u, resolveSizing(u, c.taskSetSizing), c, 0, [{ candidateId: 'A', scope: a }], 'anchor', ['task-6', 'task-7', 'task-8'], () => { throw new Error('capacity must be checked before executing or allocating'); })
    expect(noCapacity.plan).toBeUndefined()
    expect(noCapacity.exclusions[0]!.reason).toBe('bridge-capacity')
  })

  it('[A10,E03] rotates group quotas deterministically and distinguishes capacity from cost', async () => {
    const u = universe(10), c = config(); c.evaluationStages.bridge.maxCandidates = 1
    const nominees = ['a', 'b', 'c'].map((family, i) => ({ candidateId: family.toUpperCase(), scope: scopeFixture(u, [`task-${i}`], family) }))
    for (let index = 0; index < 3; index++) {
      const result = await bridgeSelection(u, resolveSizing(u, c.taskSetSizing), c, index, nominees, 'anchor', [], () => true)
      expect(result.plan!.participantIds).toContain(nominees[index]!.candidateId)
      expect(result.exclusions).toHaveLength(2)
      expect(result.exclusions.every(e => e.reason === 'group-quota')).toBe(true)
    }
    const unaffordable = await bridgeSelection(u, resolveSizing(u, c.taskSetSizing), c, 0, nominees, 'anchor', [], async () => false)
    expect(unaffordable.plan).toBeUndefined()
    expect(unaffordable.exclusions.find(e => e.candidateId === 'A')!.reason).toBe('bridge-budget')
  })
})

describe('recovery acceptance: execution and evolution identity', () => {
  for (const phase of ['diagnosis', 'workplans'] as const) it(`[R10] forbids repair after ${phase} consumes evidence, even before the next stage starts`, async () => {
    const f = fixtures(20), root = await mkdtemp(join(tmpdir(), 'gear-consumed-acceptance-')); roots.push(root)
    const journal = new SearchStore(root), write = journal.write.bind(journal)
    let pointerName = '', interrupt = true
    journal.write = async (name, value) => {
      await write(name, value)
      const matches = phase === 'diagnosis' ? /^rounds\/r\/diagnosis-[a-f0-9]+$/u.test(name) : name === 'rounds/r/planning'
      if (interrupt && matches) { interrupt = false; pointerName = name; throw new Error('consumer sealed before interruption') }
    }
    const engine = new FailureClusterSearch(journal, f.provider, f.diagnosis, f.hooks)
    const request = { evolutionId: 'consumption', roundId: 'r', roundIndex: 0, maxCandidates: 1,
      anchor: f.anchor, championRevisionDigest: digestJson('revision'), settings: settings() }
    await expect(engine.run(request, new AbortController().signal)).rejects.toThrow('consumer sealed')
    const pointer = await journal.read<{ ref: string }>(pointerName)
    const consumer = await journal.object<{ digest: string; baselineEvidenceDigests?: string[]; works?: Array<{ baseline: { digest: string } }> }>(pointer!.ref)
    const evidence = phase === 'diagnosis' ? consumer.baselineEvidenceDigests![0]! : consumer.works![0]!.baseline.digest
    expect(await journal.read('rounds/r/local')).toBeUndefined()
    await expect(engine.repairEvaluation('r', 'late-repair', evidence, new AbortController().signal)).rejects.toThrow('stage already consumed')
    expect(f.generated).toEqual([])
    expect((await engine.run(request, new AbortController().signal)).championChanged).toBe(true)
  })

  it('[R01,A06] reuses exact-commit cells across candidate roles while retaining their original provenance', async () => {
    const f = fixtures(20), root = await mkdtemp(join(tmpdir(), 'gear-identity-acceptance-')); roots.push(root)
    const generate = f.hooks.generate
    f.hooks.generate = async input => {
      const candidate = await generate(input)
      return revise(candidate, { snapshot: revise(candidate.snapshot!, { commit: f.anchor.commit, tree: f.anchor.tree,
        manifestDigest: f.anchor.manifestDigest }), changedPaths: [] })
    }
    const journal = new SearchStore(root), engine = new FailureClusterSearch(journal, f.provider, f.diagnosis, f.hooks)
    const result = await engine.run({ evolutionId: 'roles', roundId: 'r', roundIndex: 0, maxCandidates: 1,
      anchor: f.anchor, championRevisionDigest: digestJson('revision'), settings: settings() }, new AbortController().signal)
    expect(f.executions).toHaveLength(1); expect(f.executions[0]).toMatchObject({ participant: 'anchor', count: 20 })
    expect(f.generated).toHaveLength(1); expect(result.championChanged).toBe(false)
    const saved = (await journal.archive())!, candidate = saved.snapshots.find(s => s.candidateId !== 'anchor')!
    const local = saved.results.find(r => r.snapshotDigest === candidate.digest)!
    expect(local.cells.length).toBeGreaterThan(0)
    expect(local.cells.every(c => c.identity.snapshotDigest === f.anchor.digest)).toBe(true)
    expect(local.snapshotDigest).toBe(candidate.digest)
    const originalKey = cellKey(cellIdentity(f.seed, 'task-0', 0, f.anchor))
    expect(cellKey(cellIdentity(f.seed, 'task-0', 0, candidate))).toBe(originalKey)
    expect(cellKey(cellIdentity(f.seed, 'task-0', 0, revise(candidate, { commit: 'b'.repeat(40) })))).not.toBe(originalKey)
  })

  it('[E12,R01,C01] refuses in-place rule or dataset changes across rounds of a frozen evolution', async () => {
    const f = fixtures(20), root = await mkdtemp(join(tmpdir(), 'gear-cohort-acceptance-')); roots.push(root)
    const journal = new SearchStore(root), engine = new FailureClusterSearch(journal, f.provider, f.diagnosis, f.hooks)
    const request = { evolutionId: 'frozen', roundId: 'r', roundIndex: 0, maxCandidates: 1,
      anchor: f.anchor, championRevisionDigest: digestJson('revision'), settings: settings() }
    await engine.run(request, new AbortController().signal)
    const before = f.executions.length, changed = settings(); changed.search.taskSetSizing.bridge.ratio = 0.5
    await expect(engine.run({ ...request, settings: changed }, new AbortController().signal)).rejects.toThrow('round request changed')
    await expect(engine.run({ ...request, roundId: 'r-next', roundIndex: 1, settings: changed }, new AbortController().signal)).rejects.toThrow('evolution identity changed')
    f.provider.describe = async partition => partition === 'seed' ? revise(f.seed, { conditionDigest: digestJson('new-execution-condition') }) : f.heldOut
    await expect(engine.run({ ...request, roundId: 'r-next', roundIndex: 1 }, new AbortController().signal)).rejects.toThrow('evolution identity changed')
    expect(f.executions).toHaveLength(before)
    expect(await journal.read('rounds/r-next/admission')).toBeUndefined()
  })

  it('[R02,R08] prevents a new round from reading an unresolved predecessor as stable', async () => {
    const f = fixtures(20), root = await mkdtemp(join(tmpdir(), 'gear-unresolved-acceptance-')); roots.push(root)
    const generate = f.hooks.generate
    f.hooks.generate = async () => { throw new Error('unsettled generation transport') }
    const journal = new SearchStore(root), engine = new FailureClusterSearch(journal, f.provider, f.diagnosis, f.hooks)
    const request = { evolutionId: 'unresolved', roundId: 'r', roundIndex: 0, maxCandidates: 1,
      anchor: f.anchor, championRevisionDigest: digestJson('revision'), settings: settings() }
    await expect(engine.run(request, new AbortController().signal)).rejects.toThrow('unsettled generation')
    const before = f.executions.length
    await expect(engine.run({ ...request, roundId: 'r-next', roundIndex: 1 }, new AbortController().signal)).rejects.toThrow('unresolved round')
    expect(f.executions).toHaveLength(before); expect(await journal.read('rounds/r-next/admission')).toBeUndefined()
    f.hooks.generate = generate
    expect((await engine.run(request, new AbortController().signal)).championChanged).toBe(true)
    expect(await journal.read('active-round')).toEqual({ roundId: null })
  })
})

describe('diagnosis acceptance: sourced workplans and adaptive slots', () => {
  it('[D01,D04] produces three distinct assignments for three supported families under a four-candidate cap', async () => {
    const f = fixtures(20), root = await mkdtemp(join(tmpdir(), 'gear-diagnosis-acceptance-')); roots.push(root)
    const diagnose = f.diagnosis.diagnose.bind(f.diagnosis), generate = f.hooks.generate
    let diagnosisCalls = 0
    f.diagnosis.diagnose = async input => {
      diagnosisCalls++
      const result = await diagnose(input)
      return { ...result, facts: result.facts.map(fact => fact.familyId === 'family-3'
        ? { taskId: fact.taskId, evidenceRefs: fact.evidenceRefs, status: 'unresolved' as const } : fact) }
    }
    f.hooks.generate = async input => {
      expect(input.delivery.dossier.facts.length).toBeLessThan(20)
      expect(input.delivery.dossier.facts.every(fact => input.delivery.workplan.targetTaskIds.includes(fact.taskId)
        || input.delivery.scope!.taskIds.includes(fact.taskId))).toBe(true)
      expect(input.delivery.workplan.parentSnapshotDigest).toBe(f.anchor.digest)
      return generate(input)
    }
    const engine = new FailureClusterSearch(new SearchStore(root), f.provider, f.diagnosis, f.hooks)
    const result = await engine.run({ evolutionId: 'three-families', roundId: 'r', roundIndex: 0, maxCandidates: 4,
      anchor: f.anchor, championRevisionDigest: digestJson('revision'), settings: settings() }, new AbortController().signal)
    expect(diagnosisCalls).toBe(1); expect(f.generated).toHaveLength(3)
    expect(new Set(result.research.workplans.map(w => w.familyId)).size).toBe(3)
    expect(new Set(result.research.workplans.map(w => w.hypothesis)).size).toBe(3)
    expect(result.research.workplans.every(w => w.requiredDiagnosisRefs.length > 0)).toBe(true)
  })

  it('[D03,D05] records unresolved failures and returns zero workplans without inventing a shared cause', async () => {
    const f = fixtures(20), root = await mkdtemp(join(tmpdir(), 'gear-unresolved-diagnosis-')); roots.push(root)
    f.diagnosis.diagnose = async () => ({ facts: [], inputTokens: 1, outputTokens: 1 })
    const journal = new SearchStore(root), engine = new FailureClusterSearch(journal, f.provider, f.diagnosis, f.hooks)
    const result = await engine.run({ evolutionId: 'unresolved-facts', roundId: 'r', roundIndex: 0, maxCandidates: 4,
      anchor: f.anchor, championRevisionDigest: digestJson('revision'), settings: settings() }, new AbortController().signal)
    expect(f.generated).toEqual([]); expect(result.research.workplans).toEqual([])
    expect(result.reasonCodes).toContain('no-actionable-cluster')
    const refs = (await import('node:fs/promises')).readdir
    const dossierPointer = (await refs(join(root, 'rounds/r'))).find(name => /^diagnosis-[a-f0-9]+\.json$/u.test(name))!
    const pointer = await journal.read<{ ref: string }>(`rounds/r/${dossierPointer.slice(0, -5)}`)
    const dossier = await journal.object<import('../../src/search/types.js').DiagnosisDossier>(pointer!.ref)
    expect(dossier.facts.filter(fact => fact.status === 'unresolved')).toHaveLength(16)
    expect(dossier.facts.filter(fact => fact.status === 'successful-control')).toHaveLength(4)
    expect(f.executions.reduce((sum, e) => sum + e.count, 0)).toBe(20)
  })

  it('[D03] rejects a diagnosis that cites another task as its evidence', async () => {
    const f = fixtures(20), root = await mkdtemp(join(tmpdir(), 'gear-forged-diagnosis-')); roots.push(root)
    const diagnose = f.diagnosis.diagnose.bind(f.diagnosis)
    f.diagnosis.diagnose = async input => {
      const output = await diagnose(input)
      return { ...output, facts: output.facts.map((fact, index) => index === 0 ? { ...fact, evidenceRefs: output.facts[1]!.evidenceRefs } : fact) }
    }
    const engine = new FailureClusterSearch(new SearchStore(root), f.provider, f.diagnosis, f.hooks)
    await expect(engine.run({ evolutionId: 'forged-facts', roundId: 'r', roundIndex: 0, maxCandidates: 4,
      anchor: f.anchor, championRevisionDigest: digestJson('revision'), settings: settings() }, new AbortController().signal)).rejects.toThrow('lacks parent seed provenance')
    expect(f.generated).toEqual([])
  })

  it('[D05] does not call the classifier with an exhausted diagnosis budget', async () => {
    const f = fixtures(20), limits = settings(), root = await mkdtemp(join(tmpdir(), 'gear-diagnosis-budget-')); roots.push(root)
    limits.budgets.round.maxDiagnosisInputTokens = 0
    f.diagnosis.diagnose = async () => { throw new Error('classifier must not be called') }
    const engine = new FailureClusterSearch(new SearchStore(root), f.provider, f.diagnosis, f.hooks)
    const result = await engine.run({ evolutionId: 'no-diagnosis-budget', roundId: 'r', roundIndex: 0, maxCandidates: 4,
      anchor: f.anchor, championRevisionDigest: digestJson('revision'), settings: limits }, new AbortController().signal)
    expect(result.reasonCodes).toContain('search budget exhausted: diagnosisInputTokens')
    expect(result.research.workplans).toEqual([]); expect(f.generated).toEqual([])
  })
})

function mixedUniverse(): TaskUniverse {
  const source = universe(4, 'seed', true)
  const process = revise(source.tasks[2]!.process!, { applicableTaskSetDigest: digestJson(sorted(source.tasks.slice(2).map(t => t.contentDigest))) })
  return revise(source, { tasks: source.tasks.map((task, index) => {
    const { process: ignored, ...outcomeOnly } = task
    return index < 2 ? outcomeOnly : { ...outcomeOnly, process }
  }) })
}

describe('metric acceptance: scoped process capability', () => {
  it('[M02,M03,M10] counts only declared process slots, including when a local scope has none', () => {
    const u = mixedUniverse(), a = snapshot('A')
    expect(() => validateSettings(settings(), u, universe(2, 'held-out'), 1)).not.toThrow()
    const local = evaluatedFixture(u, scopeFixture(u, ['task-0', 'task-1']), a, () => ({ outcome: 1 }))
    const lp = profile(u, local.plan, a, local.result, 'auto')
    expect(lp.processComplete).toBe(true); expect(lp.processTaskIds).toEqual([])
    expect(lp.processCoverage).toMatchObject({ planned: 0, available: 0, notEvaluated: 2 })
    const full = evaluatedFixture(u, scopeFixture(u, u.tasks.map(t => t.id)), a, id => ({ outcome: 1, ...(id === 'task-2' ? { process: 0 } : {}) }))
    const fp = profile(u, full.plan, a, full.result, 'auto')
    expect(fp.outcomeComplete).toBe(true); expect(fp.processComplete).toBe(false)
    expect(fp.processCoverage).toMatchObject({ planned: 2, available: 1, missing: 1, notEvaluated: 0 })
    expect(fp.tasks.find(t => t.taskId === 'task-2')!.process).toBe(0)
    expect(fp.tasks.find(t => t.taskId === 'task-0')).not.toHaveProperty('process')
    expect(profile(u, full.plan, a, full.result, 'off').processCoverage.planned).toBe(0)
  })

  it('[A08,M10] checks zero-weight guard evidence without inventing a process aggregate', () => {
    const u = mixedUniverse(), a = snapshot('A')
    const scope = scopeFixture(u, ['task-0'], 'guarded', 1, [{ partition: 'seed', taskId: 'task-2', rule: 'must-pass' }])
    const row = evaluatedFixture(u, scope, a, () => ({ outcome: 1, process: 0.5 }))
    const p = profile(u, row.plan, a, row.result, 'auto', scope.weights)
    expect(p.processComplete).toBe(true)
    expect(p.tasks.find(t => t.taskId === 'task-2')!.process).toBe(0.5)
    expect(p.processGroups).toEqual({})
    expect(archive(u, [a], [row]).activeParentIds).toEqual(['A'])
  })
})
