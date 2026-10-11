import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FileArtifactStore, sha256 } from '../../src/algorithm/artifacts.js';
import { BindingStore } from '../../src/algorithm/bindings.js';
import { AlgorithmRuntime } from '../../src/algorithm/runtime/engine.js';
import { ALGORITHM_API_VERSION, type Algorithm, type OperationEnvelope, type OperationProvider } from '../../src/algorithm/contracts.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture(count: number, concurrency: number, options: { immediate?: boolean; preflight?: () => void } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gear-reviewer-concurrency-')); roots.push(root);
  const schema = { id: 'review.bindings', slots: {} };
  const artifacts = new FileArtifactStore(join(root, 'artifacts'));
  const initialBindingSetRef = new BindingStore(artifacts, schema).create({});
  const started = new Set<string>(), finished = new Set<string>();
  let submissions = 0, reductions = 0, peak = 0;
  const completion = (e: OperationEnvelope) => ({ operationId: e.operationId, idempotencyKey: e.idempotencyKey,
    inputDigest: e.inputDigest, implementationDigest: e.implementationDigest, outcome: { kind: 'result' as const, value: {} } });
  const provider: OperationProvider = {
    describe: () => ({ kind: 'review.work', implementationDigest: sha256('review.work'), execution: options.immediate ? 'trusted-local' : 'external',
      supportsInspect: true, inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, meteredDimensions: [] }),
    preflight: options.preflight ?? (() => {}),
    inspect: async e => finished.has(e.operationId) ? { status: 'completed', completion: completion(e) }
      : started.has(e.operationId) ? { status: 'running' } : { status: 'not-started' },
    submit: async e => {
      started.add(e.operationId); submissions++; peak = Math.max(peak, started.size - finished.size);
      if (options.immediate) { finished.add(e.operationId); return { status: 'completed', completion: completion(e) }; }
      return { status: 'running' };
    },
    collect: async e => completion(e), cancel: async () => ({ status: 'unknown' }),
  };
  const algorithm: Algorithm = {
    describe: () => ({ id: 'review', apiVersion: ALGORITHM_API_VERSION, implementationDigest: sha256('review'),
      configSchema: { type: 'object' }, stateSchema: { type: 'object' }, bindingSchema: schema }),
    initialize: () => ({ nextState: {}, operations: Array.from({ length: count }, (_, i) => ({ localKey: `work${i}`, kind: 'review.work', input: {} })) }),
    reduce: () => { reductions++; return { nextState: {}, complete: true }; },
  };
  const runtime = () => new AlgorithmRuntime(root, algorithm, [provider], { campaignId: 'review', concurrency,
    config: {}, initialBindingSetRef, budget: {} });
  return { runtime, finish: () => started.forEach(id => finished.add(id)), counters: () => ({ submissions, reductions, peak }) };
}

it('bounds real running operations, including after cold reopen', async () => {
  const f = fixture(25, 20), first = f.runtime();
  await first.tick(); expect(await first.tick()).toBe('waiting');
  expect(f.counters().submissions).toBe(20);
  const reopened = f.runtime(); await reopened.tick(); expect(f.counters().submissions).toBe(20);
  f.finish(); await reopened.tick(); expect(f.counters().submissions).toBe(25);
  f.finish(); expect(await reopened.tick()).toBe('complete');
  expect(f.counters()).toEqual({ submissions: 25, reductions: 1, peak: 20 });
});

it('observes completed main work while auxiliary work waits for its slot', async () => {
  const f = fixture(1, 1), runtime = f.runtime();
  await runtime.tick(); await runtime.tick();
  await runtime.enqueueAuxiliary('repair', [{ localKey: 'repair', kind: 'review.work', input: {} }]);
  expect(await runtime.runAuxiliaryUntilBlocked('repair')).toBe('waiting');
  f.finish();
  await runtime.runAuxiliaryUntilBlocked('repair');
  expect(f.counters()).toEqual({ submissions: 2, reductions: 0, peak: 1 });
  f.finish(); expect(await runtime.runAuxiliaryUntilBlocked('repair')).toBe('complete');
  expect(await runtime.tick()).toBe('complete');
});

it('drains immediately completed batches in one tick', async () => {
  const f = fixture(25, 8, { immediate: true }), runtime = f.runtime();
  await runtime.tick();
  expect(await runtime.tick()).toBe('complete');
  expect(f.counters()).toMatchObject({ submissions: 25, reductions: 1 });
});

it('surfaces a falsy preflight exception without retrying an unchanged queue', async () => {
  let preflights = 0;
  const f = fixture(1, 1, { preflight: () => { preflights++; throw 0; } }), runtime = f.runtime();
  await runtime.tick();
  await expect(runtime.tick()).rejects.toBe(0);
  expect(preflights).toBe(1);
  expect(f.counters()).toMatchObject({ submissions: 0, reductions: 0 });
});
