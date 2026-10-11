import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALGORITHM_API_VERSION, AlgorithmRuntime, BindingStore, FileArtifactStore, LocalDurableProvider, sha256 } from '../../src/algorithm/index.js'
import type { Algorithm, BindingSchema, BudgetSnapshot } from '../../src/algorithm/contracts.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('passes the same read-only spent/reserved/remaining budget view to any algorithm', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gear-algorithm-budget-')); roots.push(root)
  const artifacts = new FileArtifactStore(join(root, 'artifacts'))
  const bindingSchema: BindingSchema = { id: 'budget-view.v1', slots: { harness: { schemaId: 'harness.v1', required: true } } }
  const bindingSetRef = new BindingStore(artifacts, bindingSchema).create({ harness: artifacts.putJson({ name: 'H0' }, 'harness.v1') })
  const seen: BudgetSnapshot[] = []
  const algorithm: Algorithm = {
    describe: () => ({ id: 'budget-view', apiVersion: ALGORITHM_API_VERSION, implementationDigest: sha256('budget-view'),
      stateSchema: { type: 'object', additionalProperties: true }, configSchema: { type: 'object', additionalProperties: true }, bindingSchema }),
    initialize(context) { seen.push(structuredClone(context.budget!)); context.budget!.dimensions.calls!.remaining = 1000
      return { nextState: {}, operations: [{ localKey: 'meter', kind: 'budget.meter', input: {}, limits: { calls: 3 } }] } },
    reduce(context) { seen.push(structuredClone(context.budget!)); context.budget!.dimensions.calls!.spent = 1000
      return { nextState: {}, complete: true } },
  }
  const provider = new LocalDurableProvider(join(root, 'provider'), { kind: 'budget.meter', implementationDigest: sha256('budget-provider'),
    execution: 'trusted-local', supportsInspect: true, meteredDimensions: ['calls'],
    inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object', additionalProperties: false } },
  envelope => ({ outcome: { kind: 'result', value: {} }, receipt: { source: 'budget.meter', scope: 'operation',
    operationId: envelope.operationId, cursor: 'complete', cumulative: { calls: 2 } } }))
  const runtime = new AlgorithmRuntime(root, algorithm, [provider], { campaignId: 'budget-fixture', config: {}, initialBindingSetRef: bindingSetRef,
    budget: { calls: { unit: 'request', limit: 5, source: 'budget.meter', capability: 'stop' } } })
  expect(await runtime.runUntilBlocked()).toBe('complete')
  expect(seen.map(view => view.dimensions.calls)).toEqual([
    { unit: 'request', limit: 5, source: 'budget.meter', capability: 'stop', spent: 0, reserved: 0, remaining: 5 },
    { unit: 'request', limit: 5, source: 'budget.meter', capability: 'stop', spent: 2, reserved: 0, remaining: 3 },
  ])
  expect(runtime.snapshot()?.spent.calls).toBe(2)
})

it('clamps the visible remaining budget after a stop-capability overrun', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gear-algorithm-budget-')); roots.push(root)
  const artifacts = new FileArtifactStore(join(root, 'artifacts'))
  const bindingSchema: BindingSchema = { id: 'budget-overrun.v1', slots: { harness: { schemaId: 'harness.v1', required: true } } }
  const bindingSetRef = new BindingStore(artifacts, bindingSchema).create({ harness: artifacts.putJson({ name: 'H0' }, 'harness.v1') })
  let finalView: BudgetSnapshot | undefined
  const algorithm: Algorithm = {
    describe: () => ({ id: 'budget-overrun', apiVersion: ALGORITHM_API_VERSION, implementationDigest: sha256('budget-overrun'),
      stateSchema: { type: 'object', additionalProperties: true }, configSchema: { type: 'object', additionalProperties: true }, bindingSchema }),
    initialize: () => ({ nextState: {}, operations: [{ localKey: 'meter', kind: 'budget.meter', input: {}, limits: { calls: 3 } }] }),
    reduce(context) { finalView = context.budget; return { nextState: {}, complete: true } },
  }
  const provider = new LocalDurableProvider(join(root, 'provider'), { kind: 'budget.meter', implementationDigest: sha256('budget-provider'),
    execution: 'trusted-local', supportsInspect: true, meteredDimensions: ['calls'],
    inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object', additionalProperties: false } },
  envelope => ({ outcome: { kind: 'result', value: {} }, receipt: { source: 'budget.meter', scope: 'operation',
    operationId: envelope.operationId, cursor: 'overrun', cumulative: { calls: 7 } } }))
  const runtime = new AlgorithmRuntime(root, algorithm, [provider], { campaignId: 'budget-overrun-fixture', config: {},
    initialBindingSetRef: bindingSetRef,
    budget: { calls: { unit: 'request', limit: 5, source: 'budget.meter', capability: 'stop' } } })
  expect(await runtime.runUntilBlocked()).toBe('complete')
  expect(finalView?.dimensions.calls).toMatchObject({ spent: 7, reserved: 0, remaining: 0 })
  expect(runtime.snapshot()?.spent.calls).toBe(7)
})
