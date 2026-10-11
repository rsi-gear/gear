import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createHitchExecutionHost } from '../../src/algorithm/author/host.js';
import { StepAlgorithmAdapter } from '../../src/algorithm/author/step-adapter.js';
import { algorithm, type Evaluation, type Task, type TaskSelection } from '../../src/algorithm/author/definition.js';
import { FileArtifactStore, sha256 } from '../../src/algorithm/artifacts.js';
import { BindingStore } from '../../src/algorithm/bindings.js';
import { AlgorithmRuntime } from '../../src/algorithm/runtime/engine.js';
import { HarnessBuilder, NoopHarnessCompiler } from '../../src/harness/builder.js';
import { digestJson } from '../../src/state/digest.js';
import { readExperienceView } from '../../src/algorithm/data/experience.js';
import { createGitHarnessFixture } from '../helpers/git-fixture.js';
import { createMultiRecordedHitchCliFixture } from '../helpers/algorithm-hitch-multi-cli.js';
import { standardSearchDataset } from '../helpers/standard-search-dataset.js';
import type { BudgetPlan } from '../../src/algorithm/contracts.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('assembles a generic Hitch host from real Git and compiled task bytes and evaluates an author-selected task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-step-hitch-')); roots.push(root);
  const git = await createGitHarnessFixture(); roots.push(git.root);
  const dataset = await standardSearchDataset(root, 2);
  const recorded = await createMultiRecordedHitchCliFixture(git, { 'task-0': 1, 'task-1': 0 });
  const builder = new HarnessBuilder({ repositoryPath: git.repository, targetRoot: git.targetRoot,
    dshBaseRef: git.baseRef, toolchainRef: 'node-22-tsc', sandboxProfileRef: 'sandbox-v1', compiler: new NoopHarnessCompiler() });
  await builder.initialize();
  const stateDir = join(root, 'state'), artifacts = new FileArtifactStore(join(stateDir, 'artifacts'));
  const budget: BudgetPlan = { 'rollout.trials': { limit: 4, source: 'hitch-rollout', unit: 'trials', capability: 'hard' } };
  const context = { campaignId: 'step-hitch', stateDir, configDir: root, artifacts, config: {}, budget };
  const options = { builder, evaluator: recorded.evaluator, workspaceRoot: root, datasetRoot: dataset.ref,
    initialHarness: { commitOid: git.championRef, manifestDigest: git.manifest.digest }, authorityId: 'host-task-authority',
    repetitions: 1, maxTrials: 512, taskBudgetMs: 60_000,
    rolloutProviderDigest: digestJson({ provider: 'hitch-cli', version: '0.2.8' }),
    operationLimits: { 'execution.rollout': { 'rollout.trials': 1 } } };
  const host = await createHitchExecutionHost(context, options), execution = host.execution!;
  const view = readExperienceView(artifacts, execution.experienceSource!);
  expect(view.provenance).toBe('verified');
  expect(view.sourceManifestDigest).toMatch(/^[a-f0-9]{64}$/);
  const author = algorithm<{ phase: string }>(ctx => {
    if (!ctx.state) return ctx.run({ phase: 'select' }, { content: ctx.services.tasks(ctx.taskSource) });
    if (ctx.state.phase === 'select') {
      const content = ctx.results.get<Task[]>('content'); if (!content.ok) throw new Error('Task content unavailable');
      expect(content.value.map(task => task.prompt)).toEqual(['seed fixture task 0\n', 'seed fixture task 1\n']);
      return ctx.run({ phase: 'evaluate' }, { tasks: ctx.services.select(['task-0']) });
    }
    if (ctx.state.phase === 'evaluate') {
      const selected = ctx.results.get<TaskSelection>('tasks'); if (!selected.ok) throw new Error('Selection failed');
      expect(selected.value.selectedTaskIds).toEqual(['task-0']);
      return ctx.run({ phase: 'finish' }, { measured: ctx.services.evaluate(ctx.initialCandidate, selected.value) });
    }
    const measured = ctx.results.get<Evaluation>('measured');
    expect(measured).toMatchObject({ ok: true, value: { comparable: true, metrics: { pass_rate: 1 } } });
    return ctx.finish({ selected: ctx.initialCandidate });
  });
  const adapter = new StepAlgorithmAdapter(author, execution, artifacts, new BindingStore(artifacts, execution.bindingSchema), sha256('physical-author'));
  const runtime = new AlgorithmRuntime(stateDir, adapter, host.providers, { campaignId: 'step-hitch', config: {}, budget,
    initialBindingSetRef: execution.initialCandidate.bindingSetRef });
  let status = await runtime.tick();
  for (let i = 0; i < 40 && status !== 'complete'; i++) status = await runtime.tick();
  expect(status).toBe('complete');
  // Admission of the same persisted task/evidence authority is stable on cold construction.
  expect((await createHitchExecutionHost(context, options)).execution!.identityDigest).toBe(execution.identityDigest);
});
