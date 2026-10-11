import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { algorithm, Archive, type Algorithm, type Candidate, type Evaluation, type Proposals, type Task, type TaskSelection } from '../../src/algorithm/author/definition.js';
import { StepAlgorithmAdapter } from '../../src/algorithm/author/step-adapter.js';
import { createRecordedExecutionHost } from '../../src/algorithm/author/recorded-host.js';
import { readCommittedOperations } from '../../src/algorithm/author/committed-rollout-resolver.js';
import { FileArtifactStore, sha256 } from '../../src/algorithm/artifacts.js';
import { BindingStore } from '../../src/algorithm/bindings.js';
import { AlgorithmRuntime } from '../../src/algorithm/runtime/engine.js';
import { LocalDurableProvider } from '../../src/algorithm/runtime/providers.js';
import type { BudgetPlan, OperationEnvelope, OperationProvider } from '../../src/algorithm/contracts.js';
import type { JsonValue } from '../../src/algorithm/schema.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
async function fixture<S>(author: Algorithm<S, JsonValue>, budgetLimit = 100) {
  const root = mkdtempSync(join(tmpdir(), 'gear-step-')); roots.push(root);
  const artifacts = new FileArtifactStore(join(root, 'artifacts'));
  const budget: BudgetPlan = { 'rollout.trials': { limit: budgetLimit, unit: 'trials', source: 'execution.rollout', capability: 'hard' } };
  const host = await createRecordedExecutionHost({ artifacts, stateDir: root, configDir: root, campaignId: 'step-test', config: {}, budget });
  const execution = host.execution!;
  const adapter = new StepAlgorithmAdapter(author, execution, artifacts, new BindingStore(artifacts, execution.bindingSchema), sha256('step-test-source'));
  const runtime = (providers = host.providers, limits = budget) => new AlgorithmRuntime(root, adapter, providers,
    { campaignId: 'step-test', concurrency: 20, config: {}, budget: limits, initialBindingSetRef: execution.initialCandidate.bindingSetRef });
  return { root, artifacts, host, adapter, execution, runtime };
}

it('lets the algorithm choose tasks, accept a nonwinner, and reproduce from its archive', async () => {
  type State = { phase: string; tasks?: TaskSelection; archive?: Candidate[] };
  const author = algorithm<State>(ctx => {
    const state = ctx.state;
    if (!state) return ctx.run({ phase: 'choose-tasks' }, { content: ctx.services.tasks(ctx.taskSource) });
    if (state.phase === 'choose-tasks') {
      const result = ctx.results.get<Task[]>('content');
      if (!result.ok) throw new Error('Task read failed');
      expect(result.value.map(task => task.prompt)).toEqual(Array.from({ length: 4 }, (_, i) => `Recorded teaching task ${i}`));
      return ctx.run({ phase: 'propose' }, { tasks: ctx.services.select(result.value.filter(task => task.id === 'task-2').map(task => task.id)) });
    }
    if (state.phase === 'propose') {
      const tasks = ctx.results.get<TaskSelection>('tasks'); if (!tasks.ok) throw new Error('Task selection failed');
      expect(tasks.value.selectedTaskIds).toEqual(['task-2']);
      return ctx.run({ phase: 'measure', tasks: tasks.value }, { children: ctx.services.propose(ctx.initialCandidate, { role: 'optimizer', count: 2 }) });
    }
    if (state.phase === 'measure') {
      const proposals = ctx.results.get<Proposals>('children'); if (!proposals.ok) throw new Error('Proposal failed');
      return ctx.run({ phase: 'archive', tasks: state.tasks! }, Object.fromEntries(proposals.value.candidates.map((candidate, index) =>
        [`child${index}`, ctx.services.evaluate(candidate, state.tasks!)])));
    }
    if (state.phase === 'archive') {
      const first = ctx.results.get<Evaluation>('child0'), winner = ctx.results.get<Evaluation>('child1');
      if (!first.ok || !winner.ok || !first.value.comparable || !winner.value.comparable) throw new Error('Measurement failed');
      expect(first.value.metrics.pass_rate).toBeLessThan(winner.value.metrics.pass_rate!);
      const archive = new Archive().add(first.value.subject).add(winner.value.subject);
      return ctx.run({ phase: 'finish', archive: [...archive.candidates] }, {
        descendant: ctx.services.propose(archive.candidates[0]!, { role: 'optimizer' }),
      });
    }
    const descendant = ctx.results.get<Proposals>('descendant'); if (!descendant.ok) throw new Error('Descendant failed');
    return ctx.finish({ selected: state.archive![0]!, outputs: { archive: state.archive, descendant: descendant.value.candidates[0] } });
  }, { id: 'archive-control' });
  const f = await fixture(author);
  expect(await f.runtime().runUntilBlocked()).toBe('complete');
  const result = f.adapter.readResult(f.runtime().snapshot()!) as { selected: Candidate; outputs: { descendant: Candidate } };
  expect(result.selected.proposalIndex).toBe(0);
  expect(readCommittedOperations(join(f.root, 'campaign'), 'step-test').filter(item => item.envelope.kind === 'execution.workspace-edit')).toHaveLength(3);
  const descendantHarness = f.artifacts.getJson(new BindingStore(f.artifacts, f.execution.bindingSchema).read(result.outputs.descendant.bindingSetRef).slots.harness!) as { level: number };
  expect(descendantHarness.level).toBe(2);
});

it('keeps a valid zero, incomplete evaluation, and infrastructure error distinct', async () => {
  const author = algorithm<{ phase: string }>(ctx => {
    if (!ctx.state) return ctx.run({ phase: 'measure' }, { tasks: ctx.services.sample(ctx.taskSource, 1) });
    if (ctx.state.phase === 'measure') {
      const selection = ctx.results.get<TaskSelection>('tasks'); if (!selection.ok) throw new Error('Sample failed');
      return ctx.run({ phase: 'finish' }, { zero: ctx.services.evaluate(ctx.initialCandidate, selection.value),
        invalid: ctx.services.call('invalid', {}), failed: ctx.services.call('failed', {}) });
    }
    const zero = ctx.results.get<Evaluation>('zero'), invalid = ctx.results.get<Evaluation>('invalid'), failed = ctx.results.get<Evaluation>('failed');
    expect(zero.ok && zero.value.comparable && zero.value.metrics.pass_rate).toBe(0);
    expect(invalid.ok && invalid.value.comparable).toBe(false);
    expect(failed).toMatchObject({ ok: false, error: { kind: 'error', code: 'offline' } });
    return ctx.finish({ selected: ctx.initialCandidate, outputs: { zero, invalid, failed } });
  });
  const f = await fixture(author);
  f.execution.capabilities = { invalid: { kind: 'fixture.invalid', limits: {} }, failed: { kind: 'fixture.failed', limits: {} } };
  const provider = (kind: string) => new LocalDurableProvider(join(f.root, kind), {
    kind, implementationDigest: sha256(kind), execution: 'trusted-local', supportsInspect: true,
    meteredDimensions: [], inputSchema: { type: 'object' }, outputSchema: { type: 'any' },
  }, () => ({ outcome: kind.endsWith('invalid') ? { kind: 'result', value: { status: 'invalid', comparable: false } }
    : { kind: 'error', code: 'offline', message: 'Infrastructure unavailable', retryable: false } }));
  expect(await f.runtime([...f.host.providers, provider('fixture.invalid'), provider('fixture.failed')]).runUntilBlocked()).toBe('complete');
});

it('resumes explicit state after a lost submit reply without repeating the step or external submission', async () => {
  let decisions = 0, submissions = 0, ready = false;
  const author = algorithm<{ completed: number }>(ctx => {
    decisions++;
    if (!ctx.state) return ctx.run({ completed: 7 }, { work: ctx.services.call('work', {}) });
    expect(ctx.state.completed).toBe(7); expect(ctx.results.get('work').ok).toBe(true);
    return ctx.finish({ outputs: { completed: ctx.state.completed } });
  });
  const f = await fixture(author);
  f.execution.operationLimits = {};
  f.execution.roles = {};
  f.execution.capabilities = { work: { kind: 'fixture.work', limits: {} } };
  const completion = (e: OperationEnvelope) => ({ operationId: e.operationId, idempotencyKey: e.idempotencyKey,
    inputDigest: e.inputDigest, implementationDigest: e.implementationDigest, outcome: { kind: 'result' as const, value: { done: true } } });
  const provider: OperationProvider = { describe: () => ({ kind: 'fixture.work', implementationDigest: sha256('work'), execution: 'external', supportsInspect: true,
    meteredDimensions: [], inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }), preflight: () => {},
    submit: async () => { submissions++; throw new Error('Lost network reply after submission'); },
    inspect: async e => ready ? { status: 'completed', completion: completion(e) } : submissions ? { status: 'unknown' } : { status: 'not-started' },
    collect: async e => completion(e), cancel: async () => ({ status: 'unknown' }) };
  // Construct after capabilities are frozen, to exercise a call-only host with no evaluation providers.
  const adapter = new StepAlgorithmAdapter(author, f.execution, f.artifacts, new BindingStore(f.artifacts, f.execution.bindingSchema), sha256('call-only'));
  const runtime = () => new AlgorithmRuntime(f.root, adapter, [provider], { campaignId: 'step-test', config: {}, budget: {},
    initialBindingSetRef: f.execution.initialCandidate.bindingSetRef });
  const first = runtime(); await first.tick(); await first.tick();
  expect(submissions).toBe(1); expect(decisions).toBe(1);
  const head = readFileSync(join(f.root, 'campaign', 'HEAD'), 'utf8');
  const resumed = runtime();
  for (let i = 0; i < 30; i++) expect(await resumed.tick()).toBe('waiting');
  expect(readFileSync(join(f.root, 'campaign', 'HEAD'), 'utf8')).toBe(head);
  expect(submissions).toBe(1); expect(decisions).toBe(1);
  ready = true; expect(await resumed.runUntilBlocked()).toBe('complete');
  expect(submissions).toBe(1); expect(decisions).toBe(2);
});

it('admits evaluation against the remaining budget before submitting physical work', async () => {
  const author = algorithm<{ phase: string }>(ctx => {
    if (!ctx.state) return ctx.run({ phase: 'evaluate' }, { tasks: ctx.services.sample(ctx.taskSource, 2) });
    const tasks = ctx.results.get<TaskSelection>('tasks'); if (!tasks.ok) throw new Error('Sample failed');
    return ctx.run({ phase: 'finish' }, { evaluation: ctx.services.evaluate(ctx.initialCandidate, tasks.value) });
  });
  const f = await fixture(author, 1);
  let submitted = 0;
  const providers = f.host.providers.map(provider => provider.describe().kind === 'execution.rollout'
    ? { ...provider, describe: () => provider.describe(), preflight: (e: OperationEnvelope) => provider.preflight(e),
      submit: (e: OperationEnvelope) => { submitted++; return provider.submit(e); }, inspect: (e: OperationEnvelope) => provider.inspect(e),
      collect: (e: OperationEnvelope) => provider.collect(e), cancel: (e: OperationEnvelope) => provider.cancel(e) } : provider);
  await expect(f.runtime(providers).runUntilBlocked()).rejects.toThrow(/budget|reservation/i);
  expect(submitted).toBe(0);
});
