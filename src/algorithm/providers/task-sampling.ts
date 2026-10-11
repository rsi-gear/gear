import type { CompletionEnvelope, OperationEnvelope, OperationProvider, ProviderInspection, ProviderManifest, ProviderSubmission } from '../contracts.js';
import { FileArtifactStore, assertDigest, sha256 } from '../artifacts.js';
import { assertJson, canonicalJson, jsonDigest } from '../schema.js';
import { TaskViewAuthority, type TaskEntry, type TaskView, type TaskViewRef } from '../data/tasks.js';
import { implementationClosureDigest } from '../data/identity.js';
import { assertTaskSelectionV1, type TaskSelectionV1 } from '../author/a1-contract.js';

export type TaskSampleInput = { sourceTaskViewRef: TaskViewRef; count: number; seed: number };
export type TaskSampleGrant = { allowedExperienceViewDigests: readonly string[]; allowedTaskIds?: readonly string[] };
export type TaskSampleGrantResolver = (campaignId: string) => TaskSampleGrant;
export type TaskSampleProviderOptions = {
  artifacts: FileArtifactStore;
  authority: TaskViewAuthority;
  resolveGrant: TaskSampleGrantResolver;
  accessPolicyDigest: string;
  /** Frozen profile maximum, independently of the size of any requested view. */
  maxCount: number;
};

/** Ranking depends only on frozen input. The seed selects tasks, never rollout repetitions. */
function rankedTasks(view: TaskView, sourceDigest: string, seed: number): TaskEntry[] {
  return view.tasks.map(task => ({ task,
    rank: sha256(canonicalJson(['tasks.sample.v1', sourceDigest, seed, task.id])) }))
    .sort((left, right) => left.rank !== right.rank ? left.rank < right.rank ? -1 : 1
      : left.task.id < right.task.id ? -1 : left.task.id > right.task.id ? 1 : 0)
    .map(item => item.task);
}

/** Pure, CAS-only operation: a lost reply can be recreated from the same signed source and frozen input. */
export function createTasksSampleProvider(options: TaskSampleProviderOptions): OperationProvider {
  const { artifacts, authority, resolveGrant, accessPolicyDigest, maxCount } = options;
  if (authority.artifacts !== artifacts) throw new Error('Task sample authority and CAS differ');
  assertDigest(accessPolicyDigest);
  if (!Number.isSafeInteger(maxCount) || maxCount <= 0) throw new Error('Task sample profile maximum must be positive');
  const manifest: ProviderManifest = {
    kind: 'tasks.sample',
    implementationDigest: implementationClosureDigest(['providers/task-sampling'], {
      kind: 'tasks.sample', accessPolicyDigest, issuerId: authority.issuerId, keyDigest: authority.keyDigest, maxCount,
    }),
    execution: 'trusted-local', supportsInspect: true, meteredDimensions: [],
    inputSchema: { type: 'object', required: ['sourceTaskViewRef', 'count', 'seed'], properties: {
      sourceTaskViewRef: { type: 'any' }, count: { type: 'integer' }, seed: { type: 'integer' },
    }, additionalProperties: false },
    outputSchema: { type: 'object', required: ['schemaVersion', 'taskViewRef', 'selectedTaskIds', 'cursor'], properties: {
      schemaVersion: { type: 'integer' }, taskViewRef: { type: 'any' },
      selectedTaskIds: { type: 'array', items: { type: 'string' } }, cursor: { type: 'any' },
    }, additionalProperties: false },
  };
  const parse = (envelope: OperationEnvelope): { input: TaskSampleInput; source: TaskView; selected: TaskEntry[] } => {
    if (envelope.kind !== manifest.kind || envelope.implementationDigest !== manifest.implementationDigest
      || envelope.inputDigest !== jsonDigest(envelope.input)) throw new Error('Task sample operation identity drift');
    if (Object.keys(envelope.limits).length !== 0 || envelope.startsBudgetClock === true)
      throw new Error('Task sample cannot meter or start the budget clock');
    assertJson(envelope.input);
    if (!envelope.input || typeof envelope.input !== 'object' || Array.isArray(envelope.input)
      || Object.keys(envelope.input).length !== 3
      || !Object.hasOwn(envelope.input, 'sourceTaskViewRef')
      || !Object.hasOwn(envelope.input, 'count') || !Object.hasOwn(envelope.input, 'seed'))
      throw new Error('Task sample input must have exact source/count/seed fields');
    const input = envelope.input as TaskSampleInput;
    if (!Number.isSafeInteger(input.count) || input.count <= 0 || input.count > maxCount
      || !Number.isSafeInteger(input.seed)) throw new Error('Task sample count or seed exceeds profile');
    const grant = resolveGrant(envelope.campaignId);
    if (!grant || !Array.isArray(grant.allowedExperienceViewDigests)) throw new Error('Task sample grant is missing');
    const source = authority.verify(input.sourceTaskViewRef, grant.allowedExperienceViewDigests);
    if (source.tasks.length === 0 || input.count > source.tasks.length) throw new Error('Task sample count exceeds available tasks');
    if (source.tasks.some(task => task.purpose === 'final-test')) throw new Error('Final-test tasks cannot enter author search');
    if (grant.allowedTaskIds) {
      const allowed = new Set(grant.allowedTaskIds);
      if (source.tasks.some(task => !allowed.has(task.id))) throw new Error('Task sample exceeds task ID grant');
    }
    return { input, source, selected: rankedTasks(source, input.sourceTaskViewRef.digest, input.seed).slice(0, input.count) };
  };
  const completion = (envelope: OperationEnvelope): CompletionEnvelope => {
    const { input, source, selected } = parse(envelope);
    const child: TaskView = { schemaVersion: 1, sourceExperienceViewDigest: source.sourceExperienceViewDigest!,
      parentTaskViewDigest: input.sourceTaskViewRef.digest, tasks: selected };
    const taskViewRef = authority.seal(child);
    const value: TaskSelectionV1 = { schemaVersion: 1, taskViewRef,
      selectedTaskIds: selected.map(task => task.id), cursor: { viewDigest: taskViewRef.digest, nextIndex: 0 } };
    assertTaskSelectionV1(value);
    return { operationId: envelope.operationId, idempotencyKey: envelope.idempotencyKey,
      inputDigest: envelope.inputDigest, implementationDigest: envelope.implementationDigest,
      outcome: { kind: 'result', value } };
  };
  return {
    describe: () => manifest,
    preflight: envelope => { parse(envelope); },
    inspect: envelope => { parse(envelope); return Promise.resolve({ status: 'not-started' } as ProviderInspection); },
    submit: envelope => Promise.resolve({ status: 'completed', completion: completion(envelope) } as ProviderSubmission),
    collect: envelope => Promise.resolve(completion(envelope)),
    cancel: () => Promise.resolve({ status: 'cancelled', releaseConfirmed: true }),
  };
}
