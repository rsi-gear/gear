import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { FileArtifactStore, sha256 } from '../../src/algorithm/artifacts.js'
import { BindingStore } from '../../src/algorithm/bindings.js'
import { ALGORITHM_API_VERSION, type Algorithm, type CampaignSpec } from '../../src/algorithm/contracts.js'
import { GepaEvaluationProvider } from '../../src/algorithm/providers/gepa-operations.js'
import { AlgorithmRuntime } from '../../src/algorithm/runtime/engine.js'
import type { JsonValue } from '../../src/algorithm/schema.js'
import { plannedCells } from '../../src/search/evidence.js'
import { evaluatedFixture, fixtures, scopeFixture } from '../../src/search/testing.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('reuses a frozen GEPA cache split after a failed clock commit and expires without physical dispatch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gepa-clock-provider-')); roots.push(root)
  const fixture = fixtures(4)
  const { plan } = evaluatedFixture(fixture.seed,
    scopeFixture(fixture.seed, ['task-0']), fixture.anchor, () => ({ outcome: 0 }), { stage: 'baseline-probe' })
  const artifacts = new FileArtifactStore(join(root, 'artifacts'))
  const bindingSchema = { id: 'harness', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true },
  } }
  const bindings = new BindingStore(artifacts, bindingSchema)
  const harness = artifacts.putJson({ commitOid: fixture.anchor.commit,
    manifestDigest: fixture.anchor.manifestDigest }, 'harness.directory.v1')
  const initialBindingSetRef = bindings.create({ harness })
  const count = plannedCells(fixture.seed, plan, fixture.anchor).length
  const spec: CampaignSpec = { campaignId: 'gepa-clock', config: {}, initialBindingSetRef,
    budget: {
      rolloutCells: { unit: 'cell', source: 'gepa.evaluate', limit: count, capability: 'stop' },
      repairCells: { unit: 'cell', source: 'gepa.evaluate', limit: count, capability: 'stop' },
    } }
  let reducedOutcome: unknown
  const algorithm: Algorithm = {
    describe: () => ({ id: 'gepa-clock', apiVersion: ALGORITHM_API_VERSION,
      implementationDigest: sha256('gepa-clock-algorithm.v1'), bindingSchema,
      configSchema: { type: 'object', additionalProperties: false },
      stateSchema: { type: 'object', additionalProperties: true },
      requiredOperationKinds: ['gepa.evaluate'] }),
    initialize: () => ({ nextState: { phase: 'running' }, operations: [{ localKey: 'evaluate',
      kind: 'gepa.evaluate', input: { roundIdentity: { evolutionId: 'e', roundId: 'r' },
        universe: fixture.seed, plan, snapshot: fixture.anchor, processMode: 'off' } as unknown as JsonValue,
      limits: { rolloutCells: count, repairCells: 0 }, startsBudgetClock: true }] }),
    reduce: context => { reducedOutcome = context.completed.evaluate; return { nextState: { phase: 'done' }, complete: true } },
  }
  const start = Date.now()
  const provider = new GepaEvaluationProvider(join(root, 'provider'), artifacts, bindings, fixture.provider)
  const runtime = new AlgorithmRuntime(root, algorithm, [provider], spec, { artifacts })
  const endInvocation = provider.beginLegacyInvocation({ callerSignal: new AbortController().signal,
    deadlineAt: start + 60_000 })
  expect(await runtime.tick()).toBe('advanced')
  const originalCommit = runtime.store.commit.bind(runtime.store)
  runtime.store.commit = async (state, event) => {
    if (event === 'budget.clock-start') throw new Error('clock commit failed')
    await originalCommit(state, event)
  }
  await expect(runtime.tick()).rejects.toThrow('clock commit failed')
  expect(runtime.snapshot()?.budgetStartedAt).toBeUndefined()
  expect(fixture.executions).toHaveLength(0)
  endInvocation()
  const resumedProvider = new GepaEvaluationProvider(join(root, 'provider'), artifacts, bindings, fixture.provider)
  const endResumed = resumedProvider.beginLegacyInvocation({ callerSignal: new AbortController().signal,
    deadlineAt: start - 1 })
  try {
    const resumed = new AlgorithmRuntime(root, algorithm, [resumedProvider], spec, { artifacts })
    expect(await resumed.tick()).toBe('complete')
    expect(resumed.snapshot()?.budgetStartedAt).toBeUndefined()
    expect(fixture.executions).toHaveLength(0)
    expect(reducedOutcome).toMatchObject({ kind: 'result' })
  } finally { endResumed() }
})
