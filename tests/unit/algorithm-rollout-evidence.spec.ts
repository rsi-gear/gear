import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileArtifactStore, sha256 } from '../../src/algorithm/artifacts.js';
import type { ArtifactRef, OperationEnvelope } from '../../src/algorithm/contracts.js';
import { jsonDigest } from '../../src/algorithm/schema.js';
import { createRoleRolloutEvidenceTools, type RolloutEvidenceAuthorization } from '../../src/algorithm/providers/rollout-evidence.js';
import type { HitchTrajectoryReader } from '../../src/types.js';

const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gear-rollout-evidence-'));
  paths.push(root);
  const artifacts = new FileArtifactStore(join(root, 'artifacts'));
  const stateRoot = join(root, 'state');
  const recordDir = join(stateRoot, 'algorithm-hitch-operations');
  await mkdir(recordDir, { recursive: true });
  const runId = `run_${'a'.repeat(32)}`;
  const canonicalSha256 = `sha256:${'b'.repeat(64)}`;
  const requestDigest = `sha256:${'c'.repeat(64)}`;
  const identity = { provider: 'offline-Hitch-fixture', effectiveConfigDigest: `sha256:${'d'.repeat(64)}` };
  const evidence = { ...identity, evalId: 'eval_offline_1', dataset: 'seed', conditionId: 'condition',
    requestedCommit: 'commit', actualCommit: 'commit', revisionIdentity: 'revision',
    completeness: 'complete', plannedTrialCount: 1, primaryReward: 0.75,
    summary: { total: 1, passed: 1, failed: 0, score: 0.75 },
    trials: [{ taskName: 'task-1', trialName: 'trial-1', runId, attempt: 1,
      status: 'completed', rewards: { reward: 0.75 }, scores: { totalScore: 0.75, normalization: 'standard' } }],
    invalidTrials: [] };
  const evidenceRef = artifacts.putJson({ schemaVersion: 1, kind: 'hitch-daemon-evaluation',
    evidence, submittedIdentity: identity, requestDigest }, 'execution.rollout.evidence.v1');
  const producerId = sha256('rollout-producer');
  const bindingSetRef = { kind: 'binding-set' as const, digest: sha256('binding'), schemaId: 'test.bindings.v1' };
  const producerInput = { task: { id: 'task-1' } };
  const producer: OperationEnvelope = { operationId: producerId, idempotencyKey: producerId,
    campaignId: 'same-campaign', decisionIndex: 0, localKey: 'rollout', kind: 'execution.rollout',
    input: producerInput, inputDigest: jsonDigest(producerInput), implementationDigest: sha256('physical-Hitch'),
    bindingSetRef, limits: {} };
  const receiptRef = artifacts.putJson({ schemaVersion: 1, providerImplementationDigest: producer.implementationDigest,
    operationId: producerId, inputDigest: producer.inputDigest, loadedBindingSetDigest: bindingSetRef.digest,
    evidenceDigest: evidenceRef.digest, actualBindings: {}, executionIdentity: 'physical-eval' },
  'execution.receipt.v1');
  const authorization: RolloutEvidenceAuthorization = { evidenceRef, receiptRef };
  const completion = { operationId: producerId, idempotencyKey: producerId,
    inputDigest: producer.inputDigest, implementationDigest: producer.implementationDigest,
    outcome: { kind: 'result', value: { requestedBindingSetDigest: bindingSetRef.digest,
      actualBindings: {}, evidenceRef, receiptRef } } };
  const journalPath = join(recordDir, `${producerId}.json`);
  const journal = { envelope: producer, requestDigest, intent: { idempotencyKey: 'fixture' },
    status: 'completed', identity, completion };
  await writeFile(journalPath, JSON.stringify(journal));
  const roleInput = { roleId: 'rho.pairPreference', baselineRollout: authorization };
  const role: OperationEnvelope = { ...producer, operationId: sha256('role-consumer'),
    idempotencyKey: sha256('role-consumer'), decisionIndex: 1, localKey: 'preference', kind: 'execution.role',
    input: roleInput, inputDigest: jsonDigest(roleInput) };
  const calls: string[] = [];
  const reader = {
    async inspectCapabilities() { calls.push('capabilities'); return { schemaVersion: 1, trajectoryAnalysis: 1, trajectoryEventsPage: 1 }; },
    async inspectTrajectoryAnalysis(id: string) {
      calls.push(`analysis:${id}`);
      return { schemaVersion: 1, kind: 'trajectory-analysis', runId: id,
        source: { canonicalSha256 }, coverage: { surface: 'complete' }, redactions: [] };
    },
    async inspectTrajectoryEvents(id: string, query: { eventTypes?: string[] }) {
      calls.push(`events:${id}`);
      return { schemaVersion: 1, kind: 'trajectory-events-page', runId: id, canonicalSha256,
        filter: { eventTypes: query.eventTypes }, events: [{ seq: 1, type: 'assistant/message',
          content: 'A real action in held-out-private with password=fixture-secret',
          graderScore: 99, nested: '{"score":99,"message":"ok"}',
          credential: 'fixture-secret' }], totalMatches: 1, eof: true };
    },
  } as unknown as HitchTrajectoryReader;
  const options = { stateRoot, artifacts, trajectoryReader: reader, heldOutRef: 'held-out-private' };
  return { artifacts, stateRoot, role, authorization, evidenceRef, receiptRef, journal, journalPath,
    options, calls, producerId };
}

describe('recorded physical Hitch rollout evidence for role-bound tools', () => {
  it('projects actual Hitch trace with redaction and no unapproved score', async () => {
    const f = await fixture();
    const tools = createRoleRolloutEvidenceTools(f.options, f.role);
    const page = await tools.query(f.authorization);
    expect(page.traceRefs).toHaveLength(2); // projection receipt + selected event
    expect(page.reportRef.schemaId).toBe('execution.rollout.task-report.v1');
    const report = JSON.parse((await tools.read(f.authorization, page.reportRef.digest)).text) as Record<string, unknown>;
    expect(report).toMatchObject({ producerOperationId: f.producerId, taskId: 'task-1', traceChunkCount: 2 });
    expect(report).not.toHaveProperty('primaryReward');
    const eventText = (await tools.read(f.authorization, page.traceRefs[1]!.digest)).text;
    expect(eventText).toContain('A real action');
    expect(eventText).not.toContain('fixture-secret');
    expect(eventText).not.toContain('held-out-private');
    expect(eventText).not.toContain('99');
    expect(f.calls).toContain(`analysis:run_${'a'.repeat(32)}`);
    expect(f.calls.filter(call => call.startsWith('analysis:'))).toHaveLength(1);
    expect(tools.usage()).toMatchObject({ returnedItems: 5, requests: 3 });
    expect(tools.usage().returnedBytes).toBeGreaterThan(Buffer.byteLength(eventText));
    const scored = createRoleRolloutEvidenceTools({ ...f.options, exposeMeasurement: true }, f.role);
    const scoredPage = await scored.query(f.authorization);
    const scoredReport = JSON.parse((await scored.read(f.authorization, scoredPage.reportRef.digest)).text) as Record<string, unknown>;
    expect(scoredReport.primaryReward).toBe(0.75);
  });

  it('requires the exact input pair and refuses arbitrary artifact digests', async () => {
    const f = await fixture();
    const tools = createRoleRolloutEvidenceTools(f.options, f.role);
    const unrelated = f.artifacts.putJson({ text: 'private' }, 'private.v1');
    await expect(tools.read(f.authorization, unrelated.digest)).rejects.toThrow(/not authorized/);
    const otherReceipt = f.artifacts.putJson({ operationId: sha256('other') }, 'execution.receipt.v1');
    await expect(tools.query({ evidenceRef: f.evidenceRef, receiptRef: otherReceipt })).rejects.toThrow(/not named/);
    expect(f.calls).toContain('capabilities');
  });

  it('rejects unfinished, foreign-campaign and mismatched producer journals before opening a trace', async () => {
    const f = await fixture();
    const tools = createRoleRolloutEvidenceTools(f.options, f.role);
    for (const changed of [
      { ...f.journal, status: 'reserved' },
      { ...f.journal, envelope: { ...f.journal.envelope, campaignId: 'another-campaign' } },
      { ...f.journal, completion: { ...f.journal.completion,
        outcome: { kind: 'result', value: { ...(f.journal.completion.outcome.value), evidenceRef: {
          ...(f.journal.completion.outcome.value.evidenceRef as ArtifactRef), digest: sha256('swapped') } } } } },
      { ...f.journal, requestDigest: 'sha256:changed' },
    ]) {
      await writeFile(f.journalPath, JSON.stringify(changed));
      await expect(tools.query(f.authorization)).rejects.toThrow();
    }
    expect(f.calls).toEqual([]);
    const original = await readFile(f.journalPath, 'utf8');
    expect(original).toContain('sha256:changed');
  });
});
