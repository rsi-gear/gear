import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileArtifactStore, sha256 } from '../../src/algorithm/artifacts.js'
import { BindingStore } from '../../src/algorithm/bindings.js'
import { ALGORITHM_API_VERSION, type Algorithm, type BindingSchema, type CampaignSpec,
  type OperationProvider, type ProviderManifest } from '../../src/algorithm/contracts.js'
import { ProviderProtocolError } from '../../src/algorithm/provider-errors.js'
import { AlgorithmRuntime } from '../../src/algorithm/runtime/engine.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const schema: BindingSchema = { id: 'auxiliary-test-bindings.v1', slots: {} }
const mainManifest: ProviderManifest = { kind: 'toy.wait', implementationDigest: sha256('toy.wait.v1'),
  inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object', additionalProperties: true },
  execution: 'external', supportsInspect: true, meteredDimensions: [] }
const repairManifest: ProviderManifest = { kind: 'toy.repair', implementationDigest: sha256('toy.repair.v1'),
  inputSchema: { type: 'object', required: ['cell'], properties: { cell: { type: 'string' } }, additionalProperties: false },
  outputSchema: { type: 'object', required: ['repaired'], properties: { repaired: { type: 'boolean' } }, additionalProperties: false },
  execution: 'external', supportsInspect: true, supportsIdempotentReplay: true, meteredDimensions: ['cells'] }

function fixture(limit = 1, mode: 'complete' | 'unknown' | 'protocol' = 'complete') {
  const root = mkdtempSync(join(tmpdir(), 'gear-auxiliary-')); roots.push(root)
  const artifacts = new FileArtifactStore(join(root, 'artifacts'))
  const initialBindingSetRef = new BindingStore(artifacts, schema).create({})
  const spec: CampaignSpec = { campaignId: 'auxiliary-fixture', config: {}, initialBindingSetRef,
    budget: { cells: { unit: 'cell', limit, source: 'toy.repair', capability: 'stop' } } }
  let reductions = 0, mainSubmits = 0, repairSubmits = 0
  const started = new Set<string>()
  const algorithm: Algorithm = {
    describe: () => ({ id: 'auxiliary-fixture', apiVersion: ALGORITHM_API_VERSION,
      implementationDigest: sha256('auxiliary-fixture.v1'), configSchema: { type: 'object', additionalProperties: false },
      stateSchema: { type: 'object', additionalProperties: true }, bindingSchema: schema }),
    initialize: () => ({ nextState: { phase: 'waiting' }, operations: [{ localKey: 'main', kind: 'toy.wait', input: {}, limits: {} }] }),
    reduce: () => { reductions++; return { nextState: { phase: 'done' }, complete: true } },
  }
  const main: OperationProvider = { describe: () => mainManifest, preflight: () => {},
    inspect: async () => ({ status: 'not-started' }),
    submit: async () => { mainSubmits++; return { status: 'running' } },
    cancel: async () => ({ status: 'unknown' }), collect: async () => { throw new Error('main has no result') } }
  const repair: OperationProvider = { describe: () => repairManifest, preflight: () => {},
    inspect: async envelope => mode === 'protocol'
      ? { status: 'replay-safe', receipt: { source: 'toy.repair', scope: 'operation',
        operationId: envelope.operationId, cursor: 'observed-one', cumulative: { cells: 1 } } }
      : mode === 'unknown' && started.has(envelope.operationId)
        ? { status: 'running' } : { status: 'not-started' },
    submit: async envelope => {
      repairSubmits++
      if (mode === 'protocol') throw new ProviderProtocolError('verified malformed repair evidence')
      if (mode === 'unknown') { started.add(envelope.operationId); return { status: 'running' } }
      return { status: 'completed', completion: { operationId: envelope.operationId,
        idempotencyKey: envelope.idempotencyKey, inputDigest: envelope.inputDigest,
        implementationDigest: envelope.implementationDigest,
        outcome: { kind: 'result', value: { repaired: true } },
        receipt: { source: 'toy.repair', scope: 'operation', operationId: envelope.operationId,
          cursor: 'final-one', cumulative: { cells: 1 } } } }
    }, cancel: async () => ({ status: 'unknown' }), collect: async () => { throw new Error('unused') } }
  const runtime = () => new AlgorithmRuntime(root, algorithm, [main, repair], spec)
  return { root, runtime, counters: () => ({ reductions, mainSubmits, repairSubmits }) }
}

const intent = (cell = 'task-1', cells = 1) => [{ localKey: 'fill', kind: 'toy.repair', input: { cell }, limits: { cells } }]

describe('Campaign auxiliary repair operations', () => {
  it('uses the primary budget and never advances the main reducer while servicing a repair', async () => {
    const f = fixture(), runtime = f.runtime()
    expect(await runtime.tick()).toBe('advanced')
    await runtime.enqueueAuxiliary('repair-1', intent())
    expect(await runtime.runAuxiliaryUntilBlocked('repair-1')).toBe('complete')
    expect(runtime.snapshot()?.spent.cells).toBe(1)
    expect(runtime.snapshot()?.auxiliaryOperations?.['repair-1']?.fill?.released).toBe(true)
    expect(f.counters()).toEqual({ reductions: 0, mainSubmits: 0, repairSubmits: 1 })
    const resumed = f.runtime()
    await resumed.enqueueAuxiliary('repair-1', intent())
    expect(await resumed.runAuxiliaryUntilBlocked('repair-1')).toBe('complete')
    expect(f.counters()).toEqual({ reductions: 0, mainSubmits: 0, repairSubmits: 1 })
  })

  it('rejects a reused group with different input and a new group beyond the shared budget', async () => {
    const f = fixture(), runtime = f.runtime()
    await runtime.tick()
    await runtime.enqueueAuxiliary('repair-1', intent())
    await expect(runtime.enqueueAuxiliary('repair-1', intent('different-task'))).rejects.toThrow('identity drift')
    await expect(runtime.enqueueAuxiliary('repair-1', [intent()[0]!, intent()[0]!]))
      .rejects.toThrow('Duplicate auxiliary local key')
    await runtime.runAuxiliaryUntilBlocked('repair-1')
    await expect(runtime.enqueueAuxiliary('repair-2', intent())).rejects.toThrow('Budget exceeded')
    expect(runtime.snapshot()?.spent.cells).toBe(1)
    expect(f.counters().repairSubmits).toBe(1)
  })

  it('keeps an unknown repair reserved and fences a different repair owner', async () => {
    const f = fixture(1, 'unknown'), runtime = f.runtime()
    await runtime.tick()
    await runtime.enqueueAuxiliary('repair-1', intent())
    expect(await runtime.runAuxiliaryUntilBlocked('repair-1')).toBe('waiting')
    expect(runtime.snapshot()?.auxiliaryOperations?.['repair-1']?.fill).toMatchObject({ status: 'running', released: false })
    expect(runtime.snapshot()?.spent.cells ?? 0).toBe(0)
    await expect(runtime.enqueueAuxiliary('repair-2', intent())).rejects.toThrow('Another auxiliary group')
    expect(await runtime.tick()).toBe('waiting')
    expect(f.counters()).toEqual({ reductions: 0, mainSubmits: 0, repairSubmits: 1 })
  })

  it('persists a replay-safe prior receipt before surfacing a verified protocol error', async () => {
    const f = fixture(1, 'protocol'), runtime = f.runtime()
    await runtime.tick()
    await runtime.enqueueAuxiliary('repair-1', intent())
    await expect(runtime.runAuxiliaryUntilBlocked('repair-1')).rejects.toBeInstanceOf(ProviderProtocolError)
    expect(runtime.snapshot()?.spent.cells).toBe(1)
    expect(runtime.snapshot()?.auxiliaryOperations?.['repair-1']?.fill).toMatchObject({
      status: 'unknown', accounted: { cells: 1 }, released: false,
    })
    expect(f.counters()).toEqual({ reductions: 0, mainSubmits: 0, repairSubmits: 1 })
  })
})
