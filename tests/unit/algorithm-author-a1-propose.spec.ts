import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { sha256 } from '../../src/algorithm/artifacts.js';
import { AuthorProcessReplayPort } from '../../src/algorithm/author/process-port.js';
import { PythonWorker } from '../../src/algorithm/hosts/python.js';
import { AUTHOR_WIRE_VERSION_V2, algorithm, authorIntentDigest, replay,
  type AuthorAtomic, type AuthorHistoryEntry, type AuthorReplayRequest, type EvaluationV1 } from '../../src/algorithm/author/index.js';

const hash = (value: string) => sha256(value);
const taskView = { kind: 'artifact' as const, digest: hash('proposal-view'), size: 10,
  mediaType: 'application/json', schemaId: 'task.view.v1' };
const parent = { schemaVersion: 1 as const, kind: 'harness-agent' as const,
  bindingSetRef: { kind: 'binding-set' as const, digest: hash('parent-binding'), schemaId: 'binding.set.v1' },
  executionProfileDigest: hash('execution-profile') };
const feedback: EvaluationV1 = { schemaVersion: 1, subject: parent, taskViewRef: taskView,
  status: 'complete', comparable: true, comparisonKey: hash('conditions'), metrics: { pass_rate: 0.5 },
  measurementRef: { ...taskView, digest: hash('measurement'), schemaId: 'measurement.record.v1' },
  trials: [{ taskId: 'task-1', repeatIndex: 0, status: 'completed', evidenceRef: { ...taskView,
    digest: hash('evidence'), schemaId: 'execution.rollout.evidence.v1' } }],
  evidenceRefs: [{ ...taskView, digest: hash('evidence'), schemaId: 'execution.rollout.evidence.v1' }] };
const capabilities = { version: 'gear.author.capabilities.v1' as const, lockDigest: hash('lock'),
  roles: { optimizer: { template: 'harness-editor' as const, kind: 'execution.workspace-edit' as const } },
  operationLimits: { 'execution.workspace-edit': { 'model.requests': 2, 'model.tokens': 1000 } },
  execution: { proposal: { schemaVersion: 1, maxCount: 3 } } };
const request: AuthorReplayRequest = { version: AUTHOR_WIRE_VERSION_V2,
  input: { initialAgent: parent, data: { feedback }, config: {}, capabilities }, history: [] };
type Data = { feedback: EvaluationV1 };
const definition = algorithm<{}, 'v2', Data>(async ctx => {
  const proposals = await ctx.propose(ctx.initialAgent, { feedback: ctx.data.feedback,
    role: 'optimizer', count: 3 });
  return ctx.result({ outputs: { proposals } });
});
function sealed(item: AuthorAtomic, outcome: AuthorHistoryEntry['outcome']): AuthorHistoryEntry {
  return { address: item.address, kind: item.kind, definitionVersion: item.definitionVersion,
    operationId: hash(`operation:${item.address}`), inputDigest: authorIntentDigest(item), outcome };
}
function edited(index: number) {
  const base = { kind: 'artifact' as const, size: 10, mediaType: 'application/json' };
  return { requestedBindingSetDigest: parent.bindingSetRef.digest, actualBindings: {},
    producedArtifactRef: { ...base, digest: hash(`harness:${index}`), schemaId: 'harness.directory.v1' },
    evidenceRef: { ...base, digest: hash(`edit-evidence:${index}`), schemaId: 'execution.workspace-edit.evidence.v1' },
    receiptRef: { ...base, digest: hash(`edit-receipt:${index}`), schemaId: 'execution.receipt.v1' },
    validationReceiptRef: { ...base, digest: hash(`edit-validation:${index}`), schemaId: 'execution.workspace-edit.validation.v1' } };
}
const interpreter = [process.env.GEAR_TEST_PYTHON, '/opt/homebrew/bin/python3.11', 'python3.11'].find(value => {
  if (!value) return false;
  try { return execFileSync(value, ['-c', 'import sys; print(int(sys.version_info >= (3,11)))'],
    { encoding: 'utf8', timeout: 3000 }).trim() === '1'; } catch { return false; }
});

(interpreter ? it : it.skip)('keeps original proposal ordinals across editor failure and checked binding derivation in real workers', async () => {
  const port = new AuthorProcessReplayPort(resolve('tests/fixtures/algorithm-author-a1-propose.mjs'),
    'sample', resolve('lib/algorithm/author/worker-entry.js'), 10_000, undefined, undefined, AUTHOR_WIRE_VERSION_V2);
  const worker = await PythonWorker.start({ configDir: resolve('packages/python-sdk/tests/fixtures'),
    module: 'author_a1_propose.py', export: 'sample', interpreter: interpreter!,
    sdkPath: resolve('packages/python-sdk/src'), mode: 'author' });
  const compare = async (history: AuthorHistoryEntry[]) => {
    const next: AuthorReplayRequest = { ...request, history };
    const expected = await replay(definition, next);
    expect(await worker.call('author.replay', next)).toEqual(expected);
    expect(await port.replay(next)).toEqual(expected);
    return expected;
  };
  try {
    const editors = await compare([]);
    if (editors.status !== 'waiting') throw new Error('expected editors');
    expect(editors.frontier.map(item => item.kind)).toEqual(Array(3).fill('execution.workspace-edit'));
    editors.frontier.forEach((item, index) => {
      expect(item).toMatchObject({ bindingSetRef: parent.bindingSetRef,
        limits: capabilities.operationLimits['execution.workspace-edit'], startsBudgetClock: true,
        input: { roleId: 'optimizer', baseBindingSetRef: parent.bindingSetRef, proposalIndex: index,
          feedback: { schemaVersion: 1, subject: parent, taskViewRef: taskView,
            measurementRef: feedback.measurementRef, comparisonKey: feedback.comparisonKey } } });
      expect((item.input as { feedback: Record<string, unknown> }).feedback).not.toHaveProperty('metrics');
    });
    const history = editors.frontier.map((item, index) => sealed(item,
      index === 1 ? { kind: 'no-result', reason: 'workspace-edit-fixed-check-failed' }
        : { kind: 'result', value: edited(index) }));
    const derives = await compare(history);
    if (derives.status !== 'waiting') throw new Error('expected derivations');
    expect(derives.frontier.map(item => item.kind)).toEqual(['bindings.derive', 'bindings.derive']);
    expect(derives.frontier.map(item => (item.input as { replacements: { harness: { digest: string } } })
      .replacements.harness.digest)).toEqual([hash('harness:0'), hash('harness:2')]);
    const derivedHistory = [...history, ...derives.frontier.map((item, index) => sealed(item,
      { kind: 'result', value: { bindingSetRef: { ...parent.bindingSetRef,
        digest: hash(`derived:${index === 0 ? 0 : 2}`) } } }))];
    const completed = await compare(derivedHistory);
    expect(completed).toMatchObject({ status: 'completed', result: { outputs: { proposals: {
      schemaVersion: 1, requestedCount: 3,
      candidates: [{ proposalIndex: 0 }, { proposalIndex: 2 }],
      failures: [{ index: 1, stage: 'validation', code: 'workspace-edit-fixed-check-failed' }],
    } } } });
    expect(await compare(derivedHistory)).toEqual(completed);

    const deriveFailed = [...history, sealed(derives.frontier[0]!,
      { kind: 'result', value: { bindingSetRef: { ...parent.bindingSetRef, digest: hash('derived:0') } } }),
    sealed(derives.frontier[1]!, { kind: 'error', code: 'DERIVE_DECLINED', message: 'declined' })];
    const withDeriveFailure = await compare(deriveFailed);
    expect(withDeriveFailure).toMatchObject({ status: 'completed', result: { outputs: { proposals: {
      candidates: [{ proposalIndex: 0 }], failures: [{ index: 1, stage: 'validation' },
        { index: 2, stage: 'derive', code: 'DERIVE_DECLINED' }],
    } } } });
    const { validationReceiptRef: _omitted, ...malformedEdit } = edited(0);
    const malformedRequest: AuthorReplayRequest = { ...request, history: [sealed(editors.frontier[0]!,
      { kind: 'result', value: malformedEdit })] };
    await expect(replay(definition, malformedRequest)).rejects.toThrow('Edit validation');
    await expect(worker.call('author.replay', malformedRequest)).rejects.toThrow();
    await expect(port.replay(malformedRequest)).rejects.toThrow();
  } finally { await worker.close(); }
});

it('rejects unmeasured or mismatched feedback, role and proposal count before an editor intent', async () => {
  const incomplete: EvaluationV1 = { schemaVersion: 1, subject: parent, taskViewRef: taskView,
    status: 'incomplete', comparable: false, trials: [], evidenceRefs: [] };
  const cases = [
    { ...request, input: { ...request.input, data: { feedback: incomplete } } },
    { ...request, input: { ...request.input, data: { feedback: { ...feedback,
      subject: { ...parent, bindingSetRef: { ...parent.bindingSetRef, digest: hash('other') } } } } } },
    { ...request, input: { ...request.input, capabilities: { ...capabilities, execution: {
      proposal: { schemaVersion: 1, maxCount: 2 } } } } },
    { ...request, input: { ...request.input, capabilities: { ...capabilities, roles: {} } } },
  ];
  for (const item of cases) await expect(replay(definition, item)).rejects.toThrow();
});

(interpreter ? it : it.skip)('replays a prior-only proposal with no feedback field in either real worker', async () => {
  const port = new AuthorProcessReplayPort(resolve('tests/fixtures/algorithm-author-a1-propose-no-feedback.mjs'),
    'sample', resolve('lib/algorithm/author/worker-entry.js'), 10_000, undefined, undefined, AUTHOR_WIRE_VERSION_V2);
  const worker = await PythonWorker.start({ configDir: resolve('packages/python-sdk/tests/fixtures'),
    module: 'author_a1_propose_no_feedback.py', export: 'sample', interpreter: interpreter!,
    sdkPath: resolve('packages/python-sdk/src'), mode: 'author' });
  const priorOnly = algorithm(async ctx => {
    const proposals = await ctx.propose(ctx.initialAgent, { role: 'optimizer', count: 1 });
    return ctx.result({ outputs: { proposals } });
  });
  const next: AuthorReplayRequest = { ...request, input: { ...request.input, data: {} }, history: [] };
  const compare = async (rows: AuthorHistoryEntry[]) => {
    const replayRequest: AuthorReplayRequest = { ...next, history: rows };
    const expected = await replay(priorOnly, replayRequest);
    expect(await worker.call('author.replay', replayRequest)).toEqual(expected);
    expect(await port.replay(replayRequest)).toEqual(expected);
    return expected;
  };
  try {
    const first = await compare([]);
    if (first.status !== 'waiting') throw new Error('expected edit');
    expect(first.frontier).toHaveLength(1);
    expect(Object.keys(first.frontier[0]!.input as object).sort()).toEqual(
      ['baseBindingSetRef', 'proposalIndex', 'roleId']);
    const editHistory = [sealed(first.frontier[0]!, { kind: 'result', value: edited(0) })];
    const second = await compare(editHistory);
    if (second.status !== 'waiting') throw new Error('expected derive');
    expect(second.frontier.map(item => item.kind)).toEqual(['bindings.derive']);
    const completeHistory = [...editHistory, sealed(second.frontier[0]!, { kind: 'result', value: {
      bindingSetRef: { ...parent.bindingSetRef, digest: hash('prior-derived') } } })];
    const result = await compare(completeHistory);
    expect(result).toMatchObject({ status: 'completed', result: { outputs: { proposals: {
      requestedCount: 1, candidates: [{ proposalIndex: 0 }], failures: [],
    } } } });
    expect(await compare(completeHistory)).toEqual(result);
  } finally { await worker.close(); }
});
