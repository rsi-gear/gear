import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileArtifactStore, sha256 } from '../../src/algorithm/artifacts.js';
import { BindingStore } from '../../src/algorithm/bindings.js';
import type { ArtifactRef, OperationEnvelope } from '../../src/algorithm/contracts.js';
import { TaskViewAuthority, type TaskEntry } from '../../src/algorithm/data/tasks.js';
import { jsonDigest } from '../../src/algorithm/schema.js';
import { createTrustedRolloutFeedbackAdapter } from '../../src/algorithm/providers/trusted-feedback.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gear-trusted-feedback-')); roots.push(root);
  const stateRoot = join(root, 'state');
  await mkdir(join(stateRoot, 'algorithm-hitch-operations'), { recursive: true });
  const artifacts = new FileArtifactStore(join(root, 'artifacts'));
  const bindings = new BindingStore(artifacts, { id: 'feedback.bindings.v1', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true },
    skills: { schemaId: 'skills.library.v1', required: false },
  } });
  const harness = artifacts.putJson({ schemaVersion: 1, kind: 'git-harness', commitOid: 'a'.repeat(40),
    manifestDigest: `sha256:${'b'.repeat(64)}` }, 'harness.directory.v1');
  const bindingSetRef = bindings.create({ harness });
  const task: TaskEntry = { id: 'task-1', contentRef: artifacts.putJson({ prompt: 'synthetic task' }, 'task.content.v1'),
    purpose: 'development', exposure: { seenInTraining: false, graderLabelExposed: false }, ancestry: [] };
  const authority = new TaskViewAuthority(artifacts, 'test-host', Buffer.alloc(32, 4));
  const sourceDigest = sha256('authorized-experience');
  const taskViewRef = authority.seal({ schemaVersion: 1, sourceExperienceViewDigest: sourceDigest, tasks: [task] });
  const policy = { root: join(root, 'feedback'), stateRoot, artifacts, bindings,
    taskAuthority: authority, allowedExperienceViewDigests: () => [sourceDigest], passThreshold: 0.6,
    expectedAheRepeats: 2, accessPolicyDigest: sha256('host-feedback-policy') };
  const provider = createTrustedRolloutFeedbackAdapter(policy);

  async function producer(name: string, score: number, options?: { taskId?: string; campaignId?: string;
    bindingDigest?: string; normalization?: string; completeness?: string; repeatIndex?: number;
    samplingDigest?: string; environmentDigest?: string; evalId?: string;
    runId?: string; attempt?: number }): Promise<{ evidenceRef: ArtifactRef; receiptRef: ArtifactRef }> {
    const operationId = sha256(`producer-${name}`);
    const input = { task: { ...task, id: options?.taskId ?? task.id }, taskViewRef,
      repeatIndex: options?.repeatIndex ?? 0, samplingDigest: options?.samplingDigest ?? sha256('sampling'),
      environmentDigest: options?.environmentDigest ?? sha256('environment'), recipePhase: 'ahe.measure',
      executedRevisionDigest: bindingSetRef.digest };
    const envelope: OperationEnvelope = { operationId, idempotencyKey: operationId,
      campaignId: options?.campaignId ?? 'campaign', decisionIndex: 0, localKey: name, kind: 'execution.rollout',
      input, inputDigest: jsonDigest(input), implementationDigest: sha256('recorded-Hitch-port'),
      bindingSetRef: options?.bindingDigest ? { ...bindingSetRef, digest: options.bindingDigest } : bindingSetRef, limits: {} };
    const identity = { provider: 'recorded-Hitch', effectiveConfigDigest: `sha256:${'c'.repeat(64)}`,
      evalId: options?.evalId ?? `eval_${name}` };
    const requestDigest = `sha256:${'d'.repeat(64)}`;
    const evidence = { ...identity, dataset: 'synthetic', conditionId: 'condition',
      requestedCommit: 'a'.repeat(40), actualCommit: 'a'.repeat(40), revisionIdentity: 'revision',
      completeness: options?.completeness ?? 'complete', plannedTrialCount: 1, primaryReward: score,
      summary: { total: 1, passed: score >= 0.6 ? 1 : 0, failed: score >= 0.6 ? 0 : 1, score },
      trials: [{ taskName: input.task.id, trialName: name,
        runId: options?.runId ?? `run_${sha256(name).slice(0, 32)}`, attempt: options?.attempt ?? 1,
        status: 'completed', rewards: { reward: score }, scores: { totalScore: score,
          normalization: options?.normalization ?? 'standard' } }], invalidTrials: [] };
    const evidenceRef = artifacts.putJson({ schemaVersion: 1, kind: 'hitch-daemon-evaluation', evidence,
      submittedIdentity: identity, requestDigest }, 'execution.rollout.evidence.v1');
    const receiptRef = artifacts.putJson({ schemaVersion: 1, providerImplementationDigest: envelope.implementationDigest,
      operationId, inputDigest: envelope.inputDigest, loadedBindingSetDigest: envelope.bindingSetRef.digest,
      evidenceDigest: evidenceRef.digest, actualBindings: { harness: harness.digest },
      executionIdentity: `eval_${name}` }, 'execution.receipt.v1');
    const completion = { operationId, idempotencyKey: operationId, inputDigest: envelope.inputDigest,
      implementationDigest: envelope.implementationDigest, outcome: { kind: 'result', value: {
        requestedBindingSetDigest: envelope.bindingSetRef.digest, actualBindings: { harness }, evidenceRef, receiptRef } } };
    await writeFile(join(stateRoot, 'algorithm-hitch-operations', `${operationId}.json`),
      JSON.stringify({ envelope, requestDigest, status: 'completed', identity, completion }));
    return { evidenceRef, receiptRef };
  }
  const first = await producer('first', 0.25), second = await producer('second', 0.75, { repeatIndex: 1 });
  function feedback(rollouts = [first, second]): OperationEnvelope {
    const input = { mode: 'ahe.task-measurement', task, taskViewRef, authorizedRollouts: rollouts,
      rolloutEvidenceRefs: rollouts.map(item => item.evidenceRef), executedRevisionDigest: bindingSetRef.digest };
    const operationId = sha256(`feedback-${jsonDigest(input)}`);
    return { operationId, idempotencyKey: operationId, campaignId: 'campaign', decisionIndex: 1,
      localKey: 'feedback', kind: 'execution.feedback', input, inputDigest: jsonDigest(input),
      implementationDigest: provider.describe().implementationDigest, bindingSetRef, limits: {} };
  }
  return { root, stateRoot, provider, policy, producer, feedback, first, second, task, taskViewRef,
    artifacts, bindings, harness, bindingSetRef };
}

describe('trusted physical rollout feedback (synthetic producer journals, no model calls)', () => {
  it('seals a host-computed AHE mean and pass flag, with exact producer receipts', async () => {
    const f = await fixture();
    const envelope = f.feedback();
    await f.provider.preflight(envelope);
    const complete = await f.provider.submit(envelope);
    expect(complete.status).toBe('completed');
    if (complete.status !== 'completed' || complete.completion.outcome.kind !== 'result') throw new Error('missing result');
    const value = complete.completion.outcome.value as unknown as { structuredResult: { score: number; passed: boolean };
      structuredResultRef: ArtifactRef; receiptRef: ArtifactRef };
    expect(value.structuredResult).toEqual({ score: 0.5, passed: false });
    expect(f.artifacts.getJson(value.structuredResultRef)).toEqual(value.structuredResult);
    expect(f.artifacts.getJson(value.receiptRef)).toMatchObject({ bindingUse: 'host-admission-only' });
    expect((await f.provider.inspect(envelope)).status).toBe('completed');
  });

  it('rejects omitted or duplicated physical repetitions and mismatched binding/campaign/task', async () => {
    const f = await fixture();
    await expect(f.provider.preflight(f.feedback([f.first]))).rejects.toThrow(/count mismatch/);
    await expect(f.provider.preflight(f.feedback([f.first, f.first]))).rejects.toThrow(/repetition mismatch/);
    for (const pair of [
      await f.producer('wrong-campaign', 0.9, { campaignId: 'other' }),
      await f.producer('wrong-task', 0.9, { taskId: 'task-2' }),
      await f.producer('wrong-binding', 0.9, { bindingDigest: sha256('other-binding') }),
    ]) await expect(f.provider.preflight(f.feedback([f.first, pair]))).rejects.toThrow();
  });

  it('rejects nonstandard, incomplete, and out-of-range scoring instead of fabricating a measurement', async () => {
    const f = await fixture();
    for (const pair of [
      await f.producer('legacy', 0.7, { normalization: 'legacy-reward', repeatIndex: 1 }),
      await f.producer('partial', 0.7, { completeness: 'partial', repeatIndex: 1 }),
      await f.producer('out-of-range', 1.2, { repeatIndex: 1 }),
    ]) await expect(f.provider.preflight(f.feedback([f.first, pair]))).rejects.toThrow(/complete standard normalized|sealed physical evaluation/);
  });

  it('rejects duplicate repeat slots or changed sampling while preserving a frozen host scoring policy', async () => {
    const f = await fixture();
    const wrongRepeat = await f.producer('wrong-repeat', 0.8, { repeatIndex: 0 });
    await expect(f.provider.preflight(f.feedback([f.first, wrongRepeat]))).rejects.toThrow(/repeat slot/);
    const wrongCondition = await f.producer('wrong-condition', 0.8, { repeatIndex: 1,
      samplingDigest: sha256('different-sampling') });
    await expect(f.provider.preflight(f.feedback([f.first, wrongCondition]))).rejects.toThrow(/condition mismatch/);
    const identity = f.provider.describe().implementationDigest;
    f.policy.passThreshold = 0.1;
    f.policy.expectedAheRepeats = 1;
    const complete = await f.provider.submit(f.feedback());
    expect(complete.status).toBe('completed');
    if (complete.status !== 'completed' || complete.completion.outcome.kind !== 'result') throw new Error('missing result');
    expect((complete.completion.outcome.value as unknown as { structuredResult: unknown }).structuredResult)
      .toEqual({ score: 0.5, passed: false });
    expect(f.provider.describe().implementationDigest).toBe(identity);
  });

  it('rejects reused physical eval or run-attempt despite distinct producer IDs, but allows a different attempt', async () => {
    const f = await fixture();
    const reusedEval = await f.producer('reused-eval', 0.8, { repeatIndex: 1, evalId: 'eval_first' });
    await expect(f.provider.preflight(f.feedback([f.first, reusedEval]))).rejects.toThrow(/counted twice/);
    const runId = `run_${sha256('first').slice(0, 32)}`;
    const reusedAttempt = await f.producer('reused-attempt', 0.8, { repeatIndex: 1, runId });
    await expect(f.provider.preflight(f.feedback([f.first, reusedAttempt]))).rejects.toThrow(/counted twice/);
    const differentAttempt = await f.producer('different-attempt', 0.8, { repeatIndex: 1, runId, attempt: 2 });
    await expect(f.provider.preflight(f.feedback([f.first, differentAttempt]))).resolves.toBeUndefined();
  });

  it('accepts reversed two-Skill selection only with a canonical physical overlay receipt and commit', async () => {
    const f = await fixture();
    const alpha = f.artifacts.putJson({ schemaVersion: 1, markdown: '---\nname: alpha\ndescription: Alpha.\n---\n' }, 'skills.body.v1');
    const zeta = f.artifacts.putJson({ schemaVersion: 1, markdown: '---\nname: zeta\ndescription: Zeta.\n---\n' }, 'skills.body.v1');
    const library = f.artifacts.putJson({ schemaVersion: 1, skills: [
      { name: 'alpha', contentRef: alpha }, { name: 'zeta', contentRef: zeta },
    ] }, 'skills.library.v1');
    const bindingSetRef = f.bindings.create({ harness: f.harness, skills: library });
    const selected = [zeta, alpha]; // Retriever order, intentionally different from physical name order.
    const canonical = [alpha.digest, zeta.digest];
    const operationId = sha256('evo-two-skills-producer');
    const input = { task: f.task, taskViewRef: f.taskViewRef,
      samplingDigest: sha256('sampling'), environmentDigest: sha256('environment'),
      recipePhase: 'evo.batch', skillBindingSetDigest: bindingSetRef.digest, injectedSkillRefs: selected };
    const producer: OperationEnvelope = { operationId, idempotencyKey: operationId,
      campaignId: 'campaign', decisionIndex: 0, localKey: 'evo-rollout', kind: 'execution.rollout',
      input, inputDigest: jsonDigest(input), implementationDigest: sha256('physical-hitch-with-overlay'),
      bindingSetRef, limits: {} };
    const commitOid = 'f'.repeat(40), manifestDigest = `sha256:${'e'.repeat(64)}`;
    const identity = { provider: 'recorded-Hitch', effectiveConfigDigest: `sha256:${'c'.repeat(64)}`,
      evalId: 'eval_evo' };
    const requestDigest = `sha256:${'d'.repeat(64)}`;
    const evidenceRef = f.artifacts.putJson({ schemaVersion: 1, kind: 'hitch-daemon-evaluation',
      submittedIdentity: identity, requestDigest,
      evidence: { ...identity, dataset: 'synthetic', conditionId: 'condition',
        requestedCommit: commitOid, actualCommit: commitOid, revisionIdentity: 'revision',
        completeness: 'complete', plannedTrialCount: 1, primaryReward: 0.9,
        summary: { total: 1, passed: 1, failed: 0, score: 0.9 },
        trials: [{ taskName: f.task.id, trialName: 'evo', runId: `run_${'e'.repeat(32)}`, attempt: 1,
          status: 'completed', rewards: { reward: 0.9 }, scores: { totalScore: 0.9, normalization: 'standard' } }],
        invalidTrials: [] } }, 'execution.rollout.evidence.v1');
    const overlayReceiptRef = f.artifacts.putJson({ schemaVersion: 1, operationId,
      baseHarness: f.artifacts.getJson(f.harness), bindingSetDigest: bindingSetRef.digest,
      skillsLibraryDigest: library.digest, commitOid, manifestDigest,
      injectedSkillDigests: canonical, paths: ['skills/alpha/SKILL.md', 'skills/zeta/SKILL.md'] },
    'skills.overlay.receipt.v1');
    const receiptRef = f.artifacts.putJson({ schemaVersion: 1, providerImplementationDigest: producer.implementationDigest,
      operationId, inputDigest: producer.inputDigest, loadedBindingSetDigest: bindingSetRef.digest,
      evidenceDigest: evidenceRef.digest, actualBindings: { harness: f.harness.digest, skills: library.digest },
      executionIdentity: 'verified-evo', executedHarnessCommit: commitOid,
      skillOverlayReceiptRef: overlayReceiptRef, injectedSkillDigests: canonical }, 'execution.receipt.v1');
    const authorization = { evidenceRef, receiptRef };
    const completion = { operationId, idempotencyKey: operationId, inputDigest: producer.inputDigest,
      implementationDigest: producer.implementationDigest, outcome: { kind: 'result', value: {
        requestedBindingSetDigest: bindingSetRef.digest, actualBindings: { harness: f.harness, skills: library },
        evidenceRef, receiptRef } } };
    await writeFile(join(f.stateRoot, 'algorithm-hitch-operations', `${operationId}.json`),
      JSON.stringify({ envelope: producer, requestDigest, status: 'completed', identity,
        overlay: { receiptRef: overlayReceiptRef, commitOid, manifestDigest,
          injectedSkillDigests: canonical }, completion }));
    const feedbackInput = { mode: 'evo.task-feedback', task: f.task, taskViewRef: f.taskViewRef,
      authorizedRollouts: [authorization], rolloutEvidenceRef: evidenceRef, injectedSkillRefs: selected };
    const feedbackId = sha256('evo-feedback');
    const feedback: OperationEnvelope = { operationId: feedbackId, idempotencyKey: feedbackId,
      campaignId: 'campaign', decisionIndex: 1, localKey: 'feedback', kind: 'execution.feedback',
      input: feedbackInput, inputDigest: jsonDigest(feedbackInput),
      implementationDigest: f.provider.describe().implementationDigest, bindingSetRef, limits: {} };
    const result = await f.provider.submit(feedback);
    expect(result.status).toBe('completed');
    if (result.status !== 'completed' || result.completion.outcome.kind !== 'result') throw new Error('missing Evo feedback');
    expect((result.completion.outcome.value as unknown as { structuredResult: unknown }).structuredResult)
      .toEqual({ score: 0.9, passed: true });
    const changedInput = { ...feedbackInput, injectedSkillRefs: [alpha, zeta] };
    await expect(f.provider.preflight({ ...feedback, input: changedInput, inputDigest: jsonDigest(changedInput) }))
      .rejects.toThrow(/exact physical Skill injection/);
    const wrongCommit = f.artifacts.putJson({ ...f.artifacts.getJson(receiptRef) as object,
      executedHarnessCommit: '1'.repeat(40) }, 'execution.receipt.v1');
    const invalidInput = { ...feedbackInput, authorizedRollouts: [{ evidenceRef, receiptRef: wrongCommit }] };
    await expect(f.provider.preflight({ ...feedback, input: invalidInput, inputDigest: jsonDigest(invalidInput) }))
      .rejects.toThrow();
  });
});
