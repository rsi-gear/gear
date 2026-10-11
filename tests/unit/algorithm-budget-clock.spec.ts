import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileArtifactStore, sha256 } from '../../src/algorithm/artifacts.js'
import { BindingStore } from '../../src/algorithm/bindings.js'
import { ALGORITHM_API_VERSION, type Algorithm, type CampaignSpec, type OperationIntent,
  type OperationProvider, type ProviderPreflight } from '../../src/algorithm/contracts.js'
import { AlgorithmRuntime } from '../../src/algorithm/runtime/engine.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const bindingSchema = { id: 'clock.bindings.v1', slots: {} }

function fixture(options: { intents?: OperationIntent[]; preflight?: () => void | ProviderPreflight;
  prepare?: () => ProviderPreflight; prepareFailure?: 'before-write' | 'after-write';
  replayReceipt?: boolean; mainWait?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gear-budget-clock-')); roots.push(root)
  const artifacts = new FileArtifactStore(join(root, 'artifacts'))
  const initialBindingSetRef = new BindingStore(artifacts, bindingSchema).create({})
  const spec: CampaignSpec = { campaignId: 'clock-fixture', config: {}, initialBindingSetRef,
    budget: { units: { unit: 'unit', limit: 2, source: 'toy.clock', capability: 'stop' } } }
  const intents = options.intents ?? [{ localKey: 'one', kind: 'toy.clock', input: {}, limits: {}, startsBudgetClock: true }]
  const counts = { preflight: 0, prepare: 0, submit: 0 }
  const preparedPath = join(root, 'prepared.json')
  const algorithm: Algorithm = {
    describe: () => ({ id: 'clock-fixture', apiVersion: ALGORITHM_API_VERSION,
      implementationDigest: sha256('clock-fixture.v1'), bindingSchema,
      configSchema: { type: 'object', additionalProperties: false },
      stateSchema: { type: 'object', additionalProperties: true } }),
    initialize: () => ({ nextState: { phase: 'running' }, operations: options.mainWait
      ? [{ localKey: 'main', kind: 'toy.wait', input: {}, limits: {} }] : intents }),
    reduce: () => ({ nextState: { phase: 'done' }, complete: true }),
  }
  const manifest = { kind: 'toy.clock', implementationDigest: sha256('toy.clock.v1'),
    inputSchema: { type: 'object' as const, additionalProperties: false },
    outputSchema: { type: 'object' as const, additionalProperties: false },
    execution: 'trusted-local' as const, supportsInspect: true as const,
    supportsIdempotentReplay: true as const,
    meteredDimensions: options.replayReceipt ? ['units'] : [] }
  const clock: OperationProvider = {
    describe: () => manifest,
    inspect: async envelope => options.replayReceipt
      ? { status: 'replay-safe', receipt: { source: 'toy.clock', scope: 'operation',
        operationId: envelope.operationId, cursor: 'observed-one', cumulative: { units: 1 } } }
      : { status: 'not-started' },
    preflight: () => { counts.preflight++; return options.preflight?.() },
    prepareForDispatch: () => {
      counts.prepare++
      if (options.prepareFailure === 'before-write') throw new Error('preparation failed before write')
      const existing = existsSync(preparedPath) ? JSON.parse(readFileSync(preparedPath, 'utf8')) as { startsBudgetClock: boolean } : null
      const disposition = existing ?? options.prepare?.() ?? { startsBudgetClock: true }
      if (!existing) writeFileSync(preparedPath, JSON.stringify(disposition))
      if (options.prepareFailure === 'after-write') throw new Error('preparation failed after write')
      return disposition
    },
    submit: async envelope => {
      counts.submit++
      if (!existsSync(preparedPath)) throw new Error('submit before durable preparation')
      return { status: 'completed', completion: { operationId: envelope.operationId,
        idempotencyKey: envelope.idempotencyKey, inputDigest: envelope.inputDigest,
        implementationDigest: envelope.implementationDigest,
        outcome: { kind: 'result', value: {} },
        ...(options.replayReceipt ? { receipt: { source: 'toy.clock', scope: 'operation' as const,
          operationId: envelope.operationId, cursor: 'final-one', cumulative: { units: 1 } } } : {}) } }
    },
    cancel: async () => ({ status: 'cancelled', releaseConfirmed: true }),
    collect: async () => { throw new Error('unused') },
  }
  const wait: OperationProvider = {
    describe: () => ({ ...manifest, kind: 'toy.wait', implementationDigest: sha256('toy.wait.v1'), meteredDimensions: [] }),
    inspect: async () => ({ status: 'not-started' }), preflight: () => {},
    submit: async () => ({ status: 'running' }), cancel: async () => ({ status: 'unknown' }),
    collect: async () => { throw new Error('unused') },
  }
  const runtime = () => new AlgorithmRuntime(root, algorithm, [clock, wait], spec)
  return { runtime, counts, preparedPath }
}

describe('Campaign budget clock dispatch', () => {
  it('starts once for a zero-cost flagged dispatch and survives restart without a second timestamp', async () => {
    const f = fixture(), first = f.runtime()
    expect(await first.tick()).toBe('advanced')
    expect(first.snapshot()?.budgetStartedAt).toBeUndefined()
    expect(await first.tick()).toBe('complete')
    const startedAt = first.snapshot()?.budgetStartedAt
    expect(startedAt).toEqual(expect.any(Number))
    expect(f.counts).toMatchObject({ prepare: 1, submit: 1 })
    expect(await f.runtime().tick()).toBe('complete')
    expect(f.runtime().snapshot()?.budgetStartedAt).toBe(startedAt)
    expect(f.counts.submit).toBe(1)
  })

  it('uses one durable clock commit for a parallel batch', async () => {
    const f = fixture({ intents: [
      { localKey: 'a', kind: 'toy.clock', input: {}, limits: {}, startsBudgetClock: true },
      { localKey: 'b', kind: 'toy.clock', input: {}, limits: {}, startsBudgetClock: true },
    ] }), runtime = f.runtime()
    await runtime.tick()
    let clockCommits = 0
    const original = runtime.store.commit.bind(runtime.store)
    runtime.store.commit = async (state, event) => {
      if (event === 'budget.clock-start') clockCommits++
      await original(state, event)
    }
    expect(await runtime.tick()).toBe('complete')
    expect(clockCommits).toBe(1)
    expect(f.counts.submit).toBe(2)
  })

  it('does not start for an unflagged operation or a frozen no-dispatch disposition', async () => {
    const unflagged = fixture({ intents: [{ localKey: 'one', kind: 'toy.clock', input: {}, limits: {} }],
      prepare: () => ({ startsBudgetClock: false }) }), first = unflagged.runtime()
    await first.tick(); expect(await first.tick()).toBe('complete')
    expect(first.snapshot()?.budgetStartedAt).toBeUndefined()
    const expired = fixture({ prepare: () => ({ startsBudgetClock: false }) }), second = expired.runtime()
    await second.tick(); expect(await second.tick()).toBe('complete')
    expect(second.snapshot()?.budgetStartedAt).toBeUndefined()
    expect(expired.counts.submit).toBe(1)
    const readOnlyDenied = fixture({ preflight: () => ({ startsBudgetClock: false }) }), third = readOnlyDenied.runtime()
    await third.tick(); expect(await third.tick()).toBe('complete')
    expect(third.snapshot()?.budgetStartedAt).toBeUndefined()
    expect(readOnlyDenied.counts.submit).toBe(1)
  })

  it('rejects invalid clock intent and refuses a provider upgrade of an unflagged intent', async () => {
    const invalid = fixture({ intents: [{ localKey: 'one', kind: 'toy.clock', input: {}, limits: {},
      startsBudgetClock: 1 as unknown as boolean }] })
    await expect(invalid.runtime().tick()).rejects.toThrow('budget clock intent must be boolean')
    const upgrade = fixture({ intents: [{ localKey: 'one', kind: 'toy.clock', input: {}, limits: {} }] })
    const runtime = upgrade.runtime(); await runtime.tick()
    await expect(runtime.tick()).rejects.toThrow('unrequested budget clock')
    expect(upgrade.counts.submit).toBe(0)
    expect(runtime.snapshot()?.budgetStartedAt).toBeUndefined()
  })

  it('does not submit when preparation or the clock commit fails, then reuses the prepared plan', async () => {
    const f = fixture(), runtime = f.runtime()
    await runtime.tick()
    const original = runtime.store.commit.bind(runtime.store)
    runtime.store.commit = async (state, event) => {
      if (event === 'budget.clock-start') throw new Error('clock commit failed before durable write')
      await original(state, event)
    }
    await expect(runtime.tick()).rejects.toThrow('clock commit failed')
    expect(existsSync(f.preparedPath)).toBe(true)
    expect(f.counts.submit).toBe(0)
    expect(runtime.snapshot()?.budgetStartedAt).toBeUndefined()
    const resumed = f.runtime()
    expect(await resumed.tick()).toBe('complete')
    expect(f.counts.submit).toBe(1)
    expect(resumed.snapshot()?.budgetStartedAt).toEqual(expect.any(Number))
  })

  it('does not start the clock or submit when preparation fails before or after its durable plan write', async () => {
    for (const failure of ['before-write', 'after-write'] as const) {
      const f = fixture({ prepareFailure: failure }), runtime = f.runtime()
      await runtime.tick()
      await expect(runtime.tick()).rejects.toThrow(`preparation failed ${failure === 'before-write' ? 'before' : 'after'} write`)
      expect(existsSync(f.preparedPath)).toBe(failure === 'after-write')
      expect(runtime.snapshot()?.budgetStartedAt).toBeUndefined()
      expect(f.counts).toMatchObject({ prepare: 1, submit: 0 })
    }
  })

  it('keeps a clock committed before a lost acknowledgement and dispatches only after recovery', async () => {
    const f = fixture(), runtime = f.runtime()
    await runtime.tick()
    const original = runtime.store.commit.bind(runtime.store)
    runtime.store.commit = async (state, event) => {
      await original(state, event)
      if (event === 'budget.clock-start') throw new Error('lost clock acknowledgement')
    }
    await expect(runtime.tick()).rejects.toThrow('lost clock acknowledgement')
    const startedAt = runtime.snapshot()?.budgetStartedAt
    expect(startedAt).toEqual(expect.any(Number))
    expect(f.counts.submit).toBe(0)
    const resumed = f.runtime()
    expect(await resumed.tick()).toBe('complete')
    expect(resumed.snapshot()?.budgetStartedAt).toBe(startedAt)
    expect(f.counts.submit).toBe(1)
  })

  it('rechecks expiry after a prepared plan but failed clock commit, without discarding the plan', async () => {
    let expired = false
    const f = fixture({ preflight: () => ({ startsBudgetClock: !expired }) }), runtime = f.runtime()
    await runtime.tick()
    const original = runtime.store.commit.bind(runtime.store)
    runtime.store.commit = async (state, event) => {
      if (event === 'budget.clock-start') throw new Error('clock did not commit')
      await original(state, event)
    }
    await expect(runtime.tick()).rejects.toThrow('clock did not commit')
    expect(existsSync(f.preparedPath)).toBe(true)
    expired = true
    const resumed = f.runtime()
    expect(await resumed.tick()).toBe('complete')
    expect(resumed.snapshot()?.budgetStartedAt).toBeUndefined()
    expect(f.counts.submit).toBe(1) // provider seals its local expired outcome; no Campaign clock
  })

  it('shares the clock with an auxiliary operation without advancing the main reducer', async () => {
    const f = fixture({ mainWait: true }), runtime = f.runtime()
    await runtime.tick()
    await runtime.enqueueAuxiliary('repair', [{ localKey: 'zero', kind: 'toy.clock', input: {},
      limits: {}, startsBudgetClock: true }])
    expect(runtime.snapshot()?.budgetStartedAt).toBeUndefined()
    expect(await runtime.runAuxiliaryUntilBlocked('repair')).toBe('complete')
    const startedAt = runtime.snapshot()?.budgetStartedAt
    expect(startedAt).toEqual(expect.any(Number))
    expect(runtime.snapshot()?.decisionIndex).toBe(0)
    expect(f.counts.submit).toBe(1)
    expect(await runtime.tick()).toBe('waiting')
    expect(runtime.snapshot()?.budgetStartedAt).toBe(startedAt)
  })

  it('persists a replay-safe prior receipt when preflight fails and never starts the clock', async () => {
    const f = fixture({ replayReceipt: true,
      intents: [{ localKey: 'one', kind: 'toy.clock', input: {}, limits: { units: 1 }, startsBudgetClock: true }],
      preflight: () => { throw new Error('eligibility failed') } }), runtime = f.runtime()
    await runtime.tick()
    await expect(runtime.tick()).rejects.toThrow('eligibility failed')
    expect(runtime.snapshot()).toMatchObject({ spent: { units: 1 }, operations: { one: {
      status: 'intent', accounted: { units: 1 } } } })
    expect(runtime.snapshot()?.budgetStartedAt).toBeUndefined()
    expect(f.counts).toMatchObject({ preflight: 1, prepare: 0, submit: 0 })
  })

  it('preserves a replay-safe prior receipt when durable preparation rejects', async () => {
    const f = fixture({ replayReceipt: true, prepareFailure: 'after-write',
      intents: [{ localKey: 'one', kind: 'toy.clock', input: {}, limits: { units: 1 }, startsBudgetClock: true }] }),
      runtime = f.runtime()
    await runtime.tick()
    await expect(runtime.tick()).rejects.toThrow('preparation failed after write')
    expect(runtime.snapshot()).toMatchObject({ spent: { units: 1 }, operations: { one: {
      status: 'intent', accounted: { units: 1 } } } })
    expect(runtime.snapshot()?.budgetStartedAt).toBeUndefined()
    expect(f.counts.submit).toBe(0)
  })
})
