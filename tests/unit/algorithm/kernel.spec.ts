import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AlgorithmRuntime, BindingStore, FileArtifactStore, LocalDurableProvider, ALGORITHM_API_VERSION, assertJson, assertSchema, canonicalJson, sha256, task, parallel, defineWorkflow } from '../../../src/algorithm/index.js';
import { CampaignStore, probeProviderReplay, probeProviderNoResult, probeProviderReceipt, probeProviderCancellation } from '../../../src/algorithm/testing.js';
import type { Algorithm, BindingSchema, BindingSetRef, CampaignSpec, OperationProvider, ProviderManifest } from '../../../src/algorithm/index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const makeRoot = () => { const root = mkdtempSync(join(tmpdir(), 'gear-algorithm-')); roots.push(root); return root; };
const schema: BindingSchema = { id: 'toy.bindings.v1', slots: { model: { schemaId: 'model.v1', required: true, replaceable: true }, fixed: { schemaId: 'fixed.v1', required: true } } };
function bindings(root: string) {
  const artifacts = new FileArtifactStore(join(root, 'artifacts'));
  const store = new BindingStore(artifacts, schema);
  const fixed = artifacts.putJson({ value: 'fixed' }, 'fixed.v1');
  const h0 = store.create({ model: artifacts.putJson({ value: 'H0' }, 'model.v1'), fixed });
  const h1 = store.derive(h0, { model: artifacts.putJson({ value: 'H1' }, 'model.v1') });
  return { artifacts, store, fixed, h0, h1 };
}
const providerManifest: ProviderManifest = {
  kind: 'toy.measure', implementationDigest: sha256('toy.measure.v1'), execution: 'trusted-local', supportsInspect: true, meteredDimensions: ['calls'],
  inputSchema: { type: 'object', properties: { subject: { type: 'string' } }, required: ['subject'], additionalProperties: false },
  outputSchema: { type: 'object', properties: { score: { type: 'number' } }, required: ['score'], additionalProperties: false },
};
function spec(h0: BindingSetRef): CampaignSpec { return { campaignId: 'toy-campaign', config: { seed: 7 }, initialBindingSetRef: h0, budget: { calls: { unit: 'call', limit: 2, source: 'toy', capability: 'stop' } } }; }
function algorithm(h0: BindingSetRef, h1: BindingSetRef): Algorithm {
  return {
    describe: () => ({ id: 'toy-algorithm', apiVersion: ALGORITHM_API_VERSION, implementationDigest: sha256('toy.algorithm.v1'), configSchema: { type: 'object', properties: { seed: { type: 'integer' } }, required: ['seed'], additionalProperties: false }, stateSchema: { type: 'object', additionalProperties: true }, bindingSchema: schema }),
    initialize: () => ({ nextState: { phase: 'measuring' }, bindingTransition: h1, operations: parallel(task('H0', 'toy.measure', { subject: 'H0' }, { bindingSetRef: h0, limits: { calls: 1 } }), task('H1', 'toy.measure', { subject: 'H1' }, { limits: { calls: 1 } })) }),
    reduce: ({ completed }) => ({ nextState: { outcomes: completed }, complete: true }),
  };
}
function local(root: string, faults: { dropSubmitResponseOnce?: boolean; inspectUnknownOnce?: boolean } = {}) {
  return new LocalDurableProvider(join(root, 'provider'), providerManifest, envelope => ({ outcome: { kind: 'result', value: { score: envelope.input === null ? 0 : 1 } }, receipt: { source: 'toy', scope: 'operation', operationId: envelope.operationId, cursor: '1', cumulative: { calls: 1 } } }), faults);
}

describe('algorithm kernel', () => {
  it('freezes parallel explicit/default bindings and keeps candidate transition independent of H0', async () => {
    const root = makeRoot(); const b = bindings(root); const provider = local(root);
    const runtime = new AlgorithmRuntime(root, algorithm(b.h0, b.h1), [provider], spec(b.h0));
    expect(await runtime.tick()).toBe('advanced');
    const pending = runtime.snapshot()!;
    expect(pending.activeBindingSetRef).toEqual(b.h1);
    expect(pending.operations.H0?.envelope.bindingSetRef).toEqual(b.h0);
    expect(pending.operations.H1?.envelope.bindingSetRef).toEqual(b.h1);
    expect(await runtime.runUntilBlocked()).toBe('complete');
    expect(provider.submitCalls).toBe(2);
    expect(runtime.snapshot()?.phase).toBe('complete');
  });

  it('recovers a lost submit response from inspect without resubmitting', async () => {
    const root = makeRoot(); const b = bindings(root); const first = local(root, { dropSubmitResponseOnce: true });
    const runtime = new AlgorithmRuntime(root, algorithm(b.h0, b.h1), [first], spec(b.h0));
    expect(await runtime.runUntilBlocked()).toBe('waiting');
    expect(first.submitCalls).toBe(2);
    const recovery = local(root);
    expect(await new AlgorithmRuntime(root, algorithm(b.h0, b.h1), [recovery], spec(b.h0)).runUntilBlocked()).toBe('complete');
    expect(recovery.submitCalls).toBe(0);
    expect(recovery.inspectCalls).toBeGreaterThan(0);
  });

  it('waits for unknown and distinguishes no-result from execution error', async () => {
    const root = makeRoot(); const b = bindings(root); const provider = local(root, { inspectUnknownOnce: true });
    const runtime = new AlgorithmRuntime(root, algorithm(b.h0, b.h1), [provider], spec(b.h0));
    await runtime.tick(); const op = runtime.snapshot()!.operations.H0!.envelope; expect(await runtime.tick()).toBe('waiting');
    expect(provider.submitCalls).toBe(1);
    expect(runtime.snapshot()?.operations.H0?.status).toBe('unknown');
    expect(await runtime.runUntilBlocked()).toBe('complete');
    const noResult = new LocalDurableProvider(join(root, 'no-result'), providerManifest, () => ({ outcome: { kind: 'no-result', reason: 'no candidate' } }));
    const returned = await noResult.submit(op);
    expect(returned.status).toBe('completed');
    if (returned.status === 'completed') expect(returned.completion.outcome.kind).toBe('no-result');
  });

  it('rejects same-key identity drift, invalid output and forged immutable binding', async () => {
    const root = makeRoot(); const b = bindings(root); const provider = local(root);
    const runtime = new AlgorithmRuntime(root, algorithm(b.h0, b.h1), [provider], spec(b.h0));
    await runtime.tick(); const envelope = runtime.snapshot()!.operations.H0!.envelope;
    await provider.submit(envelope);
    await expect(provider.submit({ ...envelope, inputDigest: sha256('changed') })).rejects.toThrow('identity drift');
    const bad = new LocalDurableProvider(join(root, 'bad'), providerManifest, envelope => ({ outcome: { kind: 'result', value: { score: 'wrong' } }, receipt: { source: 'toy', scope: 'operation', operationId: envelope.operationId, cursor: '1', cumulative: { calls: 1 } } }));
    const badRuntimeRoot = makeRoot(); const bb = bindings(badRuntimeRoot);
    const badRuntime = new AlgorithmRuntime(badRuntimeRoot, algorithm(bb.h0, bb.h1), [bad], spec(bb.h0));
    await badRuntime.tick(); await expect(badRuntime.tick()).rejects.toThrow('expected number');
    const otherRoot = makeRoot();
    const other = bindings(otherRoot); const forged = other.store.create({ ...other.store.read(other.h0).slots, fixed: other.artifacts.putJson({ value: 'changed' }, 'fixed.v1') });
    const otherMalicious: Algorithm = { ...algorithm(other.h0, other.h1), initialize: () => ({ nextState: {}, bindingTransition: forged, operations: [task('x', 'toy.measure', { subject: 'x' })] }) };
    await expect(new AlgorithmRuntime(otherRoot, otherMalicious, [local(otherRoot)], spec(other.h0)).tick()).rejects.toThrow('Immutable binding slot');
  });

  it('rejects corrupt journal/artifact, unsupported schema and unsafe JSON', async () => {
    const root = makeRoot(); const b = bindings(root); const runtime = new AlgorithmRuntime(root, algorithm(b.h0, b.h1), [local(root)], spec(b.h0));
    await runtime.tick();
    await expect(runtime.store.commit({} as never, 'illegal')).rejects.toThrow('writer lease');
    const headPath = join(root, 'campaign', 'HEAD');
    writeFileSync(headPath, readFileSync(headPath, 'utf8').replace(/a/g, 'b'));
    expect(() => runtime.snapshot()).toThrow();
    expect(() => assertSchema({ type: 'string', pattern: '.*' } as never)).toThrow('Unsupported');
    expect(() => assertSchema({ type: 'mystery' } as never)).toThrow('Unknown');
    expect(() => assertJson(new Array(1))).toThrow('sparse');
    const decorated = [1] as number[] & { extra?: number }; decorated.extra = 2;
    expect(() => assertJson(decorated)).toThrow('non-index');
    expect(() => assertJson('\ud800')).toThrow('surrogate');
    expect(() => canonicalJson(JSON.parse('{"__proto__":1}'))).toThrow('Unsafe');
    const ref = b.artifacts.putJson({ x: 1 }, 'example');
    writeFileSync(join(root, 'artifacts', 'objects', `${ref.digest}.json`), 'tampered');
    expect(() => b.artifacts.getBytes(ref)).toThrow('digest mismatch');
  });

  it('uses managed workflow steps and keeps unconfirmed cancellation reserved', async () => {
    const root = makeRoot(); const b = bindings(root);
    const workflow = defineWorkflow({
      manifest: { id: 'workflow', apiVersion: ALGORITHM_API_VERSION, implementationDigest: sha256('workflow.v1'), configSchema: { type: 'object', additionalProperties: true }, bindingSchema: schema },
      businessStateSchema: { type: 'object', additionalProperties: true }, initialState: () => ({}),
      steps: [{ name: 'measure', plan: () => [task('only', 'toy.measure', { subject: 'H0' }, { limits: { calls: 1 } })], join: ({ completed }) => ({ state: { measured: completed.only?.kind ?? 'missing' } }) }],
    });
    const running: OperationProvider = { describe: () => providerManifest, preflight: () => {}, submit: async () => ({ status: 'running' }), inspect: async () => ({ status: 'running' }), cancel: async () => ({ status: 'cancelled', releaseConfirmed: false }), collect: async () => { throw new Error('unavailable'); } };
    const runtime = new AlgorithmRuntime(root, workflow, [running], spec(b.h0));
    await runtime.tick(); await runtime.tick(); await runtime.cancel('only');
    expect(runtime.snapshot()?.operations.only?.released).toBe(false);
    expect(runtime.snapshot()?.operations.only?.status).toBe('cancelled');
  });

  it('replays a persisted cancellation intent after restart until release is confirmed', async () => {
    const root = makeRoot(); const b = bindings(root);
    const single: Algorithm = { ...algorithm(b.h0, b.h1), initialize: () => ({ nextState: {}, operations: [task('only', 'toy.measure', { subject: 'H0' }, { limits: { calls: 1 } })] }), reduce: () => ({ nextState: {}, complete: true }) };
    let cancels = 0;
    const provider: OperationProvider = {
      describe: () => providerManifest, preflight: () => {}, submit: async () => ({ status: 'running' }),
      inspect: async () => ({ status: 'running' }),
      cancel: async envelope => {
        cancels++;
        return { status: 'cancelled', releaseConfirmed: cancels > 1,
          ...(cancels > 1 ? { receipt: { source: 'toy', scope: 'operation' as const, operationId: envelope.operationId, cursor: 'final', cumulative: { calls: 0 } } } : {}) };
      },
      collect: async () => { throw new Error('unavailable'); },
    };
    const original = new AlgorithmRuntime(root, single, [provider], spec(b.h0));
    await original.tick();
    await original.store.withWriter(async () => {
      const state = original.snapshot()!;
      state.operations.only!.status = 'cancel-pending';
      await original.store.commit(state as never, 'operation.cancel-intent');
    });
    const recovered = new AlgorithmRuntime(root, single, [provider], spec(b.h0));
    expect(await recovered.tick()).toBe('waiting');
    expect(cancels).toBe(1);
    expect(recovered.snapshot()?.operations.only?.released).toBe(false);
    expect(recovered.snapshot()?.spent.calls ?? 0).toBe(0);
    expect(await recovered.tick()).toBe('complete');
    expect(cancels).toBe(2);
    expect(recovered.snapshot()?.operations.only).toBeUndefined();
  });

  it('atomically tombstones a local operation cancelled before submit', async () => {
    const root = makeRoot(); const b = bindings(root);
    const runtime = new AlgorithmRuntime(root, algorithm(b.h0, b.h1), [local(root)], spec(b.h0));
    await runtime.tick();
    const envelope = runtime.snapshot()!.operations.H0!.envelope;
    let executions = 0;
    const provider = () => new LocalDurableProvider(join(root, 'cancel-before-start'), providerManifest,
      () => { executions++; return { outcome: { kind: 'result', value: { score: 1 } } }; }, {}, 'toy');
    expect(await provider().cancel(envelope)).toMatchObject({ status: 'cancelled', releaseConfirmed: true,
      receipt: { source: 'toy', cumulative: { calls: 0 } } });
    const restarted = provider();
    expect(await restarted.inspect(envelope)).toMatchObject({ status: 'cancelled', releaseConfirmed: true });
    await expect(restarted.submit(envelope)).rejects.toThrow('Cancelled local operation');
    expect(executions).toBe(0);
  });

  it('dispatches parallel operations concurrently and deduplicates operation-scoped receipts', async () => {
    const root = makeRoot(); const b = bindings(root);
    let arrivals = 0; let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const provider = new LocalDurableProvider(join(root, 'provider'), providerManifest, async envelope => {
      if (++arrivals === 2) release();
      await barrier;
      return { outcome: { kind: 'result', value: { score: 0 } }, receipt: { source: 'toy', scope: 'operation', operationId: envelope.operationId, cursor: '1', cumulative: { calls: 1 } } };
    });
    const runtime = new AlgorithmRuntime(root, algorithm(b.h0, b.h1), [provider], spec(b.h0));
    await runtime.tick();
    await Promise.race([runtime.tick(), delay(2_000).then(() => { throw new Error('Parallel dispatch timed out'); })]);
    expect(arrivals).toBe(2);
    expect(runtime.snapshot()?.spent.calls).toBe(2);
  });

  it('persists started local work as unknown and joins a genuine no-result', async () => {
    const root = makeRoot(); const b = bindings(root);
    const started = new LocalDurableProvider(join(root, 'started'), providerManifest, () => { throw new Error('crash after effect'); });
    const initial = new AlgorithmRuntime(root, algorithm(b.h0, b.h1), [started], spec(b.h0));
    await initial.tick(); expect(await initial.tick()).toBe('waiting');
    const restarted = new LocalDurableProvider(join(root, 'started'), providerManifest, () => { throw new Error('must not repeat'); });
    const recovered = new AlgorithmRuntime(root, algorithm(b.h0, b.h1), [restarted], spec(b.h0));
    expect(await recovered.tick()).toBe('waiting');
    expect(restarted.submitCalls).toBe(0);
    const otherRoot = makeRoot(); const bb = bindings(otherRoot);
    const noResult = new LocalDurableProvider(join(otherRoot, 'provider'), providerManifest, envelope => ({ outcome: { kind: 'no-result', reason: 'empty' }, receipt: { source: 'toy', scope: 'operation', operationId: envelope.operationId, cursor: '1', cumulative: { calls: 0 } } }));
    const other = new AlgorithmRuntime(otherRoot, algorithm(bb.h0, bb.h1), [noResult], spec(bb.h0));
    expect(await other.runUntilBlocked()).toBe('complete');
    expect((other.snapshot()?.state as { outcomes: { H0: { kind: string } } }).outcomes.H0.kind).toBe('no-result');
  });

  it('serializes contenders through independent lock processes and fences a dead lease', async () => {
    const root = makeRoot(); const store = new CampaignStore(join(root, 'campaign'));
    writeFileSync(join(root, 'campaign', 'WRITER.lock'), 'old process');
    let inside = 0; let overlap = 0;
    const writer = (name: string) => store.withWriter(async () => {
      inside++; overlap = Math.max(overlap, inside);
      await delay(30);
      await store.commit({ name }, name);
      inside--;
    });
    await Promise.all([writer('a'), writer('b')]);
    expect(overlap).toBe(1);
    expect(store.load()?.seq).toBe(1);
    await expect(store.withWriter(async () => {
      process.kill(store.testingWriterProcessId()!, 'SIGKILL');
      await delay(30);
      await store.commit({ name: 'illegal' }, 'illegal');
    })).rejects.toThrow('lease');
    await store.withWriter(async () => { await store.commit({ name: 'recovered' }, 'recovered'); });
    expect(store.load()?.seq).toBe(2);
  });

  it('rejects missing metered reservation and receipt source drift', async () => {
    const root = makeRoot(); const b = bindings(root);
    const incomplete: Algorithm = { ...algorithm(b.h0, b.h1), initialize: () => ({ nextState: {}, operations: [task('x', 'toy.measure', { subject: 'x' })] }) };
    await expect(new AlgorithmRuntime(root, incomplete, [local(root)], spec(b.h0)).tick()).rejects.toThrow('Missing reservation');
    const wrong = new LocalDurableProvider(join(root, 'wrong'), providerManifest, envelope => ({ outcome: { kind: 'result', value: { score: 1 } }, receipt: { source: 'other', scope: 'operation', operationId: envelope.operationId, cursor: '1', cumulative: { calls: 1 } } }));
    const otherRoot = makeRoot(); const bb = bindings(otherRoot);
    const runtime = new AlgorithmRuntime(otherRoot, algorithm(bb.h0, bb.h1), [wrong], spec(bb.h0));
    await runtime.tick();
    await expect(runtime.tick()).rejects.toThrow('source mismatch');
  });

  it('does not persist partial receipt mutation when a sibling completion is valid', async () => {
    const root = makeRoot(); const b = bindings(root);
    const provider = new LocalDurableProvider(join(root, 'provider'), providerManifest, envelope => ({
      outcome: { kind: 'result', value: { score: 1 } },
      receipt: { source: 'toy', scope: 'operation', operationId: envelope.operationId, cursor: '1', cumulative: envelope.localKey === 'H0' ? { calls: 1, bogus: 1 } : { calls: 1 } },
    }));
    const runtime = new AlgorithmRuntime(root, algorithm(b.h0, b.h1), [provider], spec(b.h0));
    await runtime.tick(); await expect(runtime.tick()).rejects.toThrow('Invalid usage receipt bogus');
    const saved = runtime.snapshot()!;
    expect(saved.spent.calls).toBe(1);
    expect(saved.operations.H0?.status).toBe('intent');
    expect(saved.operations.H1?.status).toBe('completed');
  });

  it('requires final zero usage and enforces hard limit per operation', async () => {
    const root = makeRoot(); const b = bindings(root);
    const missing = new LocalDurableProvider(join(root, 'provider'), providerManifest, envelope => ({
      outcome: { kind: 'no-result' },
      ...(envelope.localKey === 'H1' ? { receipt: { source: 'toy', scope: 'operation' as const, operationId: envelope.operationId, cursor: '1', cumulative: { calls: 0 } } } : {}),
    }));
    const runtime = new AlgorithmRuntime(root, algorithm(b.h0, b.h1), [missing], spec(b.h0));
    await runtime.tick(); await expect(runtime.tick()).rejects.toThrow('Missing final usage receipt');
    expect(runtime.snapshot()?.operations.H1?.status).toBe('completed');
    expect(runtime.snapshot()?.operations.H0?.released).toBe(false);
    const otherRoot = makeRoot(); const bb = bindings(otherRoot);
    const hardManifest: ProviderManifest = { ...providerManifest, hardLimitDimensions: ['calls'] };
    const hard = new LocalDurableProvider(join(otherRoot, 'provider'), hardManifest, envelope => ({ outcome: { kind: 'result', value: { score: 1 } }, receipt: { source: 'toy', scope: 'operation', operationId: envelope.operationId, cursor: '1', cumulative: { calls: envelope.localKey === 'H0' ? 2 : 1 } } }));
    const hardSpec = spec(bb.h0); hardSpec.budget.calls = { ...hardSpec.budget.calls!, limit: 3, capability: 'hard' };
    const hardRuntime = new AlgorithmRuntime(otherRoot, algorithm(bb.h0, bb.h1), [hard], hardSpec);
    await hardRuntime.tick(); await expect(hardRuntime.tick()).rejects.toThrow('Hard operation limit');
  });

  it('rejects kernel identity drift and explicit binding forgery', async () => {
    const root = makeRoot(); const b = bindings(root); const provider = local(root);
    const runtime = new AlgorithmRuntime(root, algorithm(b.h0, b.h1), [provider], spec(b.h0));
    await runtime.tick();
    const saved = runtime.snapshot()!;
    await runtime.store.withWriter(async () => { await runtime.store.commit({ ...saved, kernelImplementationDigest: '0'.repeat(64) } as never, 'identity-test'); });
    expect(() => runtime.snapshot()).toThrow('identity drift');
    const otherRoot = makeRoot(); const bb = bindings(otherRoot);
    const forged = bb.store.create({ ...bb.store.read(bb.h0).slots, fixed: bb.artifacts.putJson({ value: 'forged' }, 'fixed.v1') });
    const explicit: Algorithm = { ...algorithm(bb.h0, bb.h1), initialize: () => ({ nextState: {}, operations: [task('x', 'toy.measure', { subject: 'x' }, { bindingSetRef: forged, limits: { calls: 1 } })] }) };
    await expect(new AlgorithmRuntime(otherRoot, explicit, [local(otherRoot)], spec(bb.h0)).tick()).rejects.toThrow('Immutable binding slot');
  });

  it('runs managed bindings.derive and passes transitioned bindings to the next named step', async () => {
    const root = makeRoot(); const b = bindings(root);
    const replacement = b.artifacts.putJson({ value: 'H2' }, 'model.v1');
    const derived: Algorithm = {
      ...algorithm(b.h0, b.h1),
      initialize: () => ({ nextState: {}, operations: [task('derive', 'bindings.derive', { baseRef: b.h0, replacements: { model: replacement } })] }),
      reduce: ({ completed }) => ({ nextState: { derived: completed.derive ?? null }, complete: true }),
    };
    const deriveRuntime = new AlgorithmRuntime(root, derived, [local(root)], spec(b.h0));
    expect(await deriveRuntime.runUntilBlocked()).toBe('complete');
    const outcome = (deriveRuntime.snapshot()?.state as { derived: { kind: string; value: { bindingSetRef: BindingSetRef } } }).derived;
    expect(outcome.kind).toBe('result');
    expect(b.store.read(outcome.value.bindingSetRef).slots.model).toEqual(replacement);
    const otherRoot = makeRoot(); const bb = bindings(otherRoot);
    const seen: BindingSetRef[] = [];
    const workflow = defineWorkflow({
      manifest: { id: 'two-step', apiVersion: ALGORITHM_API_VERSION, implementationDigest: sha256('two-step'), configSchema: { type: 'object', additionalProperties: true }, bindingSchema: schema },
      businessStateSchema: { type: 'object', additionalProperties: true }, initialState: () => ({}),
      steps: [
        { name: 'baseline', plan: () => [task('baseline', 'toy.measure', { subject: 'H0' }, { limits: { calls: 1 } })], join: () => ({ state: {}, bindingTransition: bb.h1 }) },
        { name: 'candidate', plan: context => { seen.push(context.activeBindingSetRef); return [task('candidate', 'toy.measure', { subject: 'H1' }, { bindingSetRef: context.activeBindingSetRef, limits: { calls: 1 } })]; }, join: () => ({ state: {} }) },
      ],
    });
    const next = new AlgorithmRuntime(otherRoot, workflow, [local(otherRoot)], spec(bb.h0));
    await next.tick(); await next.tick();
    expect(seen).toEqual([bb.h1]);
    expect(next.snapshot()?.operations.candidate?.envelope.bindingSetRef).toEqual(bb.h1);
  });

  it('offers public provider replay, no-result, receipt and cancellation probes', async () => {
    const root = makeRoot(); const b = bindings(root); const runtime = new AlgorithmRuntime(root, algorithm(b.h0, b.h1), [local(root)], spec(b.h0));
    await runtime.tick(); const envelope = runtime.snapshot()!.operations.H0!.envelope;
    const factory = () => new LocalDurableProvider(join(root, 'probe'), providerManifest, request => ({ outcome: { kind: 'no-result' }, receipt: { source: 'toy', scope: 'operation', operationId: request.operationId, cursor: '1', cumulative: { calls: 0 } } }));
    const replay = await probeProviderReplay(factory, envelope);
    expect(replay.recovered.status).toBe('completed');
    const otherEnvelope = { ...envelope, operationId: sha256('other'), idempotencyKey: sha256('other') };
    await probeProviderNoResult(factory, otherEnvelope);
    const thirdEnvelope = { ...envelope, operationId: sha256('third'), idempotencyKey: sha256('third') };
    await probeProviderReceipt(factory, thirdEnvelope);
    const fourthEnvelope = { ...envelope, operationId: sha256('fourth'), idempotencyKey: sha256('fourth') };
    const cancel = await probeProviderCancellation(factory, fourthEnvelope);
    expect(cancel.status).toBe('cancelled');
  });

  it('rejects raw decision shape and provider catalog changes across or within runs', async () => {
    const root = makeRoot(); const b = bindings(root);
    const invalid: Algorithm = { ...algorithm(b.h0, b.h1), initialize: () => ({ nextState: {}, complete: 'false' } as never) };
    await expect(new AlgorithmRuntime(root, invalid, [local(root)], spec(b.h0)).tick()).rejects.toThrow('complete must be boolean');
    const malformed: Algorithm = { ...algorithm(b.h0, b.h1), initialize: () => ({ nextState: {}, operations: {} } as never) };
    await expect(new AlgorithmRuntime(root, malformed, [local(root)], spec(b.h0)).tick()).rejects.toThrow('operations must be an array');
    const otherRoot = makeRoot(); const bb = bindings(otherRoot);
    const mutable: ProviderManifest = { ...providerManifest };
    const provider = new LocalDurableProvider(join(otherRoot, 'provider'), mutable, () => ({ outcome: { kind: 'no-result' } }));
    const runtime = new AlgorithmRuntime(otherRoot, algorithm(bb.h0, bb.h1), [provider], spec(bb.h0));
    await runtime.tick();
    const changed: ProviderManifest = { ...providerManifest, implementationDigest: sha256('changed provider') };
    const replacement = new LocalDurableProvider(join(otherRoot, 'provider'), changed, () => ({ outcome: { kind: 'no-result' } }));
    expect(() => new AlgorithmRuntime(otherRoot, algorithm(bb.h0, bb.h1), [replacement], spec(bb.h0)).snapshot()).toThrow('identity drift');
    mutable.implementationDigest = sha256('in place change');
    expect(() => runtime.snapshot()).toThrow('Provider manifest drift');
  });
});
