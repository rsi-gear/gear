import { readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileArtifactStore, sha256 } from '../../src/algorithm/artifacts.js';
import { BindingStore } from '../../src/algorithm/bindings.js';
import type { ArtifactRef, OperationEnvelope, OperationOutcome } from '../../src/algorithm/contracts.js';
import { TaskViewAuthority, type TaskEntry } from '../../src/algorithm/data/tasks.js';
import { readMeasurement } from '../../src/algorithm/data/measurement.js';
import { jsonDigest } from '../../src/algorithm/schema.js';
import { digestJson } from '../../src/state/digest.js';
import { resolveMetric } from '../../src/objective/contracts.js';
import { createAuthorMeasurementProvider, type CommittedRollout, type FrozenAuthorMeasurementProfile }
  from '../../src/algorithm/author/measurement.js';
import type { HarnessAgentV1, TaskSelectionV1 } from '../../src/algorithm/author/a1-contract.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gear-author-measurement-')); roots.push(root);
  const artifacts = new FileArtifactStore(join(root, 'cas'));
  const bindings = new BindingStore(artifacts, { id: 'author.harness.bindings.v1', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true },
  } });
  const commit = 'a'.repeat(40);
  const harness = artifacts.putJson({ schemaVersion: 1, kind: 'git-harness', commitOid: commit,
    manifestDigest: `sha256:${'b'.repeat(64)}` }, 'harness.directory.v1');
  const bindingSetRef = bindings.create({ harness });
  const authority = new TaskViewAuthority(artifacts, 'author-measurement-test', Buffer.alloc(32, 7));
  const experienceDigest = sha256('permitted-experience');
  const tasks: TaskEntry[] = ['alpha', 'beta'].map(id => ({ id,
    contentRef: artifacts.putJson({ prompt: id }, 'task.content.v1'), purpose: 'development',
    exposure: { seenInTraining: false, graderLabelExposed: false }, ancestry: [] }));
  const parent = authority.seal({ schemaVersion: 1, sourceExperienceViewDigest: experienceDigest, tasks });
  const view = authority.seal({ schemaVersion: 1, sourceExperienceViewDigest: experienceDigest,
    parentTaskViewDigest: parent.digest, tasks });
  const selection: TaskSelectionV1 = { schemaVersion: 1, taskViewRef: view,
    selectedTaskIds: tasks.map(task => task.id), cursor: { viewDigest: view.digest, nextIndex: 0 } };
  const agent: HarnessAgentV1 = { schemaVersion: 1, kind: 'harness-agent', bindingSetRef,
    executionProfileDigest: sha256('fixed-execution-profile') };
  const metricContract = resolveMetric({ id: 'pass_rate', revision: 'test-predicate-v1', unit: 'ratio', direction: 'maximize',
    source: { path: 'originalResult.passed', extractor: 'boolean-v1' }, range: { min: 0, max: 1 },
    granularity: 'trial', repetitionReducer: 'mean', taskReducer: 'weighted-mean', comparisonPrecision: 1e-9 });
  const metricSchemaRef = artifacts.putJson({ schemaVersion: 1, metrics: { pass_rate: { unit: 'ratio',
    minimum: 0, maximum: 1, contractDigest: metricContract.digest } } }, 'measurement.metric-schema.v1');
  const frozenRef = (name: string) => artifacts.putJson({ kind: name, revision: 1 }, `author.${name}.v1`);
  const adapterDigest = sha256('trusted-adapter'), physicalDigest = sha256('physical-hitch');
  const profile: FrozenAuthorMeasurementProfile = { campaignId: 'campaign', profileDigest: sha256('profile'),
    executionProfileDigest: agent.executionProfileDigest, accessPolicyDigest: sha256('policy'),
    resolverIdentityDigest: sha256('committed-journal-reader'), rolloutAdapterDigest: adapterDigest,
    rolloutAdapterManifestDigest: sha256('rollout-adapter-manifest'), rolloutPhysicalDigest: physicalDigest,
    allowedExperienceViewDigests: [experienceDigest], repeatCount: 2, recipePhase: 'author.evaluate',
    samplingDigest: digestJson({}), environmentDigest: digestJson({ environment: 'frozen' }),
    rolloutCondition: { partition: 'seed', repetitions: 1, model: 'target-model', sampling: {},
      timeoutMs: 1000, rolloutProviderDigest: digestJson({ provider: 'frozen' }) },
    condition: { providerImplementationDigest: physicalDigest, evaluatorRef: frozenRef('evaluator'),
      rubricRef: frozenRef('rubric'), environmentRef: frozenRef('environment'),
      samplingRef: frozenRef('sampling'), budgetRef: frozenRef('budget'), metricSchemaRef,
      subjectSchemaId: bindingSetRef.schemaId }, metricContract };
  const committed = new Map<string, CommittedRollout>();
  let resolves = 0;
  const resolveCommitted = { identityDigest: profile.resolverIdentityDigest,
    resolve(_campaignId: string, operationIds: readonly string[]) {
      resolves++;
      return Object.fromEntries(operationIds.flatMap(id => committed.has(id) ? [[id, committed.get(id)!]] : []));
    } };
  const provider = createAuthorMeasurementProvider({ artifacts, bindings, authority, profile, resolveCommitted });

  function producer(task: TaskEntry, repeatIndex: number, options: { passed?: boolean; score?: number;
    evalId?: string; runId?: string; invalid?: boolean; outcome?: OperationOutcome } = {}) {
    const operationId = sha256(`${task.id}:${repeatIndex}`);
    const input = { task, taskViewRef: view, repeatIndex, samplingDigest: profile.samplingDigest,
      environmentDigest: profile.environmentDigest, recipePhase: profile.recipePhase,
      executedRevisionDigest: bindingSetRef.digest };
    const envelope: OperationEnvelope = { operationId, idempotencyKey: operationId, campaignId: 'campaign',
      decisionIndex: 1, localKey: `${task.id}-${repeatIndex}`, kind: 'execution.rollout', input,
      inputDigest: jsonDigest(input), implementationDigest: adapterDigest, bindingSetRef,
      limits: { 'rollout.trials': 1 }, startsBudgetClock: true };
    const physicalEnvelope = { ...envelope, implementationDigest: physicalDigest };
    const ordinal = `${task.id === 'alpha' ? 0 : 1}${repeatIndex}`;
    const evalId = options.evalId ?? `eval_${ordinal.padStart(32, '0')}`;
    const runId = options.runId ?? `run_${ordinal.padStart(32, '0')}`;
    const identity = { provider: 'hitch-cli', effectiveConfigDigest: digestJson({ task: task.id }),
      invocationFingerprint: digestJson({ invocation: task.id }) };
    const score = options.score ?? (options.passed === false ? 0.95 : 0.05);
    const trial = { taskName: task.id, trialName: `${task.id}-${repeatIndex}`, runId, attempt: 1,
      status: 'completed', originalResult: { passed: options.passed !== false }, rewards: { reward: score },
      scores: { totalScore: score, normalization: 'standard' } };
    const invalidTrial = { taskName: task.id, trialName: trial.trialName, runId, attempt: 1,
      status: 'errored', invalidReason: 'physical-invalid' };
    const conditionBody = { ...profile.rolloutCondition,
      dataset: { ref: `projected-${task.id}`, digest: digestJson({ projected: task.id }) } };
    const request = { phase: 'author-candidate' as const, dataset: conditionBody.dataset.ref,
      harnessRef: commit, condition: { ...conditionBody, conditionId: digestJson(conditionBody) } };
    const requestDigest = digestJson(request);
    const evidence = { ...identity, evalId, dataset: request.dataset, conditionId: request.condition.conditionId,
      requestedCommit: commit, actualCommit: commit, revisionIdentity: digestJson({ commit }),
      completeness: options.invalid ? 'partial' : 'complete', plannedTrialCount: 1,
      primaryReward: score, summary: { total: 1, passed: 1, failed: 0, score },
      trials: options.invalid ? [] : [trial], invalidTrials: options.invalid ? [invalidTrial] : [] };
    const evidenceRef = artifacts.putJson({ schemaVersion: 1, kind: 'hitch-daemon-evaluation',
      evidence, submittedIdentity: identity, requestDigest }, 'execution.rollout.evidence.v1');
    const receiptRef = artifacts.putJson({ schemaVersion: 1, providerImplementationDigest: physicalDigest,
      operationId, inputDigest: envelope.inputDigest, loadedBindingSetDigest: bindingSetRef.digest,
      evidenceDigest: evidenceRef.digest, actualBindings: { harness: harness.digest },
      bindingUse: 'executed', executedHarnessCommit: commit,
      executionIdentity: digestJson({ evalId, submittedIdentity: identity, evidenceDigest: evidenceRef.digest,
        overlayReceiptDigest: null }), samplingDigest: profile.samplingDigest,
      environmentDigest: profile.environmentDigest }, 'execution.receipt.v1');
    const result = { requestedBindingSetDigest: bindingSetRef.digest,
      actualBindings: { harness }, evidenceRef, receiptRef };
    const outcome: OperationOutcome = options.outcome ?? { kind: 'result', value: result };
    const completion = { operationId, idempotencyKey: operationId, inputDigest: envelope.inputDigest,
      implementationDigest: physicalDigest, outcome };
    committed.set(operationId, { envelope, providerManifestDigest: profile.rolloutAdapterManifestDigest,
      status: 'completed', outcome, physical: { status: 'completed', envelope: physicalEnvelope, completion,
        request, requestDigest, submittedIdentity: identity } });
    return { operationId, evidenceRef, receiptRef };
  }
  const entries = tasks.flatMap(task => [producer(task, 0), producer(task, 1)]);
  function measurement(producerOperationIds = entries.map(item => item.operationId)): OperationEnvelope {
    const input = { subject: agent, selection, producerOperationIds };
    const operationId = sha256(jsonDigest(input));
    return { operationId, idempotencyKey: operationId, campaignId: 'campaign', decisionIndex: 2,
      localKey: 'measure', kind: 'author.measurement', input, inputDigest: jsonDigest(input),
      implementationDigest: provider.describe().implementationDigest, bindingSetRef,
      limits: {}, startsBudgetClock: false };
  }
  return { artifacts, bindings, authority, profile, provider, committed, entries, tasks, selection, agent,
    harness, bindingSetRef, resolveCommitted, producer, measurement, root, get resolveCount() { return resolves; } };
}

describe('trusted author measurement over committed Hitch rollouts', () => {
  it('seals a comparable pass_rate from raw pass predicates with deterministic cold CAS replay', async () => {
    const f = await fixture();
    const envelope = f.measurement();
    const before = readdirSync(join(f.root, 'cas', 'objects')).length;
    await f.provider.preflight(envelope);
    expect(readdirSync(join(f.root, 'cas', 'objects')).length).toBe(before);
    const result = await f.provider.submit(envelope);
    expect(result.status).toBe('completed');
    if (result.status !== 'completed' || result.completion.outcome.kind !== 'result') throw new Error('missing result');
    const evaluation = result.completion.outcome.value as unknown as { status: string; comparable: boolean;
      metrics: Record<string, number>; comparisonKey: string; measurementRef: ArtifactRef };
    expect(evaluation.status).toBe('complete');
    expect(evaluation.comparable).toBe(true);
    expect(evaluation.metrics.pass_rate).toBe(1); // Scores are 0.05; predicate, not totalScore, defines pass_rate.
    const record = readMeasurement(f.artifacts, evaluation.measurementRef);
    expect(record.comparisonKey).toBe(evaluation.comparisonKey);
    expect(record.evidenceRefs).toHaveLength(4);
    expect((await f.provider.inspect(envelope)).status).toBe('not-started');
    const cold = createAuthorMeasurementProvider({ artifacts: f.artifacts, bindings: f.bindings,
      authority: f.authority, profile: f.profile, resolveCommitted: f.resolveCommitted });
    expect(cold.describe()).toEqual(f.provider.describe());
    expect((await cold.collect(envelope)).outcome).toEqual(result.completion.outcome);
    expect(f.resolveCount).toBe(4); // preflight, submit, inspect, cold collect; one snapshot per attempt.
  });

  it('keeps missing, committed business failures, and invalid physical trials out of aggregates', async () => {
    const f = await fixture();
    const missing = f.measurement(f.entries.slice(0, 3).map(item => item.operationId));
    const missingResult = await f.provider.collect(missing);
    expect(missingResult.outcome).toMatchObject({ kind: 'result', value: { status: 'incomplete', comparable: false } });
    expect(missingResult.outcome).not.toHaveProperty('value.metrics');
    f.producer(f.tasks[0]!, 0, { outcome: { kind: 'error', code: 'hitch_failed', message: 'failed' } });
    const failed = await f.provider.collect(f.measurement());
    expect(failed.outcome).toMatchObject({ kind: 'result', value: { status: 'incomplete', comparable: false } });
    if (failed.outcome.kind !== 'result') throw new Error('missing failed evaluation');
    expect((failed.outcome.value as { trials: unknown[] }).trials[0]).toMatchObject({ status: 'failed', code: 'hitch_failed' });
    expect(failed.outcome).not.toHaveProperty('value.measurementRef');
    f.producer(f.tasks[0]!, 0, { invalid: true });
    const invalid = await f.provider.collect(f.measurement());
    expect(invalid.outcome).toMatchObject({ kind: 'result', value: { status: 'invalid', comparable: false } });
    if (invalid.outcome.kind !== 'result') throw new Error('missing invalid evaluation');
    expect((invalid.outcome.value as { trials: unknown[] }).trials[0]).toMatchObject({ status: 'invalid', code: 'physical-invalid' });
    expect(invalid.outcome).not.toHaveProperty('value.comparisonKey');
  });

  it('does not commit a pending named producer as a result that could change under the original key', async () => {
    const f = await fixture();
    const envelope = f.measurement();
    f.committed.delete(f.entries[0]!.operationId);
    await expect(f.provider.submit(envelope)).rejects.toThrow(/not committed and terminal/);
  });

  it('rejects author-supplied evidence and forged selection, subject, repeat, or campaign', async () => {
    const f = await fixture();
    const base = f.measurement();
    const changed = (input: unknown, envelope = base): OperationEnvelope => ({ ...envelope,
      input: input as OperationEnvelope['input'], inputDigest: jsonDigest(input) });
    await expect(f.provider.preflight(changed({ ...base.input as object, metrics: { pass_rate: 1 } })))
      .rejects.toThrow();
    await expect(f.provider.preflight(changed({ ...base.input as object,
      selection: { ...f.selection, selectedTaskIds: ['beta', 'alpha'] } }))).rejects.toThrow(/exact signed/);
    await expect(f.provider.preflight(changed({ ...base.input as object,
      subject: { ...f.agent, executionProfileDigest: sha256('different') } }))).rejects.toThrow(/profile drift/);
    await expect(f.provider.preflight({ ...base, campaignId: 'other' })).rejects.toThrow(/identity drift/);
    const record = f.committed.get(f.entries[0]!.operationId)!;
    f.committed.set(f.entries[0]!.operationId, { ...record,
      envelope: { ...record.envelope, input: { ...record.envelope.input as object, repeatIndex: 3 },
        inputDigest: jsonDigest({ ...record.envelope.input as object, repeatIndex: 3 }) } });
    await expect(f.provider.preflight(base)).rejects.toThrow();
  });

  it('rejects physical/adapter confusion, uncommitted physical results, and reused eval/run IDs', async () => {
    const f = await fixture();
    const base = f.measurement();
    const id = f.entries[0]!.operationId;
    const original = f.committed.get(id)!;
    f.committed.set(id, { ...original, outcome: { kind: 'no-result' } });
    await expect(f.provider.collect(base)).rejects.toThrow(/differs from committed/);
    f.committed.set(id, { ...original, providerManifestDigest: sha256('wrong-adapter-manifest') });
    await expect(f.provider.collect(base)).rejects.toThrow(/committed rollout/);
    f.committed.set(id, original);
    f.producer(f.tasks[0]!, 1, { evalId: `eval_${'0'.repeat(32)}` });
    await expect(f.provider.collect(base)).rejects.toThrow(/evalId reused/);
    f.producer(f.tasks[0]!, 1, { runId: `run_${'0'.repeat(32)}` });
    const repeatedRun = f.committed.get(f.entries[1]!.operationId)!;
    if (repeatedRun.outcome.kind !== 'result') throw new Error('fixture missing run');
    const ref = (repeatedRun.outcome.value as { evidenceRef: ArtifactRef }).evidenceRef;
    const sealed = f.artifacts.getJson(ref) as Record<string, unknown>;
    const oldEvidence = sealed.evidence as Record<string, unknown>;
    const oldTrial = (oldEvidence.trials as Record<string, unknown>[])[0]!;
    const altered = { ...sealed, evidence: { ...oldEvidence, trials: [{ ...oldTrial, attempt: 2 }] } };
    const evidenceRef = f.artifacts.putJson(altered, 'execution.rollout.evidence.v1');
    const outcome = { kind: 'result' as const, value: { ...repeatedRun.outcome.value as object,
      evidenceRef } as OperationOutcome & never };
    const receipt = f.artifacts.getJson((repeatedRun.outcome.value as { receiptRef: ArtifactRef }).receiptRef) as Record<string, unknown>;
    const receiptRef = f.artifacts.putJson({ ...receipt, evidenceDigest: evidenceRef.digest,
      executionIdentity: digestJson({ evalId: oldEvidence.evalId,
        submittedIdentity: repeatedRun.physical.submittedIdentity, evidenceDigest: evidenceRef.digest,
        overlayReceiptDigest: null }) }, 'execution.receipt.v1');
    const completeOutcome = { kind: 'result' as const, value: { ...outcome.value as object,
      receiptRef } as OperationOutcome & never };
    f.committed.set(f.entries[1]!.operationId, { ...repeatedRun, outcome: completeOutcome,
      physical: { ...repeatedRun.physical, completion: { ...repeatedRun.physical.completion,
        outcome: completeOutcome } } });
    await expect(f.provider.collect(base)).rejects.toThrow(/runId reused/);
  });

  it('rejects receipt physical-digest drift and metric contract substitution', async () => {
    const f = await fixture();
    const first = f.committed.get(f.entries[0]!.operationId)!;
    if (first.outcome.kind !== 'result') throw new Error('fixture missing result');
    const result = first.outcome.value as unknown as { receiptRef: ArtifactRef };
    const receipt = f.artifacts.getJson(result.receiptRef) as Record<string, unknown>;
    const forgedRef = f.artifacts.putJson({ ...receipt, providerImplementationDigest: f.profile.rolloutAdapterDigest },
      'execution.receipt.v1');
    const forgedOutcome: OperationOutcome = { kind: 'result', value: { ...first.outcome.value as object,
      receiptRef: forgedRef } as OperationOutcome & never };
    f.committed.set(f.entries[0]!.operationId, { ...first, outcome: forgedOutcome,
      physical: { ...first.physical, completion: { ...first.physical.completion, outcome: forgedOutcome } } });
    await expect(f.provider.collect(f.measurement())).rejects.toThrow(/Physical rollout receipt/);
    expect(() => createAuthorMeasurementProvider({ artifacts: f.artifacts, bindings: f.bindings,
      authority: f.authority, profile: { ...f.profile,
        metricContract: resolveMetric({ id: 'pass_rate', revision: 'changed', unit: 'ratio', direction: 'maximize',
          source: { path: 'originalResult.passed', extractor: 'boolean-v1' }, range: { min: 0, max: 1 },
          granularity: 'trial', repetitionReducer: 'mean', taskReducer: 'weighted-mean', comparisonPrecision: 1e-9 }) },
      resolveCommitted: f.resolveCommitted })).toThrow(/does not bind/);
  });

  it('locks the measurement provider to the actual committed resolver identity', async () => {
    const f = await fixture();
    expect(() => createAuthorMeasurementProvider({ artifacts: f.artifacts, bindings: f.bindings,
      authority: f.authority, profile: f.profile,
      resolveCommitted: { ...f.resolveCommitted, identityDigest: sha256('another-resolver') } }))
      .toThrow(/resolver identity drift/);
  });

  it('requires a saved, self-consistent Hitch request and exact evidence condition', async () => {
    const f = await fixture();
    const operationId = f.entries[0]!.operationId, original = f.committed.get(operationId)!;
    const request = original.physical.request;
    f.committed.set(operationId, { ...original, physical: { ...original.physical,
      request: { ...request, condition: { ...request.condition, conditionId: digestJson({ forged: true }) } } } });
    await expect(f.provider.collect(f.measurement())).rejects.toThrow(/Saved Hitch request/);
    f.committed.set(operationId, original);
    if (original.outcome.kind !== 'result') throw new Error('fixture missing result');
    const result = original.outcome.value as { evidenceRef: ArtifactRef; receiptRef: ArtifactRef };
    const sealed = f.artifacts.getJson(result.evidenceRef) as Record<string, unknown>;
    const evidence = sealed.evidence as Record<string, unknown>;
    const evidenceRef = f.artifacts.putJson({ ...sealed,
      evidence: { ...evidence, conditionId: digestJson({ forged: true }) } }, 'execution.rollout.evidence.v1');
    const receipt = f.artifacts.getJson(result.receiptRef) as Record<string, unknown>;
    const receiptRef = f.artifacts.putJson({ ...receipt, evidenceDigest: evidenceRef.digest,
      executionIdentity: digestJson({ evalId: evidence.evalId,
        submittedIdentity: original.physical.submittedIdentity, evidenceDigest: evidenceRef.digest,
        overlayReceiptDigest: null }) }, 'execution.receipt.v1');
    const outcome: OperationOutcome = { kind: 'result', value: { ...original.outcome.value as object,
      evidenceRef, receiptRef } as OperationOutcome & never };
    f.committed.set(operationId, { ...original, outcome,
      physical: { ...original.physical, completion: { ...original.physical.completion, outcome } } });
    await expect(f.provider.collect(f.measurement())).rejects.toThrow(/Physical Hitch evidence/);
  });
});
