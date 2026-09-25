import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FileArtifactStore } from '../../src/algorithm/artifacts.js';
import type { OperationProvider } from '../../src/algorithm/contracts.js';
import { readExperienceView } from '../../src/algorithm/data/experience.js';
import { readTaskView } from '../../src/algorithm/data/tasks.js';
import { createFreshRecipeHostProfile } from '../../src/algorithm/fresh-profile.js';
import { HarnessBuilder, NoopHarnessCompiler } from '../../src/harness/builder.js';
import { createGitHarnessFixture } from '../helpers/git-fixture.js';
import { createRecordedHitchCliFixture } from '../helpers/algorithm-hitch-recorded-cli.js';
import { standardSearchDataset } from '../helpers/standard-search-dataset.js';
import { evolutionSpec } from '../helpers/research-fixture.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function declaredPhysical(kind: string): OperationProvider {
  return {
    describe: () => ({ kind, implementationDigest: 'sha256:' + 'a'.repeat(64),
      execution: 'trusted-local', supportsInspect: true, meteredDimensions: [],
      inputSchema: { type: 'any' }, outputSchema: { type: 'any' } }),
    preflight: () => undefined,
    submit: async () => ({ status: 'running' }),
    inspect: async () => ({ status: 'not-started' }),
    cancel: async () => ({ status: 'cancelled', releaseConfirmed: true }),
    collect: async () => { throw new Error('Recorded profile test does not execute a model role'); },
  };
}

it('assembles a physical fresh-seed host and freezes real managed refs into AHE config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-fresh-profile-')); roots.push(root);
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
  const context = { campaignId: 'fresh-profile', configDir: root, stateDir: join(root, 'state'),
    config: { taskCount: 1, rounds: 2, rolloutsPerTask: 2 },
    budget: { 'rollout.trials': { unit: 'trials', source: 'hitch-rollout', limit: 8, capability: 'hard' as const },
      'evidence.items': { unit: 'items', source: 'evidence-service', limit: 100, capability: 'stop' as const },
      'evidence.bytes': { unit: 'bytes', source: 'evidence-service', limit: 100_000, capability: 'stop' as const } },
    artifacts: new FileArtifactStore(join(root, 'artifacts')) };
  let closed = 0;
  const options = { recipe: 'ahe' as const, spec, workspaceRoot: root, authorityId: 'fresh-host',
    builder, evaluator: recorded.evaluator,
    operationLimits: { 'execution.rollout': { 'rollout.trials': 1 },
      'evidence.query': { 'evidence.items': 10, 'evidence.bytes': 10_000 },
      'evidence.read': { 'evidence.items': 10, 'evidence.bytes': 10_000 } },
    allowedTaskIds: ['task-0'],
    physicalHost: () => ({ providers: ['execution.role', 'execution.feedback', 'execution.workspace-edit']
      .map(declaredPhysical), close: () => { closed++; } }) };
  const profile = await createFreshRecipeHostProfile(context, options);
  const config = profile.config as Record<string, any>;
  const view = readExperienceView(context.artifacts, config.experienceViewRef);
  expect(view.entries).toHaveLength(2);
  expect(view.entries[0]?.taskId).toBe('task-0');
  const taskView = readTaskView(context.artifacts, config.taskViewRef);
  expect(taskView.tasks.map(task => task.id)).toEqual(['task-0']);
  expect(config.asOf).toEqual(view.source.cursor);
  expect(config.samplingDigest).toMatch(/^sha256:/);
  expect(config.environmentDigest).toMatch(/^sha256:/);
  expect(profile.bindings?.harness).toBeDefined();
  expect(context.artifacts.getJson(profile.bindings!.harness!)).toMatchObject({
    kind: 'git-harness', commitOid: git.championRef, manifestDigest: git.manifest.digest });
  expect(profile.providers.map(provider => provider.describe().kind)).toContain('execution.rollout');
  await profile.close?.();
  expect(closed).toBe(1);

  await writeFile(join(root, 'seed/task-0/instruction.md'), 'changed instruction after frozen capture\n');
  expect(readExperienceView(context.artifacts, config.experienceViewRef)).toEqual(view);
  await expect(createFreshRecipeHostProfile(context, options)).rejects.toThrow(/dataset|source|changed/iu);
});

it('rejects missing physical edit capability and closes the partially assembled host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-fresh-profile-missing-')); roots.push(root);
  const git = await createGitHarnessFixture(); roots.push(git.root);
  const seed = await standardSearchDataset(root, 1, 'seed');
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
  let closed = false;
  await expect(createFreshRecipeHostProfile({ campaignId: 'missing-edit', configDir: root,
    stateDir: join(root, 'state'), config: { coresetSize: 1, historyPageSize: 1,
      baselineRepeats: 2, proposalCount: 1 },
    budget: { 'rollout.trials': { unit: 'trials', source: 'hitch-rollout', limit: 4,
      capability: 'hard' } }, artifacts: new FileArtifactStore(join(root, 'artifacts')) },
  { recipe: 'rho', spec, workspaceRoot: root, authorityId: 'fresh-host', builder,
    evaluator: recorded.evaluator, operationLimits: { 'execution.rollout': { 'rollout.trials': 1 } },
    physicalHost: () => ({ providers: ['execution.role', 'execution.feedback'].map(declaredPhysical),
      close: () => { closed = true; } }) })).rejects.toThrow('execution.workspace-edit');
  expect(closed).toBe(true);
});
