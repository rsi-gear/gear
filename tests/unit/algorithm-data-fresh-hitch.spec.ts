import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileArtifactStore, sha256 } from '../../src/algorithm/artifacts.js';
import { BindingStore } from '../../src/algorithm/bindings.js';
import { jsonDigest } from '../../src/algorithm/schema.js';
import { FreshSeedExperienceSource } from '../../src/algorithm/data/fresh-seed.js';
import { createFreshHitchRolloutContext } from '../../src/algorithm/data/fresh-rollout-context.js';
import { sealExperienceView } from '../../src/algorithm/data/experience.js';
import { TaskViewAuthority, readTaskView, taskViewFromExperience } from '../../src/algorithm/data/tasks.js';
import { createHitchRolloutAdapter, HitchRolloutPort } from '../../src/algorithm/providers/hitch.js';
import { HarnessBuilder, NoopHarnessCompiler } from '../../src/harness/builder.js';
import { createGitHarnessFixture } from '../helpers/git-fixture.js';
import { createRecordedHitchCliFixture } from '../helpers/algorithm-hitch-recorded-cli.js';
import { standardSearchDataset } from '../helpers/standard-search-dataset.js';
import { evolutionSpec } from '../helpers/research-fixture.js';
import type { OperationEnvelope } from '../../src/algorithm/contracts.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('fresh Hitch physical rollout context', () => {
  it('runs a synthetic compiled task through the real recorded daemon CLI without a registry or old round', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gear-fresh-hitch-')); roots.push(root);
    const git = await createGitHarnessFixture(); roots.push(git.root);
    const seed = await standardSearchDataset(root, 2, 'seed');
    const held = await standardSearchDataset(root, 1, 'held-out');
    const base = evolutionSpec();
    const spec = { ...base, initialHarness: { ref: git.championRef, digest: git.manifest.digest },
      datasets: { seed: { ref: 'seed', digest: seed.digest }, heldOut: { ref: 'held-out', digest: held.digest } },
      rollout: { ...base.rollout, repetitions: 2 } };
    await expect(createFreshHitchRolloutContext({ spec, campaignId: 'fresh-campaign', workspaceRoot: root,
      minRepetitions: 3 })).rejects.toThrow(/repetitions/u);
    const context = await createFreshHitchRolloutContext({ spec, campaignId: 'fresh-campaign', workspaceRoot: root,
      minRepetitions: 2 });
    expect(context.round.plan.seed.repetitions).toBe(2);
    expect(context.round.candidatePool).toEqual([]);
    const artifacts = new FileArtifactStore(join(root, 'artifacts'));
    const source = new FreshSeedExperienceSource({ spec, campaignId: 'fresh-campaign', workspaceRoot: root,
      authorityId: 'fresh-host' });
    const viewRef = await sealExperienceView(artifacts, source, await source.selector(), 'research', ['overview', 'task-report']);
    const taskRef = taskViewFromExperience(artifacts, viewRef, [{ id: 'task-1', purpose: 'development' }]);
    const authority = new TaskViewAuthority(artifacts, 'fresh-task-host', Buffer.alloc(32, 4));
    const signedTaskViewRef = authority.seal(readTaskView(artifacts, taskRef));
    const task = readTaskView(artifacts, signedTaskViewRef).tasks[0]!;
    const bindings = new BindingStore(artifacts, { id: 'rho.bindings.v1', slots: {
      harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true } } });
    const harness = artifacts.putJson({ schemaVersion: 1, kind: 'git-harness', commitOid: git.championRef,
      manifestDigest: git.manifest.digest }, 'harness.directory.v1');
    const bindingSetRef = bindings.create({ harness });
    const builder = new HarnessBuilder({ repositoryPath: git.repository, targetRoot: git.targetRoot,
      dshBaseRef: git.baseRef, toolchainRef: 'node-22-tsc', sandboxProfileRef: 'sandbox-v1',
      compiler: new NoopHarnessCompiler() });
    const recorded = await createRecordedHitchCliFixture('0.2.8', {},
      { followSubmission: true, controlPlane: { mode: 'daemon', requireModelCapture: false } }, git);
    const options = { freshContext: context, workspaceRoot: root, stateRoot: join(root, 'algorithm-state'),
      artifacts, bindings, taskAuthority: authority, allowedExperienceViewDigests: () => [viewRef.digest],
      accessPolicyDigest: sha256('fresh-task-policy'), builder, evaluator: recorded.evaluator,
      campaignBudget: { 'rollout.trials': { unit: 'trials', limit: 5, source: 'hitch-rollout', capability: 'hard' as const } } };
    const port = await HitchRolloutPort.create(options);
    const adapter = await createHitchRolloutAdapter(options);
    const input = { task, taskViewRef: signedTaskViewRef, repeatIndex: 1,
      samplingDigest: port.profile().samplingDigest, environmentDigest: port.profile().environmentDigest,
      recipePhase: 'rho.baseline' };
    const envelope: OperationEnvelope = { operationId: sha256('fresh-hitch-op'), idempotencyKey: sha256('fresh-hitch-op'),
      campaignId: 'fresh-campaign', decisionIndex: 0, localKey: 'rollout', kind: 'execution.rollout',
      input, inputDigest: jsonDigest(input), implementationDigest: adapter.describe().implementationDigest,
      bindingSetRef, limits: { 'rollout.trials': 1 } };
    expect((await adapter.submit(envelope)).status).toBe('running');
    const completed = await adapter.inspect(envelope);
    expect(completed.status).toBe('completed');
    if (completed.status !== 'completed') throw new Error('fresh physical rollout incomplete');
    expect(completed.completion.receipt?.cumulative).toEqual({ 'rollout.trials': 1 });
    const reopened = await createHitchRolloutAdapter(options);
    expect((await reopened.inspect(envelope)).status).toBe('completed');
  });
});
