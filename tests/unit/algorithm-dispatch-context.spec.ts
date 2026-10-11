import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileArtifactStore, sha256 } from '../../src/algorithm/artifacts.js';
import { BindingStore } from '../../src/algorithm/bindings.js';
import { ALGORITHM_API_VERSION, type Algorithm, type CampaignSpec, type OperationIntent,
  type OperationProvider, type ProviderDispatchContext } from '../../src/algorithm/contracts.js';
import { AlgorithmRuntime } from '../../src/algorithm/runtime/engine.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(options: { prepare?: boolean; clock?: boolean; mainKeys?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gear-dispatch-context-')); roots.push(root);
  const artifacts = new FileArtifactStore(join(root, 'artifacts'));
  const bindingSchema = { id: 'dispatch.bindings.v1', slots: {} };
  const initialBindingSetRef = new BindingStore(artifacts, bindingSchema).create({});
  const spec: CampaignSpec = { campaignId: 'dispatch-context', config: {}, initialBindingSetRef,
    budget: { units: { unit: 'unit', limit: 8, source: 'toy.dispatch', capability: 'stop' } } };
  const intent = (name: string): OperationIntent => ({ localKey: name, kind: 'toy.dispatch', input: { name },
    limits: { units: 1 }, ...(options.clock ? { startsBudgetClock: true } : {}) });
  const algorithm: Algorithm = {
    describe: () => ({ id: 'dispatch-context', apiVersion: ALGORITHM_API_VERSION,
      implementationDigest: sha256('dispatch-context.v1'), bindingSchema,
      configSchema: { type: 'object', additionalProperties: false },
      stateSchema: { type: 'object', additionalProperties: true } }),
    initialize: () => ({ nextState: {}, operations: (options.mainKeys ?? ['main']).map(intent) }),
    reduce: () => ({ nextState: {}, complete: true }),
  };
  const contexts: Array<{ name: string; context: ProviderDispatchContext }> = [];
  const counts = { submit: 0 };
  const provider: OperationProvider = {
    describe: () => ({ kind: 'toy.dispatch', implementationDigest: sha256('toy.dispatch.v1'),
      inputSchema: { type: 'object', properties: { name: { type: 'string' } },
        required: ['name'], additionalProperties: false },
      outputSchema: { type: 'object', additionalProperties: false },
      execution: 'trusted-local', supportsInspect: true, meteredDimensions: ['units'] }),
    inspect: async () => ({ status: 'not-started' }),
    preflight: () => {},
    ...(options.prepare === false ? {} : { prepareForDispatch: async (envelope, context) => {
      contexts.push({ name: (envelope.input as { name: string }).name, context });
      return { startsBudgetClock: options.clock === true };
    } }),
    submit: async envelope => {
      counts.submit++;
      return { status: 'completed', completion: { operationId: envelope.operationId,
        idempotencyKey: envelope.idempotencyKey, inputDigest: envelope.inputDigest,
        implementationDigest: envelope.implementationDigest,
        outcome: { kind: 'result', value: {} },
        receipt: { source: 'toy.dispatch', scope: 'operation', operationId: envelope.operationId,
          cursor: 'final', cumulative: { units: 1 } } } };
    },
    cancel: async () => ({ status: 'unknown' }),
    collect: async () => { throw new Error('unused'); },
  };
  const runtime = () => new AlgorithmRuntime(root, algorithm, [provider], spec);
  return { runtime, intent, contexts, counts };
}

describe('Campaign provider dispatch context', () => {
  it('shows detached main and auxiliary holdings in stable batch order', async () => {
    const f = fixture({ mainKeys: ['b', 'a'] });
    const runtime = f.runtime();
    expect(await runtime.tick()).toBe('advanced');
    await runtime.enqueueAuxiliary('repair', [f.intent('y'), f.intent('x')]);
    expect(await runtime.runAuxiliaryUntilBlocked('repair')).toBe('complete');
    expect(f.contexts.map(row => [row.name, row.context.batchOrdinal])).toEqual([['x', 0], ['y', 1]]);
    for (const { context } of f.contexts) {
      expect(context).toMatchObject({ dispatchAdmitted: false, spent: {},
        reservedExcludingSelf: { units: 3 } });
      expect(Object.isFrozen(context)).toBe(true);
      expect(Object.isFrozen(context.spent)).toBe(true);
      expect(Object.isFrozen(context.reservedExcludingSelf)).toBe(true);
      expect(() => { (context.reservedExcludingSelf as Record<string, number>).units = 999; }).toThrow();
    }
    expect(await runtime.tick()).toBe('complete');
    expect(f.contexts.slice(2).map(row => [row.name, row.context.batchOrdinal])).toEqual([['a', 0], ['b', 1]]);
    for (const { context } of f.contexts.slice(2))
      expect(context).toMatchObject({ dispatchAdmitted: false, spent: { units: 2 },
        reservedExcludingSelf: { units: 1 } });
    expect(runtime.snapshot()?.spent.units).toBe(4);
  });

  it('does not submit after a failed marker commit, then rechecks admission on restart', async () => {
    const f = fixture();
    const runtime = f.runtime();
    await runtime.tick();
    const original = runtime.store.commit.bind(runtime.store);
    runtime.store.commit = async (state, event) => {
      if (event === 'operation.dispatch-admit') throw new Error('marker commit failed');
      await original(state, event);
    };
    await expect(runtime.tick()).rejects.toThrow('marker commit failed');
    expect(f.counts.submit).toBe(0);
    expect(runtime.snapshot()?.operations.main?.dispatchAdmitted).toBeUndefined();
    const resumed = f.runtime();
    const resumedEvents: string[] = [];
    const resumedCommit = resumed.store.commit.bind(resumed.store);
    resumed.store.commit = async (state, event) => { resumedEvents.push(event); await resumedCommit(state, event); };
    expect(await resumed.tick()).toBe('complete');
    expect(f.contexts.map(row => row.context.dispatchAdmitted)).toEqual([false, false]);
    expect(f.counts.submit).toBe(1);
    expect(resumedEvents[0]).toBe('operation.dispatch-admit');
  });

  it('retains a committed marker after a lost acknowledgement and resumes the same operation', async () => {
    const f = fixture();
    const runtime = f.runtime();
    await runtime.tick();
    const original = runtime.store.commit.bind(runtime.store);
    runtime.store.commit = async (state, event) => {
      await original(state, event);
      if (event === 'operation.dispatch-admit') throw new Error('marker acknowledgement lost');
    };
    await expect(runtime.tick()).rejects.toThrow('marker acknowledgement lost');
    expect(f.counts.submit).toBe(0);
    expect(runtime.snapshot()?.operations.main?.dispatchAdmitted).toBe(true);
    const resumed = f.runtime();
    expect(await resumed.tick()).toBe('complete');
    expect(f.contexts.map(row => row.context.dispatchAdmitted)).toEqual([false, true]);
    expect(f.counts.submit).toBe(1);
  });

  it('avoids a marker commit for an ordinary provider with no dispatch preparation or clock', async () => {
    const f = fixture({ prepare: false });
    const runtime = f.runtime();
    await runtime.tick();
    const events: string[] = [];
    const original = runtime.store.commit.bind(runtime.store);
    runtime.store.commit = async (state, event) => { events.push(event); await original(state, event); };
    expect(await runtime.tick()).toBe('complete');
    expect(events).toEqual(['operation.completed', 'decision.reduce']);
    expect(runtime.snapshot()?.operations.main?.dispatchAdmitted).toBeUndefined();
    expect(f.contexts).toEqual([]);
  });
});
