import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256 } from '../../src/algorithm/artifacts.js';
import { BindingStore } from '../../src/algorithm/bindings.js';
import { FileArtifactStore } from '../../src/algorithm/artifacts.js';
import { ALGORITHM_API_VERSION } from '../../src/algorithm/contracts.js';
import type { Algorithm, OperationEnvelope, OperationOutcome, OperationProvider, ProviderManifest } from '../../src/algorithm/contracts.js';
import { jsonDigest } from '../../src/algorithm/schema.js';
import { AlgorithmRuntime } from '../../src/algorithm/runtime/engine.js';
import { CampaignStore } from '../../src/algorithm/runtime/store.js';
import { digestJson } from '../../src/state/digest.js';
import { createLocalCommittedRolloutResolver,
  type AuthorPhysicalRolloutJournalSnapshot } from '../../src/algorithm/author/committed-rollout-resolver.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(complete = true) {
  const root = await mkdtemp(join(tmpdir(), 'gear-committed-rollout-')); roots.push(root);
  const campaignJournalRoot = join(root, 'campaign');
  const store = new CampaignStore(campaignJournalRoot);
  const operationId = jsonDigest(['campaign', 0, 'rollout']), adapterDigest = sha256('adapter'), physicalDigest = sha256('Hitch');
  const bindingSetRef = { kind: 'binding-set' as const, digest: sha256('binding'), schemaId: 'author.harness.v1' };
  const input = { task: { id: 'task-1' }, repeatIndex: 0, samplingDigest: digestJson({}),
    environmentDigest: digestJson({ environment: 1 }), recipePhase: 'author.evaluate' };
  const envelope: OperationEnvelope = { operationId, idempotencyKey: operationId,
    campaignId: 'campaign', decisionIndex: 0, localKey: 'rollout', kind: 'execution.rollout',
    input, inputDigest: jsonDigest(input), implementationDigest: adapterDigest, bindingSetRef,
    limits: { 'rollout.trials': 1 }, startsBudgetClock: true };
  const requestBody = { partition: 'seed' as const, dataset: { ref: 'projected-task-1',
    digest: digestJson({ dataset: 1 }) }, repetitions: 1, model: 'target', sampling: {},
    timeoutMs: 1000, rolloutProviderDigest: digestJson({ provider: 1 }) };
  const request = { phase: 'author-candidate' as const, dataset: requestBody.dataset.ref,
    harnessRef: 'a'.repeat(40), condition: { ...requestBody, conditionId: digestJson(requestBody) } };
  const outcome: OperationOutcome = { kind: 'result', value: { receipt: 'trusted-by-measurement-layer' } };
  const physicalEnvelope = { ...envelope, implementationDigest: physicalDigest };
  const completion = { operationId, idempotencyKey: operationId, inputDigest: envelope.inputDigest,
    implementationDigest: physicalDigest, outcome };
  let physical: AuthorPhysicalRolloutJournalSnapshot = { status: 'completed', envelope: physicalEnvelope,
    request, requestDigest: digestJson(request), completion,
    submittedIdentity: { provider: 'hitch-cli', effectiveConfigDigest: digestJson({ config: 1 }) } };
  const physicalManifest: ProviderManifest = { kind: 'execution.rollout', implementationDigest: physicalDigest,
    execution: 'external', supportsInspect: true, meteredDimensions: ['rollout.trials'],
    inputSchema: { type: 'object', additionalProperties: true },
    outputSchema: { type: 'object', additionalProperties: true } };
  let reads = 0, manifest = physicalManifest;
  const physicalReader = { describe: () => manifest,
    readAuthorRolloutJournal(id: string) { reads++; return id === operationId ? physical : undefined; } };
  const base = { version: 1 as const, spec: { campaignId: 'campaign', config: {},
    initialBindingSetRef: bindingSetRef, budget: {} }, algorithmManifestDigest: sha256('algorithm'),
    kernelImplementationDigest: sha256('kernel'), providerCatalogDigest: sha256('catalog'),
    activeBindingSetRef: bindingSetRef, initialBindingSetRef: bindingSetRef, state: null,
    decisionIndex: 0, spent: {}, receiptSources: {}, phase: 'running' as const };
  const record = { envelope, providerManifestDigest: sha256('adapter-manifest'),
    status: 'intent', accounted: {}, released: false };
  await store.withWriter(async () => {
    await store.commit({ ...base, operations: { rollout: record } }, 'decision.initialize');
    await store.commit({ ...base, operations: { rollout: { ...record, status: 'running' } } }, 'operation.running');
    if (complete) {
      await store.commit({ ...base, operations: { rollout: { ...record, status: 'completed',
        outcome, released: true } } }, 'operation.completed');
      await store.commit({ ...base, decisionIndex: 1, operations: {} }, 'decision.reduce');
    }
  });
  const resolver = createLocalCommittedRolloutResolver({ campaignJournalRoot, physicalReader });
  const journalBytes = () => ({ head: readFileSync(join(campaignJournalRoot, 'HEAD')).toString('hex'),
    records: readdirSync(join(campaignJournalRoot, 'journal')).sort().map(name => [name,
      sha256(readFileSync(join(campaignJournalRoot, 'journal', name)))] as const) });
  return { root, campaignJournalRoot, store, envelope, operationId, outcome, physical, resolver,
    physicalReader, journalBytes, get readCount() { return reads; },
    changePhysical(next: AuthorPhysicalRolloutJournalSnapshot) { physical = next; },
    changeManifest(next: ProviderManifest) { manifest = next; } };
}

describe('read-only resolver over the real local CampaignStore hash chain', () => {
  it('finds a committed producer after decision.reduce cleared operations, with one cold snapshot and no writes', async () => {
    const f = await fixture();
    expect((f.store.load()!.state as { operations: object }).operations).toEqual({});
    const before = f.journalBytes();
    const first = await f.resolver.resolve('campaign', [f.operationId]);
    expect(first[f.operationId]).toMatchObject({ status: 'completed', envelope: f.envelope,
      outcome: f.outcome, physical: { status: 'completed', request: f.physical.request } });
    expect(f.readCount).toBe(1);
    const cold = createLocalCommittedRolloutResolver({ campaignJournalRoot: f.campaignJournalRoot,
      physicalReader: f.physicalReader });
    expect(cold.identityDigest).toBe(f.resolver.identityDigest);
    expect(await cold.resolve('campaign', [f.operationId])).toEqual(first);
    expect(f.journalBytes()).toEqual(before);
  });

  it('never upgrades a physical completion when the kernel only committed a pending state', async () => {
    const f = await fixture(false);
    expect(await f.resolver.resolve('campaign', [f.operationId])).toEqual({});
    expect(f.readCount).toBe(0);
  });

  it('rejects tampered hash-chain bytes before reading any physical journal', async () => {
    const f = await fixture();
    const head = JSON.parse(readFileSync(join(f.campaignJournalRoot, 'HEAD'), 'utf8')) as { digest: string };
    writeFileSync(join(f.campaignJournalRoot, 'journal', `${head.digest}.json`), 'tampered');
    await expect(f.resolver.resolve('campaign', [f.operationId])).rejects.toThrow(/digest or size drift/);
    expect(f.readCount).toBe(0);
  });

  it('rejects physical mismatch and reader manifest drift after construction', async () => {
    const f = await fixture();
    f.changePhysical({ ...f.physical, completion: { ...f.physical.completion!, outcome: { kind: 'no-result' } } });
    await expect(f.resolver.resolve('campaign', [f.operationId])).rejects.toThrow(/does not match kernel/);
    f.changeManifest({ ...f.physicalReader.describe(), implementationDigest: sha256('changed') });
    await expect(f.resolver.resolve('campaign', [f.operationId])).rejects.toThrow(/manifest identity drift/);
  });

  it('binds implementation identity to the real physical reader manifest and local journal root', async () => {
    const f = await fixture();
    const other = createLocalCommittedRolloutResolver({ campaignJournalRoot: join(f.root, 'other'),
      physicalReader: f.physicalReader });
    expect(other.identityDigest).not.toBe(f.resolver.identityDigest);
    await expect(other.resolve('campaign', [f.operationId])).rejects.toThrow();
  });

  it.each([false, true])('reads an actual kernel %s completion after operations are cleared', async cancelCompletion => {
    const root = await mkdtemp(join(tmpdir(), 'gear-committed-kernel-')); roots.push(root);
    const artifacts = new FileArtifactStore(join(root, 'artifacts'));
    const bindingSchema = { id: 'author.harness.v1', slots: { harness: { schemaId: 'harness.v1', required: true } } };
    const bindingSetRef = new BindingStore(artifacts, bindingSchema).create({ harness: artifacts.putJson({ name: 'H0' }, 'harness.v1') });
    const adapterDigest = sha256('actual-kernel-adapter'), physicalDigest = sha256('actual-kernel-physical');
    const outcome: OperationOutcome = { kind: 'result', value: {} };
    const adapterManifest: ProviderManifest = { kind: 'execution.rollout', implementationDigest: adapterDigest,
      execution: 'trusted-local', supportsInspect: true, meteredDimensions: [],
      inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object', additionalProperties: false } };
    const completion = (envelope: OperationEnvelope) => ({ operationId: envelope.operationId,
      idempotencyKey: envelope.idempotencyKey, inputDigest: envelope.inputDigest,
      implementationDigest: envelope.implementationDigest, outcome });
    const provider: OperationProvider = { describe: () => adapterManifest, preflight: () => {},
      inspect: async () => ({ status: 'not-started' }),
      submit: async envelope => cancelCompletion ? { status: 'running' } : { status: 'completed', completion: completion(envelope) },
      cancel: async envelope => ({ status: 'completed', completion: completion(envelope) }),
      collect: async () => { throw new Error('not needed'); } };
    const algorithm: Algorithm = {
      describe: () => ({ id: 'author-kernel-source', apiVersion: ALGORITHM_API_VERSION,
        implementationDigest: sha256('author-kernel-source'), bindingSchema,
        configSchema: { type: 'object', additionalProperties: false },
        stateSchema: { type: 'object', additionalProperties: false } }),
      initialize: () => ({ nextState: {}, operations: [{ localKey: 'rollout', kind: 'execution.rollout', input: {} }] }),
      reduce: () => ({ nextState: {}, complete: true }),
    };
    const runtime = new AlgorithmRuntime(root, algorithm, [provider], {
      campaignId: 'actual-campaign', config: {}, initialBindingSetRef: bindingSetRef, budget: {} }, { artifacts });
    expect(await runtime.tick()).toBe('advanced');
    const envelope = runtime.snapshot()!.operations.rollout!.envelope;
    if (cancelCompletion) {
      expect(await runtime.tick()).toBe('waiting');
      await runtime.cancel('rollout');
    }
    expect(await runtime.runUntilBlocked()).toBe('complete');
    expect(runtime.snapshot()!.operations).toEqual({});
    const physicalManifest: ProviderManifest = { ...adapterManifest, implementationDigest: physicalDigest,
      execution: 'external' };
    const physicalEnvelope = { ...envelope, implementationDigest: physicalDigest };
    const requestBody = { partition: 'seed' as const, dataset: { ref: 'task-dataset', digest: digestJson({ task: 1 }) },
      repetitions: 1, model: 'target', sampling: {}, timeoutMs: 1000,
      rolloutProviderDigest: digestJson({ provider: 1 }) };
    const request = { phase: 'author-candidate' as const, dataset: 'task-dataset', harnessRef: 'a'.repeat(40),
      condition: { ...requestBody, conditionId: digestJson(requestBody) } };
    const physical: AuthorPhysicalRolloutJournalSnapshot = { status: 'completed', envelope: physicalEnvelope,
      request, requestDigest: digestJson(request), completion: completion(physicalEnvelope) };
    const resolver = createLocalCommittedRolloutResolver({ campaignJournalRoot: join(root, 'campaign'),
      physicalReader: { describe: () => physicalManifest,
        readAuthorRolloutJournal: id => id === envelope.operationId ? physical : undefined } });
    const result = await resolver.resolve('actual-campaign', [envelope.operationId]);
    expect(result[envelope.operationId]).toMatchObject({ envelope, outcome, status: 'completed',
      physical: { envelope: physicalEnvelope, request } });
  });
});
