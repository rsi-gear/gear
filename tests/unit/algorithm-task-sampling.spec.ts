import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FileArtifactStore, sha256 } from '../../src/algorithm/artifacts.js';
import { BindingStore } from '../../src/algorithm/bindings.js';
import type { OperationEnvelope, OperationProvider } from '../../src/algorithm/contracts.js';
import { TaskViewAuthority, type TaskEntry, type TaskView, readTaskView } from '../../src/algorithm/data/tasks.js';
import { jsonDigest, type JsonValue } from '../../src/algorithm/schema.js';
import { createTasksSampleProvider, type TaskSampleGrant } from '../../src/algorithm/providers/task-sampling.js';
import { assertTaskSelectionV1, type TaskSelectionV1 } from '../../src/algorithm/author/a1-contract.js';
import { algorithm, replay, AUTHOR_WIRE_VERSION_V2, type AuthorReplayRequest } from '../../src/algorithm/author/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'gear-task-sampling-')); roots.push(root);
  const artifacts = new FileArtifactStore(join(root, 'cas'));
  const authority = new TaskViewAuthority(artifacts, 'sample-host', Buffer.alloc(32, 3));
  const experienceDigest = sha256('sealed-experience');
  const tasks: TaskEntry[] = Array.from({ length: 10 }, (_, index) => ({
    id: `task-${index}`, contentRef: artifacts.putJson({ prompt: `task ${index}` }, 'task.content.v1'),
    purpose: index === 0 ? 'train' : 'development',
    exposure: { seenInTraining: index === 0, graderLabelExposed: index % 3 === 0 },
    ancestry: index === 0 ? [] : [`parent-${index}`],
  }));
  const source: TaskView = { schemaVersion: 1, sourceExperienceViewDigest: experienceDigest, tasks };
  const sourceTaskViewRef = authority.seal(source);
  const grants = new Map<string, TaskSampleGrant>([['allowed', { allowedExperienceViewDigests: [experienceDigest] }]]);
  const options = { artifacts, authority, resolveGrant: (campaignId: string) => {
    const grant = grants.get(campaignId); if (!grant) throw new Error('Campaign not authorized'); return grant;
  }, accessPolicyDigest: sha256('task-sample-policy'), maxCount: 5 };
  const provider = createTasksSampleProvider(options);
  const bindings = new BindingStore(artifacts, { id: 'sample.bindings.v1', slots: {} });
  const bindingSetRef = bindings.create({});
  const envelope = (input: JsonValue, campaignId = 'allowed', onProvider: OperationProvider = provider): OperationEnvelope => ({
    operationId: sha256('task-sample-op'), idempotencyKey: sha256('task-sample-key'),
    campaignId, decisionIndex: 0, localKey: 'sample', kind: 'tasks.sample', input, inputDigest: jsonDigest(input),
    implementationDigest: onProvider.describe().implementationDigest, bindingSetRef, limits: {}, startsBudgetClock: false,
  });
  return { root, artifacts, authority, tasks, sourceTaskViewRef, grants, options, provider, envelope, bindingSetRef };
}
function selected(submission: Awaited<ReturnType<OperationProvider['submit']>>): TaskSelectionV1 {
  expect(submission.status).toBe('completed');
  if (submission.status !== 'completed' || submission.completion.outcome.kind !== 'result') throw new Error('missing result');
  const result = submission.completion.outcome.value;
  assertTaskSelectionV1(result);
  return result;
}

it('samples a signed child view without replacement, preserving task purpose, exposure and lineage', async () => {
  const f = await setup();
  const originalBytes = f.artifacts.getBytes(f.sourceTaskViewRef);
  const input = { sourceTaskViewRef: f.sourceTaskViewRef, count: 4, seed: 17 };
  const operation = f.envelope(input);
  f.provider.preflight(operation);
  const result = selected(await f.provider.submit(operation));
  expect(result.selectedTaskIds).toHaveLength(4);
  expect(new Set(result.selectedTaskIds).size).toBe(4);
  expect(result.cursor).toEqual({ viewDigest: result.taskViewRef.digest, nextIndex: 0 });
  const child = f.authority.verify(result.taskViewRef, [sha256('sealed-experience')]);
  expect(child.parentTaskViewDigest).toBe(f.sourceTaskViewRef.digest);
  expect(child.sourceExperienceViewDigest).toBe(sha256('sealed-experience'));
  expect(child.tasks.map(task => task.id)).toEqual(result.selectedTaskIds);
  for (const task of child.tasks) expect(task).toEqual(f.tasks.find(original => original.id === task.id));
  expect(f.artifacts.getBytes(f.sourceTaskViewRef)).toEqual(originalBytes);
  expect(readTaskView(f.artifacts, f.sourceTaskViewRef).tasks).toEqual(f.tasks);
  expect(f.provider.describe()).toMatchObject({ kind: 'tasks.sample', execution: 'trusted-local', meteredDimensions: [] });
});

it('admits the actual A1 SDK frontier through the pure physical provider preflight', async () => {
  const f = await setup();
  const definition = algorithm(async ctx => {
    await ctx.tasks.sample(f.sourceTaskViewRef, { count: 2, seed: 7 });
    return ctx.result({ selected: ctx.initialAgent });
  });
  const request: AuthorReplayRequest = { version: AUTHOR_WIRE_VERSION_V2, input: {
    initialAgent: { schemaVersion: 1, kind: 'harness-agent', bindingSetRef: f.bindingSetRef,
      executionProfileDigest: sha256('profile') }, data: {}, config: {},
    capabilities: { version: 'gear.author.capabilities.v1', lockDigest: sha256('lock'), roles: {},
      operationLimits: { 'tasks.sample': {} }, execution: {} },
  }, history: [] };
  const reply = await replay(definition, request);
  if (reply.status !== 'waiting' || reply.frontier.length !== 1) throw new Error('sample frontier missing');
  const item = reply.frontier[0]!;
  expect(item).toMatchObject({ kind: 'tasks.sample', limits: {}, startsBudgetClock: false });
  const operation: OperationEnvelope = { ...f.envelope(item.input), limits: item.limits ?? {},
    startsBudgetClock: item.startsBudgetClock ?? true };
  expect(() => f.provider.preflight(operation)).not.toThrow();
  expect(selected(await f.provider.submit(operation)).selectedTaskIds).toHaveLength(2);
});

it('recreates one CAS result after a lost reply and cold provider reconstruction', async () => {
  const f = await setup();
  const input = { sourceTaskViewRef: f.sourceTaskViewRef, count: 5, seed: -3 };
  const operation = f.envelope(input);
  const first = selected(await f.provider.submit(operation));
  const before = await readdir(join(f.artifacts.root, 'objects'));
  const reopened = createTasksSampleProvider(f.options);
  expect(reopened.describe().implementationDigest).toBe(f.provider.describe().implementationDigest);
  expect(await reopened.inspect(operation)).toEqual({ status: 'not-started' });
  const again = selected(await reopened.submit(operation));
  expect(again).toEqual(first);
  expect((await reopened.collect(operation)).outcome).toEqual({ kind: 'result', value: first });
  expect(await readdir(join(f.artifacts.root, 'objects'))).toEqual(before);
});

it('uses a safe task-selection seed and deterministic source-view ranking', async () => {
  const f = await setup();
  const results = [];
  for (const seed of [0, 1, 2, 3, 4]) {
    const input = { sourceTaskViewRef: f.sourceTaskViewRef, count: 3, seed };
    results.push(selected(await f.provider.submit(f.envelope(input))).selectedTaskIds);
  }
  expect(new Set(results.map(ids => ids.join(','))).size).toBeGreaterThan(1);
  const repeated = selected(await f.provider.submit(f.envelope({ sourceTaskViewRef: f.sourceTaskViewRef, count: 3, seed: 0 })));
  expect(repeated.selectedTaskIds).toEqual(results[0]);
});

it('enforces signed source, original experience grant, task grant and final-test exclusion', async () => {
  const f = await setup();
  const input = { sourceTaskViewRef: f.sourceTaskViewRef, count: 2, seed: 1 };
  expect(() => f.provider.preflight(f.envelope(input, 'denied'))).toThrow(/Campaign not authorized/);
  f.grants.set('allowed', { allowedExperienceViewDigests: [sha256('other')] });
  expect(() => f.provider.preflight(f.envelope(input))).toThrow(/not authorized/);
  f.grants.set('allowed', { allowedExperienceViewDigests: [sha256('sealed-experience')], allowedTaskIds: ['task-0'] });
  expect(() => f.provider.preflight(f.envelope(input))).toThrow(/task ID grant/);
  f.grants.set('allowed', { allowedExperienceViewDigests: [sha256('sealed-experience')] });
  const unsigned = f.artifacts.putJson({ schemaVersion: 1, sourceExperienceViewDigest: sha256('sealed-experience'), tasks: f.tasks }, 'task.view.v1');
  expect(() => f.provider.preflight(f.envelope({ ...input, sourceTaskViewRef: unsigned }))).toThrow(/not authorized/);
  const finalSource = f.authority.seal({ schemaVersion: 1, sourceExperienceViewDigest: sha256('sealed-experience'),
    tasks: [{ ...f.tasks[1]!, purpose: 'final-test', exposure: { seenInTraining: false, graderLabelExposed: false } }] });
  expect(() => f.provider.preflight(f.envelope({ sourceTaskViewRef: finalSource, count: 1, seed: 0 })))
    .toThrow(/Final-test/);
});

it('rejects invalid counts, seeds, limits, and operation identity before any new CAS seal', async () => {
  const f = await setup();
  const objectCount = (await readdir(join(f.artifacts.root, 'objects'))).length;
  for (const bad of [
    { sourceTaskViewRef: f.sourceTaskViewRef, count: 0, seed: 1 },
    { sourceTaskViewRef: f.sourceTaskViewRef, count: 6, seed: 1 },
    { sourceTaskViewRef: f.sourceTaskViewRef, count: 2.5, seed: 1 },
    { sourceTaskViewRef: f.sourceTaskViewRef, count: 1, seed: 1.5 },
    { sourceTaskViewRef: f.sourceTaskViewRef, count: 1, seed: 1, extra: true },
  ]) expect(() => f.provider.preflight(f.envelope(bad))).toThrow();
  const input = { sourceTaskViewRef: f.sourceTaskViewRef, count: 2, seed: 1 };
  const operation = f.envelope(input);
  expect(() => f.provider.preflight({ ...operation, limits: { tokens: 1 } })).toThrow(/cannot meter/);
  expect(() => f.provider.preflight({ ...operation, startsBudgetClock: true })).toThrow(/budget clock/);
  expect(() => f.provider.preflight({ ...operation, inputDigest: sha256('drift') })).toThrow(/identity drift/);
  expect((await readdir(join(f.artifacts.root, 'objects'))).length).toBe(objectCount);
  expect(() => createTasksSampleProvider({ ...f.options, maxCount: 0 })).toThrow(/profile maximum/);
});
