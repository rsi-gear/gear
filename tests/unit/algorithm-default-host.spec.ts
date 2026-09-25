import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, expect, it } from 'vitest';
import { FileArtifactStore, sha256 } from '../../src/algorithm/artifacts.js';
import { BindingStore } from '../../src/algorithm/bindings.js';
import type { OperationEnvelope } from '../../src/algorithm/contracts.js';
import { readTaskView } from '../../src/algorithm/data/tasks.js';
import { createDefaultFreshHostProfile } from '../../src/algorithm/default-host.js';
import type { ExecutionResult } from '../../src/algorithm/providers/execution.js';
import { jsonDigest } from '../../src/algorithm/schema.js';
import { CandidateWorkspaceManager } from '../../src/candidate/workspace.js';
import { HarnessBuilder, NoopHarnessCompiler } from '../../src/harness/builder.js';
import { createGitHarnessFixture } from '../helpers/git-fixture.js';
import { createRecordedHitchCliFixture } from '../helpers/algorithm-hitch-recorded-cli.js';
import { standardSearchDataset } from '../helpers/standard-search-dataset.js';
import { evolutionSpec, metaAgent } from '../helpers/research-fixture.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function resources(recipe: 'ahe' | 'evo') {
  const root = await mkdtemp(join(tmpdir(), 'gear-default-host-')); roots.push(root);
  const git = await createGitHarnessFixture(); roots.push(git.root);
  const seed = await standardSearchDataset(root, 2, 'seed');
  const held = await standardSearchDataset(root, 1, 'held-out');
  const base = evolutionSpec();
  const spec = { ...base, initialHarness: { ref: git.championRef, digest: git.manifest.digest },
    datasets: { seed: { ref: 'seed', digest: seed.digest }, heldOut: { ref: 'held-out', digest: held.digest } },
    rollout: { ...base.rollout, repetitions: 2 } };
  const builder = new HarnessBuilder({ repositoryPath: git.repository, targetRoot: git.targetRoot,
    dshBaseRef: git.baseRef, toolchainRef: 'node-22-tsc', sandboxProfileRef: 'sandbox-v1',
    compiler: new NoopHarnessCompiler() });
  const recorded = await createRecordedHitchCliFixture('0.2.8', {},
    { followSubmission: true, controlPlane: { mode: 'daemon', requireModelCapture: false } }, git);
  const workspaceManager = new CandidateWorkspaceManager({ repositoryPath: git.repository,
    targetRoot: git.targetRoot, rootForEvolution: id => join(root, 'workspaces', id),
    maxFiles: 10, maxBytes: 200_000, maxDiffBytes: 200_000 });
  const budget = { 'rollout.trials': { unit: 'trials', source: 'hitch-rollout', limit: 12,
    capability: 'hard' as const },
  'model.requests': { unit: 'requests', source: 'dsh-generation', limit: 10, capability: 'hard' as const },
  'model.tokens': { unit: 'tokens', source: 'dsh-generation', limit: 5_000, capability: 'stop' as const },
  'evidence.items': { unit: 'items', source: 'dsh-generation', limit: 100, capability: 'stop' as const },
  'evidence.bytes': { unit: 'bytes', source: 'dsh-generation', limit: 100_000, capability: 'stop' as const } };
  const context = { campaignId: `default-${recipe}`, configDir: root, stateDir: join(root, 'state'),
    config: recipe === 'ahe' ? { taskCount: 1, rounds: 2, rolloutsPerTask: 2 }
      : { batchSize: 1, injectionBudget: 1 }, budget,
    artifacts: new FileArtifactStore(join(root, 'state', 'artifacts')) };
  const role = (id: string) => ({ id, spec: metaAgent(), instruction: `Offline ${id} fixture`,
    maxModelRequests: 1, maxTokens: 500, timeoutMs: 20_000,
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: true },
    resultSchema: { type: 'object' as const, properties: {}, additionalProperties: true } });
  const editor = (id: string) => ({ id, spec: metaAgent(), instruction: `Offline ${id} fixture`,
    maxModelRequests: 1, maxTokens: 500, timeoutMs: 20_000 });
  const limits = { 'execution.rollout': { 'rollout.trials': 1 },
    'execution.role': { 'model.requests': 1, 'model.tokens': 500,
      'evidence.items': 20, 'evidence.bytes': 20_000 },
    'execution.workspace-edit': { 'model.requests': 1, 'model.tokens': 500,
      'evidence.items': 20, 'evidence.bytes': 20_000 },
    'evidence.query': { 'evidence.items': 20, 'evidence.bytes': 20_000 },
    'evidence.read': { 'evidence.items': 20, 'evidence.bytes': 20_000 } };
  const shared = { recipe, spec, workspaceRoot: root, authorityId: 'default-host',
    builder, evaluator: recorded.evaluator, operationLimits: limits,
    dshContext: new Context(), workspaceManager,
    roleDefinitions: recipe === 'ahe' ? [role('ahe.attributor')]
      : [role('evo.retriever'), role('evo.proposer'), role('evo.curator')],
    workspaceEditRoles: recipe === 'ahe' ? [editor('ahe.evolver'), editor('ahe.rollback')] : [],
    modelRuntimeDigest: sha256('configured-offline-model'),
    currentModelRuntimeDigest: () => sha256('configured-offline-model'),
    modelDisclosurePolicyDigest: sha256('configured-destination-policy'),
    currentModelDisclosurePolicyDigest: () => sha256('configured-destination-policy'),
    authorizeModelRole: () => undefined,
    passThreshold: 0.5 };
  return { context, shared, role };
}

it('assembles AHE real seed/Hitch/role/edit/trusted-feedback providers from one host setup', async () => {
  const { context, shared } = await resources('ahe');
  let closed = 0;
  const profile = await createDefaultFreshHostProfile(context, { ...shared, closeHost: () => { closed++; } });
  expect(profile.providers.map(provider => provider.describe().kind)).toEqual([
    'evidence.query', 'evidence.read', 'tasks.select', 'tasks.consume',
    'execution.rollout', 'execution.role', 'execution.feedback', 'execution.workspace-edit']);
  const config = profile.config as Record<string, any>;
  expect(readTaskView(context.artifacts, config.taskViewRef).tasks).toHaveLength(1);
  expect(config.samplingDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(config.operationLimits['execution.rollout']).toEqual({ 'rollout.trials': 1 });
  expect(profile.bindings?.harness?.schemaId).toBe('harness.directory.v1');
  await profile.close?.();
  expect(closed).toBe(1);
});

it('closes an allocated DSH host exactly once when role admission fails', async () => {
  const { context, shared } = await resources('ahe');
  let closed = 0;
  await expect(createDefaultFreshHostProfile(context, { ...shared, roleDefinitions: [],
    closeHost: () => { closed++; } })).rejects.toThrow('Science role catalog must declare exactly');
  expect(closed).toBe(1);
});

it('assembles Evo with a host-owned Skill library, physical overlay and trusted feedback', async () => {
  const { context, shared } = await resources('evo');
  const policyDigest = sha256('explicit-skill-destination-grant');
  const profile = await createDefaultFreshHostProfile(context, { ...shared,
    evoSkillDisclosure: { policyDigest, currentPolicyDigest: () => policyDigest,
      authorize: () => undefined } });
  expect(profile.providers.map(provider => provider.describe().kind)).toEqual([
    'evidence.query', 'evidence.read', 'tasks.select', 'tasks.consume',
    'execution.rollout', 'execution.role', 'execution.feedback']);
  expect(profile.providers.some(provider => provider.describe().kind === 'execution.workspace-edit')).toBe(false);
  expect(profile.bindings?.harness?.schemaId).toBe('harness.directory.v1');
  expect(context.artifacts.getJson(profile.bindings!.skills!)).toEqual({ schemaVersion: 1, skills: [] });
  const config = profile.config as Record<string, any>;
  expect(readTaskView(context.artifacts, config.taskViewRef).tasks.map(task => task.purpose)).toEqual(['train', 'train']);
  expect(config).not.toHaveProperty('experienceViewRef');
  expect(config.operationLimits).not.toHaveProperty('evidence.query');
  expect(config.operationLimits).not.toHaveProperty('evidence.read');
  const bindings = new BindingStore(context.artifacts, { id: 'evo.bindings.v1', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true, replaceable: false },
    skills: { schemaId: 'skills.library.v1', required: true, replaceable: true } } });
  const bindingSetRef = bindings.create(profile.bindings!);
  const task = readTaskView(context.artifacts, config.taskViewRef).tasks[1]!;
  const rollout = profile.providers.find(provider => provider.describe().kind === 'execution.rollout')!;
  const rolloutInput = { task, taskViewRef: config.taskViewRef,
    samplingDigest: config.samplingDigest, environmentDigest: config.environmentDigest,
    recipePhase: 'evo.batch', skillBindingSetDigest: bindingSetRef.digest, injectedSkillRefs: [] };
  const rolloutId = sha256('default-evo-physical-rollout');
  const rolloutEnvelope: OperationEnvelope = { operationId: rolloutId, idempotencyKey: rolloutId,
    campaignId: context.campaignId, decisionIndex: 0, localKey: 'rollout', kind: 'execution.rollout',
    input: rolloutInput, inputDigest: jsonDigest(rolloutInput),
    implementationDigest: rollout.describe().implementationDigest,
    bindingSetRef, limits: { 'rollout.trials': 1 } };
  expect((await rollout.submit(rolloutEnvelope)).status).toBe('running');
  const inspected = await rollout.inspect(rolloutEnvelope);
  expect(inspected.status).toBe('completed');
  if (inspected.status !== 'completed' || inspected.completion.outcome.kind !== 'result')
    throw new Error('Recorded Evo rollout did not complete');
  const physical = inspected.completion.outcome.value as unknown as ExecutionResult;
  expect(context.artifacts.getJson(physical.receiptRef)).toMatchObject({ injectedSkillDigests: [],
    skillOverlayReceiptRef: { schemaId: 'skills.overlay.receipt.v1' } });
  const feedback = profile.providers.find(provider => provider.describe().kind === 'execution.feedback')!;
  const feedbackInput = { mode: 'evo.task-feedback', task, taskViewRef: config.taskViewRef,
    rolloutEvidenceRef: physical.evidenceRef, authorizedRollouts: [{ evidenceRef: physical.evidenceRef,
      receiptRef: physical.receiptRef }], injectedSkillRefs: [] };
  const feedbackId = sha256('default-evo-trusted-feedback');
  const feedbackEnvelope: OperationEnvelope = { operationId: feedbackId, idempotencyKey: feedbackId,
    campaignId: context.campaignId, decisionIndex: 1, localKey: 'feedback', kind: 'execution.feedback',
    input: feedbackInput, inputDigest: jsonDigest(feedbackInput),
    implementationDigest: feedback.describe().implementationDigest, bindingSetRef, limits: {} };
  const scored = await feedback.submit(feedbackEnvelope);
  expect(scored.status).toBe('completed');
  if (scored.status !== 'completed' || scored.completion.outcome.kind !== 'result')
    throw new Error('Trusted Evo feedback did not complete');
  expect(scored.completion.outcome.value).toMatchObject({ structuredResult: { score: expect.any(Number),
    passed: expect.any(Boolean) } });
});
