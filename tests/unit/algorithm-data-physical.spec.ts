import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileArtifactStore, sha256 } from '../../src/algorithm/artifacts.js';
import { BindingStore } from '../../src/algorithm/bindings.js';
import { jsonDigest } from '../../src/algorithm/schema.js';
import { sealExperienceView } from '../../src/algorithm/data/experience.js';
import { HistoricalSeedExperienceSource } from '../../src/algorithm/data/history-source.js';
import { TaskViewAuthority, readTaskView, taskViewFromExperience } from '../../src/algorithm/data/tasks.js';
import { HitchRolloutPort, createHitchRolloutAdapter } from '../../src/algorithm/providers/hitch.js';
import { EvolutionRegistryStore } from '../../src/state/evolution.js';
import { digestJson } from '../../src/state/digest.js';
import { HarnessBuilder, NoopHarnessCompiler } from '../../src/harness/builder.js';
import { createGitHarnessFixture } from '../helpers/git-fixture.js';
import { createRecordedHitchCliFixture } from '../helpers/algorithm-hitch-recorded-cli.js';
import { standardSearchDataset } from '../helpers/standard-search-dataset.js';
import { evolutionSpec, roundFixture } from '../helpers/research-fixture.js';
import type { EvaluationCondition, EvaluationEvidence, EvaluationRequest, RefinementRound } from '../../src/types.js';
import type { HitchCliEvaluator } from '../../src/evaluator/hitch-cli.js';
import type { OperationEnvelope } from '../../src/algorithm/contracts.js';

const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function setup(realCli = false) {
  const path = await mkdtemp(join(tmpdir(), 'gear-algorithm-physical-')); paths.push(path);
  const git = await createGitHarnessFixture(); paths.push(git.root);
  const seed = await standardSearchDataset(path, 2, 'seed');
  const held = await standardSearchDataset(path, 1, 'held-out');
  const spec = { ...evolutionSpec(), initialHarness: { ref: git.championRef, digest: git.manifest.digest },
    datasets: { seed: { ref: 'seed', digest: seed.digest }, heldOut: { ref: 'held-out', digest: held.digest } },
    toolchainRef: 'node-22-tsc' };
  const registry = new EvolutionRegistryStore(join(path, 'registry'));
  await registry.createEvolution({ spec, champion: { schemaVersion: 2, ref: git.championRef,
    manifestDigest: git.manifest.digest, updatedAt: 'now' } });
  const base = roundFixture({ workspaceRoot: path, seedTaskRef: 'seed', heldOutRef: 'held-out',
    targetHarnessRef: git.championRef, targetHarnessDigest: git.manifest.digest });
  function condition(original: EvaluationCondition, dataset: { ref: string; digest: string }): EvaluationCondition {
    const { conditionId: ignored, ...body } = original;
    return { ...body, dataset, conditionId: digestJson({ ...body, dataset }) };
  }
  const seedCondition = condition(base.plan.seed, spec.datasets.seed);
  const heldCondition = condition(base.plan.heldOut, spec.datasets.heldOut);
  const round: RefinementRound = { ...base, plan: { ...base.plan, seed: seedCondition, heldOut: heldCondition,
    digest: digestJson({ roundId: base.roundId, taskSampler: base.plan.taskSampler,
      seed: seedCondition, heldOut: heldCondition }) } };
  await registry.stateStore(spec.evolutionId).writeRound(round);
  const artifacts = new FileArtifactStore(join(path, 'artifacts'));
  const source = new HistoricalSeedExperienceSource({ registry, evolutionId: spec.evolutionId,
    roundId: round.roundId, workspaceRoot: path, authorityId: 'host' });
  const viewRef = await sealExperienceView(artifacts, source, await source.selector(), 'research', ['overview']);
  const taskViewRef = taskViewFromExperience(artifacts, viewRef, [{ id: 'task-1', purpose: 'development' }]);
  const authority = new TaskViewAuthority(artifacts, 'task-host', Buffer.alloc(32, 7));
  const signedViewRef = authority.seal({ ...readTaskView(artifacts, taskViewRef) });
  const task = readTaskView(artifacts, signedViewRef).tasks[0]!;
  const bindings = new BindingStore(artifacts, { id: 'rho.bindings.v1', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true },
  } });
  const harness = artifacts.putJson({ schemaVersion: 1, kind: 'git-harness', commitOid: git.championRef,
    manifestDigest: git.manifest.digest }, 'harness.directory.v1');
  const bindingSetRef = bindings.create({ harness });
  const builder = new HarnessBuilder({ repositoryPath: git.repository, targetRoot: git.targetRoot,
    dshBaseRef: git.baseRef, toolchainRef: 'node-22-tsc', sandboxProfileRef: 'sandbox-v1',
    compiler: new NoopHarnessCompiler() });
  const requests: EvaluationRequest[] = [];
  const observations = new Map<string, EvaluationEvidence>();
  let version = 'runtime-A';
  const identity = (request: EvaluationRequest) => ({ provider: 'fixture-physical-evaluator',
    effectiveConfigDigest: digestJson([version, request.condition]), invocationFingerprint: digestJson(version) });
  const fixtureEvaluator = { repositoryPath: git.repository, options: { repositoryPath: git.repository,
    controlPlane: { mode: 'daemon' }, passEnv: [] }, preflight: async () => {},
    prepareSubmission: (_round: RefinementRound, request: EvaluationRequest) => ({ provider: 'fixture-physical-evaluator',
      idempotencyKey: digestJson(request), parameters: { request } }),
    reserve: async (_round: RefinementRound, request: EvaluationRequest) => {
      requests.push(request);
      return { provider: 'fixture-physical-evaluator', evalId: 'eval_fixture_1' };
    },
    recoverReservation: async () => ({ provider: 'fixture-physical-evaluator', evalId: 'eval_fixture_1' }),
    submittedEvaluationIdentity: async (_round: RefinementRound, request: EvaluationRequest) => ({
      ...identity(request), cohortDigest: digestJson('cohort'),
    }),
    cancelReservation: async () => {},
    inspectResult: async (_round: RefinementRound, _request: EvaluationRequest, reservation: { evalId: string }) =>
      observations.has(reservation.evalId) ? { status: 'complete', evidence: observations.get(reservation.evalId) } : { status: 'running' },
  } as unknown as HitchCliEvaluator;
  const recorded = realCli ? await createRecordedHitchCliFixture('0.2.8', {},
    { followSubmission: true, controlPlane: { mode: 'daemon', requireModelCapture: false } }, git) : undefined;
  const evaluator = recorded?.evaluator ?? fixtureEvaluator;
  function finish(request: EvaluationRequest): void {
      const result: EvaluationEvidence = { ...identity(request), evalId: 'eval_fixture_1', conditionId: request.condition.conditionId,
        dataset: request.dataset, requestedCommit: request.harnessRef, actualCommit: request.harnessRef,
        revisionIdentity: digestJson(request.harnessRef), completeness: 'complete', plannedTrialCount: 1,
        primaryReward: 1, summary: { total: 1, passed: 1, failed: 0, score: 1 },
        trials: [{ taskName: 'task-1', trialName: 'trial-1', runId: `run_${'1'.repeat(32)}`, attempt: 1,
          status: 'completed', rewards: { reward: 1 }, scores: { totalScore: 1, processScore: 1, normalization: 'standard' } }],
        invalidTrials: [] };
      observations.set(result.evalId, result);
  }
  const options = { registry, evolutionId: spec.evolutionId, roundId: round.roundId, workspaceRoot: path,
    stateRoot: join(path, 'search-state'), artifacts, bindings, taskAuthority: authority,
    allowedExperienceViewDigests: () => [viewRef.digest], accessPolicyDigest: sha256('task-policy'),
    builder, evaluator, campaignBudget: { 'rollout.trials': { unit: 'trials', limit: 10,
      source: 'hitch-rollout', capability: 'hard' as const } } };
  const port = await HitchRolloutPort.create(options);
  const adapter = await createHitchRolloutAdapter(options);
  const input = { task, taskViewRef: signedViewRef, samplingDigest: port.profile().samplingDigest,
    environmentDigest: port.profile().environmentDigest, recipePhase: 'rho.baseline' };
  const envelope: OperationEnvelope = { operationId: sha256('physical-op'), idempotencyKey: sha256('physical-op'),
    campaignId: 'physical-campaign', decisionIndex: 0, localKey: 'rollout', kind: 'execution.rollout',
    input, inputDigest: jsonDigest(input), implementationDigest: adapter.describe().implementationDigest,
    bindingSetRef, limits: { 'rollout.trials': 1 } };
  return { options, adapter, envelope, requests, finish: () => finish(requests[0]!),
    changeRuntime: () => { version = 'runtime-B'; }, task, artifacts, recorded };
}

describe('S3b Hitch rollout bridge CPU contract (fixture evaluator, no model run)', () => {
  it('uses physical Git harness and compiled task source; recovers sealed evidence without a second evaluation', async () => {
    const f = await setup();
    const first = await f.adapter.submit(f.envelope);
    expect(first.status).toBe('running');
    expect((await f.adapter.inspect(f.envelope)).status).toBe('running');
    f.finish();
    const done = await f.adapter.inspect(f.envelope);
    expect(done.status).toBe('completed');
    if (done.status !== 'completed' || done.completion.outcome.kind !== 'result') throw new Error('missing physical result');
    expect(done.completion.receipt?.cumulative).toEqual({ 'rollout.trials': 1 });
    const value = done.completion.outcome.value as unknown as { evidenceRef: { digest: string }; receiptRef: { digest: string } };
    expect(value.evidenceRef.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(f.requests).toHaveLength(1);
    const restored = await createHitchRolloutAdapter(f.options);
    expect((await restored.inspect(f.envelope)).status).toBe('completed');
    expect(f.requests).toHaveLength(1);
    f.changeRuntime();
    const changed = await createHitchRolloutAdapter(f.options);
    expect(changed.describe().implementationDigest).toBe(f.adapter.describe().implementationDigest);
    expect((await changed.inspect(f.envelope)).status).toBe('completed');
  });
  it('rejects recipe-forged skill injection and task payload before physical submission', async () => {
    const f = await setup();
    await expect(f.adapter.preflight({ ...f.envelope, input: { ...f.envelope.input as object,
      injectedSkillRefs: [f.task.contentRef] } })).rejects.toThrow(/unsupported skill injection/);
    await expect(f.adapter.preflight({ ...f.envelope, input: { ...f.envelope.input as object,
      task: { ...f.task, id: 'task-0' } } })).rejects.toThrow(/not an authorized research task/);
    expect(f.requests).toHaveLength(0);
  });
  it('uses the real HitchCliEvaluator daemon CLI protocol and completes by read-only inspection', async () => {
    const f = await setup(true);
    const started = await f.adapter.submit(f.envelope);
    expect(started.status).toBe('running');
    const callsAfterSubmit = (await readFile(f.recorded!.invocationLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
    expect(callsAfterSubmit.filter(args => args.includes('submit'))).toHaveLength(1);
    expect(callsAfterSubmit.filter(args => args.includes('inspect'))).toHaveLength(0);
    const done = await f.adapter.inspect(f.envelope);
    expect(done.status).toBe('completed');
    if (done.status !== 'completed') throw new Error('missing physical completion');
    expect(done.completion.receipt?.cumulative).toEqual({ 'rollout.trials': 1 });
    const restored = await createHitchRolloutAdapter(f.options);
    expect((await restored.inspect(f.envelope)).status).toBe('completed');
    const calls = (await readFile(f.recorded!.invocationLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
    expect(calls.filter(args => args.includes('submit'))).toHaveLength(1);
  });
  it('never replays a daemon submit when cancelling an intent whose reservation was not saved', async () => {
    const f = await setup(true);
    const started = await f.adapter.submit(f.envelope);
    expect(started.status).toBe('running');
    const journal = join(f.options.stateRoot, 'algorithm-hitch-operations', `${f.envelope.operationId}.json`);
    const saved = JSON.parse(await readFile(journal, 'utf8')) as Record<string, unknown>;
    delete saved.reservation;
    saved.status = 'intent';
    await writeFile(journal, JSON.stringify(saved));
    await rm(f.recorded!.submissionState);
    const cancelled = await f.adapter.cancel(f.envelope);
    expect(cancelled.status).toBe('unknown');
    const calls = (await readFile(f.recorded!.invocationLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
    expect(calls.filter(args => args.includes('submit'))).toHaveLength(1);
    expect(calls.some(args => args.includes('list'))).toBe(true);
  });
  it('finds an accepted submission by key before cancelling and confirms release without another submit', async () => {
    const f = await setup(true);
    expect((await f.adapter.submit(f.envelope)).status).toBe('running');
    const journal = join(f.options.stateRoot, 'algorithm-hitch-operations', `${f.envelope.operationId}.json`);
    const saved = JSON.parse(await readFile(journal, 'utf8')) as Record<string, unknown>;
    delete saved.reservation;
    saved.status = 'intent';
    await writeFile(journal, JSON.stringify(saved));
    const cancelled = await f.adapter.cancel(f.envelope);
    expect(cancelled.status).toBe('cancelled');
    if (cancelled.status !== 'cancelled') throw new Error('cancellation did not settle');
    expect(cancelled.releaseConfirmed).toBe(true);
    expect(cancelled.receipt?.cumulative).toEqual({ 'rollout.trials': 1 });
    const calls = (await readFile(f.recorded!.invocationLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
    expect(calls.filter(args => args.includes('submit'))).toHaveLength(1);
    expect(calls.filter(args => args.includes('cancel'))).toHaveLength(1);
    expect((await f.adapter.inspect(f.envelope)).status).toBe('cancelled');
  });
  it('persists a zero-cost prestart cancellation tombstone and forbids late submission', async () => {
    const f = await setup();
    const cancelled = await f.adapter.cancel(f.envelope);
    expect(cancelled.status).toBe('cancelled');
    if (cancelled.status !== 'cancelled') throw new Error('cancellation did not settle');
    expect(cancelled.receipt?.cumulative).toEqual({ 'rollout.trials': 0 });
    await expect(f.adapter.submit(f.envelope)).rejects.toThrow(/cancelled before submission/);
    expect(f.requests).toHaveLength(0);
  });
});
