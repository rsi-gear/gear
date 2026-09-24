import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FrozenFailureClusterSearch } from '../helpers/frozen-failure-cluster-search.js'
import { fixtures, revise, settings } from '../helpers/search-fixture.js'
import { CampaignFailureClusterSearch } from '../../src/search/campaign-engine.js'
import { selectParentsWithPolicy } from '../../src/search/parent-selection.js'
import { resolveParentPolicyRef, scopedFrontierPolicy } from '../../src/search/policies/parents.js'
import { SearchExecutionFailure, SearchOperationPending } from '../../src/search/recovery.js'
import { MemorySearchStore } from '../../src/search/testing.js'
import { SearchStore } from '../../src/search/store.js'
import type { ResearchArchive } from '../../src/search/types.js'
import { digestJson } from '../../src/state/digest.js'
import { resolveMetric, resolveObjective } from '../../src/objective/contracts.js'
import { extractRawMetrics } from '../../src/objective/scoring.js'

const frozenOraclePath = fileURLToPath(new URL('../helpers/frozen-failure-cluster-search.ts', import.meta.url))
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function oracleCase(mode: 'actionable' | 'no-actionable' | 'bootstrap-failure', driver: 'frozen' | 'campaign' = 'frozen') {
  const root = await mkdtemp(join(tmpdir(), 'gear-frozen-search-oracle-'))
  roots.push(root)
  const store = new SearchStore(root), fixture = fixtures(20), config = settings()
  const admission = { evolutionId: 'equivalence', roundId: 'r', roundIndex: 0, maxCandidates: 1,
    anchor: fixture.anchor, championRevisionDigest: digestJson('frozen-champion'), settings: config }
  const evaluate = fixture.provider.evaluate
  const attempts: Array<{ stage: string; participant: string; cells: number; key: string }> = []
  let diagnoses = 0
  const heldOutBoundaries: Array<{ research: ResearchArchive | undefined; progress: unknown }> = []
  fixture.provider.evaluate = async input => {
    attempts.push({ stage: input.plan.stage, participant: input.snapshot.candidateId,
      cells: input.cells.length, key: input.idempotencyKey })
    if (input.plan.stage === 'held-out') {
      const pointer = await store.read<{ ref: string }>('rounds/r/research')
      heldOutBoundaries.push({ research: pointer ? await store.object<ResearchArchive>(pointer.ref) : undefined,
        progress: await store.read('rounds/r/progress') })
    }
    if (mode === 'bootstrap-failure') throw new SearchExecutionFailure('worker-exited', 'worker exited', 'fixture:worker-exited')
    return evaluate(input)
  }
  if (mode === 'no-actionable') fixture.diagnosis.diagnose = async () => {
    diagnoses++
    return { facts: [], inputTokens: 1, outputTokens: 1 }
  }
  const run = (journal = store, signal = new AbortController().signal) => (driver === 'frozen'
    ? new FrozenFailureClusterSearch(journal, fixture.provider, fixture.diagnosis, fixture.hooks)
    : new CampaignFailureClusterSearch(journal, fixture.provider, fixture.diagnosis, fixture.hooks))
    .run(admission, signal)
  return { root, store, fixture, admission, run, attempts, heldOutBoundaries, diagnoses: () => diagnoses }
}

describe('frozen FailureClusterSearch oracle', () => {
  it('reconstructs the original source byte for byte before differential assertions', () => {
    const source = readFileSync(frozenOraclePath, 'utf8')
    const lines = source.split('\n')
    expect(lines[0]).toBe('// Frozen behavioral oracle from ec76b8b25703c46cbe3b2aaf94b64dc0c2277921:src/search/engine.ts')
    const expected = /^\/\/ Original SHA256: ([a-f0-9]{64})$/u.exec(lines[1] ?? '')?.[1]
    expect(expected).toBe('ccb837ed2ebc85afcb6b63ea0f7acf0f28fdae6251fde7401e11c9da3ce7f732')
    const restored = lines.slice(3).join('\n')
      .replaceAll('../../src/search/', './')
      .replaceAll('../../src/', '../')
      .replaceAll('FrozenFailureClusterSearch', 'FailureClusterSearch')
    expect(createHash('sha256').update(restored).digest('hex')).toBe(expected)
  })

  it('establishes a deterministic successful bootstrap with no actionable diagnosis and terminal replay', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const caseFile = await oracleCase('no-actionable')
    const first = await caseFile.run()
    expect(first.reasonCodes).toContain('no-actionable-cluster')
    expect(first.research.workplans).toEqual([])
    expect(first.championChanged).toBe(false)
    expect(caseFile.diagnoses()).toBe(1)
    expect((await caseFile.store.archive())?.digest).toBe(first.archiveDigest)
    expect(await caseFile.store.remaining(caseFile.admission.roundId, caseFile.admission.settings.budgets))
      .toEqual(first.research.remainingBudget)
    expect(caseFile.fixture.executions.map(call => [call.stage, call.participant, call.count]))
      .toEqual([['baseline-probe', 'anchor', 20]])
    expect(new Set(caseFile.fixture.executions.map(call => call.key)).size).toBe(caseFile.fixture.executions.length)
    expect(caseFile.attempts).toEqual([{
      stage: 'baseline-probe', participant: 'anchor', cells: 20,
      key: caseFile.fixture.executions[0]!.key,
    }])
    const executions = structuredClone(caseFile.fixture.executions)
    expect(await caseFile.run(new SearchStore(caseFile.root))).toEqual(first)
    expect(caseFile.fixture.executions).toEqual(executions)
    expect(caseFile.attempts).toHaveLength(1)
    expect(caseFile.diagnoses()).toBe(1)
  })

  it('establishes the complete staged candidate path and its physical call sequence', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const scenario = await oracleCase('actionable')
    const outcome = await scenario.run()
    expect(outcome.research.workplans).toHaveLength(1)
    expect(outcome.research.candidates).toHaveLength(1)
    expect(scenario.fixture.generated).toHaveLength(1)
    expect(scenario.heldOutBoundaries).toHaveLength(2)
    for (const boundary of scenario.heldOutBoundaries) {
      expect(boundary.research?.digest).toBe(outcome.archiveDigest)
      expect(boundary.progress).toMatchObject({ phase: 'seed-research-complete' })
    }
    expect(scenario.attempts.map(attempt => attempt.stage)).toEqual([
      'baseline-probe', 'local', 'bridge', 'global-seed', 'held-out', 'held-out',
    ])
    expect(await scenario.store.remaining('r', scenario.admission.settings.budgets))
      .toEqual(outcome.research.remainingBudget)
    expect(await scenario.run(new SearchStore(scenario.root))).toEqual(outcome)
    expect(scenario.fixture.generated).toHaveLength(1)
  })

  it('establishes a terminal failed bootstrap without installing a parent archive', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const caseFile = await oracleCase('bootstrap-failure')
    const first = await caseFile.run()
    expect(first.reasonCodes).toEqual(['execution-failure:worker-exited', 'bootstrap-execution-unavailable'])
    expect(first.research.parents.batches).toEqual([])
    expect((await caseFile.store.object<ResearchArchive>(first.archiveDigest)).results[0]?.failure).toBeDefined()
    expect(await caseFile.store.archive()).toBeUndefined()
    expect(await caseFile.store.remaining(caseFile.admission.roundId, caseFile.admission.settings.budgets))
      .toEqual(first.research.remainingBudget)
    expect(caseFile.fixture.executions).toEqual([])
    expect(caseFile.attempts).toMatchObject([{ stage: 'baseline-probe', participant: 'anchor', cells: 20 }])
    expect(await caseFile.run(new SearchStore(caseFile.root))).toEqual(first)
    expect(caseFile.attempts).toHaveLength(1)
  })

  it('establishes that one incomplete bridge participant blocks every global nomination', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const root = await mkdtemp(join(tmpdir(), 'gear-frozen-search-bridge-'))
    roots.push(root)
    const store = new SearchStore(root), fixture = fixtures(20), config = settings()
    const evaluate = fixture.provider.evaluate
    let partialId: string | undefined
    fixture.provider.evaluate = async input => {
      const cells = await evaluate(input)
      if (input.plan.stage === 'bridge' && input.snapshot.candidateId !== fixture.anchor.candidateId && !partialId) {
        partialId = input.snapshot.candidateId
        return cells.slice(1)
      }
      return cells
    }
    const admission = { evolutionId: 'bridge-equivalence', roundId: 'r', roundIndex: 0, maxCandidates: 4,
      anchor: fixture.anchor, championRevisionDigest: digestJson('bridge-champion'), settings: config }
    const result = await new FrozenFailureClusterSearch(store, fixture.provider, fixture.diagnosis, fixture.hooks)
      .run(admission, new AbortController().signal)
    expect(partialId).toBeDefined()
    expect(result.nomineeId).toBeUndefined()
    expect(result.reasonCodes).toContain('incomplete-bridge-evidence')
    expect(result.research.stageDecisions.filter(decision => decision.reasonCodes.includes('incomplete-bridge-evidence')))
      .toHaveLength(2)
    expect(fixture.executions.some(call => call.stage === 'global-seed' || call.stage === 'held-out')).toBe(false)
    expect((await store.archive())?.scopeViews.some(view => view.outcomeEligibleIds.includes(partialId!))).toBe(true)
  })

  it('establishes that absent model limits stay absent rather than becoming zero reservations', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const root = await mkdtemp(join(tmpdir(), 'gear-frozen-search-unbounded-'))
    roots.push(root)
    const store = new SearchStore(root), fixture = fixtures(20), config = settings()
    for (const budget of [config.budgets.round, config.budgets.evolution]) {
      delete budget.maxGenerationTokens
      delete budget.maxGenerationRequests
    }
    const admission = { evolutionId: 'unbounded-equivalence', roundId: 'r', roundIndex: 0, maxCandidates: 1,
      anchor: fixture.anchor, championRevisionDigest: digestJson('unbounded-champion'), settings: config }
    const result = await new FrozenFailureClusterSearch(store, fixture.provider, fixture.diagnosis, fixture.hooks)
      .run(admission, new AbortController().signal)
    expect(result.research.workplans).toHaveLength(1)
    expect(result.research.workplans[0]!.generationBudget).toEqual({ deadlineAt: 2_000_000_600_000 })
    expect(result.research.remainingBudget.generationTokens).toBeNull()
    expect(result.research.remainingBudget.generationRequests).toBeNull()
    expect(await store.remaining('r', config.budgets)).toEqual(result.research.remainingBudget)
  })

  it('establishes two-round finding handoff to a selected historical specialist', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const root = await mkdtemp(join(tmpdir(), 'gear-frozen-search-findings-'))
    roots.push(root)
    const store = new SearchStore(root), fixture = fixtures(20), config = settings()
    const evaluate = fixture.provider.evaluate, generate = fixture.hooks.generate
    const deliveries: Array<{ parent: string; findingDigests: string[] }> = []
    let residualFailureTaskId: string | undefined
    fixture.provider.evaluate = async input => {
      if (input.snapshot.candidateId !== fixture.anchor.candidateId && input.plan.stage === 'local')
        residualFailureTaskId ??= input.plan.taskIds[0]
      return (await evaluate(input)).map(cell =>
      input.snapshot.candidateId !== fixture.anchor.candidateId && cell.identity.taskId === residualFailureTaskId
        && cell.outcome.status === 'available'
        ? revise(cell, { outcome: { ...cell.outcome, rawValue: 0 } })
        : cell)
    }
    fixture.hooks.generate = async input => {
      deliveries.push({ parent: input.parent.candidateId,
        findingDigests: input.delivery.findings.map(finding => (finding as { digest: string }).digest) })
      return generate(input)
    }
    const request = { evolutionId: 'finding-equivalence', roundId: 'first', roundIndex: 0, maxCandidates: 1,
      anchor: fixture.anchor, championRevisionDigest: digestJson('first-champion'), settings: config }
    const first = await new FrozenFailureClusterSearch(store, fixture.provider, fixture.diagnosis, fixture.hooks)
      .run(request, new AbortController().signal)
    expect(first.findings).toHaveLength(1)
    const archive = (await store.archive())!
    const specialist = archive.snapshots.find(snapshot => snapshot.candidateId === first.findings[0]!.candidateId)!
    expect(specialist).toBeDefined()
    const policy = scopedFrontierPolicy(resolveParentPolicyRef(config.search))
    const nextId = Array.from({ length: 100 }, (_, index) => `next-${index}`).find(roundId =>
      selectParentsWithPolicy(archive, policy, 1, roundId, config.search.seed, specialist.candidateId)
        .batches.some(batch => batch.parentSnapshotDigest === specialist.digest))
    expect(nextId).toBeDefined()
    const second = await new FrozenFailureClusterSearch(store, fixture.provider, fixture.diagnosis, fixture.hooks)
      .run({ ...request, roundId: nextId!, roundIndex: 1, anchor: specialist,
        championRevisionDigest: digestJson('second-champion') }, new AbortController().signal)
    expect(second.research.parents.batches[0]?.parentSnapshotDigest).toBe(specialist.digest)
    expect(second.research.workplans.length).toBeGreaterThan(0)
    expect(deliveries).toContainEqual({ parent: specialist.candidateId,
      findingDigests: expect.arrayContaining([first.findings[0]!.digest]) })
  })
})

describe('Campaign FailureClusterSearch differential', () => {
  it.each([0.5, 0.7])('matches frozen initial-baseline objective constraints with retained metric %s', async retained => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const comparisons = []
    const contracts = ['quality', 'retained'].map(id => resolveMetric({ id, revision: '1', unit: 'score',
      direction: 'maximize', source: { path: `originalResult.${id}`, extractor: 'number-v1' },
      granularity: 'trial', repetitionReducer: 'mean', taskReducer: 'weighted-mean', comparisonPrecision: 1e-9 }))
    const objective = resolveObjective({ terms: [{ metric: 'quality', weight: 1 }],
      constraints: [{ metric: 'retained', rule: 'no_regression', reference: 'initial_baseline' }] }, contracts)
    for (const Search of [FrozenFailureClusterSearch, CampaignFailureClusterSearch]) {
      const store = new MemorySearchStore(), fixture = fixtures(20), config = settings()
      const seed = revise(fixture.seed, { rawMetricContracts: contracts, objective })
      const heldOut = revise(fixture.heldOut, { rawMetricContracts: contracts, objective })
      fixture.provider.capabilities.objectives = 1
      fixture.provider.describe = async partition => partition === 'seed' ? seed : heldOut
      const evaluate = fixture.provider.evaluate
      fixture.provider.evaluate = async input => (await evaluate(input)).map(cell => revise(cell, {
        rawMetrics: extractRawMetrics({ contracts, certified: true,
          trial: { originalResult: { quality: cell.outcome.status === 'available' ? cell.outcome.rawValue : 0,
            retained: input.snapshot.candidateId === fixture.anchor.candidateId ? 0.6 : retained } },
          identity: { taskId: cell.identity.taskId, repetition: cell.identity.repetition, runId: cell.evidenceRef,
            attempt: 1, harnessCommit: cell.identity.harnessCommit, conditionDigest: cell.identity.conditionDigest,
            originalArtifactRefs: [digestJson(['source', cell.identity])] } }) }))
      const request = { evolutionId: 'initial-objective', roundId: 'r', roundIndex: 0, maxCandidates: 1,
        anchor: fixture.anchor, championRevisionDigest: digestJson('initial-objective-champion'), settings: config }
      const outcome = await new Search(store, fixture.provider, fixture.diagnosis, fixture.hooks)
        .run(request, new AbortController().signal)
      expect(outcome.championChanged).toBe(retained >= 0.6)
      const initial: Record<string, unknown> = {}
      for (const [name, value] of store.checkpoint()) if (name.startsWith('evolution/objective-initial-'))
        initial[name] = await store.object((value as { ref: string }).ref)
      expect(Object.keys(initial).length).toBeGreaterThan(1)
      comparisons.push({ outcome, initial, archive: await store.archive(),
        remaining: await store.remaining('r', config.budgets), executions: fixture.executions })
    }
    expect(comparisons[1]).toEqual(comparisons[0])
  })

  it('collects the same seed regression proposals before held-out execution', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const comparisons = []
    for (const Search of [FrozenFailureClusterSearch, CampaignFailureClusterSearch]) {
      const store = new MemorySearchStore(), fixture = fixtures(20), config = settings()
      config.regression.collectFailures = true
      const seed = revise(fixture.seed, { tasks: fixture.seed.tasks.map(task => ({ ...task,
        regressionTemplate: { prompt: `Verify the final state of ${task.id}`, fixtureRefs: [],
          expectedBehavior: 'The final state matches the requested result', failureCategory: 'verification' } })) })
      fixture.provider.describe = async partition => partition === 'seed' ? seed : fixture.heldOut
      const evaluate = fixture.provider.evaluate
      const heldOutBoundaries: unknown[] = []
      let residualTask: string | undefined
      fixture.provider.evaluate = async input => {
        if (input.plan.stage === 'held-out') heldOutBoundaries.push(await store.read('regression/proposals'))
        if (input.snapshot.candidateId !== fixture.anchor.candidateId && input.plan.stage === 'local')
          residualTask ??= input.plan.taskIds[0]
        return (await evaluate(input)).map(cell => input.snapshot.candidateId !== fixture.anchor.candidateId
          && (cell.identity.taskId === residualTask || input.plan.partition === 'held-out')
          && cell.outcome.status === 'available'
          ? revise(cell, { outcome: { ...cell.outcome, rawValue: 0 } }) : cell)
      }
      const request = { evolutionId: 'regression-equivalence', roundId: 'r', roundIndex: 0, maxCandidates: 1,
        anchor: fixture.anchor, championRevisionDigest: digestJson('regression-champion'), settings: config }
      const outcome = await new Search(store, fixture.provider, fixture.diagnosis, fixture.hooks)
        .run(request, new AbortController().signal)
      const proposals = await store.read<{ proposals: Array<{ digest: string }> }>('regression/proposals')
      expect(proposals?.proposals.length).toBeGreaterThan(0)
      for (const proposal of proposals!.proposals) await store.object(proposal.digest)
      expect(heldOutBoundaries.length).toBeGreaterThan(0)
      expect(heldOutBoundaries.every(value => digestJson(value) === digestJson(proposals))).toBe(true)
      const pointer = await store.read<{ ref: string }>('rounds/r/regression-proposals')
      comparisons.push({ outcome, proposals, heldOutBoundaries,
        checkpoint: pointer ? await store.object(pointer.ref) : undefined,
        archive: await store.archive(), executions: fixture.executions })
    }
    expect(comparisons[1]).toEqual(comparisons[0])
  })

  it('preserves scientific journal checkpoints and their immutable support objects', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const projections = []
    for (const Search of [FrozenFailureClusterSearch, CampaignFailureClusterSearch]) {
      const store = new MemorySearchStore(), fixture = fixtures(20), config = settings()
      const request = { evolutionId: 'journal-projections', roundId: 'r', roundIndex: 0, maxCandidates: 2,
        anchor: fixture.anchor, championRevisionDigest: digestJson('projection-champion'), settings: config }
      const outcome = await new Search(store, fixture.provider, fixture.diagnosis, fixture.hooks)
        .run(request, new AbortController().signal)
      const names = /^(archive-base|completions|parent-archive|parents|scope-preparation|planning|local|expansion|local-stage-decisions|nomination|research|commit|consumed-.+|generated-.+|diagnosis-.+)$/u
      const projection: Record<string, unknown> = {}
      for (const [name, value] of store.checkpoint()) {
        if (!name.startsWith('rounds/r/') || !names.test(name.slice('rounds/r/'.length))) continue
        const pointer = value as { ref?: string }
        projection[name] = pointer.ref ? await store.object(pointer.ref) : value
      }
      for (const decision of outcome.research.stageDecisions)
        await store.object(decision.supportDigest)
      projections.push(projection)
    }
    expect(projections[1]).toEqual(projections[0])
  })

  it('preserves legacy external identities beyond the internal Campaign identifier format', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const comparisons = []
    for (const Search of [FrozenFailureClusterSearch, CampaignFailureClusterSearch]) {
      const store = new MemorySearchStore(), fixture = fixtures(20), config = settings()
      fixture.diagnosis.diagnose = async () => ({ facts: [], inputTokens: 1, outputTokens: 1 })
      const request = { evolutionId: 'research/中文 project', roundId: `round-${'x'.repeat(160)}`,
        roundIndex: 0, maxCandidates: 1, anchor: fixture.anchor,
        championRevisionDigest: digestJson('long-identity-champion'), settings: config }
      const outcome = await new Search(store, fixture.provider, fixture.diagnosis, fixture.hooks)
        .run(request, new AbortController().signal)
      const restored = new MemorySearchStore(store.checkpoint())
      expect(await new Search(restored, fixture.provider, fixture.diagnosis, fixture.hooks)
        .run(request, new AbortController().signal)).toEqual(outcome)
      comparisons.push({ outcome, archive: await restored.archive(),
        remaining: await restored.remaining(request.roundId, config.budgets), executions: fixture.executions })
    }
    expect(comparisons[1]).toEqual(comparisons[0])
  })

  it('recovers an unfinished round from a fresh journal checkpoint with its original physical keys', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const comparisons = []
    for (const Search of [FrozenFailureClusterSearch, CampaignFailureClusterSearch]) {
      const store = new MemorySearchStore(), fixture = fixtures(20), config = settings()
      const request = { evolutionId: 'journal-checkpoint', roundId: 'r', roundIndex: 0, maxCandidates: 1,
        anchor: fixture.anchor, championRevisionDigest: digestJson('checkpoint-champion'), settings: config }
      const diagnose = fixture.diagnosis.diagnose
      let interrupted = false
      const keys: string[] = []
      fixture.diagnosis.diagnose = async input => {
        keys.push(input.idempotencyKey)
        if (!interrupted) { interrupted = true; throw new Error('diagnosis transport lost') }
        return diagnose(input)
      }
      await expect(new Search(store, fixture.provider, fixture.diagnosis, fixture.hooks)
        .run(request, new AbortController().signal)).rejects.toBeInstanceOf(SearchOperationPending)
      const pending = await store.read('rounds/r/pending-operation')
      const restored = new MemorySearchStore(store.checkpoint())
      const outcome = await new Search(restored, fixture.provider, fixture.diagnosis, fixture.hooks)
        .run(request, new AbortController().signal)
      expect(keys).toHaveLength(2)
      expect(keys[1]).toBe(keys[0])
      expect(await restored.read('rounds/r/pending-operation')).toBeNull()
      comparisons.push({ outcome, pending, keys, archive: await restored.archive(),
        remaining: await restored.remaining('r', config.budgets),
        executions: fixture.executions, generated: fixture.generated, promotions: fixture.promotions })
    }
    expect(comparisons[1]).toEqual(comparisons[0])
  })

  it('matches two-round historical-parent selection, finding handoff and cumulative budget', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const comparisons = []
    for (const Search of [FrozenFailureClusterSearch, CampaignFailureClusterSearch]) {
    const root = await mkdtemp(join(tmpdir(), 'gear-frozen-search-findings-'))
    roots.push(root)
    const store = new SearchStore(root), fixture = fixtures(20), config = settings()
    const evaluate = fixture.provider.evaluate, generate = fixture.hooks.generate
    const deliveries: Array<{ parent: string; findingDigests: string[] }> = []
    let residualFailureTaskId: string | undefined
    fixture.provider.evaluate = async input => {
      if (input.snapshot.candidateId !== fixture.anchor.candidateId && input.plan.stage === 'local')
        residualFailureTaskId ??= input.plan.taskIds[0]
      return (await evaluate(input)).map(cell =>
      input.snapshot.candidateId !== fixture.anchor.candidateId && cell.identity.taskId === residualFailureTaskId
        && cell.outcome.status === 'available'
        ? revise(cell, { outcome: { ...cell.outcome, rawValue: 0 } })
        : cell)
    }
    fixture.hooks.generate = async input => {
      deliveries.push({ parent: input.parent.candidateId,
        findingDigests: input.delivery.findings.map(finding => (finding as { digest: string }).digest) })
      return generate(input)
    }
    const request = { evolutionId: 'finding-equivalence', roundId: 'first', roundIndex: 0, maxCandidates: 1,
      anchor: fixture.anchor, championRevisionDigest: digestJson('first-champion'), settings: config }
    const first = await new Search(store, fixture.provider, fixture.diagnosis, fixture.hooks)
      .run(request, new AbortController().signal)
    expect(first.findings).toHaveLength(1)
    const archive = (await store.archive())!
    const specialist = archive.snapshots.find(snapshot => snapshot.candidateId === first.findings[0]!.candidateId)!
    expect(specialist).toBeDefined()
    const policy = scopedFrontierPolicy(resolveParentPolicyRef(config.search))
    const nextId = Array.from({ length: 100 }, (_, index) => `next-${index}`).find(roundId =>
      selectParentsWithPolicy(archive, policy, 1, roundId, config.search.seed, specialist.candidateId)
        .batches.some(batch => batch.parentSnapshotDigest === specialist.digest))
    expect(nextId).toBeDefined()
    const second = await new Search(new SearchStore(root), fixture.provider, fixture.diagnosis, fixture.hooks)
      .run({ ...request, roundId: nextId!, roundIndex: 1, anchor: specialist,
        championRevisionDigest: digestJson('second-champion') }, new AbortController().signal)
    expect(second.research.parents.batches[0]?.parentSnapshotDigest).toBe(specialist.digest)
    expect(second.research.workplans.length).toBeGreaterThan(0)
    expect(deliveries).toContainEqual({ parent: specialist.candidateId,
      findingDigests: expect.arrayContaining([first.findings[0]!.digest]) })
    comparisons.push({ first, second, deliveries, archive: await store.archive(),
      remaining: await store.remaining(nextId!, config.budgets),
      executions: fixture.executions, generated: fixture.generated, promotions: fixture.promotions })
    }
    expect(comparisons[1]).toEqual(comparisons[0])
  })

  for (const expired of [false, true]) it(`starts the budget ledger at the first successful reservation (expired=${expired})`, async () => {
    const base = 2_000_000_000_000
    let now = base
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const exercise = async (driver: 'frozen' | 'campaign') => {
      now = base
      const scenario = await oracleCase('no-actionable', driver)
      const originalWrite = scenario.store.write.bind(scenario.store)
      const elapsed = expired ? scenario.admission.settings.budgets.round.timeoutMs + 1000 : 1000
      scenario.store.write = async (path, value) => {
        await originalWrite(path, value)
        if (path === 'rounds/r/admission') now = base + elapsed
      }
      const outcome = await scenario.run()
      const pointer = await scenario.store.read<{ ref: string }>('rounds/r/admission')
      const admission = await scenario.store.object<{ digest: string; startedAt: number }>(pointer!.ref)
      const ledger = await scenario.store.read<{ startedAt: number }>('budget')
      expect(admission.startedAt).toBe(base)
      if (expired) {
        expect(ledger).toBeUndefined()
        expect(scenario.attempts).toEqual([])
      } else expect(ledger?.startedAt).toBe(base + elapsed)
      return { outcome, attempts: scenario.attempts, startedAt: ledger?.startedAt,
        remaining: await scenario.store.remaining('r', scenario.admission.settings.budgets) }
    }
    expect(await exercise('campaign')).toEqual(await exercise('frozen'))
  })

  it('matches every candidate stage, physical key, archive, budget and publication in a full round', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const frozen = await oracleCase('actionable')
    const campaign = await oracleCase('actionable', 'campaign')
    const expected = await frozen.run(), observed = await campaign.run()
    expect(observed).toEqual(expected)
    expect(await campaign.store.archive()).toEqual(await frozen.store.archive())
    expect(await campaign.store.remaining('r', campaign.admission.settings.budgets))
      .toEqual(await frozen.store.remaining('r', frozen.admission.settings.budgets))
    for (const path of ['rounds/r/terminal', 'active-round', 'rounds/r/progress'])
      expect(await campaign.store.read(path)).toEqual(await frozen.store.read(path))
    expect(campaign.attempts).toEqual(frozen.attempts)
    expect(campaign.heldOutBoundaries).toEqual(frozen.heldOutBoundaries)
    expect(campaign.fixture.executions).toEqual(frozen.fixture.executions)
    expect(campaign.fixture.generated).toEqual(frozen.fixture.generated)
    expect(campaign.fixture.promotions).toEqual(frozen.fixture.promotions)
    const before = { attempts: campaign.attempts.length, generations: campaign.fixture.generated.length,
      promotions: campaign.fixture.promotions.length }
    expect(await campaign.run(new SearchStore(campaign.root))).toEqual(observed)
    expect(campaign.attempts).toHaveLength(before.attempts)
    expect(campaign.fixture.generated).toHaveLength(before.generations)
    expect(campaign.fixture.promotions).toHaveLength(before.promotions)
  })

  it('matches the complete no-actionable outcome, bootstrap archive, budget and terminal replay', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const frozen = await oracleCase('no-actionable')
    const campaign = await oracleCase('no-actionable', 'campaign')
    const expected = await frozen.run(), observed = await campaign.run()
    expect(await campaign.store.archive()).toEqual(await frozen.store.archive())
    expect(observed).toEqual(expected)
    expect(await campaign.store.remaining('r', campaign.admission.settings.budgets))
      .toEqual(await frozen.store.remaining('r', frozen.admission.settings.budgets))
    for (const path of ['rounds/r/terminal', 'active-round', 'rounds/r/progress'])
      expect(await campaign.store.read(path)).toEqual(await frozen.store.read(path))
    expect(campaign.attempts).toEqual(frozen.attempts)
    expect(campaign.diagnoses()).toBe(frozen.diagnoses())
    expect(campaign.fixture.generated).toEqual(frozen.fixture.generated)
    expect(campaign.fixture.promotions).toEqual(frozen.fixture.promotions)
    const before = { attempts: campaign.attempts.length, diagnoses: campaign.diagnoses() }
    expect(await campaign.run(new SearchStore(campaign.root))).toEqual(observed)
    expect(campaign.attempts).toHaveLength(before.attempts)
    expect(campaign.diagnoses()).toBe(before.diagnoses)
  })

  it('matches verified bootstrap failure, absence of a parent, budget, terminal state and replay', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const frozen = await oracleCase('bootstrap-failure')
    const campaign = await oracleCase('bootstrap-failure', 'campaign')
    const expected = await frozen.run(), observed = await campaign.run()
    expect(observed).toEqual(expected)
    expect(await campaign.store.archive()).toEqual(await frozen.store.archive())
    expect(await campaign.store.object<ResearchArchive>(observed.archiveDigest))
      .toEqual(await frozen.store.object<ResearchArchive>(expected.archiveDigest))
    expect(await campaign.store.remaining('r', campaign.admission.settings.budgets))
      .toEqual(await frozen.store.remaining('r', frozen.admission.settings.budgets))
    for (const path of ['rounds/r/terminal', 'active-round', 'rounds/r/progress'])
      expect(await campaign.store.read(path)).toEqual(await frozen.store.read(path))
    expect(campaign.attempts).toEqual(frozen.attempts)
    expect(campaign.fixture.executions).toEqual(frozen.fixture.executions)
    const attempts = campaign.attempts.length
    expect(await campaign.run(new SearchStore(campaign.root))).toEqual(observed)
    expect(campaign.attempts).toHaveLength(attempts)
  })
})


// Root-audited adversarial cases use identical independent fixtures and compare
// the public contract, not the Campaign implementation's private state shape.
describe('Campaign search adversarial behavioral equivalence', () => {
  it('reconciles a frozen commit while the provider is offline and the caller is aborted', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const compare = async (driver: 'frozen' | 'campaign') => {
      const scenario = await oracleCase('actionable', driver)
      const write = scenario.store.write.bind(scenario.store)
      let crashed = false
      scenario.store.write = async (name, value) => {
        await write(name, value)
        if (!crashed && name === 'rounds/r/commit') {
          crashed = true
          throw new Error('fixture:commit-pointer-crash')
        }
      }
      await expect(scenario.run()).rejects.toThrow('fixture:commit-pointer-crash')
      const before = structuredClone(scenario.attempts)
      const generated = structuredClone(scenario.fixture.generated)
      const budgetBefore = await scenario.store.remaining('r', scenario.admission.settings.budgets)
      scenario.fixture.provider.describe = async () => { throw new Error('provider is offline') }
      scenario.fixture.hooks.verifySnapshot = async () => { throw new Error('harness is unavailable') }
      const caller = new AbortController()
      caller.abort(new Error('caller cancelled after commit freeze'))
      const outcome = await scenario.run(new SearchStore(scenario.root), caller.signal)
      expect(scenario.attempts).toEqual(before)
      expect(scenario.fixture.generated).toEqual(generated)
      expect(await scenario.store.remaining('r', scenario.admission.settings.budgets)).toEqual(budgetBefore)
      const pointer = await scenario.store.read<{ ref: string }>('rounds/r/commit')
      return { outcome, attempts: scenario.attempts, generated,
        archive: await scenario.store.archive(), commit: await scenario.store.object(pointer!.ref),
        terminal: await scenario.store.read('rounds/r/terminal'), active: await scenario.store.read('active-round') }
    }
    expect(await compare('campaign')).toEqual(await compare('frozen'))
  })

  it('reads a completed legacy round through the new public implementation without re-admission', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const scenario = await oracleCase('actionable', 'frozen')
    const outcome = await scenario.run()
    const attempts = structuredClone(scenario.attempts)
    const generated = structuredClone(scenario.fixture.generated)
    scenario.fixture.provider.describe = async () => { throw new Error('legacy provider is offline') }
    scenario.fixture.hooks.verifySnapshot = async () => { throw new Error('legacy harness is unavailable') }
    const caller = new AbortController()
    caller.abort(new Error('completed caller cancelled'))
    const resumed = await new CampaignFailureClusterSearch(new SearchStore(scenario.root),
      scenario.fixture.provider, scenario.fixture.diagnosis, scenario.fixture.hooks)
      .run(scenario.admission, caller.signal)
    expect(resumed).toEqual(outcome)
    expect(scenario.attempts).toEqual(attempts)
    expect(scenario.fixture.generated).toEqual(generated)
  })

  it('reads a sealed terminal without provider admission or an uncancelled caller', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    for (const driver of ['frozen', 'campaign'] as const) {
      const scenario = await oracleCase('no-actionable', driver)
      const outcome = await scenario.run()
      scenario.fixture.provider.describe = async () => { throw new Error('provider is offline') }
      scenario.fixture.hooks.verifySnapshot = async () => { throw new Error('old snapshot is no longer available') }
      const cancelled = new AbortController()
      cancelled.abort(new Error('caller has cancelled'))
      expect(await scenario.run(new SearchStore(scenario.root), cancelled.signal)).toEqual(outcome)
    }
  })

  async function compareCase(options: {
    id: string
    maxCandidates?: number
    process?: boolean
    configure?: (fixture: ReturnType<typeof fixtures>, config: ReturnType<typeof settings>) => void
  }) {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    const results = []
    for (const driver of ['frozen', 'campaign'] as const) {
      const root = await mkdtemp(join(tmpdir(), 'gear-search-adversarial-'))
      roots.push(root)
      const store = new SearchStore(root), fixture = fixtures(20, options.process), config = settings()
      options.configure?.(fixture, config)
      const request = { evolutionId: options.id, roundId: 'r', roundIndex: 0,
        maxCandidates: options.maxCandidates ?? 1, anchor: fixture.anchor,
        championRevisionDigest: digestJson('adversarial-champion'), settings: config }
      const Search = driver === 'frozen' ? FrozenFailureClusterSearch : CampaignFailureClusterSearch
      const outcome = await new Search(store, fixture.provider, fixture.diagnosis, fixture.hooks)
        .run(request, new AbortController().signal)
      results.push({ outcome, archive: await store.archive(),
        remaining: await store.remaining('r', config.budgets),
        progress: await store.read('rounds/r/progress'),
        terminal: await store.read('rounds/r/terminal'),
        executions: structuredClone(fixture.executions), generated: [...fixture.generated],
        promotions: [...fixture.promotions] })
      const before = [fixture.executions.length, fixture.generated.length, fixture.promotions.length]
      expect(await new Search(new SearchStore(root), fixture.provider, fixture.diagnosis, fixture.hooks)
        .run(request, new AbortController().signal)).toEqual(outcome)
      expect([fixture.executions.length, fixture.generated.length, fixture.promotions.length]).toEqual(before)
    }
    expect(results[1]).toEqual(results[0])
    return results[0]!
  }

  it.each(['neither', 'tokens-only', 'requests-only'] as const)(
    'preserves independently optional generation limits: %s', async mode => {
      const result = await compareCase({ id: `optional-${mode}`, configure: (_fixture, config) => {
        for (const budget of [config.budgets.round, config.budgets.evolution]) {
          if (mode !== 'tokens-only') delete budget.maxGenerationTokens
          if (mode !== 'requests-only') delete budget.maxGenerationRequests
        }
      } })
      expect(result.outcome.research.workplans).toHaveLength(1)
      if (mode !== 'tokens-only') expect(result.remaining.generationTokens).toBeNull()
      if (mode !== 'requests-only') expect(result.remaining.generationRequests).toBeNull()
    })

  it.each(['round', 'evolution'] as const)('charges generation when only the %s budget supplies limits', async layer => {
    const result = await compareCase({ id: `one-layer-${layer}`, configure: (_fixture, config) => {
      const unbounded = layer === 'round' ? config.budgets.evolution : config.budgets.round
      delete unbounded.maxGenerationTokens
      delete unbounded.maxGenerationRequests
    } })
    expect(result.outcome.research.workplans).toHaveLength(1)
    expect(result.outcome.research.remainingBudget).toEqual(result.remaining)
  })

  it('blocks every nominee when one bridge participant lacks evidence', async () => {
    const result = await compareCase({ id: 'partial-bridge', maxCandidates: 4,
      configure: (fixture) => {
        const evaluate = fixture.provider.evaluate
        let partialId: string | undefined
        fixture.provider.evaluate = async input => {
          const cells = await evaluate(input)
          if (input.plan.stage === 'bridge' && input.snapshot.candidateId !== fixture.anchor.candidateId && !partialId) {
            partialId = input.snapshot.candidateId
            return cells.slice(1)
          }
          return cells
        }
      } })
    expect(result.outcome.nomineeId).toBeUndefined()
    expect(result.outcome.reasonCodes).toContain('incomplete-bridge-evidence')
    expect(result.executions.some(call => call.stage === 'global-seed' || call.stage === 'held-out')).toBe(false)
  })

  it('preserves process evidence and all stage decisions', async () => {
    await compareCase({ id: 'process-enabled', process: true })
  })

  it('retains failed generation workplans and their ineligible stage decisions', async () => {
    const result = await compareCase({ id: 'generation-no-candidate', configure: (fixture) => {
      const value = { changedPaths: [], reason: 'candidate validation failed', usage: { tokens: 7, requests: 1 } }
      fixture.hooks.generate = async () => ({ ...value, digest: digestJson(value) })
    } })
    expect(result.outcome.research.workplans).toHaveLength(1)
    expect(result.outcome.research.candidates).toEqual([])
    expect(result.outcome.research.stageDecisions).toContainEqual(expect.objectContaining({
      outcome: 'ineligible', reasonCodes: ['candidate validation failed'],
    }))
  })

  it('retains a candidate outside its modification boundary without expanding it', async () => {
    const result = await compareCase({ id: 'modification-boundary', configure: (fixture) => {
      const generate = fixture.hooks.generate
      fixture.hooks.generate = async input => revise(await generate(input), { changedPaths: ['outside/other.ts'] })
    } })
    expect(result.outcome.research.candidates).toHaveLength(1)
    expect(result.outcome.research.candidates[0]!.expansion).toBe('requires-broader-evaluation')
    expect(result.outcome.nomineeId).toBeUndefined()
  })

  it('retains diagnosed clusters when generation has an explicit zero budget', async () => {
    const result = await compareCase({ id: 'zero-generation', configure: (_fixture, config) => {
      config.budgets.round.maxGenerationTokens = 0
    } })
    expect(result.generated).toEqual([])
    expect(result.outcome.research.workplans).toEqual([])
  })
})
