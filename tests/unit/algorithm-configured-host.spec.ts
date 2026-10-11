import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FileArtifactStore, sha256 } from '../../src/algorithm/artifacts.js';
import { BindingStore } from '../../src/algorithm/bindings.js';
import { createConfiguredFreshHostProfile } from '../../src/algorithm/configured-host.js';
import { LlmAdapter } from '../../src/algorithm/dsh-host.js';
import type { OperationEnvelope } from '../../src/algorithm/contracts.js';
import { jsonDigest } from '../../src/algorithm/schema.js';
import { createGitHarnessFixture } from '../helpers/git-fixture.js';
import { createMultiRecordedHitchCliFixture } from '../helpers/algorithm-hitch-multi-cli.js';
import { standardSearchDataset } from '../helpers/standard-search-dataset.js';
import { evolutionSpec } from '../helpers/research-fixture.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('assembles a physical fresh host from closed JSON and rejects changed model source before a role turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-configured-host-')); roots.push(root);
  const git = await createGitHarnessFixture(); roots.push(git.root);
  const seed = await standardSearchDataset(root, 2, 'seed');
  const held = await standardSearchDataset(root, 1, 'held-out');
  const base = evolutionSpec();
  const spec = { ...base, initialHarness: { ref: git.championRef, digest: git.manifest.digest },
    datasets: { seed: { ref: 'seed', digest: seed.digest }, heldOut: { ref: 'held', digest: held.digest } },
    rollout: { ...base.rollout, repetitions: 2 } };
  const recorded = await createMultiRecordedHitchCliFixture(git);
  const roles = Object.fromEntries(['rho.difficulty', 'rho.diagnoser', 'rho.self-preference', 'rho.optimizer']
    .map(id => [id, { instruction: `Recorded ${id}`, maxModelRequests: 3, maxTokens: 5000,
      timeoutMs: 20_000 }]));
  const settings = { schemaVersion: 1, recipe: 'rho', spec, workspaceRoot: root,
    authorityId: 'configured-host', builder: { repositoryPath: git.repository,
      targetRoot: git.targetRoot, dshBaseRef: git.baseRef, toolchainRef: 'node-22-tsc',
      sandboxProfileRef: 'sandbox-v1' },
    compiler: { command: '/usr/bin/true', sandboxMode: 'disabled' },
    hitch: recorded.evaluator.options,
    workspace: { repositoryPath: git.repository, targetRoot: git.targetRoot,
      maxFiles: 10, maxBytes: 200_000, maxDiffBytes: 200_000 },
    operationLimits: { 'execution.rollout': { 'rollout.trials': 1 },
      'execution.role': { 'model.requests': 3, 'model.tokens': 5000, 'evidence.items': 20, 'evidence.bytes': 20000 },
      'execution.feedback': { 'model.requests': 3, 'model.tokens': 5000, 'evidence.items': 20, 'evidence.bytes': 20000 },
      'execution.workspace-edit': { 'model.requests': 3, 'model.tokens': 5000 },
      'evidence.query': { 'evidence.items': 20, 'evidence.bytes': 20000 },
      'evidence.read': { 'evidence.items': 20, 'evidence.bytes': 20000 } },
    roles, runtimeResources: ['./tool-helper.js'],
    modelDestination: { id: 'recorded-p/m', module: './model.mjs', provider: 'p', model: 'm' } };
  const settingsPath = join(root, 'host.settings.json'), modulePath = join(root, 'model.mjs');
  const resourcePath = join(root, 'tool-helper.js');
  await writeFile(settingsPath, JSON.stringify(settings));
  await writeFile(modulePath, 'export const destination = "recorded-p/m";\n');
  await writeFile(resourcePath, 'export const version = 1;\n');
  const budget = { 'rollout.trials': { unit: 'trials', source: 'hitch-rollout', limit: 4, capability: 'hard' as const },
    'model.requests': { unit: 'requests', source: 'dsh-generation', limit: 30, capability: 'hard' as const },
    'model.tokens': { unit: 'tokens', source: 'dsh-generation', limit: 100_000, capability: 'stop' as const },
    'evidence.items': { unit: 'items', source: 'dsh-generation', limit: 100, capability: 'stop' as const },
    'evidence.bytes': { unit: 'bytes', source: 'dsh-generation', limit: 100_000, capability: 'stop' as const } };
  const context = { campaignId: 'configured-rho', configDir: root, stateDir: join(root, 'state'),
    config: { coresetSize: 1, historyPageSize: 2, baselineRepeats: 2, proposalCount: 1 },
    budget, artifacts: new FileArtifactStore(join(root, 'state', 'artifacts')) };
  class RecordedAdapter extends LlmAdapter {
    async *stream(): AsyncGenerator<never> { throw new Error('Admission fixture cannot perform a model call'); }
  }
  await expect(createConfiguredFreshHostProfile(context, { settingsPath: 'host.settings.json',
    registerModel: () => ({ destinationId: 'recorded-p/m', currentDestinationId: () => 'recorded-p/m' }) }))
    .rejects.toThrow('no registered DSH adapter');
  const profile = await createConfiguredFreshHostProfile(context, { settingsPath: 'host.settings.json',
    registerModel: llm => { llm.registerAdapter(['p'], new RecordedAdapter());
      return { destinationId: 'recorded-p/m', currentDestinationId: () => 'recorded-p/m' }; } });
  try {
    expect(profile.providers.map(provider => provider.describe().kind)).toContain('execution.workspace-edit');
    expect((profile.config as Record<string, unknown>).historyTraceAvailable).toBe(false);
    const bindings = new BindingStore(context.artifacts, { id: 'rho.bindings.v1',
      slots: { harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true } } });
    const bindingSetRef = bindings.create(profile.bindings!);
    const provider = profile.providers.find(item => item.describe().kind === 'execution.role')!;
    const input = { roleId: 'rho.difficulty' };
    const operationId = sha256('configured-model-drift');
    const envelope: OperationEnvelope = { operationId, idempotencyKey: operationId,
      campaignId: context.campaignId, decisionIndex: 0, localKey: 'difficulty', kind: 'execution.role',
      input, inputDigest: jsonDigest(input), implementationDigest: provider.describe().implementationDigest,
      bindingSetRef, limits: { 'model.requests': 3, 'model.tokens': 5000,
        'evidence.items': 20, 'evidence.bytes': 20000 } };
    await provider.preflight(envelope);
    await writeFile(modulePath, (await readFile(modulePath, 'utf8')) + '// drift\n');
    await expect(provider.preflight(envelope)).rejects.toThrow('host runtime identity drift');
    await writeFile(modulePath, 'export const destination = "recorded-p/m";\n');
    await writeFile(resourcePath, 'export const version = 2;\n');
    await expect(provider.preflight(envelope)).rejects.toThrow('host runtime identity drift');
  } finally { await profile.close?.(); }
});
