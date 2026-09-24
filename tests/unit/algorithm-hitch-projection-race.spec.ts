import { appendFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FileArtifactStore, sha256 } from '../../src/algorithm/artifacts.js';
import { BindingStore } from '../../src/algorithm/bindings.js';
import { jsonDigest } from '../../src/algorithm/schema.js';
import { FreshSeedExperienceSource } from '../../src/algorithm/data/fresh-seed.js';
import { createFreshHitchRolloutContext } from '../../src/algorithm/data/fresh-rollout-context.js';
import { sealExperienceView } from '../../src/algorithm/data/experience.js';
import { TaskViewAuthority, readTaskView, taskViewFromExperience } from '../../src/algorithm/data/tasks.js';
import { HitchRolloutPort } from '../../src/algorithm/providers/hitch.js';
import { HarnessBuilder, NoopHarnessCompiler } from '../../src/harness/builder.js';
import { createGitHarnessFixture } from '../helpers/git-fixture.js';
import { createRecordedHitchCliFixture } from '../helpers/algorithm-hitch-recorded-cli.js';
import { standardSearchDataset } from '../helpers/standard-search-dataset.js';
import { evolutionSpec } from '../helpers/research-fixture.js';
import type { OperationEnvelope } from '../../src/algorithm/contracts.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('admits concurrent repetitions after one exact dataset publication and rejects later projected-byte drift', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-hitch-projection-race-')); roots.push(root);
  const git = await createGitHarnessFixture(); roots.push(git.root);
  const seed = await standardSearchDataset(root, 2, 'seed');
  const held = await standardSearchDataset(root, 1, 'held-out');
  const base = evolutionSpec();
  const spec = { ...base, initialHarness: { ref: git.championRef, digest: git.manifest.digest },
    datasets: { seed: { ref: 'seed', digest: seed.digest }, heldOut: { ref: 'held-out', digest: held.digest } },
    rollout: { ...base.rollout, repetitions: 2 } };
  const context = await createFreshHitchRolloutContext({ spec, campaignId: 'projection-race', workspaceRoot: root,
    minRepetitions: 2 });
  const artifacts = new FileArtifactStore(join(root, 'artifacts'));
  const source = new FreshSeedExperienceSource({ spec, campaignId: 'projection-race', workspaceRoot: root,
    authorityId: 'projection-host' });
  const experience = await sealExperienceView(artifacts, source, await source.selector(), 'research', ['overview', 'task-report']);
  const taskRef = taskViewFromExperience(artifacts, experience, [{ id: 'task-1', purpose: 'development' }]);
  const authority = new TaskViewAuthority(artifacts, 'projection-host', Buffer.alloc(32, 4));
  const signedTaskRef = authority.seal(readTaskView(artifacts, taskRef));
  const task = readTaskView(artifacts, signedTaskRef).tasks[0]!;
  const bindings = new BindingStore(artifacts, { id: 'projection.bindings.v1', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true } } });
  const harness = artifacts.putJson({ schemaVersion: 1, kind: 'git-harness', commitOid: git.championRef,
    manifestDigest: git.manifest.digest }, 'harness.directory.v1');
  const bindingSetRef = bindings.create({ harness });
  const builder = new HarnessBuilder({ repositoryPath: git.repository, targetRoot: git.targetRoot,
    dshBaseRef: git.baseRef, toolchainRef: 'node-22-tsc', sandboxProfileRef: 'sandbox-v1',
    compiler: new NoopHarnessCompiler() });
  const recorded = await createRecordedHitchCliFixture('0.2.8', {},
    { followSubmission: true, controlPlane: { mode: 'daemon', requireModelCapture: false } }, git);
  const stateRoot = join(root, 'state');
  const port = await HitchRolloutPort.create({ freshContext: context, workspaceRoot: root, stateRoot,
    artifacts, bindings, taskAuthority: authority, allowedExperienceViewDigests: () => [experience.digest],
    accessPolicyDigest: sha256('projection-policy'), builder, evaluator: recorded.evaluator,
    campaignBudget: { 'rollout.trials': { unit: 'trials', limit: 12, source: 'hitch-rollout', capability: 'hard' } } });
  const envelopes: OperationEnvelope[] = Array.from({ length: 12 }, (_, index) => {
    const input = { task, taskViewRef: signedTaskRef, repeatIndex: index % 2,
      ...port.profile(), recipePhase: 'rho.baseline' };
    const operationId = sha256(`projection-race-${index}`);
    return { operationId, idempotencyKey: operationId, campaignId: 'projection-race', decisionIndex: index,
      localKey: `rollout-${index}`, kind: 'execution.rollout', input, inputDigest: jsonDigest(input),
      implementationDigest: port.describe().implementationDigest, bindingSetRef, limits: { 'rollout.trials': 1 } };
  });
  await Promise.all(envelopes.map(envelope => port.preflight(envelope)));
  const published = await readdir(join(stateRoot, 'datasets'));
  expect(published).toHaveLength(1);
  const priorConcurrent = recorded.evaluator.options.maxConcurrent;
  try {
    recorded.evaluator.options.maxConcurrent = priorConcurrent + 1;
    await expect(port.preflight(envelopes[0]!)).rejects.toThrow(/evaluator, builder, or subprocess environment drift/u);
  } finally { recorded.evaluator.options.maxConcurrent = priorConcurrent; }
  const priorToolchain = builder.options.toolchainRef;
  try {
    builder.options.toolchainRef = 'mutated-toolchain';
    await expect(port.preflight(envelopes[0]!)).rejects.toThrow(/evaluator, builder, or subprocess environment drift/u);
  } finally { builder.options.toolchainRef = priorToolchain; }
  const unlistedVariable = 'GEAR_ALGORITHM_UNLISTED_HITCH_TEST';
  expect(recorded.evaluator.options.passEnv).not.toContain(unlistedVariable);
  const previous = process.env[unlistedVariable];
  try {
    process.env[unlistedVariable] = 'changed-after-admission';
    await expect(port.preflight(envelopes[0]!)).rejects.toThrow(/evaluator, builder, or subprocess environment drift/u);
  } finally {
    if (previous === undefined) delete process.env[unlistedVariable];
    else process.env[unlistedVariable] = previous;
  }
  await appendFile(join(stateRoot, 'datasets', published[0]!, 'task-1', 'task.toml'), '\n# damaged after publication\n');
  await expect(port.preflight(envelopes[0]!)).rejects.toThrow(/prepared task content changed/u);
});
