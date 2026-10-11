import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AlgorithmRuntime, BindingStore, FileArtifactStore, LocalDurableProvider, jsonDigest, sha256 } from '../../src/algorithm/index.js';
import type { ArtifactRef, OperationEnvelope, ProviderManifest } from '../../src/algorithm/contracts.js';
import { AuthorizedExperienceSources, sealExperienceView } from '../../src/algorithm/data/experience.js';
import { EvidenceService } from '../../src/algorithm/data/evidence.js';
import { TaskViewAuthority } from '../../src/algorithm/data/tasks.js';
import { createEvidenceProviders } from '../../src/algorithm/providers/evidence.js';
import { createTasksConsumeProvider, createTasksSelectProvider } from '../../src/algorithm/providers/tasks.js';
import { VerifiedExecutionAdapter, executionResultSchema, type ExecutionKind, type PhysicalExecutionPort } from '../../src/algorithm/providers/execution.js';
import { loadPythonAlgorithm } from '../../src/algorithm/loader.js';

const interpreter = process.env.GEAR_ALGORITHM_TEST_PYTHON ?? process.env.GEAR_TRAINING_TEST_PYTHON;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.skipIf(!interpreter)('runs Python RHO against sealed history and verifies physical candidate binding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-rho-recipe-')); roots.push(root);
  const stateRoot = join(root, '.gear', 'rho');
  const artifacts = new FileArtifactStore(join(stateRoot, 'artifacts'));
  const bindingSchema = { id: 'rho.bindings.v1', slots: { harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true } } };
  const bindings = new BindingStore(artifacts, bindingSchema);
  const baselineHarness = artifacts.putJson({ revision: 'baseline' }, 'harness.directory.v1');
  const baseline = bindings.create({ harness: baselineHarness });
  const selector = { namespace: 'campaign' as const, sourceId: 'rho-history',
    cursor: { namespace: 'campaign:rho-history', value: 'snapshot-1' } };
  const sources = new AuthorizedExperienceSources();
  sources.registerVerified({ selector, sourceManifestDigest: sha256('sealed-history'), indexVersion: '1', provenance: 'verified', entries: [
    { id: 'trajectory-1', taskId: 'task-1', exposure: { seenInTraining: false, graderLabelExposed: false },
      task: { prompt: 'diagnose a tool failure' }, overview: { summary: 'tool failure', tags: ['tool'] },
      taskReport: { narrative: 'tool response was malformed' },
      traceChunks: [{ sequence: 0, text: 'malformed tool payload' }], grader: { trueLabel: 'PRIVATE' } },
    { id: 'trajectory-2', taskId: 'task-2', exposure: { seenInTraining: false, graderLabelExposed: false },
      task: { prompt: 'diagnose a format failure' }, overview: { summary: 'format failure', tags: ['format'] },
      taskReport: { narrative: 'answer format was wrong' },
      traceChunks: [{ sequence: 0, text: 'format parser rejected output' }] },
  ] }, { purpose: 'research', projections: ['overview', 'task-report', 'trace-chunk'],
    exposeGraderLabels: false, authorityId: 'history-host' }, () => {});
  const viewRef = await sealExperienceView(artifacts, sources, selector, 'research', ['overview', 'task-report', 'trace-chunk']);
  expect(JSON.stringify(artifacts.getJson(viewRef))).not.toContain('PRIVATE');
  const campaignId = 'rho-controlled-cpu';
  const evidence = new EvidenceService(artifacts, Buffer.alloc(32, 7));
  const evidenceGrant = (principalId: string) => ({ principalId, viewDigests: [viewRef.digest],
    projections: ['overview' as const, 'task-report' as const, 'trace-chunk' as const] });
  const taskAuthority = new TaskViewAuthority(artifacts, 'rho-task-host', Buffer.alloc(32, 8));
  const taskGrant = () => ({ allowedExperienceViewDigests: [viewRef.digest] });
  const physicalRuns: Array<{ kind: ExecutionKind; revision: string; phase: string }> = [];
  const physical = (kind: ExecutionKind): PhysicalExecutionPort => {
    const implementationDigest = sha256(`controlled-physical-${kind}-v1`);
    const structuredResultSchema = { type: 'object' as const, additionalProperties: true };
    const metered = kind === 'execution.rollout';
    const manifest: ProviderManifest & { kind: ExecutionKind; structuredResultSchema?: typeof structuredResultSchema } = {
      kind, implementationDigest, execution: 'trusted-local', supportsInspect: true,
      meteredDimensions: metered ? ['rollout.trials'] : [],
      inputSchema: { type: 'object', additionalProperties: true }, outputSchema: executionResultSchema,
      ...(kind === 'execution.rollout' ? {} : { structuredResultSchema }),
    };
    const local = new LocalDurableProvider(join(stateRoot, `physical-${kind}`), manifest, (envelope: OperationEnvelope) => {
      const bound = bindings.read(envelope.bindingSetRef);
      const actualBindings = bound.slots;
      const harness = artifacts.getJson(bound.slots.harness!) as { revision: string };
      const input = envelope.input as Record<string, any>;
      let structuredResult: Record<string, any> | undefined;
      let producedArtifactRef: ArtifactRef | undefined;
      let evidenceRef: ArtifactRef;
      if (kind === 'execution.role') {
        if (input.roleId === 'rho.difficulty') {
          expect(input.history.taskReports[0].body.narrative).toMatch(/tool response|answer format/);
          expect(input.history.traceChunks[0].body.text).toMatch(/payload|parser/);
          expect(input.history.taskReports[0].readReceiptRef.kind).toBe('artifact');
        }
        structuredResult = input.roleId === 'rho.difficulty'
          ? { difficulty: input.history.taskId === 'task-1' ? 9 : 4,
              fingerprint: input.history.taskId === 'task-1' ? [1, 0] : [0, 1] }
          : { diagnosis: 'repair the bound harness' };
        evidenceRef = artifacts.putJson({ roleId: input.roleId }, 'controlled.role-evidence.v1');
      } else if (kind === 'execution.workspace-edit') {
        expect(harness.revision).toBe('baseline');
        producedArtifactRef = artifacts.putJson({ revision: 'candidate' }, 'harness.directory.v1');
        structuredResult = { edited: true };
        evidenceRef = artifacts.putJson({ editedFrom: harness.revision }, 'controlled.edit-evidence.v1');
      } else if (kind === 'execution.rollout') {
        const task = artifacts.getJson(input.task.contentRef) as { prompt: string };
        physicalRuns.push({ kind, revision: harness.revision, phase: input.recipePhase });
        evidenceRef = artifacts.putJson({ revision: harness.revision, prompt: task.prompt }, 'controlled.rollout-evidence.v1');
      } else {
        const baselineEvidence = artifacts.getJson(input.baselineEvidenceRef) as { revision: string };
        const candidateEvidence = artifacts.getJson(input.candidateEvidenceRef) as { revision: string };
        structuredResult = { preference: baselineEvidence.revision === 'baseline' && candidateEvidence.revision === 'candidate' ? 2 : -2 };
        evidenceRef = artifacts.putJson({ compared: [baselineEvidence.revision, candidateEvidence.revision] }, 'controlled.feedback-evidence.v1');
      }
      const structuredResultRef = structuredResult === undefined ? undefined
        : artifacts.putJson(structuredResult, 'controlled.structured-result.v1');
      const receiptRef = artifacts.putJson({ schemaVersion: 1, providerImplementationDigest: implementationDigest,
        operationId: envelope.operationId, inputDigest: envelope.inputDigest,
        loadedBindingSetDigest: envelope.bindingSetRef.digest, evidenceDigest: evidenceRef.digest,
        actualBindings: Object.fromEntries(Object.entries(actualBindings).map(([slot, ref]) => [slot, ref.digest])),
        executionIdentity: sha256(`physical:${envelope.operationId}`),
        ...(typeof input.samplingDigest === 'string' ? { samplingDigest: input.samplingDigest } : {}),
        ...(typeof input.environmentDigest === 'string' ? { environmentDigest: input.environmentDigest } : {}),
        ...(structuredResult ? { structuredResultDigest: jsonDigest(structuredResult) } : {}),
      }, 'execution.receipt.v1');
      const validationReceiptRef = kind === 'execution.workspace-edit'
        ? artifacts.putJson({ valid: true, producedDigest: producedArtifactRef!.digest }, 'execution.validation.v1') : undefined;
      return { outcome: { kind: 'result', value: { requestedBindingSetDigest: envelope.bindingSetRef.digest,
        actualBindings, evidenceRef, receiptRef, ...(structuredResult ? { structuredResult, structuredResultRef: structuredResultRef! } : {}),
        ...(producedArtifactRef ? { producedArtifactRef } : {}),
        ...(validationReceiptRef ? { validationReceiptRef } : {}),
      } }, ...(metered ? { receipt: { source: 'controlled.rollout', scope: 'operation' as const,
        operationId: envelope.operationId, cursor: receiptRef.digest, cumulative: { 'rollout.trials': 1 } } } : {}) };
    });
    return { describe: () => manifest, preflight: () => local.preflight(), submit: e => local.submit(e),
      inspect: e => local.inspect(e), cancel: e => local.cancel(e), collect: e => local.collect(e) };
  };
  const loaded = await loadPythonAlgorithm({ configDir: root, module: 'gear_algorithm.recipes.rho', export: 'algorithm',
    interpreter: interpreter!, sdkPath: resolve('packages/python-sdk/src') });
  try {
    const budget = { 'evidence.items': { unit: 'item', limit: 30, source: 'history.evidence', capability: 'stop' as const },
      'evidence.bytes': { unit: 'byte', limit: 100_000, source: 'history.evidence', capability: 'stop' as const },
      'rollout.trials': { unit: 'trial', limit: 3, source: 'controlled.rollout', capability: 'stop' as const } };
    const providers = [
      ...createEvidenceProviders(join(stateRoot, 'evidence'), evidence, evidenceGrant, sha256('evidence-policy'), budget),
      createTasksSelectProvider(join(stateRoot, 'select'), artifacts, taskAuthority, taskGrant, sha256('task-policy')),
      createTasksConsumeProvider(join(stateRoot, 'consume'), artifacts, taskAuthority, taskGrant, sha256('task-policy')),
      ...(['execution.role', 'execution.workspace-edit', 'execution.rollout', 'execution.feedback'] as ExecutionKind[])
        .map(kind => new VerifiedExecutionAdapter(physical(kind), artifacts, bindings, ['harness'])),
    ];
    const runtime = new AlgorithmRuntime(stateRoot, loaded.value, providers, { campaignId,
      config: { experienceViewRef: viewRef, asOf: selector.cursor, coresetSize: 1, historyPageSize: 1,
        baselineRepeats: 2, proposalCount: 1, samplingDigest: sha256('sampling'), environmentDigest: sha256('cpu'),
        operationLimits: { 'evidence.query': { 'evidence.items': 1, 'evidence.bytes': 4096 },
          'evidence.read': { 'evidence.items': 1, 'evidence.bytes': 4096 },
          'execution.rollout': { 'rollout.trials': 1 } } },
      initialBindingSetRef: baseline, budget });
    expect(await runtime.runUntilBlocked()).toBe('complete');
    const snapshot = runtime.snapshot()!;
    expect((snapshot.state as any).accepted).toBe(true);
    expect(snapshot.activeBindingSetRef.digest).not.toBe(baseline.digest);
    expect((artifacts.getJson(bindings.read(snapshot.activeBindingSetRef).slots.harness!) as any).revision).toBe('candidate');
    expect(physicalRuns.filter(item => item.phase === 'baseline').map(item => item.revision)).toEqual(['baseline', 'baseline']);
    expect(physicalRuns.filter(item => item.phase === 'candidate.0').map(item => item.revision)).toEqual(['candidate']);
    expect(snapshot.spent['evidence.items']).toBeGreaterThan(0);
    expect(snapshot.spent['rollout.trials']).toBe(3);
  } finally { await loaded.close(); }
});
