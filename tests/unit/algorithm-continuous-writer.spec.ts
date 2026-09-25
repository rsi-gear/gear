import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '../../src/algorithm/artifacts.js';
import { BindingStore } from '../../src/algorithm/bindings.js';
import { ALGORITHM_API_VERSION, type Algorithm, type CampaignSpec,
  type OperationProvider } from '../../src/algorithm/contracts.js';
import { AlgorithmRuntime } from '../../src/algorithm/runtime/engine.js';
import { JournalArtifactStore, JournalCampaignStore } from '../../src/algorithm/runtime/persistence.js';
import { MemorySearchStore } from '../../src/search/testing.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(journal = new MemorySearchStore(), initialBindingSetRef?: CampaignSpec['initialBindingSetRef']) {
  const root = mkdtempSync(join(tmpdir(), 'gear-continuous-writer-')); roots.push(root);
  const artifacts = new JournalArtifactStore(join(root, 'artifacts'), journal, 'round');
  const bindingSchema = { id: 'continuous.bindings.v1', slots: {} };
  const bindingRef = initialBindingSetRef ?? new BindingStore(artifacts, bindingSchema).create({});
  const spec: CampaignSpec = { campaignId: 'continuous', config: {},
    initialBindingSetRef: bindingRef, budget: {} };
  const intent = (name: string) => ({ localKey: name, kind: 'toy.step', input: { name }, limits: {} });
  const algorithm: Algorithm = {
    describe: () => ({ id: 'continuous', apiVersion: ALGORITHM_API_VERSION,
      implementationDigest: sha256('continuous.v1'), bindingSchema,
      configSchema: { type: 'object', additionalProperties: false },
      stateSchema: { type: 'object', additionalProperties: true } }),
    initialize: () => ({ nextState: { phase: 'first', nested: { safe: true } }, operations: [intent('one')] }),
    reduce: ({ decisionIndex }) => decisionIndex === 1
      ? { nextState: { phase: 'second', nested: { safe: true } }, operations: [intent('two')] }
      : { nextState: { phase: 'done' }, complete: true },
  };
  const submitted: string[] = [];
  const provider: OperationProvider = {
    describe: () => ({ kind: 'toy.step', implementationDigest: sha256('toy.step.v1'),
      inputSchema: { type: 'object', properties: { name: { type: 'string' } },
        required: ['name'], additionalProperties: false },
      outputSchema: { type: 'object', additionalProperties: false },
      execution: 'trusted-local', supportsInspect: true, meteredDimensions: [] }),
    preflight: () => {},
    inspect: async () => ({ status: 'not-started' }),
    submit: async envelope => {
      submitted.push((envelope.input as { name: string }).name);
      return { status: 'completed', completion: { operationId: envelope.operationId,
        idempotencyKey: envelope.idempotencyKey, inputDigest: envelope.inputDigest,
        implementationDigest: envelope.implementationDigest,
        outcome: { kind: 'result', value: {} } } };
    },
    cancel: async () => ({ status: 'unknown' }),
    collect: async () => { throw new Error('unused'); },
  };
  const store = new JournalCampaignStore(journal, 'round');
  const runtime = new AlgorithmRuntime(root, algorithm, [provider], spec, { store, artifacts });
  return { runtime, store, submitted, journal, bindingRef, algorithm, provider, spec };
}

describe('continuous Campaign writer for a SearchJournal-owned run', () => {
  it('uses one verified writer entry and observes detached committed states between steps', async () => {
    const f = fixture();
    const hydrated = vi.spyOn(f.store, 'hydrate');
    const phases: string[] = [];
    let before = 0;
    expect(await f.runtime.runWithWriterUntilBlocked({
      beforeTick: () => { before++; },
      onAdvanced: state => {
        const value = state as { phase: string; nested: { safe: boolean } };
        phases.push(value.phase);
        expect(Object.isFrozen(state)).toBe(true);
        expect(Object.isFrozen(value.nested)).toBe(true);
        expect(() => { value.nested.safe = false; }).toThrow();
      },
    })).toBe('complete');
    expect(hydrated).toHaveBeenCalledTimes(1);
    expect(before).toBe(3);
    expect(phases).toEqual(['first', 'second']);
    expect(f.submitted).toEqual(['one', 'two']);
    expect(f.runtime.snapshot()?.state).toEqual({ phase: 'done' });
  });

  it('keeps the committed step when a phase hook fails and resumes without repeating it', async () => {
    const f = fixture();
    await expect(f.runtime.runWithWriterUntilBlocked({
      onAdvanced: state => {
        expect(state).toMatchObject({ phase: 'first' });
        throw new Error('phase callback failed');
      },
    })).rejects.toThrow('phase callback failed');
    expect(f.submitted).toEqual([]);
    expect(f.runtime.snapshot()).toMatchObject({ decisionIndex: 0, state: { phase: 'first' } });
    const recovered = fixture(new MemorySearchStore(f.journal.checkpoint()), f.bindingRef);
    expect(await recovered.runtime.runWithWriterUntilBlocked()).toBe('complete');
    expect(recovered.submitted).toEqual(['one', 'two']);
  });

  it('checks caller abort before each new step, after prior durable effects', async () => {
    const f = fixture();
    let calls = 0;
    await expect(f.runtime.runWithWriterUntilBlocked({
      beforeTick: () => { if (++calls === 2) throw new Error('caller aborted'); },
    })).rejects.toThrow('caller aborted');
    expect(calls).toBe(2);
    expect(f.submitted).toEqual([]);
    expect(f.runtime.snapshot()?.state).toMatchObject({ phase: 'first' });
  });

  it('enforces only an explicitly requested safe step cap', async () => {
    const f = fixture();
    await expect(f.runtime.runWithWriterUntilBlocked({}, 0)).rejects.toThrow('positive safe step limit');
    await expect(f.runtime.runWithWriterUntilBlocked({}, 1)).rejects.toThrow('Maximum decisions exceeded');
    expect(f.runtime.snapshot()?.state).toMatchObject({ phase: 'first' });
    expect(f.submitted).toEqual([]);
    expect(await f.runtime.runWithWriterUntilBlocked()).toBe('complete');
  });

  it('requires an explicitly journal-backed writer, leaving ordinary tick unchanged', async () => {
    const f = fixture();
    const normal = new AlgorithmRuntime(join(roots[0]!, 'ordinary'), f.algorithm,
      [f.provider], f.spec);
    await expect(normal.runWithWriterUntilBlocked()).rejects.toThrow('journal-backed store');
  });
});
