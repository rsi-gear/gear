import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AlgorithmRuntime } from '../../src/algorithm/runtime/engine.js'
import { BindingStore } from '../../src/algorithm/bindings.js'
import { FileArtifactStore, sha256 } from '../../src/algorithm/artifacts.js'
import { ALGORITHM_API_VERSION, type Algorithm, type CampaignSpec, type OperationProvider,
  type ProviderInspection, type ProviderManifest, type ProviderSubmission } from '../../src/algorithm/contracts.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('replays only an opted-in frozen operation and keeps a partial receipt when its replay response is lost', async () => {
  const root = await mkdtemp(join(tmpdir(), 'algorithm-replay-safe-'))
  roots.push(root)
  const artifacts = new FileArtifactStore(join(root, 'artifacts'))
  const bindings = new BindingStore(artifacts, { id: 'empty', slots: {} })
  const initialBindingSetRef = bindings.create({})
  const manifest: ProviderManifest = { kind: 'toy.replay', implementationDigest: sha256('toy-replay-v1'),
    inputSchema: { type: 'any' }, outputSchema: { type: 'any' }, meteredDimensions: ['calls'],
    execution: 'external', supportsInspect: true, supportsIdempotentReplay: true }
  let submissions = 0
  const provider: OperationProvider = {
    describe: () => manifest, preflight: () => {},
    inspect: async envelope => {
      const receipt = (amount: number) => ({ source: 'toy.replay', scope: 'operation' as const,
        operationId: envelope.operationId, cursor: String(amount), cumulative: { calls: amount } })
      return submissions === 0 ? { status: 'not-started' } as ProviderInspection
        : submissions === 1 ? { status: 'replay-safe', receipt: receipt(2) } as ProviderInspection
          : { status: 'unknown', receipt: receipt(2) } as ProviderInspection
    },
    submit: async envelope => {
      submissions++
      if (submissions === 2) throw new Error('same-key replay response lost')
      return { status: 'running', receipt: { source: 'toy.replay', scope: 'operation',
        operationId: envelope.operationId, cursor: '1', cumulative: { calls: 1 } } } as ProviderSubmission
    },
    cancel: async () => ({ status: 'unknown' }),
    collect: async () => { throw new Error('not completed') },
  }
  const algorithm: Algorithm = {
    describe: () => ({ id: 'replay-safe', apiVersion: ALGORITHM_API_VERSION,
      implementationDigest: sha256('replay-recipe'), bindingSchema: { id: 'empty', slots: {} },
      configSchema: { type: 'object' }, stateSchema: { type: 'object' } }),
    initialize: () => ({ nextState: {}, operations: [{ localKey: 'one', kind: 'toy.replay', input: null,
      limits: { calls: 5 } }] }),
    reduce: () => ({ nextState: {}, complete: true }),
  }
  const spec: CampaignSpec = { campaignId: 'replay-safe', config: {}, initialBindingSetRef,
    budget: { calls: { unit: 'call', source: 'toy.replay', capability: 'stop', limit: 5 } } }
  const runtime = new AlgorithmRuntime(root, algorithm, [provider], spec)
  expect(await runtime.tick()).toBe('advanced')
  expect(await runtime.tick()).toBe('waiting')
  expect(runtime.snapshot()?.spent.calls).toBe(1)
  expect(await runtime.tick()).toBe('waiting')
  const state = runtime.snapshot()!
  expect(submissions).toBe(2)
  expect(state.spent.calls).toBe(2)
  expect(state.operations.one?.accounted.calls).toBe(2)
  expect(state.operations.one?.released).toBe(false)
  expect(state.operations.one?.status).toBe('unknown')
  expect(state.receiptSources).toHaveProperty(`toy.replay:${state.operations.one?.envelope.operationId}`)
})

it('rejects replay-safe from a provider that did not declare replay support without submitting it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'algorithm-no-replay-'))
  roots.push(root)
  const artifacts = new FileArtifactStore(join(root, 'artifacts'))
  const bindings = new BindingStore(artifacts, { id: 'empty', slots: {} })
  const initialBindingSetRef = bindings.create({})
  const manifest: ProviderManifest = { kind: 'toy.no-replay', implementationDigest: sha256('no-replay-v1'),
    inputSchema: { type: 'any' }, outputSchema: { type: 'any' }, meteredDimensions: [],
    execution: 'external', supportsInspect: true }
  let submissions = 0
  const provider: OperationProvider = { describe: () => manifest, preflight: () => {},
    inspect: async () => ({ status: 'replay-safe' }),
    submit: async () => { submissions++; return { status: 'running' } },
    cancel: async () => ({ status: 'unknown' }), collect: async () => { throw new Error('not completed') } }
  const algorithm: Algorithm = { describe: () => ({ id: 'no-replay', apiVersion: ALGORITHM_API_VERSION,
    implementationDigest: sha256('no-replay-recipe'), bindingSchema: { id: 'empty', slots: {} },
    configSchema: { type: 'object' }, stateSchema: { type: 'object' } }),
  initialize: () => ({ nextState: {}, operations: [{ localKey: 'one', kind: 'toy.no-replay', input: null }] }),
  reduce: () => ({ nextState: {}, complete: true }) }
  const spec: CampaignSpec = { campaignId: 'no-replay', config: {}, initialBindingSetRef, budget: {} }
  const runtime = new AlgorithmRuntime(root, algorithm, [provider], spec)
  expect(await runtime.tick()).toBe('advanced')
  await expect(runtime.tick()).rejects.toThrow('did not declare idempotent replay')
  expect(submissions).toBe(0)
})
