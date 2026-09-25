import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { sha256 } from '../../src/algorithm/artifacts.js';
import { PythonWorker } from '../../src/algorithm/hosts/python.js';
import { AUTHOR_WIRE_VERSION_V2, algorithm, replay,
  type EvaluationV1 } from '../../src/algorithm/author/index.js';

const hash = (value: string) => sha256(value);
const agent = { schemaVersion: 1 as const, kind: 'harness-agent' as const,
  bindingSetRef: { kind: 'binding-set' as const, schemaId: 'binding.set.v1', digest: hash('baseline') },
  executionProfileDigest: hash('profile') };
const candidate = { ...agent, bindingSetRef: { ...agent.bindingSetRef, digest: hash('candidate') }, proposalIndex: 0 };
const taskView = { kind: 'artifact' as const, digest: hash('task-view'), size: 10,
  mediaType: 'application/json', schemaId: 'task.view.v1' };
const evidenceRef = { ...taskView, schemaId: 'execution.rollout.evidence.v1' };
const recordRef = { ...taskView, schemaId: 'measurement.record.v1' };
const evaluation = (subject: typeof agent, score: number, key = hash('same-condition')): EvaluationV1 => ({
  schemaVersion: 1, subject, taskViewRef: taskView, status: 'complete', comparable: true,
  comparisonKey: key, metrics: { score }, measurementRef: recordRef,
  trials: [{ taskId: 'task-1', repeatIndex: 0, status: 'completed', evidenceRef }], evidenceRefs: [evidenceRef],
});
type SelectData = { evaluations: EvaluationV1[] };
const definition = algorithm<{}, 'v2', SelectData>(ctx => {
  const winner = ctx.select(ctx.data.evaluations, { metric: 'score', requireImprovement: true }).agent;
  return ctx.result({ selected: winner });
});
const capabilities = { version: 'gear.author.capabilities.v1' as const, lockDigest: hash('lock'), roles: {},
  operationLimits: {}, execution: { selection: { schemaVersion: 1, metric: { id: 'score',
    direction: 'maximize', comparisonPrecision: 0.1, contractDigest: `sha256:${hash('metric')}` } } } };
const request = (evaluations: EvaluationV1[], selection = capabilities.execution.selection) => ({
  version: AUTHOR_WIRE_VERSION_V2,
  input: { initialAgent: agent, data: { evaluations }, config: {}, capabilities: { ...capabilities,
    execution: { selection } } }, history: [],
});
const interpreter = [process.env.GEAR_TEST_PYTHON, '/opt/homebrew/bin/python3.11', 'python3.11'].find(candidateName => {
  if (!candidateName) return false;
  try { return execFileSync(candidateName, ['-c', 'import sys; print(int(sys.version_info >= (3,11)))'],
    { encoding: 'utf8', timeout: 3000 }).trim() === '1'; } catch { return false; }
});

(interpreter ? it : it.skip)('uses identical decimal-rational half-precision ties in both author languages', async () => {
  const worker = await PythonWorker.start({ configDir: resolve('packages/python-sdk/tests/fixtures'),
    module: 'author_a1_select.py', export: 'sample', interpreter: interpreter!,
    sdkPath: resolve('packages/python-sdk/src'), mode: 'author' });
  try {
    for (const [first, second, expected] of [
      [-0.15000000000000002, -0.15, candidate],
      [0.049999999999999996, 0.05, candidate],
      [-0.05, -0.049999999999999996, agent],
    ] as const) {
      const next = request([evaluation(agent, first), evaluation(candidate, second)]);
      const expectedResult = { status: 'completed', result: { selected: expected } };
      expect(await replay(definition, next)).toEqual(expectedResult);
      expect(await worker.call('author.replay', next)).toEqual(expectedResult);
    }
  } finally { await worker.close(); }
});

it('rejects incompatible conditions, incomplete baseline, missing metric and unconfigured selection', async () => {
  const incomplete: EvaluationV1 = { schemaVersion: 1, subject: agent, taskViewRef: taskView,
    status: 'incomplete', comparable: false, trials: [], evidenceRefs: [] };
  const cases = [
    request([evaluation(agent, 0.2), evaluation(candidate, 0.3, hash('other-condition'))]),
    request([incomplete, evaluation(candidate, 0.3)]),
    request([{ ...evaluation(agent, 0.2), metrics: { other: 0.2 } }, evaluation(candidate, 0.3)]),
    { ...request([evaluation(agent, 0.2)]), input: { ...request([evaluation(agent, 0.2)]).input,
      capabilities: { ...capabilities, execution: {} } } },
  ];
  for (const item of cases) await expect(replay(definition, item)).rejects.toThrow();
});
