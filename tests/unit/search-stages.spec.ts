import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { digestJson } from '../../src/state/digest.js'
import { FailureClusterSearch } from '../../src/search/engine.js'
import { SearchOperationPending } from '../../src/search/recovery.js'
import { SearchStore } from '../../src/search/store.js'
import { validateSearchSchema } from '../../src/search/schema.js'
import type { GateDecision, SearchProgress, StageEvaluationPlan } from '../../src/search/types.js'
import { fixtures, revise, settings } from '../helpers/search-fixture.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup(process = false) {
  const f = fixtures(20, process), config = settings(), root = await mkdtemp(join(tmpdir(), 'gear-stage-')); roots.push(root)
  const store = new SearchStore(root), request = { evolutionId: 'stage', roundId: 'r', roundIndex: 0, maxCandidates: 4, anchor: f.anchor, championRevisionDigest: digestJson('revision'), settings: config }
  const run = () => new FailureClusterSearch(store, f.provider, f.diagnosis, f.hooks).run(request, new AbortController().signal)
  return { ...f, config, store, run }
}

describe('frozen stage decisions and seed progress', () => {
  it.each([0.25, 1])('evaluates a bridge process regression on the full seed before deciding promotion with remaining-task process %s', async remainingProcess => {
    const f = await setup(true), evaluate = f.provider.evaluate
    f.provider.evaluate = async input => {
      const cells = await evaluate(input)
      if (input.snapshot.candidateId === 'anchor') return cells
      return cells.map(c => revise(c, { process: {
        status: 'available', contractDigest: c.identity.processContractDigest!, evidenceRef: c.evidenceRef,
        rawValue: input.plan.stage === 'local' || input.plan.stage === 'bridge' ? 0.25 : remainingProcess,
      } }))
    }
    const result = await f.run(), bridge = result.research.bridge.plan!
    const decisions = result.research.stageDecisions.filter(d => d.stagePlanDigest === bridge.digest)
    expect(decisions.filter(d => d.outcome === 'advance')).toHaveLength(1)
    for (const decision of decisions) {
      const support = await f.store.object<{ digest: string; gate: GateDecision }>(decision.supportDigest)
      expect(support.gate).toMatchObject({ outcome: 'eligible', comparison: { processGains: { process: -0.25 } } })
    }
    const progress = await f.store.read<SearchProgress>('rounds/r/progress')
    expect(progress?.evaluations.find(e => e.stage === 'global-seed' && e.candidateId === result.nomineeId)?.profile?.coverage.available).toBe(20)
    expect(f.executions.some(e => e.stage === 'global-seed' && e.participant === result.nomineeId)).toBe(true)
    expect(result.championChanged).toBe(remainingProcess === 1)
    expect(result.promotion?.reasonCodes).toEqual(remainingProcess === 1 ? [] : ['process-regression:process'])
    expect(f.executions.some(e => e.stage === 'held-out')).toBe(remainingProcess === 1)
    expect(await f.run()).toEqual(result)
  })

  it('publishes scoped decisions and completed coverage before held-out while keeping that evidence isolated', async () => {
    const f = await setup(), evaluate = f.provider.evaluate
    let beforeHeldOut: SearchProgress | undefined
    f.provider.evaluate = async input => {
      if (input.plan.stage === 'held-out' && !beforeHeldOut) beforeHeldOut = await f.store.read<SearchProgress>('rounds/r/progress')
      return evaluate(input)
    }
    const result = await f.run(), decisions = result.research.stageDecisions
    expect(result.championChanged).toBe(true)
    expect(decisions).toHaveLength(6)
    expect(beforeHeldOut?.phase).toBe('seed-research-complete')
    expect(beforeHeldOut?.decisions).toEqual(decisions)
    expect(beforeHeldOut?.evaluations.every(e => e.state === 'settled' && e.profile?.coverage.available === e.plannedCells)).toBe(true)
    expect(beforeHeldOut?.evaluations.some(e => (e.stage as string) === 'held-out')).toBe(false)
    const byStage: Record<string, number> = {}
    for (const d of decisions) {
      validateSearchSchema('EvaluationStageDecision', d)
      expect(await f.store.object(d.digest)).toEqual(d)
      expect(await f.store.object(d.supportDigest)).toBeDefined()
      const p = await f.store.object<StageEvaluationPlan>(d.stagePlanDigest)
      if (d.outcome === 'advance') {
        byStage[p.stage] = (byStage[p.stage] ?? 0) + 1
        const next = await f.store.object<StageEvaluationPlan>(d.nextStagePlanDigest!)
        expect(next.participantIds).toContain(d.candidateId)
        expect(next.stage).toBe(p.stage === 'local' ? 'bridge' : 'global-seed')
      }
    }
    expect(byStage).toEqual({ local: 2, bridge: 1 })
    expect(await f.store.read('rounds/r/progress')).toEqual(beforeHeldOut)
    expect(await f.run()).toEqual(result)
  })

  it('distinguishes incomplete local evidence from complete versions retained without bridge quota', async () => {
    const f = await setup(), evaluate = f.provider.evaluate
    f.provider.evaluate = async input => {
      const cells = await evaluate(input)
      return input.plan.stage === 'local' ? cells.slice(1) : cells
    }
    const result = await f.run()
    expect(result.research.stageDecisions).toHaveLength(4)
    expect(result.research.stageDecisions.every(d => d.outcome === 'insufficient-evidence' && !d.nextStagePlanDigest)).toBe(true)
    expect(result.championChanged).toBe(false)
    const progress = await f.store.read<SearchProgress>('rounds/r/progress')
    expect(progress?.evaluations.filter(e => e.stage === 'local' && e.candidateId !== 'anchor').every(e => e.profile!.coverage.available < e.plannedCells)).toBe(true)
    const second = await setup(); second.config.search.evaluationStages.bridge.maxCandidates = 0
    const localOnly = await second.run()
    expect(localOnly.research.stageDecisions.every(d => d.outcome === 'retained-local' && d.reasonCodes.includes('bridge-disabled'))).toBe(true)
  })

  it('shows an unresolved bridge participant and resumes its original decision without changing local consumption', async () => {
    const f = await setup(), evaluate = f.provider.evaluate
    let pending = true
    f.provider.inspectEvaluation = async () => ({ status: 'running', handle: 'bridge-operation' })
    f.provider.evaluate = async input => {
      if (pending && input.plan.stage === 'bridge' && input.snapshot.candidateId !== 'anchor') throw new Error('bridge still running')
      return evaluate(input)
    }
    await expect(f.run()).rejects.toBeInstanceOf(SearchOperationPending)
    const before = await f.store.read<SearchProgress>('rounds/r/progress')
    expect(before?.phase).toBe('bridge')
    expect(before?.decisions).toHaveLength(4)
    expect(before?.evaluations.find(e => e.state === 'running')).toMatchObject({ stage: 'bridge', plannedCells: 8 })
    expect(await f.store.read('rounds/r/nomination')).toBeUndefined()
    pending = false
    const result = await f.run()
    expect(result.research.stageDecisions.slice(0, 4)).toEqual(before?.decisions)
    expect(f.generated).toHaveLength(4)
    expect(result.championChanged).toBe(true)
  })

  it('records modification-boundary exclusions and never uses their local results to nominate release', async () => {
    const f = await setup(), generate = f.hooks.generate
    f.hooks.generate = async input => {
      expect(input.delivery.workplan.modificationBoundaryRule).toEqual({ requiredSeedTaskIds: f.seed.tasks.map(t => t.id).sort(), onInsufficientScope: 'retain-research-only' })
      expect(f.executions.every(e => e.participant === 'anchor')).toBe(true)
      return revise(await generate(input), { changedPaths: ['outside/other-module.ts'] })
    }
    const result = await f.run()
    expect(result.research.stageDecisions.every(d => d.outcome === 'ineligible' && d.reasonCodes.includes('requires-broader-evaluation'))).toBe(true)
    expect(result.research.candidates.every(c => c.expansion === 'requires-broader-evaluation')).toBe(true)
    expect(f.executions.some(e => e.stage === 'bridge' || e.stage === 'global-seed' || e.stage === 'held-out')).toBe(false)
  })

  it('[D07] admits a disclosed boundary change only when the frozen local plan already covers the entire seed universe', async () => {
    const f = await setup(), generate = f.hooks.generate
    f.config.search.explorationGuards = f.seed.tasks.map(t => ({ taskId: t.id, partition: 'seed', rule: 'minimum-score', minimumUtility: 0 }))
    f.config.search.taskSetSizing.bridge.ratio = 1
    f.hooks.generate = async input => {
      expect(input.baselineContext.plan.taskIds).toEqual(input.delivery.workplan.modificationBoundaryRule.requiredSeedTaskIds)
      return revise(await generate(input), { changedPaths: ['outside/other-module.ts'] })
    }
    const result = await f.run()
    expect(result.reasonCodes.some(r => r.startsWith('modification-boundary-full-seed-covered:'))).toBe(true)
    expect(result.research.stageDecisions.some(d => d.outcome === 'advance')).toBe(true)
    expect(result.championChanged).toBe(true)
    expect(f.executions.some(e => e.stage === 'held-out')).toBe(true)
  })

  it('[R09] keeps complete local specialization when one bridge expansion lacks evidence and freezes no finalist', async () => {
    const f = await setup(), evaluate = f.provider.evaluate
    let partialId: string | undefined
    f.provider.evaluate = async input => {
      const cells = await evaluate(input)
      if (input.plan.stage === 'bridge' && input.snapshot.candidateId !== 'anchor' && !partialId) {
        partialId = input.snapshot.candidateId; return cells.slice(1)
      }
      return cells
    }
    const result = await f.run(), progress = await f.store.read<SearchProgress>('rounds/r/progress')
    expect(partialId).toBeTruthy()
    expect(result.nomineeId).toBeUndefined()
    expect(result.research.candidates.find(c => c.candidateId === partialId)?.profile.outcomeComplete).toBe(true)
    expect(progress?.evaluations.find(e => e.stage === 'bridge' && e.candidateId === partialId)?.profile?.outcomeComplete).toBe(false)
    expect(result.research.stageDecisions.filter(d => d.reasonCodes.includes('incomplete-bridge-evidence'))).toHaveLength(2)
    expect(result.research.scopeViews.some(v => v.outcomeEligibleIds.includes(partialId!))).toBe(true)
    expect(f.executions.some(e => e.stage === 'global-seed')).toBe(false)
  })
})
