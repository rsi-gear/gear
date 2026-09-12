import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { digestJson } from '../../src/state/digest.js'
import { FailureClusterSearch } from '../../src/search/engine.js'
import { SearchStore } from '../../src/search/store.js'
import { collectFailure, materializeSuite, resolveRegressionSettings, validateRegressionSuite } from '../../src/search/regression.js'
import type { RegressionInput } from '../../src/search/regression.js'
import { fixtures, regressionSuiteFixture, revise, settings, universe } from '../helpers/search-fixture.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const input: RegressionInput = { source: { kind: 'online-feedback', evidenceRef: 'feedback:simulation' }, outcome: 'business-failure', prompt: 'Check the final state',
  fixtureRefs: [], expectedBehavior: 'The simulated state matches the expected result', failureCategory: 'verification' }
const collection = { collectFailures: true, maxProposals: 2 }

describe('immutable regression suites and admission policy', () => {
  it('[G01,G02,G04] collects only reproducible business proposals with source isolation, deduplication and limits', async () => {
    const promptOnly = collectFailure(input, [], collection).proposal!
    expect(promptOnly.status).toBe('needs-fixture')
    expect(collectFailure(input, [promptOnly], collection).reason).toBe('duplicate')
    expect(collectFailure({ ...input, source: { kind: 'held-out', evidenceRef: 'private' } }, [], collection).reason).toBe('held-out-isolation')
    expect(collectFailure({ ...input, outcome: 'infrastructure-invalid' }, [], collection).reason).toBe('execution-repair-required')
    expect(collectFailure(input, [], { ...collection, collectFailures: false }).reason).toBe('collection-disabled')
    for (const prompt of ['api_key=credential-value', 'Contact person@example.test', 'Bearer confidential']) expect(collectFailure({ ...input, prompt }, [], collection).reason).toBe('sensitive-content')
    expect(collectFailure({ ...input, prompt: 'Another failure' }, [promptOnly], { ...collection, maxProposals: 1 }).reason).toBe('proposal-capacity')
    const reproducible = { ...input, fixtureRefs: ['fixture:state'], environmentRef: 'env:1', graderRef: 'grader:1' }
    const first = collectFailure(reproducible, [], collection).proposal!
    expect(collectFailure({ ...reproducible, graderRef: 'grader:2' }, [first], collection).proposal).toBeDefined()
    const suite = await regressionSuiteFixture(universe(20), 'development')
    const { digest: discarded, schemaVersion: ignored, ...body } = suite
    const task = { ...body.tasks[0]!, proposalDigest: promptOnly.digest }
    await expect(materializeSuite({ ...body, tasks: [task] }, [promptOnly], async () => true)).rejects.toThrow('unmaterializable')
  })

  it('[G03] validates materialized roles and freezes all protected rules without weakening explicit guards', async () => {
    const u = universe(20), h = universe(2, 'held-out'), suite = await regressionSuiteFixture(u, 'protected-regression')
    const seed = revise(u, { regressionSuiteDigest: suite.digest, regressionSuite: suite }), config = settings()
    config.regression.suiteRef = suite.digest
    config.promotion.protectedTasks = [{ taskId: 'task-16', partition: 'seed', rule: 'minimum-score', minimumUtility: 0.9 }]
    const before = structuredClone(config), resolved = resolveRegressionSettings(config, seed, h)
    expect(config).toEqual(before)
    expect(resolved.promotion.protectedTasks).toEqual([...before.promotion.protectedTasks, suite.tasks[0]!.guard])
    expect(resolveRegressionSettings(resolved, seed, h)).toEqual(resolved)
    expect(() => resolveRegressionSettings(config, u, h)).toThrow('frozen manifest')
    expect(() => resolveRegressionSettings(settings(), seed, h)).toThrow('explicitly selected')
    expect(() => resolveRegressionSettings(config, revise(seed, { tasks: u.tasks.filter(t => t.id !== 'task-16') }), h)).toThrow('member missing')
    expect(() => resolveRegressionSettings(config, seed, revise(h, { regressionSuiteDigest: suite.digest }))).toThrow('cannot serve as held-out')
    expect(() => validateRegressionSuite(revise(suite, { tasks: [{ ...suite.tasks[0]!, role: 'development' }] }))).toThrow('hidden guard')
    const { guard: discardedGuard, ...unguarded } = suite.tasks[0]!
    expect(() => validateRegressionSuite(revise(suite, { tasks: [unguarded] }))).toThrow('explicit seed guard')
    expect(() => validateRegressionSuite(revise(suite, { tasks: [{ ...suite.tasks[0]!, validationEvidenceRef: '' }] }))).toThrow('validation')
  })

  for (const role of ['development', 'protected-regression'] as const) it(`[G03] enforces ${role} semantics on paired candidate/champion evidence at new admission`, async () => {
    const f = fixtures(20), baseBytes = JSON.stringify(f.seed), suite = await regressionSuiteFixture(f.seed, role)
    let seed = revise(f.seed, { regressionSuiteDigest: suite.digest, regressionSuite: suite })
    f.provider.describe = async p => p === 'seed' ? seed : f.heldOut
    f.provider.verifyRegressionSuite = async (ref, u) => ref === suite.digest && u.digest === seed.digest
    const evaluate = f.provider.evaluate
    f.provider.evaluate = async input => {
      const cells = await evaluate(input)
      return cells.map(cell => cell.identity.taskId === 'task-16' && input.plan.partition === 'seed' && input.snapshot.candidateId !== 'anchor'
        ? revise(cell, { outcome: { status: 'available', contractDigest: cell.identity.outcomeContractDigest, evidenceRef: cell.evidenceRef, rawValue: 0.5 } }) : cell)
    }
    const config = settings(); config.regression.suiteRef = suite.digest
    const root = await mkdtemp(join(tmpdir(), 'gear-regression-')); roots.push(root)
    const store = new SearchStore(root), engine = new FailureClusterSearch(store, f.provider, f.diagnosis, f.hooks)
    const request = { evolutionId: 'suite', roundId: 'r', roundIndex: 0, maxCandidates: 4, anchor: f.anchor, championRevisionDigest: digestJson('revision'), settings: config }
    const result = await engine.run(request, new AbortController().signal)
    expect(result.championChanged).toBe(role === 'development')
    expect(result.research.bridge.plan?.taskIds).toContain('task-16')
    if (role === 'protected-regression') {
      expect(result.nomineeId).toBeUndefined()
      expect(f.executions.some(e => e.stage === 'held-out')).toBe(false)
      expect(f.executions.some(e => e.stage === 'bridge' && e.participant !== 'anchor')).toBe(true)
    }
    expect(JSON.stringify(f.seed)).toBe(baseBytes)
    expect(config.promotion.protectedTasks).toEqual([])
    const next = await regressionSuiteFixture(f.seed, role, 17, suite.digest)
    seed = revise(f.seed, { regressionSuiteDigest: next.digest, regressionSuite: next })
    f.provider.verifyRegressionSuite = async () => true
    const counts = [...f.executions]
    await expect(engine.run({ ...request, roundId: 'r2', roundIndex: 1, settings: { ...config, regression: { ...config.regression, suiteRef: next.digest } } }, new AbortController().signal)).rejects.toThrow('start a new evolution')
    expect(f.executions).toEqual(counts)
    const nextRoot = await mkdtemp(join(tmpdir(), 'gear-regression-next-')); roots.push(nextRoot)
    const nextResult = await new FailureClusterSearch(new SearchStore(nextRoot), f.provider, f.diagnosis, f.hooks).run({
      ...request, evolutionId: 'suite-next', settings: { ...config, regression: { ...config.regression, suiteRef: next.digest } },
    }, new AbortController().signal)
    expect(nextResult.championChanged).toBe(true)
    expect(f.executions.slice(counts.length).some(e => e.participant === 'anchor' && e.stage === 'baseline-probe')).toBe(true)
    expect(nextResult.research.bridge.plan?.taskIds).toContain('task-17')
  })
})
