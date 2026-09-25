import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { sha256 } from '../../src/algorithm/artifacts.js';
import { PythonWorker } from '../../src/algorithm/hosts/python.js';
import { AuthorProcessReplayPort } from '../../src/algorithm/author/process-port.js';
import { AUTHOR_WIRE_VERSION_V2, algorithm, authorIntentDigest, replay,
  type AuthorAtomic, type AuthorHistoryEntry, type AuthorReplayRequest, type EvaluationV1 } from '../../src/algorithm/author/index.js';

const interpreter = [process.env.GEAR_TEST_PYTHON, '/opt/homebrew/bin/python3.11', 'python3.11'].find(candidate => {
  if (!candidate) return false;
  try { return execFileSync(candidate, ['-c', 'import sys; print(int(sys.version_info >= (3,11)))'],
    { encoding: 'utf8', timeout: 3000 }).trim() === '1'; } catch { return false; }
});
const hash = (text: string) => sha256(text);
const taskView = { kind: 'artifact' as const, digest: hash('source-task-view'), size: 10,
  mediaType: 'application/json', schemaId: 'task.view.v1' };
const selectedView = { ...taskView, digest: hash('selected-task-view') };
const baseline = { schemaVersion: 1 as const, kind: 'harness-agent' as const,
  bindingSetRef: { kind: 'binding-set' as const, digest: hash('baseline-binding'), schemaId: 'binding.set.v1' },
  executionProfileDigest: hash('profile') };
const candidate = { ...baseline,
  bindingSetRef: { ...baseline.bindingSetRef, digest: hash('candidate-binding') }, proposalIndex: 0 };
const selection = { schemaVersion: 1 as const, taskViewRef: selectedView,
  selectedTaskIds: ['task-1', 'task-2'], cursor: { viewDigest: selectedView.digest, nextIndex: 0 as const } };
const capabilities = { version: 'gear.author.capabilities.v1' as const, lockDigest: hash('lock'), roles: {},
  operationLimits: { 'execution.rollout': { 'rollout.trials': 1 } },
  execution: { selection: { schemaVersion: 1, metric: { id: 'pass_rate', direction: 'maximize',
    comparisonPrecision: 0.01, contractDigest: `sha256:${hash('metric')}` } },
  evaluation: { schemaVersion: 1, repeatCount: 1, maxTrials: 4, recipePhase: 'author.evaluate',
    samplingDigest: `sha256:${hash('sampling')}`, environmentDigest: `sha256:${hash('environment')}` } } };
const request: AuthorReplayRequest = { version: AUTHOR_WIRE_VERSION_V2,
  input: { initialAgent: baseline, data: { searchTasks: taskView, candidate }, config: {}, capabilities }, history: [] };
const definition = algorithm(async ctx => {
  const selected = await ctx.tasks.sample(ctx.data.searchTasks, { count: 2, seed: 7 });
  const settled = await ctx.parallel([
    ctx.evaluate(ctx.initialAgent, { tasks: selected }),
    ctx.evaluate(candidate, { tasks: selected }),
  ]);
  const values = settled.flatMap(item => item.ok ? [item.value] : []);
  const winner = ctx.select(values, { metric: 'pass_rate', requireImprovement: true }).agent;
  return ctx.result({ selected: winner, outputs: { selection: selected, evaluations: settled } });
});
function sealed(item: AuthorAtomic, outcome: AuthorHistoryEntry['outcome']): AuthorHistoryEntry {
  return { address: item.address, kind: item.kind, definitionVersion: item.definitionVersion,
    operationId: hash(`operation:${item.address}`), inputDigest: authorIntentDigest(item), outcome };
}
function measurement(subject: typeof baseline, passRate: number): EvaluationV1 {
  const evidenceRef = { ...taskView, digest: hash(`evidence:${subject.bindingSetRef.digest}`), schemaId: 'execution.rollout.evidence.v1' };
  return { schemaVersion: 1, subject, taskViewRef: selectedView, status: 'complete', comparable: true,
    comparisonKey: hash('same-condition'), metrics: { pass_rate: passRate },
    measurementRef: { ...taskView, digest: hash(`measurement:${subject.bindingSetRef.digest}`), schemaId: 'measurement.record.v1' },
    trials: selection.selectedTaskIds.map(taskId => ({ taskId, repeatIndex: 0, status: 'completed', evidenceRef })),
    evidenceRefs: [evidenceRef] };
}

(interpreter ? it : it.skip)('replays a shared TaskSelection through two real-language worker evaluation frontiers', async () => {
  const port = new AuthorProcessReplayPort(resolve('tests/fixtures/algorithm-author-a1-evaluate.mjs'),
    'sample', resolve('lib/algorithm/author/worker-entry.js'), 10_000, undefined, undefined, AUTHOR_WIRE_VERSION_V2);
  const worker = await PythonWorker.start({ configDir: resolve('packages/python-sdk/tests/fixtures'),
    module: 'author_a1_evaluate.py', export: 'sample', interpreter: interpreter!,
    sdkPath: resolve('packages/python-sdk/src'), mode: 'author' });
  const history: AuthorHistoryEntry[] = [];
  const compare = async (rows: AuthorHistoryEntry[] = history) => {
    const next = { ...request, history: rows } as AuthorReplayRequest;
    const typescript = await replay(definition, next);
    expect(await worker.call('author.replay', next)).toEqual(typescript);
    expect(await port.replay(next)).toEqual(typescript);
    return typescript;
  };
  try {
    const sampled = await compare();
    if (sampled.status !== 'waiting') throw new Error('expected sample');
    expect(sampled.frontier.map(item => item.kind)).toEqual(['tasks.sample']);
    history.push(sealed(sampled.frontier[0]!, { kind: 'result', value: selection }));
    const consumed = await compare();
    if (consumed.status !== 'waiting') throw new Error('expected consume');
    expect(consumed.frontier.map(item => item.kind)).toEqual(['tasks.consume', 'tasks.consume']);
    const task = (id: string) => ({ id, contentRef: { ...taskView, digest: hash(`task:${id}`) },
      purpose: 'development', exposure: { seenInTraining: false, graderLabelExposed: false }, ancestry: [] });
    const forgedCursor = sealed(consumed.frontier[0]!, { kind: 'result', value: {
      tasks: selection.selectedTaskIds.map(task), cursor: { viewDigest: selectedView.digest, nextIndex: 2, extra: true } } });
    const forgedRequest = { ...request, history: [...history, forgedCursor] } as AuthorReplayRequest;
    await expect(replay(definition, forgedRequest)).rejects.toThrow('exact signed TaskSelection');
    await expect(worker.call('author.replay', forgedRequest)).rejects.toThrow('exact signed TaskSelection');
    await expect(port.replay(forgedRequest)).rejects.toThrow('exact signed TaskSelection');
    for (const item of consumed.frontier) history.push(sealed(item, { kind: 'result', value: {
      tasks: selection.selectedTaskIds.map(task), cursor: { viewDigest: selectedView.digest, nextIndex: 2 } } }));
    const rollouts = await compare();
    if (rollouts.status !== 'waiting') throw new Error('expected rollout');
    expect(rollouts.frontier).toHaveLength(4);
    expect(rollouts.frontier.every(item => item.kind === 'execution.rollout' && item.limits?.['rollout.trials'] === 1)).toBe(true);
    for (const item of rollouts.frontier) history.push(sealed(item, { kind: 'result', value: null }));
    const measured = await compare();
    if (measured.status !== 'waiting') throw new Error('expected measurement');
    expect(measured.frontier).toHaveLength(2);
    expect(measured.frontier.every(item => item.kind === 'author.measurement'
      && (item.input as { producerOperationIds: string[] }).producerOperationIds.length === 2)).toBe(true);
    for (const item of measured.frontier) {
      const subject = (item.input as { subject: typeof baseline }).subject;
      history.push(sealed(item, { kind: 'result', value: measurement(subject,
        subject.bindingSetRef.digest === baseline.bindingSetRef.digest ? 0.4 : 0.6) }));
    }
    const final = await compare();
    expect(final.status).toBe('completed');
    if (final.status === 'completed') expect((final.result as { selected: unknown }).selected).toEqual(candidate);
    expect(await compare()).toEqual(final);

    const rolloutHistory = history.slice(0, -2);
    const failedRollout = rolloutHistory.find(item => item.kind === 'execution.rollout'
      && rollouts.frontier.find(frontier => frontier.address === item.address)?.bindingSetRef?.digest
        === candidate.bindingSetRef.digest)!;
    const failedHistory = rolloutHistory.map(item => item.address === failedRollout.address ? {
      ...item, outcome: { kind: 'error' as const, code: 'TASK_FAILED', message: 'sealed business failure' },
    } : item);
    const pending = await compare(failedHistory.filter(item => item.address !== failedRollout.address));
    if (pending.status !== 'waiting') throw new Error('expected one unknown rollout');
    expect(pending.frontier.map(item => item.address)).toContain(failedRollout.address);
    expect(pending.frontier.some(item => item.kind === 'author.measurement'
      && item.bindingSetRef?.digest === candidate.bindingSetRef.digest)).toBe(false);
    const failureMeasurement = await compare(failedHistory);
    if (failureMeasurement.status !== 'waiting') throw new Error('expected measurement after terminal failure');
    expect(failureMeasurement.frontier.map(item => item.kind)).toEqual(['author.measurement', 'author.measurement']);
    const candidateMeasurement = failureMeasurement.frontier.find(item => item.bindingSetRef?.digest
      === candidate.bindingSetRef.digest)!;
    expect((candidateMeasurement.input as { producerOperationIds: string[] }).producerOperationIds)
      .toContain(failedRollout.operationId);
    const incomplete: EvaluationV1 = { schemaVersion: 1, subject: candidate, taskViewRef: selectedView,
      status: 'incomplete', comparable: false, trials: [{ taskId: 'task-1', repeatIndex: 0, status: 'failed',
        code: 'TASK_FAILED' }], evidenceRefs: [] };
    const failedFinished = [...failedHistory, ...failureMeasurement.frontier.map(item => sealed(item,
      { kind: 'result', value: item.bindingSetRef?.digest === candidate.bindingSetRef.digest
        ? incomplete : measurement(baseline, 0.4) }))];
    const chosenBaseline = await compare(failedFinished);
    expect(chosenBaseline.status).toBe('completed');
    if (chosenBaseline.status === 'completed')
      expect((chosenBaseline.result as { selected: unknown }).selected).toEqual(baseline);
  } finally { await worker.close(); }
});

it('rejects a selection exceeding the frozen trial bound before creating any rollout call', async () => {
  const direct = algorithm(async ctx => await ctx.evaluate(ctx.initialAgent, { tasks: selection }));
  const bounded: AuthorReplayRequest = { ...request, input: { ...request.input,
    capabilities: { ...capabilities, execution: { ...capabilities.execution,
      evaluation: { ...capabilities.execution.evaluation, maxTrials: 1 } } } }, history: [] };
  await expect(replay(direct, bounded)).rejects.toThrow('finite trial bound');
  const wrongProfile = { ...candidate, executionProfileDigest: hash('other-profile') };
  const drift = algorithm(async ctx => await ctx.evaluate(wrongProfile, { tasks: selection }));
  await expect(replay(drift, request)).rejects.toThrow('subject profile');
});
