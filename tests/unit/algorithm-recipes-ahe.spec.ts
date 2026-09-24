import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AlgorithmRuntime, BindingStore, FileArtifactStore, LocalDurableProvider, jsonDigest, sha256 } from '../../src/algorithm/index.js';
import type { ArtifactRef, OperationEnvelope, ProviderManifest } from '../../src/algorithm/contracts.js';
import { AuthorizedExperienceSources, sealExperienceView } from '../../src/algorithm/data/experience.js';
import { EvidenceService } from '../../src/algorithm/data/evidence.js';
import { TaskViewAuthority, prepareTaskViewFromExperience } from '../../src/algorithm/data/tasks.js';
import { createEvidenceProviders } from '../../src/algorithm/providers/evidence.js';
import { createTasksConsumeProvider } from '../../src/algorithm/providers/tasks.js';
import { VerifiedExecutionAdapter, executionResultSchema, type ExecutionKind, type PhysicalExecutionPort } from '../../src/algorithm/providers/execution.js';
import { loadPythonAlgorithm } from '../../src/algorithm/loader.js';

const interpreter = process.env.GEAR_ALGORITHM_TEST_PYTHON ?? process.env.GEAR_TRAINING_TEST_PYTHON;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.skipIf(!interpreter)('attributes AHE revision using authorized reports and traces bound to executed H1', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-ahe-recipe-')); roots.push(root);
  const stateRoot = join(root, '.gear', 'ahe');
  const artifacts = new FileArtifactStore(join(stateRoot, 'artifacts'));
  const bindings = new BindingStore(artifacts, { id: 'ahe.bindings.v1', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true } } });
  const h0 = bindings.create({ harness: artifacts.putJson({ revision: 'H0' }, 'harness.directory.v1') });
  const selector = { namespace: 'campaign' as const, sourceId: 'ahe-history',
    cursor: { namespace: 'campaign:ahe-history', value: 'snapshot-1' } };
  const sources = new AuthorizedExperienceSources();
  sources.registerVerified({ selector, sourceManifestDigest: sha256('ahe-source'), indexVersion: '1', provenance: 'verified',
    entries: ['task-1', 'task-2'].map((taskId, index) => ({ id: `trajectory-${index}`, taskId,
      exposure: { seenInTraining: false, graderLabelExposed: false }, task: { prompt: `solve ${taskId}` },
      overview: { summary: `observed ${taskId}`, tags: ['repair'] },
      taskReport: { narrative: `${taskId} was historically difficult` },
      traceChunks: [{ sequence: 0, text: `${taskId} tool trace` }],
      grader: { trueLabel: 'PRIVATE-GRADER' },
    })) }, { purpose: 'research', projections: ['overview', 'task-report', 'trace-chunk'],
      exposeGraderLabels: false, authorityId: 'ahe-host' }, () => {});
  const viewRef = await sealExperienceView(artifacts, sources, selector, 'research', ['overview', 'task-report', 'trace-chunk']);
  const authority = new TaskViewAuthority(artifacts, 'ahe-task-host', Buffer.alloc(32, 8));
  const taskViewRef = authority.seal(prepareTaskViewFromExperience(artifacts, viewRef, [
    { id: 'task-1', purpose: 'development' }, { id: 'task-2', purpose: 'development' }]));
  const sawAttribution: Array<{ revision: string; reports: number; traces: number }> = [];
  const physical = (kind: ExecutionKind): PhysicalExecutionPort => {
    const implementationDigest = sha256(`ahe-cpu-${kind}`);
    const structuredResultSchema = { type: 'object' as const, additionalProperties: true };
    const metered = kind === 'execution.rollout';
    const manifest: ProviderManifest & { kind: ExecutionKind; structuredResultSchema?: typeof structuredResultSchema } = {
      kind, implementationDigest, execution: 'trusted-local', supportsInspect: true,
      meteredDimensions: metered ? ['rollout.trials'] : [],
      inputSchema: { type: 'object', additionalProperties: true }, outputSchema: executionResultSchema,
      ...(metered ? {} : { structuredResultSchema }),
    };
    const local = new LocalDurableProvider(join(stateRoot, `physical-${kind}`), manifest, (envelope: OperationEnvelope) => {
      const actualBindings = bindings.read(envelope.bindingSetRef).slots;
      const revision = (artifacts.getJson(actualBindings.harness!) as { revision: string }).revision;
      const input = envelope.input as Record<string, any>;
      let structuredResult: Record<string, any> | undefined;
      let producedArtifactRef: ArtifactRef | undefined;
      let evidenceRef: ArtifactRef;
      if (kind === 'execution.rollout') {
        evidenceRef = artifacts.putJson({ revision, taskId: input.task.id }, 'ahe.cpu-rollout.v1');
      } else if (kind === 'execution.feedback') {
        const passed = input.task.id === 'task-1' || revision === 'H1';
        structuredResult = { score: passed ? 1 : 0, passed };
        evidenceRef = artifacts.putJson({ revision, taskId: input.task.id, passed }, 'ahe.cpu-feedback.v1');
      } else if (kind === 'execution.workspace-edit') {
        expect(revision).toBe('H0');
        structuredResult = { predictedFixes: ['task-2'], riskTasks: [], changedFiles: ['instruction.md'] };
        producedArtifactRef = artifacts.putJson({ revision: 'H1' }, 'harness.directory.v1');
        evidenceRef = artifacts.putJson({ changed: 'instruction.md' }, 'ahe.cpu-edit.v1');
      } else {
        expect(input.roleId).toBe('ahe.attributor');
        expect(input.evidenceReports.some((item: any) => item.body.narrative.includes('task-2'))).toBe(true);
        expect(input.evidenceTraces.some((item: any) => item.body.text.includes('task-2 tool trace'))).toBe(true);
        for (const item of [...input.evidenceReports, ...input.evidenceTraces]) {
          expect(item.contentRef.kind).toBe('artifact');
          expect(item.readReceiptRef.kind).toBe('artifact');
        }
        sawAttribution.push({ revision, reports: input.evidenceReports.length, traces: input.evidenceTraces.length });
        structuredResult = { rollbackFiles: [] };
        evidenceRef = artifacts.putJson({ attributed: true }, 'ahe.cpu-attribution.v1');
      }
      const structuredResultRef = structuredResult === undefined ? undefined
        : artifacts.putJson(structuredResult, 'ahe.cpu-structured.v1');
      const receiptRef = artifacts.putJson({ schemaVersion: 1, providerImplementationDigest: implementationDigest,
        operationId: envelope.operationId, inputDigest: envelope.inputDigest,
        loadedBindingSetDigest: envelope.bindingSetRef.digest, evidenceDigest: evidenceRef.digest,
        actualBindings: Object.fromEntries(Object.entries(actualBindings).map(([slot, ref]) => [slot, ref.digest])),
        executionIdentity: sha256(`ahe:${envelope.operationId}`),
        ...(typeof input.samplingDigest === 'string' ? { samplingDigest: input.samplingDigest } : {}),
        ...(typeof input.environmentDigest === 'string' ? { environmentDigest: input.environmentDigest } : {}),
        ...(structuredResult ? { structuredResultDigest: jsonDigest(structuredResult) } : {}),
      }, 'execution.receipt.v1');
      const validationReceiptRef = kind === 'execution.workspace-edit'
        ? artifacts.putJson({ valid: true, producedDigest: producedArtifactRef!.digest }, 'execution.validation.v1') : undefined;
      return { outcome: { kind: 'result', value: { requestedBindingSetDigest: envelope.bindingSetRef.digest,
        actualBindings, evidenceRef, receiptRef,
        ...(structuredResult ? { structuredResult, structuredResultRef: structuredResultRef! } : {}),
        ...(producedArtifactRef ? { producedArtifactRef } : {}),
        ...(validationReceiptRef ? { validationReceiptRef } : {}),
      } }, ...(metered ? { receipt: { source: 'ahe.rollout', scope: 'operation' as const,
        operationId: envelope.operationId, cursor: receiptRef.digest, cumulative: { 'rollout.trials': 1 } } } : {}) };
    });
    return { describe: () => manifest, preflight: () => local.preflight(), submit: e => local.submit(e),
      inspect: e => local.inspect(e), cancel: e => local.cancel(e), collect: e => local.collect(e) };
  };
  const loaded = await loadPythonAlgorithm({ configDir: root, module: 'gear_algorithm.recipes.ahe', export: 'algorithm',
    interpreter: interpreter!, sdkPath: resolve('packages/python-sdk/src') });
  try {
    const budget = { 'evidence.items': { unit: 'item', limit: 30, source: 'ahe.evidence', capability: 'stop' as const },
      'evidence.bytes': { unit: 'byte', limit: 100_000, source: 'ahe.evidence', capability: 'stop' as const },
      'rollout.trials': { unit: 'trial', limit: 4, source: 'ahe.rollout', capability: 'stop' as const } };
    const evidence = new EvidenceService(artifacts, Buffer.alloc(32, 7));
    const providers = [
      ...createEvidenceProviders(join(stateRoot, 'evidence'), evidence,
        principalId => ({ principalId, viewDigests: [viewRef.digest],
          projections: ['overview', 'task-report', 'trace-chunk'] }), sha256('ahe-evidence-policy'), budget),
      createTasksConsumeProvider(join(stateRoot, 'tasks'), artifacts, authority,
        () => ({ allowedExperienceViewDigests: [viewRef.digest] }), sha256('ahe-task-policy')),
      ...(['execution.role', 'execution.workspace-edit', 'execution.rollout', 'execution.feedback'] as ExecutionKind[])
        .map(kind => new VerifiedExecutionAdapter(physical(kind), artifacts, bindings, ['harness'])),
    ];
    const runtime = new AlgorithmRuntime(stateRoot, loaded.value, providers, { campaignId: 'ahe-controlled-cpu',
      config: { taskViewRef, experienceViewRef: viewRef, asOf: selector.cursor, taskCount: 2, rounds: 2,
        rolloutsPerTask: 1, samplingDigest: sha256('sampling'), environmentDigest: sha256('cpu'),
        operationLimits: { 'evidence.query': { 'evidence.items': 2, 'evidence.bytes': 4096 },
          'evidence.read': { 'evidence.items': 1, 'evidence.bytes': 4096 },
          'execution.rollout': { 'rollout.trials': 1 } } },
      initialBindingSetRef: h0, budget });
    expect(await runtime.runUntilBlocked()).toBe('complete');
    const snapshot = runtime.snapshot()!;
    expect(sawAttribution).toEqual([{ revision: 'H1', reports: 2, traces: 2 }]);
    expect((snapshot.state as any).predictionVerdict.confirmedFixes).toEqual(['task-2']);
    expect((snapshot.state as any).bestMeasured.bindingSetRef).toEqual(snapshot.activeBindingSetRef);
    expect((artifacts.getJson(bindings.read(snapshot.activeBindingSetRef).slots.harness!) as any).revision).toBe('H1');
    expect(snapshot.spent['rollout.trials']).toBe(4);
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE-GRADER');
  } finally { await loaded.close(); }
});
