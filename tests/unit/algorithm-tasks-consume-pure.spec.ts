import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FileArtifactStore, sha256 } from '../../src/algorithm/artifacts.js';
import { BindingStore } from '../../src/algorithm/bindings.js';
import type { OperationEnvelope, OperationProvider } from '../../src/algorithm/contracts.js';
import { TaskViewAuthority, readTaskView, type TaskEntry } from '../../src/algorithm/data/tasks.js';
import { createTasksConsumeProvider } from '../../src/algorithm/providers/tasks.js';
import { jsonDigest } from '../../src/algorithm/schema.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'gear-pure-consume-')); roots.push(root);
  const artifacts = new FileArtifactStore(join(root, 'cas'));
  const authority = new TaskViewAuthority(artifacts, 'task-host', Buffer.alloc(32, 7));
  const experienceDigest = sha256('sealed-experience');
  const tasks: TaskEntry[] = Array.from({ length: 3 }, (_, index) => ({ id: `task-${index}`,
    contentRef: artifacts.putJson({ prompt: `input ${index}` }, 'task.content.v1'),
    purpose: index === 0 ? 'train' : 'development',
    exposure: { seenInTraining: index === 0, graderLabelExposed: index === 1 },
    ancestry: index === 0 ? [] : [`source-${index}`] }));
  const taskViewRef = authority.seal({ schemaVersion: 1, sourceExperienceViewDigest: experienceDigest, tasks });
  const providerRoot = join(root, 'consume-provider');
  const policyDigest = sha256('policy');
  const grant = (campaignId: string) => ({ allowedExperienceViewDigests: campaignId === 'authorized' ? [experienceDigest] : [] });
  const makeProvider = () => createTasksConsumeProvider(providerRoot, artifacts, authority, grant, policyDigest);
  const provider = makeProvider();
  const bindings = new BindingStore(artifacts, { id: 'consume.bindings.v1', slots: {} });
  const bindingSetRef = bindings.create({});
  const envelope = (localKey: string, cursorIndex = 0, onProvider: OperationProvider = provider): OperationEnvelope => {
    const input = { taskViewRef, cursor: { viewDigest: taskViewRef.digest, nextIndex: cursorIndex }, count: cursorIndex === 0 ? 2 : 1 };
    const operationId = sha256(`authorized:${localKey}`);
    return { operationId, idempotencyKey: operationId, campaignId: 'authorized', decisionIndex: 0,
      localKey, kind: 'tasks.consume', input, inputDigest: jsonDigest(input),
      implementationDigest: onProvider.describe().implementationDigest, bindingSetRef, limits: {} };
  };
  return { root, artifacts, authority, tasks, taskViewRef, providerRoot, provider, makeProvider, envelope };
}
function value(result: Awaited<ReturnType<OperationProvider['submit']>>) {
  if (result.status !== 'completed' || result.completion.outcome.kind !== 'result') throw new Error('expected completed batch');
  return result.completion.outcome.value;
}

it('recomputes the same ordered batch under the original key after lost reply and cold inspect', async () => {
  const f = await setup();
  const request = f.envelope('candidate-0');
  f.provider.preflight(request);
  const first = await f.provider.submit(request);
  expect(value(first)).toEqual({ tasks: f.tasks.slice(0, 2), cursor: { viewDigest: f.taskViewRef.digest, nextIndex: 2 } });
  if (first.status !== 'completed') throw new Error('completion missing');
  expect(first.completion.receipt).toBeUndefined();
  const reopened = f.makeProvider();
  expect(reopened.describe()).toEqual(f.provider.describe());
  expect(await reopened.inspect(request)).toEqual({ status: 'not-started' });
  expect(await reopened.submit(request)).toEqual(first);
  expect((await reopened.collect(request)).outcome).toEqual(first.completion.outcome);
  expect(existsSync(f.providerRoot)).toBe(false);
  expect(readTaskView(f.artifacts, f.taskViewRef).tasks).toEqual(f.tasks);
});

it('does not advance a shared cursor when two candidates each consume from index zero', async () => {
  const f = await setup();
  const left = value(await f.provider.submit(f.envelope('candidate-left')));
  const right = value(await f.provider.submit(f.envelope('candidate-right')));
  expect(right).toEqual(left);
  const next = value(await f.provider.submit(f.envelope('candidate-left-next', 2)));
  expect(next).toEqual({ tasks: f.tasks.slice(2), cursor: { viewDigest: f.taskViewRef.digest, nextIndex: 3 } });
  expect(readTaskView(f.artifacts, f.taskViewRef).tasks).toEqual(f.tasks);
});

it('keeps signed-view authorization, frozen identity, cursor validation and missing CAS errors explicit', async () => {
  const f = await setup();
  const request = f.envelope('candidate');
  expect(() => f.provider.preflight({ ...request, campaignId: 'denied' })).toThrow(/not authorized/);
  expect(() => f.provider.preflight({ ...request, inputDigest: sha256('drift') })).toThrow(/identity drift/);
  const extraInput = { taskViewRef: f.taskViewRef, cursor: { viewDigest: f.taskViewRef.digest, nextIndex: 0 },
    count: 2, unexpected: true };
  const extraEnvelope = { ...request, input: extraInput, inputDigest: jsonDigest(extraInput) };
  expect(() => f.provider.preflight(extraEnvelope)).toThrow(/unexpected/);
  expect(() => f.provider.submit(extraEnvelope)).toThrow(/unexpected/);
  const badCursor = { taskViewRef: f.taskViewRef, cursor: { viewDigest: sha256('wrong-view'), nextIndex: 0 }, count: 2 };
  expect(() => f.provider.preflight({ ...request, input: badCursor, inputDigest: jsonDigest(badCursor) }))
    .toThrow(/Task cursor mismatch/);
  expect(() => f.provider.preflight({ ...request, limits: { calls: 1 } })).toThrow(/cannot meter/);
  expect(() => f.provider.preflight({ ...request, startsBudgetClock: true })).toThrow(/budget clock/);
  const missing = f.tasks[0]!.contentRef;
  await rm(join(f.artifacts.root, 'objects', `${missing.digest}.json`));
  expect(() => f.provider.preflight(request)).toThrow(/source artifact is missing/);
  expect(await readdir(f.root)).not.toContain('consume-provider');
});
