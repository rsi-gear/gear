/** Generic physical assembly: datasets, immutable candidates, and injected model services. */
import { existsSync } from 'node:fs';
import { readBoundedRegularFile } from '../../state/bounded-file.js';
import { digestDatasetRef } from '../../state/dataset.js';
import { join } from 'node:path';
import type { AlgorithmHostContext, AlgorithmHostProfile } from '../host-profile.js';
import type { ArtifactRef, OperationProvider } from '../contracts.js';
import { BindingStore } from '../bindings.js';
import { prepareTaskViewFromExperience, TaskViewAuthority } from '../data/tasks.js';
import { createResearchProfileFromSource, type SealedResearchProfile } from '../research-profile.js';
import type { SourceExperience, SourceSelector } from '../data/experience.js';
import { implementationClosureDigest } from '../data/identity.js';
import { createTasksSampleProvider } from '../providers/task-sampling.js';
import { HitchRolloutPort } from '../providers/hitch.js';
import { VerifiedExecutionAdapter } from '../providers/execution.js';
import { createAuthorMeasurementProvider } from './measurement.js';
import { createLocalCommittedRolloutResolver, readCommittedOperations } from './committed-rollout-resolver.js';
import { verifyHarnessAgentBinding } from './graph.js';
import { inspectStandardCompiledDatasetV1 } from '../../search/compiled-dataset-v1.js';
import type { HarnessBuilder } from '../../harness/builder.js';
import type { HitchCliEvaluator } from '../../evaluator/hitch-cli.js';
import { resolveMetric } from '../../objective/contracts.js';
import type { RawMetricContract } from '../../objective/types.js';
import { assertJson, jsonDigest } from '../schema.js';
import type { Candidate } from './definition.js';
import type { ExecutionServices } from './step-adapter.js';

export type ModelExecutionServices = { providers: OperationProvider[]; roles: ExecutionServices['roles']; close?(): Promise<void> | void };
export type HitchExecutionHostOptions = {
  builder: HarnessBuilder; evaluator: HitchCliEvaluator;
  workspaceRoot: string; datasetRoot: string;
  initialHarness: { commitOid: string; manifestDigest: string };
  /** Host authority identity. Signing keys are persisted in this Campaign's state directory. */
  authorityId: string;
  repetitions?: number; maxTrials?: number; maxProposals?: number; taskBudgetMs: number;
  rolloutProviderDigest: string; metricContract?: RawMetricContract;
  operationLimits: Record<string, Record<string, number>>;
  /** Configure a model destination and editor/analyst catalog once for all algorithms. */
  modelServices?(context: AlgorithmHostContext, capabilities: {
    bindings: BindingStore; taskAuthority: TaskViewAuthority; taskSource: ArtifactRef; research: SealedResearchProfile;
    accessPolicyDigest: string; executionProfileDigest: string;
  }): Promise<ModelExecutionServices> | ModelExecutionServices;
};

export async function createHitchExecutionHost(context: AlgorithmHostContext,
  options: HitchExecutionHostOptions): Promise<AlgorithmHostProfile> {
  const { artifacts, stateDir, campaignId } = context;
  const dataset = await inspectStandardCompiledDatasetV1(options.datasetRoot);
  const manifest = await options.builder.readManifest(options.initialHarness.commitOid);
  if (manifest.digest !== options.initialHarness.manifestDigest) throw new Error('Initial Harness manifest differs from host configuration');
  const repetitions = options.repetitions ?? 1, maxTrials = options.maxTrials ?? 128;
  if (!Number.isSafeInteger(repetitions) || repetitions < 1
    || !Number.isSafeInteger(maxTrials) || maxTrials < 1) throw new Error('Invalid finite evaluation bounds');
  const bindingSchema = { id: 'candidate.harness.v1', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true } } };
  const bindings = new BindingStore(artifacts, bindingSchema);
  const harness = artifacts.putJson({ schemaVersion: 1, kind: 'git-harness', ...options.initialHarness }, 'harness.directory.v1');
  const initialBindingSetRef = bindings.create({ harness });
  const entries: SourceExperience[] = await Promise.all(dataset.tasks.map(async task => ({
    id: task.id, taskId: task.id, exposure: { seenInTraining: false, graderLabelExposed: false },
    task: { prompt: (await readBoundedRegularFile(join(dataset.root, task.id, 'instruction.md'),
      64 * 1024, `Task instruction ${task.id}`)).toString('utf8'), executionSource: {
      kind: 'compiled-author-dataset' as const, datasetDigest: dataset.sourceDigest, taskContentDigest: task.contentDigest } },
    overview: { summary: `Compiled task ${task.id}`, tags: [] }, taskReport: { narrative: '' }, traceChunks: [] })));
  if (await digestDatasetRef(dataset.root) !== dataset.sourceDigest) throw new Error('Task dataset changed during capture');
  const selector: SourceSelector = { namespace: 'campaign', sourceId: campaignId,
    cursor: { namespace: `campaign:${campaignId}`, value: dataset.sourceDigest } };
  const research = await createResearchProfileFromSource(context, { authorityId: options.authorityId,
    source: { selector: async () => selector, async resolve(requested, purpose) {
      if (jsonDigest(requested) !== jsonDigest(selector) || purpose !== 'research') throw new Error('Dataset source selection is not authorized');
      return { snapshot: { selector, sourceManifestDigest: dataset.sourceDigest.slice('sha256:'.length), indexVersion: 'compiled-author-v1',
        entries, provenance: 'verified' }, grant: { authorityId: options.authorityId, purpose,
        projections: ['overview', 'task-report'], exposeGraderLabels: false } };
    } } });
  const authority = research.taskAuthority, accessPolicyDigest = research.accessPolicyDigest;
  const taskSource = authority.seal(prepareTaskViewFromExperience(artifacts, research.experienceViewRef,
    dataset.tasks.map(task => ({ id: task.id, purpose: 'development' }))));
  const grant = (id: string) => {
    if (id !== campaignId) throw new Error('Task campaign grant mismatch');
    return { allowedExperienceViewDigests: [research.experienceViewRef.digest] };
  };
  const plan = { schemaVersion: 1 as const, kind: 'author.hitch-plan.v1' as const, campaignId,
    workspaceRoot: options.workspaceRoot, datasetRoot: dataset.root, datasetDigest: dataset.sourceDigest,
    taskIds: dataset.tasks.map(item => item.id), repetitions, taskBudgetMs: options.taskBudgetMs,
    sandboxProfileRef: options.builder.options.sandboxProfileRef, model: options.evaluator.options.model,
    rolloutProviderDigest: options.rolloutProviderDigest, recipePhase: 'author.evaluate', allowedExperienceViewDigests: [research.experienceViewRef.digest] };
  const port = await HitchRolloutPort.create({ authorPlan: plan, workspaceRoot: options.workspaceRoot,
    stateRoot: stateDir, artifacts, bindings, taskAuthority: authority,
    allowedExperienceViewDigests: id => grant(id).allowedExperienceViewDigests, accessPolicyDigest,
    builder: options.builder, evaluator: options.evaluator, campaignBudget: context.budget });
  const rollout = new VerifiedExecutionAdapter(port, artifacts, bindings, ['harness']);
  const rolloutProfile = port.profile();
  const executionProfileDigest = jsonDigest({ plan, rolloutProfile, rollout: rollout.describe() });
  const initialCandidate: Candidate = { schemaVersion: 1, kind: 'harness-agent', bindingSetRef: initialBindingSetRef, executionProfileDigest };
  const models = await options.modelServices?.(context, { bindings, taskAuthority: authority, taskSource, research, accessPolicyDigest, executionProfileDigest });
  try {
    const resolver = createLocalCommittedRolloutResolver({ campaignJournalRoot: join(stateDir, 'campaign'), physicalReader: port });
    const metricContract = options.metricContract ?? resolveMetric(dataset.manifest.raw_metrics?.metrics.find(metric => metric.id === 'pass_rate') ?? { id: 'pass_rate', revision: 'boolean-pass-v1',
      unit: 'ratio', direction: 'maximize', source: { path: 'originalResult.passed', extractor: 'boolean-v1' },
      range: { min: 0, max: 1 }, granularity: 'trial', repetitionReducer: 'mean', taskReducer: 'weighted-mean', comparisonPrecision: 1e-9 });
    const freeze = (name: string, value: unknown) => { assertJson(value); return artifacts.putJson(value, `candidate.${name}.v1`); };
    const profileDigest = jsonDigest({ executionProfileDigest, models: models?.providers.map(provider => provider.describe()) ?? [],
      operationLimits: options.operationLimits, metricContract });
    const metricSchemaRef = artifacts.putJson({ schemaVersion: 1, metrics: { [metricContract.id]: {
      unit: metricContract.unit, contractDigest: metricContract.digest } } }, 'measurement.metric-schema.v1');
    const measurement = createAuthorMeasurementProvider({ artifacts, bindings, authority, resolveCommitted: resolver,
      profile: { campaignId, profileDigest, executionProfileDigest, accessPolicyDigest,
        resolverIdentityDigest: resolver.identityDigest, rolloutAdapterDigest: rollout.describe().implementationDigest,
        rolloutAdapterManifestDigest: jsonDigest(rollout.describe()), rolloutPhysicalDigest: port.describe().implementationDigest,
        allowedExperienceViewDigests: [research.experienceViewRef.digest], repeatCount: repetitions, recipePhase: plan.recipePhase,
        ...rolloutProfile, rolloutCondition: { partition: 'seed', repetitions: 1, model: plan.model, sampling: options.evaluator.options.sampling,
          timeoutMs: plan.taskBudgetMs, rolloutProviderDigest: plan.rolloutProviderDigest }, metricContract,
        condition: { providerImplementationDigest: port.describe().implementationDigest,
          evaluatorRef: freeze('evaluator', { provider: port.describe().implementationDigest }),
          rubricRef: freeze('rubric', metricContract), environmentRef: freeze('environment', { digest: rolloutProfile.environmentDigest }),
          samplingRef: freeze('sampling', options.evaluator.options.sampling), budgetRef: freeze('budget', { taskBudgetMs: plan.taskBudgetMs, repetitions }),
          metricSchemaRef, subjectSchemaId: bindingSchema.id } } });
    const providers = [createTasksSampleProvider({ artifacts, authority, resolveGrant: grant, accessPolicyDigest, maxCount: entries.length }),
      ...research.providers, rollout, measurement,
      ...models?.providers ?? []];
    const operationLimits: Record<string, Record<string, number>> = { 'tasks.sample': {}, 'tasks.select': {}, 'tasks.consume': {}, 'evidence.query': {}, 'evidence.read': {}, 'author.measurement': {}, ...options.operationLimits };
    for (const provider of providers) for (const dimension of provider.describe().meteredDimensions)
      if (!context.budget[dimension] || operationLimits[provider.describe().kind]?.[dimension] === undefined)
        throw new Error(`Host reservation missing for ${provider.describe().kind}.${dimension}`);
    const execution: ExecutionServices = { identityDigest: profileDigest, bindingSchema, initialCandidate, taskSource, experienceSource: research.experienceViewRef,
      roles: models?.roles ?? {}, operationLimits, maxProposals: options.maxProposals ?? 32,
      evaluation: { schemaVersion: 1, repeatCount: repetitions, maxTrials, recipePhase: plan.recipePhase, ...rolloutProfile },
      async verifyCandidate(candidate) {
        const bound = verifyHarnessAgentBinding(artifacts, bindings, candidate, executionProfileDigest);
        if ((await options.builder.readManifest(bound.commitOid)).digest !== bound.manifestDigest) throw new Error('Candidate Git manifest changed');
        if (candidate.bindingSetRef.digest === initialBindingSetRef.digest) return;
        if (existsSync(join(stateDir, 'campaign', 'HEAD')) && readCommittedOperations(join(stateDir, 'campaign'), campaignId)
          .some(item => item.envelope.kind === 'bindings.derive' && item.outcome.kind === 'result'
            && (item.outcome.value as { bindingSetRef: Candidate['bindingSetRef'] }).bindingSetRef.digest === candidate.bindingSetRef.digest)) return;
        throw new Error('Candidate was not produced by this Campaign');
      } };
    return { providers, bindings: { harness }, execution, ...(models?.close ? { close: () => models.close!() } : {}) };
  } catch (error) { await models?.close?.(); throw error; }
}
