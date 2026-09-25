import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { algorithm, replay, authorIntentDigest, AUTHOR_WIRE_VERSION, AUTHOR_WIRE_VERSION_V2,
  assertAuthorCapabilitiesV1, assertHarnessAgentV1, assertTaskSelectionV1, assertRoleResultV1,
  assertProposalBatchV1, assertEvaluationV1, type AuthorJsonValue, type AuthorReplayRequest } from '../../src/algorithm/author/index.js';
import { decodeRoleExecutionResult } from '../../src/algorithm/author/a1-contract.js';
import type { JsonValue } from '../../src/algorithm/schema.js';

const vectors = JSON.parse(readFileSync(new URL('../fixtures/author-a1-dto-vectors.json', import.meta.url), 'utf8')) as
  { name: string; validator: string; value: unknown; valid: boolean }[];
const validate = {
  harnessAgent: assertHarnessAgentV1, capabilities: assertAuthorCapabilitiesV1,
  taskSelection: assertTaskSelectionV1, proposalBatch: assertProposalBatchV1,
  evaluation: assertEvaluationV1, roleExecution: (value: unknown) => decodeRoleExecutionResult(value, 'c'.repeat(64)),
};

it.each(vectors)('shares A1 DTO validation vector $name', row => {
  const check = validate[row.validator as keyof typeof validate];
  expect(check).toBeDefined();
  if (row.valid) expect(() => check(row.value)).not.toThrow();
  else expect(() => check(row.value)).toThrow();
});

const agent = vectors.find(row => row.name === 'agent-valid')!.value;
assertHarnessAgentV1(agent);
const capabilities = vectors.find(row => row.name === 'capabilities-valid')!.value;
assertAuthorCapabilitiesV1(capabilities);
const selectionVector = vectors.find(row => row.name === 'selection-valid')!.value;
assertTaskSelectionV1(selectionVector);
const taskView = selectionVector.taskViewRef;
const input = { initialAgent: agent, data: {}, config: { taskCount: 2 }, capabilities };
const request: AuthorReplayRequest = { version: AUTHOR_WIRE_VERSION_V2, input, history: [] };

it('keeps SDK metadata independent of replay wire version and checks declared config before the first intent', async () => {
  const plain = algorithm(async ctx => await ctx.operation('custom.read', {}));
  expect((plain as typeof plain & { describe(): unknown }).describe()).toEqual({ apiVersion: AUTHOR_WIRE_VERSION,
    id: 'algorithm', definitionVersion: 'algorithm.v1' });
  const declared = algorithm<{ taskCount: number }>(async ctx => await ctx.operation('custom.read',
    { count: ctx.config.taskCount }), { configSchema: { type: 'object', required: ['taskCount'],
    properties: { taskCount: { type: 'integer' } }, additionalProperties: false } });
  expect((declared as typeof declared & { describe(): { configSchema: unknown } }).describe().configSchema).toBeDefined();
  const good = await replay(declared, request);
  expect(good).toMatchObject({ status: 'waiting', frontier: [{ kind: 'custom.read',
    definitionVersion: 'algorithm.v2', input: { count: 2 } }] });
  const bad: AuthorReplayRequest = { version: AUTHOR_WIRE_VERSION_V2,
    input: { ...input, config: { taskCount: 'invalid' } }, history: [] };
  await expect(replay(declared, bad)).rejects.toThrow('taskCount');
  await expect(replay(declared, { ...request, input: { ...input, extra: true } } as never)).rejects.toThrow('input keys');
  await expect(replay(plain, { version: AUTHOR_WIRE_VERSION,
    input: { initialAgent: null, data: {}, config: {}, capabilities }, history: [] } as never)).rejects.toThrow('input keys');
});

it('decodes physical role and task selection results and keeps malformed sealed history fatal', async () => {
  const definition = algorithm(async ctx => {
    let output: AuthorJsonValue;
    try { output = (await ctx.role('analyst', { goal: 'inspect' })).output; }
    catch { output = { attemptedFallback: true }; }
    const selection = await ctx.tasks.sample(taskView, { count: 2, seed: 7 });
    return ctx.result({ selected: ctx.initialAgent, outputs: { output, selectedTaskIds: selection.selectedTaskIds } });
  });
  const first = await replay(definition, request);
  if (first.status !== 'waiting') throw new Error('role frontier missing');
  expect(first.frontier).toHaveLength(1);
  expect(first.frontier[0]).toMatchObject({ kind: 'execution.role', definitionVersion: 'algorithm.v2',
    input: { roleId: 'analyst', input: { goal: 'inspect' } } });
  const badRole = { ...first.frontier[0]!, outcome: { kind: 'result' as const, value: { schemaVersion: 1,
    output: {}, evidenceRef: taskView, receiptRef: taskView } } };
  await expect(replay(definition, { ...request, history: [{ address: badRole.address, kind: badRole.kind,
    definitionVersion: badRole.definitionVersion, inputDigest: authorIntentDigest(badRole), outcome: badRole.outcome }] }))
    .rejects.toThrow('typed result invalid');
  const physical = vectors.find(row => row.name === 'role-execution-valid')!.value as JsonValue;
  const history = [{ address: first.frontier[0]!.address, kind: first.frontier[0]!.kind,
    definitionVersion: first.frontier[0]!.definitionVersion, inputDigest: authorIntentDigest(first.frontier[0]!),
    outcome: { kind: 'result' as const, value: physical } }];
  const second = await replay(definition, { ...request, history });
  if (second.status !== 'waiting') throw new Error('sample frontier missing');
  expect(second.frontier).toHaveLength(1);
  expect(second.frontier[0]).toMatchObject({ kind: 'tasks.sample', input: { count: 2, seed: 7 } });
  const sample = vectors.find(row => row.name === 'selection-valid')!.value as JsonValue;
  const final = await replay(definition, { ...request, history: [...history, { address: second.frontier[0]!.address,
    kind: second.frontier[0]!.kind, definitionVersion: second.frontier[0]!.definitionVersion,
    inputDigest: authorIntentDigest(second.frontier[0]!), outcome: { kind: 'result', value: sample } }] });
  expect(final).toMatchObject({ status: 'completed', result: { selected: agent,
    outputs: { output: { score: 0.4 }, selectedTaskIds: ['t-1', 't-2'] } } });
  const short = { ...(sample as Record<string, JsonValue>), selectedTaskIds: ['t-1'] };
  await expect(replay(definition, { ...request, history: [...history, { address: second.frontier[0]!.address,
    kind: second.frontier[0]!.kind, definitionVersion: second.frontier[0]!.definitionVersion,
    inputDigest: authorIntentDigest(second.frontier[0]!), outcome: { kind: 'result', value: short } }] }))
    .rejects.toThrow('TaskSelection count mismatch');
});

it('rejects invalid A1 selected agents both through ctx.result and direct return', async () => {
  const invalid = { kind: 'binding-set', digest: 'c'.repeat(64), schemaId: 'binding.set.v1' };
  await expect(replay(algorithm(ctx => ctx.result({ selected: invalid })), request)).rejects.toThrow('HarnessAgent');
  await expect(replay(algorithm(() => ({ selected: invalid })), request)).rejects.toThrow('HarnessAgent');
  const swallowed = algorithm(async ctx => {
    try { ctx.result({ selected: invalid }); } catch { /* author must not suppress output integrity failure */ }
    return await ctx.operation('custom.fallback', {});
  });
  await expect(replay(swallowed, request)).rejects.toThrow('selected Agent invalid');
});
