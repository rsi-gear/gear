import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FileArtifactStore, sha256 } from '../../src/algorithm/artifacts.js';
import { BindingStore } from '../../src/algorithm/bindings.js';
import { ALGORITHM_API_VERSION } from '../../src/algorithm/contracts.js';
import type { Algorithm, OperationEnvelope, OperationProvider, ProviderManifest } from '../../src/algorithm/contracts.js';
import { jsonDigest, type JsonValue } from '../../src/algorithm/schema.js';
import { AlgorithmRuntime } from '../../src/algorithm/runtime/engine.js';
import { AuthorizedExperienceSources, sealExperienceView, type SourceSnapshot } from '../../src/algorithm/data/experience.js';
import { EvidenceService } from '../../src/algorithm/data/evidence.js';
import { LegacyEvolutionExperienceSource } from '../../src/algorithm/data/legacy.js';
import { TaskViewAuthority, taskViewFromExperience } from '../../src/algorithm/data/tasks.js';
import { createEvidenceProviders, createRoleEvidenceTools } from '../../src/algorithm/providers/evidence.js';
import { VerifiedExecutionAdapter, executionResultSchema } from '../../src/algorithm/providers/execution.js';
import { createTasksConsumeProvider, createTasksSelectProvider } from '../../src/algorithm/providers/tasks.js';
import { RefineStateStore } from '../../src/state/store.js';
import { digestJson } from '../../src/state/digest.js';
import { roundFixture } from '../helpers/research-fixture.js';
import type { SeedExperienceRecord } from '../../src/types.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function root() { const path = await mkdtemp(join(tmpdir(), 'gear-algorithm-provider-')); roots.push(path); return path; }
function envelope(provider: OperationProvider, campaignId: string, input: JsonValue, bindingSetRef: OperationEnvelope['bindingSetRef'], limits: Record<string, number>): OperationEnvelope {
  return { operationId: sha256(`op:${campaignId}:${provider.describe().kind}`), idempotencyKey: sha256(`op:${campaignId}:${provider.describe().kind}`),
    campaignId, decisionIndex: 0, localKey: 'evidence', kind: provider.describe().kind, input, inputDigest: jsonDigest(input),
    implementationDigest: provider.describe().implementationDigest, bindingSetRef, limits };
}

describe('S3 provider contracts', () => {
  it('selects then consumes an authenticated TaskView across two decisions in one Campaign', async () => {
    const path = await root();
    const artifacts = new FileArtifactStore(join(path, 'artifacts'));
    const bindings = new BindingStore(artifacts, { id: 'task-bindings', slots: {} });
    const selector = { namespace: 'campaign' as const, sourceId: 'source', cursor: { namespace: 'campaign:source', value: 'v1' } };
    const sources = new AuthorizedExperienceSources();
    sources.registerVerified({ selector, sourceManifestDigest: sha256('source'), indexVersion: '1', provenance: 'verified', entries: [
      { id: 'experience-1', taskId: 'task-1', exposure: { seenInTraining: false, graderLabelExposed: false },
        task: { prompt: 'work' }, overview: { summary: 'observed', tags: [] }, taskReport: { narrative: 'detail' }, traceChunks: [] },
    ] }, { purpose: 'research', projections: ['overview'], exposeGraderLabels: false, authorityId: 'host' }, () => {});
    const viewRef = await sealExperienceView(artifacts, sources, selector, 'research', ['overview']);
    const authority = new TaskViewAuthority(artifacts, 'task-host', Buffer.alloc(32, 9));
    const grants = () => ({ allowedExperienceViewDigests: [viewRef.digest] });
    const providers = [createTasksSelectProvider(join(path, 'select'), artifacts, authority, grants, sha256('policy')),
      createTasksConsumeProvider(join(path, 'consume'), artifacts, authority, grants, sha256('policy'))];
    const algorithm: Algorithm = { describe: () => ({ id: 'task-flow', apiVersion: ALGORITHM_API_VERSION,
      implementationDigest: sha256('task-flow-v1'), stateSchema: { type: 'object', additionalProperties: true },
      configSchema: { type: 'object', additionalProperties: false }, bindingSchema: { id: 'task-bindings', slots: {} } }),
      initialize: () => ({ nextState: { stage: 'select' }, operations: [{ localKey: 'select', kind: 'tasks.select',
        input: { experienceViewRef: viewRef, tasks: [{ id: 'task-1', purpose: 'development' }] } }] }),
      reduce: ({ state, completed }) => {
        if ((state as { stage?: string }).stage === 'select') {
          if (completed.select?.kind !== 'result') throw new Error('select missing');
          const taskViewRef = (completed.select.value as unknown as { taskViewRef: { digest: string } }).taskViewRef;
          return { nextState: { stage: 'consume' }, operations: [{ localKey: 'consume', kind: 'tasks.consume',
            input: { taskViewRef, cursor: { viewDigest: taskViewRef.digest, nextIndex: 0 }, count: 1 } }] };
        }
        return { nextState: { batch: completed.consume ?? null }, complete: true };
      } };
    const runtime = new AlgorithmRuntime(path, algorithm, providers, { campaignId: 'task-flow', config: {},
      initialBindingSetRef: bindings.create({}), budget: {} });
    expect(await runtime.runUntilBlocked()).toBe('complete');
    expect(runtime.snapshot()?.decisionIndex).toBe(2);
    expect(JSON.stringify(runtime.snapshot()?.state)).toContain('task-1');
  });

  it('shares host-bound grants with role tools and persists operation-scoped Campaign receipts', async () => {
    const path = await root();
    const artifacts = new FileArtifactStore(join(path, 'artifacts'));
    const bindings = new BindingStore(artifacts, { id: 'empty', slots: {} });
    const selector = { namespace: 'campaign' as const, sourceId: 'c1', cursor: { namespace: 'campaign:c1', value: '1' } };
    const snapshot: SourceSnapshot = { selector, sourceManifestDigest: sha256('source'), indexVersion: 'v1', provenance: 'verified', entries: [
      { id: 'one', taskId: 'task-one', exposure: { seenInTraining: false, graderLabelExposed: false }, task: { prompt: 'p1' },
        overview: { summary: 'safe', tags: [] }, taskReport: { narrative: 'detail' }, traceChunks: [], grader: { trueLabel: 'PRIVATE' } },
    ] };
    const sources = new AuthorizedExperienceSources();
    sources.registerVerified(snapshot, { purpose: 'research', projections: ['overview'], exposeGraderLabels: false, authorityId: 'host' }, () => {});
    const viewRef = await sealExperienceView(artifacts, sources, selector, 'research', ['overview']);
    const service = new EvidenceService(artifacts, Buffer.alloc(32, 4));
    const grant = (principalId: string) => ({ principalId, viewDigests: principalId === 'allowed' ? [viewRef.digest] : [], projections: ['overview' as const] });
    const budget = { 'evidence.items': { unit: 'item', limit: 5, source: 'evidence-source', capability: 'stop' as const },
      'evidence.bytes': { unit: 'byte', limit: 5000, source: 'evidence-source', capability: 'stop' as const } };
    const [query, read] = createEvidenceProviders(join(path, 'providers'), service, grant, sha256('policy'), budget);
    expect(query).toBeDefined(); expect(read).toBeDefined();
    expect(query!.describe().meteredDimensions).toEqual(['evidence.items', 'evidence.bytes']);
    const request = { viewRef, asOf: selector.cursor, projection: 'overview' as const, pageSize: 1 };
    const denied = envelope(query!, 'denied', request, bindings.create({}), { 'evidence.items': 1, 'evidence.bytes': 5000 });
    expect(() => query!.preflight(denied)).toThrow(/access denied/);
    const accepted = envelope(query!, 'allowed', request, bindings.create({}), { 'evidence.items': 1, 'evidence.bytes': 5000 });
    const result = await query!.submit(accepted);
    expect(result.status).toBe('completed');
    if (result.status !== 'completed' || result.completion.outcome.kind !== 'result') throw new Error('unexpected provider result');
    expect(result.completion.receipt).toMatchObject({ source: 'evidence-source', scope: 'operation', operationId: accepted.operationId,
      cumulative: { 'evidence.items': 1 } });
    expect((await query!.inspect(accepted)).status).toBe('completed');
    const page = result.completion.outcome.value as unknown as { items: Array<{ contentRef: { digest: string } }> };
    const role = createRoleEvidenceTools(service, grant, 'allowed');
    expect(role.query(request).items).toHaveLength(1);
    expect(role.read({ viewRef, asOf: selector.cursor, contentDigest: page.items[0]!.contentRef.digest }).text).not.toContain('PRIVATE');
    expect(() => createRoleEvidenceTools(service, grant, 'denied').query(request)).toThrow(/access denied/);
    const unmetered = createEvidenceProviders(join(path, 'unmetered'), service, grant, sha256('policy'), {});
    expect(unmetered[0]!.describe().meteredDimensions).toEqual([]);
    expect(unmetered[0]!.describe().implementationDigest).not.toBe(query!.describe().implementationDigest);
    expect(() => createEvidenceProviders(join(path, 'hard'), service, grant, sha256('policy'),
      { 'evidence.items': { ...budget['evidence.items'], capability: 'hard' } })).toThrow(/hard budgets/);
    const kernelQuery = createEvidenceProviders(join(path, 'kernel-provider'), service, grant, sha256('policy'), budget)[0]!;
    const algorithm: Algorithm = { describe: () => ({ id: 'evidence-test', apiVersion: ALGORITHM_API_VERSION,
      implementationDigest: sha256('evidence-test'), stateSchema: { type: 'object', additionalProperties: true },
      configSchema: { type: 'object', additionalProperties: false }, bindingSchema: { id: 'empty', slots: {} } }),
      initialize: () => ({ nextState: {}, operations: [{ localKey: 'query', kind: 'evidence.query', input: request,
        limits: { 'evidence.items': 1, 'evidence.bytes': 5000 } }] }),
      reduce: ({ completed }) => ({ nextState: { result: completed.query ?? null }, complete: true }) };
    const runtime = new AlgorithmRuntime(path, algorithm, [kernelQuery], { campaignId: 'allowed', config: {},
      initialBindingSetRef: bindings.create({}), budget });
    expect(await runtime.runUntilBlocked()).toBe('complete');
    expect(runtime.snapshot()?.spent['evidence.items']).toBe(1);
    expect(runtime.snapshot()?.spent['evidence.bytes']).toBeGreaterThan(0);
    const taskAuthority = new TaskViewAuthority(artifacts, 'task-host', Buffer.alloc(32, 8));
    const taskGrant = () => ({ allowedExperienceViewDigests: [viewRef.digest] });
    const select = createTasksSelectProvider(join(path, 'task-select'), artifacts, taskAuthority, taskGrant, sha256('task-policy'));
    const selection = { experienceViewRef: viewRef, tasks: [{ id: 'task-one', purpose: 'development' as const }] };
    const selectEnvelope = envelope(select, 'allowed', selection, bindings.create({}), {});
    expect(() => select.preflight({ ...selectEnvelope, input: { ...selection, tasks: [{ id: 'task-one', purpose: 'final-test' }] } })).toThrow(/cannot create final-test/);
    const selected = await select.submit(selectEnvelope);
    if (selected.status !== 'completed' || selected.completion.outcome.kind !== 'result') throw new Error('task select failed');
    const taskViewRef = (selected.completion.outcome.value as unknown as { taskViewRef: { digest: string; kind: 'artifact'; size: number; mediaType: string; schemaId: string } }).taskViewRef;
    const consume = createTasksConsumeProvider(join(path, 'task-consume'), artifacts, taskAuthority, taskGrant, sha256('task-policy'));
    const batchInput = { taskViewRef, cursor: { viewDigest: taskViewRef.digest, nextIndex: 0 }, count: 1 };
    const batchEnvelope = envelope(consume, 'allowed', batchInput, bindings.create({}), {});
    const forged = taskViewFromExperience(artifacts, viewRef, [{ id: 'task-one', purpose: 'development' }]);
    const forgedInput = { ...batchInput, taskViewRef: forged, cursor: { viewDigest: forged.digest, nextIndex: 0 } };
    expect(() => consume.preflight({ ...batchEnvelope, input: forgedInput, inputDigest: jsonDigest(forgedInput) })).toThrow(/not authorized/);
    const consumed = await consume.submit(batchEnvelope);
    if (consumed.status !== 'completed' || consumed.completion.outcome.kind !== 'result') throw new Error('task consume failed');
    expect(consumed.completion.outcome.value).toMatchObject({ tasks: [{ id: 'task-one' }], cursor: { nextIndex: 1 } });
  });

  it('rejects a physical port changing identity or lying about any loaded binding and environment', async () => {
    const path = await root();
    const artifacts = new FileArtifactStore(join(path, 'artifacts'));
    const a = artifacts.putJson({ version: 'a' }, 'model.v1'), b = artifacts.putJson({ version: 'b' }, 'tool.v1');
    const bindings = new BindingStore(artifacts, { id: 'agent', slots: { model: { schemaId: 'model.v1', required: true }, tool: { schemaId: 'tool.v1', required: true } } });
    const bindingSetRef = bindings.create({ model: a, tool: b });
    const manifest: ProviderManifest & { kind: 'execution.rollout' } = { kind: 'execution.rollout', implementationDigest: sha256('physical-v1'),
      inputSchema: { type: 'object', additionalProperties: true }, outputSchema: executionResultSchema,
      meteredDimensions: [], supportsInspect: true, execution: 'external' };
    let actualTool = b, environmentDigest = sha256('env');
    const port: OperationProvider = {
      describe: () => manifest, preflight: () => {}, inspect: async () => ({ status: 'not-started' }),
      cancel: async () => ({ status: 'cancelled', releaseConfirmed: false }),
      submit: async operation => ({ status: 'completed', completion: await port.collect(operation) }),
      collect: async operation => {
        const evidenceRef = artifacts.putJson({ trace: true });
        const receiptRef = artifacts.putJson({ schemaVersion: 1, providerImplementationDigest: manifest.implementationDigest,
          operationId: operation.operationId, inputDigest: operation.inputDigest, loadedBindingSetDigest: bindingSetRef.digest,
          evidenceDigest: evidenceRef.digest, actualBindings: { model: a.digest, tool: actualTool.digest }, executionIdentity: 'fixture', environmentDigest });
        return { operationId: operation.operationId, idempotencyKey: operation.idempotencyKey, inputDigest: operation.inputDigest,
          implementationDigest: manifest.implementationDigest, outcome: { kind: 'result' as const, value: {
            requestedBindingSetDigest: bindingSetRef.digest, actualBindings: { model: a, tool: actualTool }, evidenceRef, receiptRef } } };
      },
    };
    const adapter = new VerifiedExecutionAdapter(port as never, artifacts, bindings, ['model']);
    const input = { environmentDigest: sha256('env') };
    const operation = envelope(adapter, 'campaign', input, bindingSetRef, {});
    expect((await adapter.submit(operation)).status).toBe('completed');
    actualTool = a;
    await expect(adapter.submit(operation)).rejects.toThrow(/version drift/);
    actualTool = b; environmentDigest = sha256('changed-env');
    await expect(adapter.submit(operation)).rejects.toThrow(/environment identity/);
    environmentDigest = sha256('env'); manifest.implementationDigest = sha256('physical-v2');
    await expect(adapter.submit(operation)).rejects.toThrow(/port identity drift/);
  });
});

describe('old evolution read-only import', () => {
  it('loads only validated sealed seed records with a pinned source cursor', async () => {
    const path = await root();
    const store = new RefineStateStore(join(path, 'old-state'), 'evo-1');
    await store.initialize();
    const source = { evolutionId: 'evo-1', roundId: 'source-round', candidateId: 'candidate-1', parentCandidateId: 'parent-1',
      parentHarnessRef: 'a'.repeat(40), candidateHarnessRef: 'b'.repeat(40), parentBaselineEvalId: 'before', candidateEvalId: 'after',
      parentRevisionIdentity: digestJson('before'), candidateRevisionIdentity: digestJson('after'), seedConditionId: 'seed' };
    const recordId = `seed_experience_${digestJson({ evolutionId: source.evolutionId, roundId: source.roundId, candidateId: source.candidateId }).slice('sha256:'.length)}`;
    const projection = { source, applicability: { model: 'fixture', provider: 'fixture', datasetDigest: 'seed', rolloutProviderDigest: 'rollout', toolchainDigest: 'tools' },
      proposal: { rationale: 'improve handling', expectedOutcome: 'better result', semanticTargets: [] },
      change: { patchDigest: digestJson('patch'), totalBytes: 1, files: [{ path: 'src/agent.ts', change: 'modified' as const }] },
      observation: { comparison: 'candidate-vs-its-parent-seed' as const, planned: 0, valid: 0, excluded: 0, baselineInvalid: 0, candidateInvalid: 0,
        taskResults: [], excludedTaskResults: [] } };
    const base = { schemaVersion: 1 as const, recordId, seedProjectionDigest: digestJson(projection), ...projection,
      classification: { execution: 'evaluated' as const, effect: 'insufficient' as const, coverage: 'none' as const,
        gainedTasks: [], regressedTasks: [], unchangedTasks: [] } };
    const record = { ...base, recordDigest: digestJson(base) } as SeedExperienceRecord;
    await store.writeExperienceRecord(record);
    const members = [{ recordId, recordDigest: record.recordDigest, sourceRoundId: source.roundId, candidateId: source.candidateId,
      candidateHarnessRef: source.candidateHarnessRef }];
    const snapshot = { schemaVersion: 1 as const, members, digest: digestJson({ schemaVersion: 1, members }) };
    await store.writeRound(roundFixture({ roundId: 'snapshot-round', experienceSnapshot: snapshot }));
    const authority = new LegacyEvolutionExperienceSource(store, 'evo-1', 'snapshot-round', 'old-state-host');
    const selector = await authority.selector();
    const artifacts = new FileArtifactStore(join(path, 'new-artifacts'));
    const viewRef = await sealExperienceView(artifacts, authority, selector, 'research', ['overview', 'task-report', 'trace-chunk']);
    const view = artifacts.getJson(viewRef);
    expect(JSON.stringify(view)).not.toContain('reward');
    expect(JSON.stringify(view)).not.toContain('heldOut');
    expect(JSON.stringify(view)).not.toContain('trueLabel');
    expect((view as { entries: unknown[] }).entries).toHaveLength(1);
    expect((view as { entries: Array<{ kind: string; taskRef?: unknown; traceRefs?: unknown[] }> }).entries[0]).toMatchObject({ kind: 'seed-summary' });
    expect((view as { entries: Array<{ taskRef?: unknown; traceRefs?: unknown[] }> }).entries[0]!.taskRef).toBeUndefined();
    expect((view as { entries: Array<{ traceRefs?: unknown[] }> }).entries[0]!.traceRefs).toEqual([]);
    expect(() => taskViewFromExperience(artifacts, viewRef, [{ id: recordId, purpose: 'development' }])).toThrow(/absent from sealed experience/);
    await expect(authority.resolve({ ...selector, cursor: { ...selector.cursor, value: sha256('wrong') } }, 'research')).rejects.toThrow(/cursor changed/);
    await store.writeRound(roundFixture({ roundId: 'snapshot-round', experienceSnapshot: { schemaVersion: 1, members: [], digest: digestJson({ schemaVersion: 1, members: [] }) } }));
    await expect(authority.resolve(selector, 'research')).rejects.toThrow(/cursor changed/);
  });
});

describe('installed package identity', () => {
  it('computes the built provider closure without a consumer package-lock', async () => {
    const path = await root();
    await writeFile(join(path, 'package.json'), JSON.stringify({ type: 'module' }));
    await symlink(join(process.cwd(), 'node_modules'), join(path, 'node_modules'));
    execFileSync(process.execPath, [join(process.cwd(), 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json',
      '--outDir', join(path, 'lib')], { cwd: process.cwd(), stdio: 'pipe' });
    const identityUrl = pathToFileURL(join(path, 'lib/algorithm/data/identity.js')).href;
    const actual = execFileSync(process.execPath, ['--input-type=module', '-e',
      `import { s3ImplementationDigest } from ${JSON.stringify(identityUrl)}; process.stdout.write(s3ImplementationDigest('installed-smoke', {}));`],
    { cwd: path, encoding: 'utf8' });
    expect(actual).toMatch(/^[a-f0-9]{64}$/u);
  });
});
