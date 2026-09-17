import { describe, expect, it } from 'vitest'
import { FailureClusterSearch } from '../../src/search/engine.js'
import { MemorySearchStore, createToySearch, createToySettings, revise } from '../../src/search/testing.js'
import type { CandidateWorkPlan } from '../../src/search/types.js'

function setup() {
  const f = createToySearch(), settings = createToySettings(), journal = new MemorySearchStore()
  for (const budget of [settings.budgets.round, settings.budgets.evolution]) {
    delete budget.maxGenerationTokens
    delete budget.maxGenerationRequests
  }
  const admission = { evolutionId: 'test', roundId: 'round', roundIndex: 0, maxCandidates: 1,
    anchor: f.anchor, championRevisionDigest: f.anchor.digest, settings }
  const generate = f.hooks.generate, workplans: CandidateWorkPlan[] = []
  f.hooks.generate = async input => {
    workplans.push(input.delivery.workplan)
    const usage = { ...(input.delivery.workplan.generationBudget.maxTokens === undefined ? {} : { tokens: 10 }),
      ...(input.delivery.workplan.generationBudget.maxModelRequests === undefined ? {} : { requests: 1 }) }
    return revise(await generate(input), { usage })
  }
  return { f, settings, journal, workplans,
    run: () => new FailureClusterSearch(journal, f.provider, f.diagnosis, f.hooks).run(admission, new AbortController().signal) }
}

describe('optional model generation budgets', () => {
  it('runs and replays without claiming unmeasured model usage', async () => {
    const f = setup(), result = await f.run()
    expect(f.workplans).toHaveLength(1)
    expect(f.workplans[0]!.generationBudget).toEqual({ deadlineAt: expect.any(Number) })
    expect(result.research.remainingBudget).toMatchObject({ generationTokens: null, generationRequests: null })
    const pointer = await f.journal.read<{ ref: string }>('rounds/round/generated-round-candidate-0')
    expect((await f.journal.object<{ digest: string; usage: object }>(pointer!.ref)).usage).toEqual({})
    expect(await f.run()).toEqual(result)
    expect(f.workplans).toHaveLength(1)
  })

  it.each(['round', 'evolution'] as const)('enforces a lone request limit from %s without inventing a token limit', async scope => {
    const f = setup()
    f.settings.budgets[scope].maxGenerationRequests = 3
    const result = await f.run()
    expect(f.workplans[0]!.generationBudget).toMatchObject({ maxModelRequests: 3 })
    expect(f.workplans[0]!.generationBudget.maxTokens).toBeUndefined()
    expect(result.research.remainingBudget).toMatchObject({ generationTokens: null, generationRequests: 2 })
  })

  it.each(['maxGenerationTokens', 'maxGenerationRequests'] as const)('treats an explicit zero %s as exhausted', async resource => {
    const f = setup()
    f.settings.budgets.evolution[resource] = 0
    await f.run()
    expect(f.workplans).toEqual([])
  })

  it.each(['tokens', 'requests'] as const)('refuses to settle a hard %s limit without accounting', async resource => {
    const f = setup()
    f.settings.budgets.round[resource === 'tokens' ? 'maxGenerationTokens' : 'maxGenerationRequests'] = 100
    const generate = f.f.hooks.generate
    f.f.hooks.generate = async input => revise(await generate(input), { usage: {} })
    await expect(f.run()).rejects.toThrow(resource === 'tokens' ? 'requires token accounting' : 'requires request accounting')
    expect(f.workplans).toHaveLength(1)
  })
})
