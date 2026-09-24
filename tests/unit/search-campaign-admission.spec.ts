import { describe, expect, it } from 'vitest'
import { ComponentRegistry } from '../../src/evolution/components.js'
import { digestJson } from '../../src/state/digest.js'
import { claimCampaignRun, inspectCampaignRun, type CampaignAdmissionExtensions } from '../../src/search/campaign-admission.js'
import { seal } from '../../src/search/contracts.js'
import { FailureClusterSearch } from '../../src/search/engine.js'
import { collectFailure } from '../../src/search/regression.js'
import type { SearchAdmission } from '../../src/search/runtime.js'
import { MemorySearchStore, fixtures, settings, universe } from '../../src/search/testing.js'

const recipeIdentity = digestJson('campaign-admission-fixture-recipe')

function scenario(store = new MemorySearchStore()) {
  const fixture = fixtures(20)
  const request: SearchAdmission = { evolutionId: 'evolution', roundId: 'round', roundIndex: 0,
    maxCandidates: 1, anchor: fixture.anchor, championRevisionDigest: digestJson('champion'),
    settings: settings() }
  const components = new ComponentRegistry()
  const proposal = collectFailure({ source: { kind: 'online-feedback', evidenceRef: 'fixture-evidence' },
    outcome: 'business-failure', prompt: 'Handle an uncommon workflow', fixtureRefs: [],
    expectedBehavior: 'Complete the workflow', failureCategory: 'coverage-gap' }, [],
  { collectFailures: true, maxProposals: 1 }).proposal!
  const extensions = (): CampaignAdmissionExtensions => ({
    startingArchiveDigest: digestJson('archive'), completionRefs: [digestJson('completion')],
    sharedEpochs: { '0': { epoch: 0, parentSnapshotDigest: fixture.anchor.digest } },
    handoffFindingDigests: { [fixture.anchor.digest]: [digestJson('finding')] },
    campaignBudget: { rolloutCells: { unit: 'cells', limit: 20,
      source: 'gepa.evaluate', capability: 'stop' } },
    startingRegressionProposals: [proposal], roundRecipeIdentity: recipeIdentity,
  })
  const inspect = (next = request, signal = new AbortController().signal) =>
    inspectCampaignRun({ store, request: next, components, signal })
  const claim = async (signal = new AbortController().signal, overrides: {
    validate?: () => Promise<{ seed: typeof fixture.seed; heldOut: typeof fixture.heldOut;
      resolvedSettings: SearchAdmission['settings'] }>
    prepareExtensions?: (startedAt: number) => CampaignAdmissionExtensions | Promise<CampaignAdmissionExtensions>
    recipeIdentity?: string
    request?: SearchAdmission
    providerIntegrity?: string
  } = {}) => {
    const chosen = overrides.request ?? request
    const inspected = await inspect(chosen, signal)
    if (inspected.kind !== 'continue') throw new Error(`unexpected ${inspected.kind}`)
    return claimCampaignRun({ store, request: chosen, signal, inspected,
      providerIntegrity: overrides.providerIntegrity ?? fixture.provider.integrity,
      diagnosisIntegrity: fixture.diagnosis.integrity,
      sanitizationPolicyDigest: fixture.diagnosis.sanitizationPolicyDigest,
      validate: overrides.validate ?? (async () => ({ seed: fixture.seed, heldOut: fixture.heldOut,
        resolvedSettings: request.settings })),
      prepareExtensions: (_current, startedAt) => overrides.prepareExtensions?.(startedAt) ?? extensions(),
      verifyFrozenRecipe: admission => {
        if (admission.roundRecipeIdentity !== (overrides.recipeIdentity ?? recipeIdentity))
          throw new Error('round recipe identity changed on resume')
      } })
  }
  return { store, fixture, request, inspect, claim, extensions }
}

describe('Campaign search admission and recovery gates', () => {
  it('claims a complete frozen admission and reuses every cut after a journal restart', async () => {
    const first = scenario()
    let preparedStartedAt: number | undefined
    const claimed = await first.claim(undefined, { prepareExtensions: async startedAt => {
      preparedStartedAt = startedAt
      expect(await first.store.read('active-round')).toEqual({ roundId: 'round' })
      expect(await first.store.read('rounds/round/operation-kind')).toBeDefined()
      expect(await first.store.read('evolution/identity')).toBeDefined()
      return first.extensions()
    } })
    expect(preparedStartedAt).toBe(claimed.admission.startedAt)
    expect(claimed.admission.settings).toEqual(first.request.settings)
    expect(claimed.admission.requestDigest).toBe(digestJson(first.request))
    expect(claimed.admission).toMatchObject(first.extensions())
    expect(await first.store.read('evolution/identity')).toBeDefined()
    expect(await first.store.read('rounds/round/operation-kind')).toBeDefined()
    const restarted = scenario(new MemorySearchStore(first.store.checkpoint()))
    const resumed = await restarted.claim(undefined, {
      prepareExtensions: () => { throw new Error('must not read new global cuts') },
    })
    expect(resumed.admission).toEqual(claimed.admission)
    expect(resumed.admission.startingArchiveDigest).toBe(digestJson('archive'))
    expect(resumed.admission.completionRefs).toEqual([digestJson('completion')])
    expect(resumed.admission.sharedEpochs).toEqual(first.extensions().sharedEpochs)
    expect(resumed.admission.handoffFindingDigests).toEqual(first.extensions().handoffFindingDigests)
    expect(resumed.admission.campaignBudget).toEqual(first.extensions().campaignBudget)
    expect(resumed.admission.startingRegressionProposals).toEqual(first.extensions().startingRegressionProposals)
  })

  it('does not claim an unsafe or cancelled round, including cancellation during validation', async () => {
    const run = scenario()
    await expect(run.inspect({ ...run.request, roundId: 'bad/id' })).rejects.toThrow('unsafe record ID')
    expect(run.store.checkpoint()).toEqual([])
    const cancelled = new AbortController()
    cancelled.abort(new Error('caller cancelled'))
    await expect(run.claim(cancelled.signal)).rejects.toThrow('caller cancelled')
    expect(run.store.checkpoint()).toEqual([])
    const during = new AbortController()
    await expect(run.claim(during.signal, { validate: async () => {
      during.abort(new Error('cancelled during validation'))
      return { seed: run.fixture.seed, heldOut: run.fixture.heldOut,
        resolvedSettings: run.request.settings }
    } })).rejects.toThrow('cancelled during validation')
    expect(run.store.checkpoint()).toEqual([])
  })

  it('checks completion and repair ownership before cancellation or new admission', async () => {
    const run = scenario()
    await run.store.write('active-completion', { id: 'pending' })
    await expect(run.inspect()).rejects.toThrow('unresolved completion')
    await run.store.write('rounds/pending/result', { ref: digestJson('done') })
    await run.store.write('rounds/round/active-repair', { id: 'repair' })
    await expect(run.inspect()).rejects.toThrow('unresolved repair')
    await run.store.write(`rounds/round/repair-result-${digestJson('repair').slice(7)}`,
      { ref: digestJson('repaired') })
    expect((await run.inspect()).kind).toBe('continue')
    expect(await run.store.read('evolution/identity')).toBeUndefined()
  })

  it('returns the frozen commit before validation and caller cancellation', async () => {
    const run = scenario()
    await run.claim()
    const intent = seal({ expectedArchiveDigest: digestJson('old'),
      nextArchiveDigest: digestJson('new'), expectedChampionRevisionDigest: digestJson('revision'),
      outcome: { pending: true } })
    await run.store.put(intent)
    await run.store.write('rounds/round/commit', { ref: intent.digest })
    run.fixture.provider.describe = async () => { throw new Error('provider offline') }
    const cancelled = new AbortController()
    cancelled.abort(new Error('caller cancelled'))
    const inspected = await run.inspect(run.request, cancelled.signal)
    expect(inspected).toEqual({ kind: 'commit', intent })
    // Claim would invoke provider validation; a caller must reconcile this intent instead.
    expect(await run.store.read('rounds/round/terminal')).toBeUndefined()
  })

  it('returns a sealed terminal and clears its active pointer without provider admission', async () => {
    const run = scenario()
    run.fixture.diagnosis.diagnose = async () => ({ facts: [], inputTokens: 1, outputTokens: 1 })
    const old = await new FailureClusterSearch(run.store, run.fixture.provider,
      run.fixture.diagnosis, run.fixture.hooks).run(run.request, new AbortController().signal)
    const pointer = await run.store.read<{ ref: string }>('rounds/round/admission')
    const legacy = await run.store.object<Record<string, unknown> & { digest: string }>(pointer!.ref)
    const { digest: _ignored, ...body } = legacy
    const adopted = seal({ ...body, ...run.extensions(), requestDigest: digestJson(run.request),
      campaignDriver: 'failure-cluster-campaign-v1' })
    await run.store.put(adopted)
    await run.store.write('rounds/round/admission', { ref: adopted.digest })
    await run.store.write('active-round', { roundId: 'round' })
    run.fixture.provider.describe = async () => { throw new Error('provider offline') }
    const cancelled = new AbortController()
    cancelled.abort(new Error('caller cancelled'))
    expect(await run.inspect(run.request, cancelled.signal)).toEqual({ kind: 'terminal', outcome: old })
    expect(await run.store.read('active-round')).toEqual({ roundId: null })
    await expect(run.inspect({ ...run.request, maxCandidates: 2 }, cancelled.signal))
      .rejects.toThrow('request changed')
  })

  it('replays a sealed legacy terminal offline but leaves an unfinished legacy round with its original engine', async () => {
    const run = scenario()
    run.fixture.diagnosis.diagnose = async () => ({ facts: [], inputTokens: 1, outputTokens: 1 })
    const old = await new FailureClusterSearch(run.store, run.fixture.provider,
      run.fixture.diagnosis, run.fixture.hooks).run(run.request, new AbortController().signal)
    const pointer = await run.store.read<{ ref: string }>('rounds/round/admission')
    const frozen = await run.store.object<Record<string, unknown> & { digest: string }>(pointer!.ref)
    expect(frozen).not.toHaveProperty('campaignDriver')
    expect(frozen).not.toHaveProperty('requestDigest')
    const unfinished = scenario(new MemorySearchStore(run.store.checkpoint()
      .filter(([path]) => path !== 'rounds/round/terminal')))
    await expect(unfinished.inspect()).rejects.toThrow('original engine and operation keys')
    await run.store.write('active-round', { roundId: 'round' })
    run.fixture.provider.describe = async () => { throw new Error('provider offline') }
    const cancelled = new AbortController()
    cancelled.abort(new Error('caller cancelled'))
    expect(await run.inspect(run.request, cancelled.signal)).toEqual({ kind: 'terminal', outcome: old })
    expect(await run.store.read('active-round')).toEqual({ roundId: null })
    await expect(run.inspect({ ...run.request, maxCandidates: 2 }, cancelled.signal))
      .rejects.toThrow('request changed')
  })

  it('rejects operation-kind collisions, other active rounds, and a changed evolution identity', async () => {
    const collided = scenario()
    await collided.store.freeze('round', 'operation-kind', () => seal({ kind: 'archive-completion' }))
    await expect(collided.claim(undefined, { prepareExtensions: () => {
      throw new Error('must not prepare a conflicting round')
    } })).rejects.toThrow('different operation kind')
    expect(await collided.store.read('evolution/identity')).toBeUndefined()

    const active = scenario()
    await active.store.write('active-round', { roundId: 'other' })
    await expect(active.claim(undefined, { prepareExtensions: () => {
      throw new Error('must not prepare a blocked round')
    } })).rejects.toThrow('unresolved round')
    expect(await active.store.read('rounds/round/admission')).toBeUndefined()

    const drifted = scenario()
    await drifted.claim()
    const changed = { ...drifted.request, roundId: 'next', roundIndex: 1,
      settings: { ...drifted.request.settings, budgets: {
        ...drifted.request.settings.budgets,
        round: { ...drifted.request.settings.budgets.round, maxNewRolloutCells: 1 } } } }
    await expect(drifted.claim(undefined, { request: changed })).rejects.toThrow('identity changed')
    expect(await drifted.store.read('rounds/next/admission')).toBeUndefined()
  })

  it('rejects changed request, policy, provider/task inputs, and recipe identity on resume', async () => {
    const run = scenario()
    await run.claim()
    await expect(run.inspect({ ...run.request, maxCandidates: 2 })).rejects.toThrow('request changed')
    await expect(run.claim(undefined, { recipeIdentity: digestJson('different recipe') }))
      .rejects.toThrow('round recipe identity changed')
    await expect(run.claim(undefined, { providerIntegrity: digestJson('different provider') }))
      .rejects.toThrow('identity changed')
    await expect(run.claim(undefined, { providerIntegrity: digestJson('different provider'),
      recipeIdentity: digestJson('different recipe') })).rejects.toThrow('search evolution identity changed')
    await expect(run.claim(undefined, { validate: async () => ({ seed: universe(21),
      heldOut: run.fixture.heldOut, resolvedSettings: run.request.settings }) }))
      .rejects.toThrow('identity changed')
    await expect(run.claim(undefined, { validate: async () => ({ seed: run.fixture.seed,
      heldOut: run.fixture.heldOut, resolvedSettings: { ...run.request.settings,
        regression: { ...run.request.settings.regression, maxProposals: 1 } } }) }))
      .rejects.toThrow('provider/task/settings identity changed')
    const policyChanged = { ...run.request, settings: { ...run.request.settings,
      search: { ...run.request.settings.search, parentSampling: 'epsilon-greedy-gepa-v1' as const } } }
    await expect(run.inspect(policyChanged)).rejects.toThrow('request changed')
    const pointer = await run.store.read<{ ref: string }>('rounds/round/admission')
    const frozen = await run.store.object<Record<string, unknown> & { digest: string }>(pointer!.ref)
    const { digest: _ignored, ...body } = frozen
    const altered = seal({ ...body, parentPolicyRef: { ...frozen.parentPolicyRef as object, id: 'other-policy' } })
    await run.store.put(altered)
    await run.store.write('rounds/round/admission', { ref: altered.digest })
    await expect(run.inspect()).rejects.toThrow('parent policy changed')
  })
})
