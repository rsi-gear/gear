import type { CompletionEnvelope, OperationEnvelope, OperationProvider, ProviderInspection, ProviderManifest, ProviderSubmission } from '../contracts.js';
import { FileArtifactStore, assertDigest } from '../artifacts.js';
import { LocalDurableProvider } from '../runtime/providers.js';
import { consumeTasks, preparePublishedTaskView, prepareTaskViewFromExperience, TaskViewAuthority,
  type PublishedTask, type TaskCursor, type TaskPurpose, type TaskViewRef } from '../data/tasks.js';
import { s3ImplementationDigest } from '../data/identity.js';
import { readExperienceView, type ExperienceViewRef } from '../data/experience.js';
import type { JsonValue } from '../schema.js';

export type TaskPublishGrantResolver = TaskViewGrantResolver;
export type TaskPublishInput = { parentViewRef: TaskViewRef; additions: PublishedTask[] };
export type TaskSelectInput = { experienceViewRef: ExperienceViewRef; tasks: Array<{ id: string; purpose: TaskPurpose; seenInTraining?: boolean }> };
export type TaskConsumeInput = { taskViewRef: TaskViewRef; cursor: TaskCursor; count: number };
export type TaskViewGrantResolver = (campaignId: string) => { allowedExperienceViewDigests: readonly string[] };
/** Verifies content/provenance of every derived task; declared parent IDs alone are not evidence. */
export type TaskPublicationVerifier = (input: TaskPublishInput, envelope: OperationEnvelope) => void | Promise<void>;

/** Recipes select only research/training tasks; an independent host admission controls final-test. */
export function createTasksSelectProvider(root: string, artifacts: FileArtifactStore, authority: TaskViewAuthority, resolveGrant: TaskViewGrantResolver,
  accessPolicyDigest: string): OperationProvider {
  assertDigest(accessPolicyDigest);
  const manifest: ProviderManifest = { kind: 'tasks.select', implementationDigest: s3ImplementationDigest('tasks.select', { accessPolicyDigest, issuerId: authority.issuerId, keyDigest: authority.keyDigest }),
    execution: 'trusted-local', supportsInspect: true, meteredDimensions: [],
    inputSchema: { type: 'object', required: ['experienceViewRef', 'tasks'], properties: { experienceViewRef: { type: 'any' },
      tasks: { type: 'array', items: { type: 'any' } } }, additionalProperties: false },
    outputSchema: { type: 'object', required: ['taskViewRef'], properties: { taskViewRef: { type: 'any' } }, additionalProperties: false } };
  const check = (envelope: OperationEnvelope): TaskSelectInput => {
    const input = envelope.input as TaskSelectInput;
    if (!input.experienceViewRef || !resolveGrant(envelope.campaignId).allowedExperienceViewDigests.includes(input.experienceViewRef.digest)) throw new Error('Task selection not authorized');
    readExperienceView(artifacts, input.experienceViewRef);
    if (!Array.isArray(input.tasks) || input.tasks.length === 0 || input.tasks.some(item => item.purpose === 'final-test')) throw new Error('Task selection cannot create final-test');
    prepareTaskViewFromExperience(artifacts, input.experienceViewRef, input.tasks);
    return input;
  };
  const local = new LocalDurableProvider(root, manifest, envelope => {
    const input = check(envelope);
    const taskViewRef = authority.seal(prepareTaskViewFromExperience(artifacts, input.experienceViewRef, input.tasks));
    return { outcome: { kind: 'result', value: { taskViewRef } } };
  });
  return { describe: () => local.describe(), preflight: envelope => { check(envelope); },
    submit: envelope => { check(envelope); return local.submit(envelope); }, inspect: envelope => { check(envelope); return local.inspect(envelope); },
    cancel: envelope => { check(envelope); return local.cancel(envelope); }, collect: envelope => { check(envelope); return local.collect(envelope); } };
}

/** The cursor and selected view are frozen operation inputs, so restart yields the same batch. */
export function createTasksConsumeProvider(root: string, artifacts: FileArtifactStore, authority: TaskViewAuthority, resolveGrant: TaskViewGrantResolver,
  accessPolicyDigest: string): OperationProvider {
  assertDigest(accessPolicyDigest);
  const manifest: ProviderManifest = { kind: 'tasks.consume', implementationDigest: s3ImplementationDigest('tasks.consume', { accessPolicyDigest, issuerId: authority.issuerId, keyDigest: authority.keyDigest }),
    execution: 'trusted-local', supportsInspect: true, meteredDimensions: [],
    inputSchema: { type: 'object', required: ['taskViewRef', 'cursor', 'count'], properties: { taskViewRef: { type: 'any' },
      cursor: { type: 'any' }, count: { type: 'integer' } }, additionalProperties: false },
    outputSchema: { type: 'object', required: ['tasks', 'cursor'], properties: { tasks: { type: 'array', items: { type: 'any' } },
      cursor: { type: 'any' } }, additionalProperties: false } };
  const check = (envelope: OperationEnvelope): TaskConsumeInput => {
    const input = envelope.input as TaskConsumeInput;
    if (!input.taskViewRef) throw new Error('Task consumption not authorized');
    authority.verify(input.taskViewRef, resolveGrant(envelope.campaignId).allowedExperienceViewDigests);
    consumeTasks(artifacts, input.taskViewRef, input.cursor, input.count);
    return input;
  };
  const local = new LocalDurableProvider(root, manifest, envelope => {
    const input = check(envelope);
    return { outcome: { kind: 'result', value: consumeTasks(artifacts, input.taskViewRef, input.cursor, input.count) as unknown as JsonValue } };
  });
  return { describe: () => local.describe(), preflight: envelope => { check(envelope); },
    submit: envelope => { check(envelope); return local.submit(envelope); }, inspect: envelope => { check(envelope); return local.inspect(envelope); },
    cancel: envelope => { check(envelope); return local.cancel(envelope); }, collect: envelope => { check(envelope); return local.collect(envelope); } };
}

/** Publication is durable and authorization comes from a host resolver, not from recipe input. */
export function createTasksPublishProvider(root: string, artifacts: FileArtifactStore, authority: TaskViewAuthority, resolveGrant: TaskPublishGrantResolver,
  accessPolicyDigest: string, verifierImplementationDigest: string, verify: TaskPublicationVerifier): OperationProvider {
  assertDigest(accessPolicyDigest);
  assertDigest(verifierImplementationDigest);
  if (typeof verify !== 'function') throw new Error('Task publication verifier required');
  const manifest: ProviderManifest = { kind: 'tasks.publish', implementationDigest: s3ImplementationDigest('tasks.publish', { accessPolicyDigest, verifierImplementationDigest, issuerId: authority.issuerId, keyDigest: authority.keyDigest }), execution: 'trusted-local', supportsInspect: true, meteredDimensions: [],
    inputSchema: { type: 'object', required: ['parentViewRef', 'additions'], properties: {
      parentViewRef: { type: 'any' }, additions: { type: 'array', items: { type: 'any' } },
    }, additionalProperties: false }, outputSchema: { type: 'object', required: ['taskViewRef'], properties: { taskViewRef: { type: 'any' } }, additionalProperties: false } };
  const check = (envelope: OperationEnvelope): TaskPublishInput => {
    const input = envelope.input as TaskPublishInput;
    if (!input.parentViewRef) throw new Error('Task publication not authorized');
    authority.verify(input.parentViewRef, resolveGrant(envelope.campaignId).allowedExperienceViewDigests);
    if (!Array.isArray(input.additions) || input.additions.length === 0) throw new Error('Task publication is empty');
    preparePublishedTaskView(artifacts, input.parentViewRef, input.additions);
    return input;
  };
  const local = new LocalDurableProvider(root, manifest, async envelope => {
    const { parentViewRef, additions } = check(envelope);
    await verify({ parentViewRef, additions }, envelope);
    const taskViewRef = authority.seal(preparePublishedTaskView(artifacts, parentViewRef, additions));
    return { outcome: { kind: 'result', value: { taskViewRef } } };
  });
  return {
    describe: () => local.describe(), preflight: async envelope => { const input = check(envelope); await verify(input, envelope); },
    submit: async envelope => { const input = check(envelope); await verify(input, envelope); return local.submit(envelope); },
    inspect: envelope => { check(envelope); return local.inspect(envelope); },
    cancel: envelope => { check(envelope); return local.cancel(envelope); },
    collect: envelope => { check(envelope); return local.collect(envelope); },
  } satisfies OperationProvider;
}
