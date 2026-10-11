/** Explicitly controlled teaching host. This does not run a model, compiler, or Hitch. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AlgorithmHostContext, AlgorithmHostProfile } from '../host-profile.js';
import type { OperationEnvelope, OperationOutcome, ProviderManifest } from '../contracts.js';
import { BindingStore } from '../bindings.js';
import { LocalDurableProvider } from '../runtime/providers.js';
import { prepareTaskViewFromExperience } from '../data/tasks.js';
import { createResearchProfileFromSource } from '../research-profile.js';
import type { SourceSelector } from '../data/experience.js';
import { createTasksSampleProvider } from '../providers/task-sampling.js';
import { jsonDigest, type JsonValue } from '../schema.js';
import { sha256 } from '../artifacts.js';
import { sealMeasurement, measurementComparisonKey } from '../data/measurement.js';
import { readCommittedOperations } from './committed-rollout-resolver.js';
import type { Candidate, Evaluation } from './definition.js';
import type { ExecutionServices } from './step-adapter.js';

export async function createRecordedExecutionHost(context: AlgorithmHostContext): Promise<AlgorithmHostProfile> {
  const { artifacts, stateDir, campaignId } = context;
  const bindingSchema = { id: 'recorded.candidates.v1', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true } } };
  const bindings = new BindingStore(artifacts, bindingSchema);
  const initial = artifacts.putJson({ kind: 'recorded-candidate', level: 0 }, 'harness.directory.v1');
  const executionProfileDigest = sha256('recorded-teaching-host-v1');
  const initialCandidate: Candidate = { schemaVersion: 1, kind: 'harness-agent',
    bindingSetRef: bindings.create({ harness: initial }), executionProfileDigest };
  const sourceDigest = sha256('recorded-task-source');
  const selector: SourceSelector = { namespace: 'campaign', sourceId: campaignId,
    cursor: { namespace: `campaign:${campaignId}`, value: sourceDigest } };
  const entries = Array.from({ length: 4 }, (_, index) => ({ id: `task-${index}`, taskId: `task-${index}`,
    task: { prompt: `Recorded teaching task ${index}` }, exposure: { seenInTraining: false, graderLabelExposed: false },
    overview: { summary: `Recorded task ${index}`, tags: [] }, taskReport: { narrative: '' }, traceChunks: [] }));
  const research = await createResearchProfileFromSource(context, { authorityId: 'recorded-tasks',
    source: { selector: async () => selector, async resolve(requested, purpose) {
      if (jsonDigest(requested) !== jsonDigest(selector) || purpose !== 'research') throw new Error('Recorded source selection changed');
      return { snapshot: { selector, sourceManifestDigest: sourceDigest, indexVersion: 'recorded-v1', entries, provenance: 'verified' },
        grant: { authorityId: 'recorded-tasks', purpose, projections: ['overview', 'task-report'], exposeGraderLabels: false } };
    } } });
  const authority = research.taskAuthority, accessPolicyDigest = research.accessPolicyDigest;
  const taskSource = authority.seal(prepareTaskViewFromExperience(artifacts, research.experienceViewRef,
    entries.map(entry => ({ id: entry.taskId, purpose: 'development' }))));
  const grant = (id: string) => {
    if (id !== campaignId) throw new Error('Recorded campaign grant mismatch');
    return { allowedExperienceViewDigests: [research.experienceViewRef.digest] };
  };
  const manifest = (kind: string, meteredDimensions: string[] = []): ProviderManifest => ({ kind,
    implementationDigest: jsonDigest({ kind, executionProfileDigest }), execution: 'trusted-local', supportsInspect: true,
    meteredDimensions, hardLimitDimensions: meteredDimensions, inputSchema: { type: 'object', additionalProperties: true },
    outputSchema: { type: 'any' } });
  const provider = (kind: string, handler: (envelope: OperationEnvelope) => OperationOutcome, metered: string[] = []) =>
    new LocalDurableProvider(join(stateDir, 'recorded', kind), manifest(kind, metered), envelope => ({ outcome: handler(envelope),
      ...(metered.length ? { receipt: { source: kind, scope: 'operation' as const, operationId: envelope.operationId,
        cursor: 'complete', cumulative: Object.fromEntries(metered.map(dimension => [dimension, 1])) } } : {}) }));
  const edit = provider('execution.workspace-edit', envelope => {
    const input = envelope.input as { proposalIndex: number; roleId: string };
    if (input.roleId !== 'optimizer') throw new Error('Recorded editor role not granted');
    const parent = artifacts.getJson(bindings.read(envelope.bindingSetRef).slots.harness!) as { level: number };
    const producedArtifactRef = artifacts.putJson({ kind: 'recorded-candidate', level: parent.level + input.proposalIndex + 1 }, 'harness.directory.v1');
    return { kind: 'result', value: { requestedBindingSetDigest: envelope.bindingSetRef.digest, producedArtifactRef } };
  });
  const rollout = provider('execution.rollout', envelope => {
    const candidate = artifacts.getJson(bindings.read(envelope.bindingSetRef).slots.harness!) as { level: number };
    const input = envelope.input as { task: { id: string } };
    const evidenceRef = artifacts.putJson({ kind: 'recorded-rollout', operationId: envelope.operationId,
      taskId: input.task.id, pass_rate: Math.min(1, candidate.level / 5) }, 'recorded.evidence.v1');
    const receiptRef = artifacts.putJson({ kind: 'recorded-receipt', operationId: envelope.operationId }, 'execution.receipt.v1');
    return { kind: 'result', value: { evidenceRef, receiptRef } };
  }, ['rollout.trials']);
  const frozen = (name: string) => artifacts.putJson({ host: 'recorded', name }, `recorded.${name}.v1`);
  const metricSchemaRef = artifacts.putJson({ schemaVersion: 1, metrics: { pass_rate: { unit: 'ratio', minimum: 0, maximum: 1 } } },
    'measurement.metric-schema.v1');
  const measurement = provider('author.measurement', envelope => {
    const input = envelope.input as { subject: Candidate; selection: import('./definition.js').TaskSelection; producerOperationIds: string[] };
    const committed = new Map(readCommittedOperations(join(stateDir, 'campaign'), campaignId).map(item => [item.envelope.operationId, item]));
    const trials: Evaluation['trials'] = [], evidenceRefs: import('../contracts.js').ArtifactRef[] = [], scores: number[] = [];
    for (const id of input.producerOperationIds) {
      const producer = committed.get(id);
      if (!producer || producer.envelope.kind !== 'execution.rollout'
        || producer.envelope.bindingSetRef.digest !== input.subject.bindingSetRef.digest) throw new Error('Recorded measurement producer is not committed');
      const trialInput = producer.envelope.input as { task: { id: string }; repeatIndex: number };
      if (producer.outcome.kind !== 'result') { trials.push({ taskId: trialInput.task.id, repeatIndex: trialInput.repeatIndex, status: 'failed' }); continue; }
      const value = producer.outcome.value as { evidenceRef: import('../contracts.js').ArtifactRef; receiptRef: import('../contracts.js').ArtifactRef };
      const evidence = artifacts.getJson(value.evidenceRef) as { pass_rate: number };
      scores.push(evidence.pass_rate); evidenceRefs.push(value.evidenceRef);
      trials.push({ taskId: trialInput.task.id, repeatIndex: trialInput.repeatIndex, status: 'completed', ...value });
    }
    const base = { schemaVersion: 1 as const, subject: input.subject, taskViewRef: input.selection.taskViewRef, trials, evidenceRefs };
    if (scores.length !== input.selection.selectedTaskIds.length) return { kind: 'result', value: { ...base, status: 'incomplete', comparable: false } };
    const condition = { taskViewRef: input.selection.taskViewRef, providerImplementationDigest: rollout.describe().implementationDigest,
      evaluatorRef: frozen('evaluator'), rubricRef: frozen('rubric'), environmentRef: frozen('environment'), samplingRef: frozen('sampling'),
      budgetRef: frozen('budget'), metricSchemaRef, subjectSchemaId: bindingSchema.id };
    const metrics = { pass_rate: scores.reduce((sum, value) => sum + value, 0) / scores.length };
    const measurementRef = sealMeasurement(artifacts, { subjectBindings: input.subject.bindingSetRef, condition, evidenceRefs, metrics,
      evaluatedAtCursor: envelope.operationId });
    return { kind: 'result', value: { ...base, status: 'complete', comparable: true, metrics,
      comparisonKey: measurementComparisonKey(condition), measurementRef } };
  });
  const execution: ExecutionServices = { identityDigest: accessPolicyDigest, bindingSchema, initialCandidate, taskSource, experienceSource: research.experienceViewRef,
    roles: { optimizer: 'editor' }, operationLimits: { 'tasks.sample': {}, 'tasks.select': {}, 'tasks.consume': {}, 'evidence.query': {}, 'evidence.read': {},
      'execution.workspace-edit': {}, 'execution.rollout': { 'rollout.trials': 1 }, 'author.measurement': {} },
    evaluation: { schemaVersion: 1, repeatCount: 1, maxTrials: 128, recipePhase: 'author.evaluate',
      samplingDigest: `sha256:${sha256('recorded-sampling')}`, environmentDigest: `sha256:${executionProfileDigest}` }, maxProposals: 32,
    verifyCandidate(candidate) {
      const harness = artifacts.getJson(bindings.read(candidate.bindingSetRef).slots.harness!) as { kind: string };
      if (harness.kind !== 'recorded-candidate') throw new Error('Candidate is outside the recorded host');
      if (candidate.bindingSetRef.digest === initialCandidate.bindingSetRef.digest) return;
      if (existsSync(join(stateDir, 'campaign', 'HEAD')) && readCommittedOperations(join(stateDir, 'campaign'), campaignId)
        .some(item => item.envelope.kind === 'bindings.derive' && item.outcome.kind === 'result'
          && (item.outcome.value as { bindingSetRef: Candidate['bindingSetRef'] }).bindingSetRef.digest === candidate.bindingSetRef.digest)) return;
      throw new Error('Candidate was not produced by this Campaign');
    } };
  return { providers: [createTasksSampleProvider({ artifacts, authority, resolveGrant: grant, accessPolicyDigest, maxCount: entries.length }),
    ...research.providers, edit, rollout, measurement],
    execution, bindings: { harness: initial } };
}
