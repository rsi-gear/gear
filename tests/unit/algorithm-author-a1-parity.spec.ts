import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PythonWorker } from '../../src/algorithm/hosts/python.js';
import { AUTHOR_WIRE_VERSION_V2, algorithm, authorIntentDigest, replay,
  type AuthorAtomic, type AuthorHistoryEntry, type AuthorReplayRequest,
  type RoleResultV1 } from '../../src/algorithm/author/index.js';

const taskView = { kind: 'artifact' as const, digest: 'b'.repeat(64), size: 10,
  mediaType: 'application/json', schemaId: 'task.view.v1' };
const agent = { schemaVersion: 1 as const, kind: 'harness-agent' as const,
  bindingSetRef: { kind: 'binding-set' as const, digest: 'c'.repeat(64), schemaId: 'binding.set.v1' },
  executionProfileDigest: 'd'.repeat(64) };
const request: AuthorReplayRequest = { version: AUTHOR_WIRE_VERSION_V2,
  input: { initialAgent: agent, data: {}, config: { mode: 'strict' }, capabilities: {
    version: 'gear.author.capabilities.v1', lockDigest: 'a'.repeat(64),
    roles: { analyst: { template: 'read-only-analyst', kind: 'execution.role' } },
    operationLimits: {}, execution: {},
  } }, history: [] };
const definition = algorithm(async ctx => {
  const role = await ctx.role('analyst', { goal: (ctx.config as { mode: string }).mode }) as RoleResultV1;
  const selection = await ctx.tasks.sample(taskView, { count: 2, seed: 7 });
  return ctx.result({ selected: ctx.initialAgent, outputs: { role: role.output, taskViewRef: selection.taskViewRef } });
}, { configSchema: { type: 'object', properties: { mode: { type: 'string' } },
  required: ['mode'], additionalProperties: false } });

function sealed(item: AuthorAtomic, value: unknown): AuthorHistoryEntry {
  return { address: item.address, kind: item.kind, definitionVersion: item.definitionVersion,
    inputDigest: authorIntentDigest(item), outcome: { kind: 'result', value: value as never } };
}
const interpreter = [process.env.GEAR_TEST_PYTHON, process.env.GEAR_ALGORITHM_TEST_PYTHON,
  'python3.12', 'python3.11', '/opt/homebrew/bin/python3.11', 'python3'].find(candidate => {
  if (!candidate) return false;
  try { return execFileSync(candidate, ['-c', 'import sys; print(int(sys.version_info >= (3,11)))'],
    { encoding: 'utf8', timeout: 3000 }).trim() === '1'; } catch { return false; }
});

(interpreter ? it : it.skip)('matches Python v2 author worker frontiers and typed results across three replays', async () => {
  const worker = await PythonWorker.start({ configDir: resolve('packages/python-sdk/tests/fixtures'),
    module: 'author_a1_sample.py', export: 'sample', interpreter: interpreter!,
    sdkPath: resolve('packages/python-sdk/src'), mode: 'author' });
  const compare = async (next: AuthorReplayRequest) => {
    const python = await worker.call('author.replay', next);
    const typescript = await replay(definition, next);
    expect(python).toEqual(typescript);
    return typescript;
  };
  try {
    const first = await compare(request);
    if (first.status !== 'waiting') throw new Error('role frontier missing');
    expect(first.frontier).toHaveLength(1);
    const roleResult = { requestedBindingSetDigest: agent.bindingSetRef.digest, actualBindings: {},
      evidenceRef: { ...taskView, schemaId: 'execution.role.evidence.v1' },
      receiptRef: { ...taskView, schemaId: 'execution.receipt.v1' },
      structuredResult: { name: 'analyst' },
      structuredResultRef: { ...taskView, schemaId: 'execution.structured-result.v1' } };
    const firstHistory = sealed(first.frontier[0]!, roleResult);
    const second = await compare({ ...request, history: [firstHistory] });
    if (second.status !== 'waiting') throw new Error('sample frontier missing');
    expect(second.frontier).toHaveLength(1);
    const selectedTaskView = { ...taskView, digest: 'e'.repeat(64) };
    const selection = { schemaVersion: 1, taskViewRef: selectedTaskView, selectedTaskIds: ['task-1', 'task-2'],
      cursor: { viewDigest: selectedTaskView.digest, nextIndex: 0 } };
    const final = await compare({ ...request, history: [firstHistory, sealed(second.frontier[0]!, selection)] });
    expect(final).toEqual({ status: 'completed', result: { selected: agent,
      outputs: { role: { name: 'analyst' }, taskViewRef: selectedTaskView } } });
  } finally { await worker.close(); }
});
