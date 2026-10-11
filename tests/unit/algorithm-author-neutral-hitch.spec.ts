import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FileArtifactStore, sha256 } from '../../src/algorithm/artifacts.js';
import { BindingStore } from '../../src/algorithm/bindings.js';
import { jsonDigest, type JsonValue } from '../../src/algorithm/schema.js';
import { digestJson } from '../../src/state/digest.js';
import { TaskViewAuthority, readTaskView } from '../../src/algorithm/data/tasks.js';
import { HitchRolloutPort, createHitchRolloutAdapter,
  type AuthorHitchRolloutPlanV1 } from '../../src/algorithm/providers/hitch.js';
import { HarnessBuilder, NoopHarnessCompiler } from '../../src/harness/builder.js';
import { inspectStandardCompiledDatasetV1 } from '../../src/search/compiled-dataset-v1.js';
import { createGitHarnessFixture } from '../helpers/git-fixture.js';
import { createRecordedHitchCliFixture } from '../helpers/algorithm-hitch-recorded-cli.js';
import { standardSearchDataset } from '../helpers/standard-search-dataset.js';
import type { OperationEnvelope } from '../../src/algorithm/contracts.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('uses an author plan without EvolutionSpec/Round and reads the completed physical journal without dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-author-neutral-hitch-')); roots.push(root);
  const git = await createGitHarnessFixture(); roots.push(git.root);
  const dataset = await standardSearchDataset(root, 2, 'search');
  const source = await inspectStandardCompiledDatasetV1(dataset.ref);
  const artifacts = new FileArtifactStore(join(root, 'artifacts'));
  const experienceDigest = sha256('verified-author-search-source');
  const taskEntries = source.tasks.map(task => ({ id: task.id,
    contentRef: artifacts.putJson({ prompt: `Do ${task.id}`, executionSource: {
      kind: 'compiled-author-dataset', datasetDigest: source.sourceDigest,
      taskContentDigest: task.contentDigest } }, 'experience.task.v1'),
    purpose: 'development' as const, exposure: { seenInTraining: false, graderLabelExposed: false },
    ancestry: [] as string[] }));
  const authority = new TaskViewAuthority(artifacts, 'author-task-host', Buffer.alloc(32, 6));
  const taskViewRef = authority.seal({ schemaVersion: 1, sourceExperienceViewDigest: experienceDigest,
    tasks: taskEntries });
  const task = readTaskView(artifacts, taskViewRef).tasks[0]!;
  const bindings = new BindingStore(artifacts, { id: 'author.bindings.v1', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true } } });
  const harness = artifacts.putJson({ schemaVersion: 1, kind: 'git-harness', commitOid: git.championRef,
    manifestDigest: git.manifest.digest }, 'harness.directory.v1');
  const bindingSetRef = bindings.create({ harness });
  const builder = new HarnessBuilder({ repositoryPath: git.repository, targetRoot: git.targetRoot,
    dshBaseRef: git.baseRef, toolchainRef: 'node-22-tsc', sandboxProfileRef: 'sandbox-v1',
    compiler: new NoopHarnessCompiler() });
  const recorded = await createRecordedHitchCliFixture('0.2.8', { tasks: ['task-0'],
    trials: [{ taskId: 'task-0', attempt: 1 }] },
    { followSubmission: true, controlPlane: { mode: 'daemon', requireModelCapture: false } }, git);
  const plan: AuthorHitchRolloutPlanV1 = { schemaVersion: 1, kind: 'author.hitch-plan.v1',
    campaignId: 'author-campaign', workspaceRoot: root, datasetRoot: source.root,
    datasetDigest: source.sourceDigest, taskIds: source.tasks.map(item => item.id), repetitions: 2,
    taskBudgetMs: 60_000, sandboxProfileRef: 'sandbox-v1', model: recorded.evaluator.options.model,
    rolloutProviderDigest: digestJson({ provider: 'hitch-cli', version: '0.2.8' }),
    recipePhase: 'author.evaluate', allowedExperienceViewDigests: [experienceDigest] };
  const options = { authorPlan: plan, workspaceRoot: root, stateRoot: join(root, 'algorithm-state'),
    artifacts, bindings, taskAuthority: authority, allowedExperienceViewDigests: () => [experienceDigest],
    accessPolicyDigest: sha256('author-task-policy'), builder, evaluator: recorded.evaluator,
    campaignBudget: { 'rollout.trials': { unit: 'trials', limit: 4, source: 'hitch-rollout', capability: 'hard' as const } } };
  const port = await HitchRolloutPort.create(options);
  const adapter = await createHitchRolloutAdapter(options);
  const input = { task, taskViewRef, repeatIndex: 1,
    samplingDigest: port.profile().samplingDigest, environmentDigest: port.profile().environmentDigest,
    recipePhase: 'author.evaluate' };
  const operationId = sha256('author-neutral-operation');
  const envelope: OperationEnvelope = { operationId, idempotencyKey: operationId,
    campaignId: 'author-campaign', decisionIndex: 0, localKey: 'rollout', kind: 'execution.rollout',
    input, inputDigest: jsonDigest(input), implementationDigest: adapter.describe().implementationDigest,
    bindingSetRef, limits: { 'rollout.trials': 1 } };
  expect(await port.readAuthorRolloutJournal(sha256('missing-author-operation'))).toBeUndefined();
  expect((await adapter.submit(envelope)).status).toBe('running');
  expect(await port.readAuthorRolloutJournal(operationId)).toMatchObject({ status: 'reserved',
    request: { phase: 'author-candidate' } });
  expect((await adapter.inspect(envelope)).status).toBe('completed');
  const callsBefore = (await readFile(recorded.invocationLog, 'utf8')).trim().split('\n').length;
  const reopened = await HitchRolloutPort.create(options);
  const snapshot = await reopened.readAuthorRolloutJournal(operationId);
  expect(snapshot).toMatchObject({ status: 'completed', envelope: { operationId },
    request: { phase: 'author-candidate', harnessRef: git.championRef } });
  expect(snapshot?.requestDigest).toBe(digestJson(snapshot!.request));
  const reopenedAdapter = await createHitchRolloutAdapter(options);
  expect((await reopenedAdapter.inspect(envelope)).status).toBe('completed');
  expect((await readFile(recorded.invocationLog, 'utf8')).trim().split('\n')).toHaveLength(callsBefore);
  const journalPath = join(options.stateRoot, 'algorithm-hitch-operations', `${operationId}.json`);
  const saved = JSON.parse(await readFile(journalPath, 'utf8')) as Record<string, JsonValue>;
  await writeFile(journalPath, JSON.stringify({ ...saved, requestDigest: digestJson({ forged: true }) }));
  await expect(reopened.readAuthorRolloutJournal(operationId)).rejects.toThrow('request identity mismatch');
});
