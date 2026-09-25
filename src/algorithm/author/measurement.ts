import type { ArtifactRef, CompletionEnvelope, OperationEnvelope, OperationOutcome, OperationProvider,
  ProviderInspection, ProviderManifest, ProviderSubmission } from '../contracts.js';
import { FileArtifactStore, assertDigest } from '../artifacts.js';
import { BindingStore } from '../bindings.js';
import { assertJson, canonicalJson, jsonDigest, validateSchema, type JsonValue } from '../schema.js';
import { TaskViewAuthority, type TaskEntry } from '../data/tasks.js';
import { implementationClosureDigest } from '../data/identity.js';
import { measurementComparisonKey, sealMeasurement, validateMeasurementInput,
  type MeasurementCondition } from '../data/measurement.js';
import { assertEvaluationV1, assertHarnessAgentV1, assertTaskSelectionV1,
  type EvaluationV1, type HarnessAgentV1, type TaskSelectionV1, type TrialV1 } from './a1-contract.js';
import type { ExecutionReceipt, ExecutionResult } from '../providers/execution.js';
import type { EvaluationCondition, EvaluationEvidence, EvaluationRequest } from '../../types.js';
import { digestJson } from '../../state/digest.js';
import { resolveMetric } from '../../objective/contracts.js';
import { aggregateRawMetrics, extractRawMetrics } from '../../objective/scoring.js';
import type { RawMetricContract, RawTrialMetrics } from '../../objective/types.js';

/** Author input names operations, never their result, receipt, score, or measurement condition. */
export type AuthorMeasurementInput = { subject: HarnessAgentV1; selection: TaskSelectionV1;
  producerOperationIds: string[] };

/** The host constructs this from its verified Campaign state and immutable physical Hitch journal. */
export type CommittedRollout = {
  envelope: OperationEnvelope;
  providerManifestDigest: string;
  status: 'completed';
  outcome: OperationOutcome;
  physical: { status: 'completed'; envelope: OperationEnvelope; completion: CompletionEnvelope;
    request: EvaluationRequest; requestDigest: string; submittedIdentity?: JsonValue };
};
/** Resolve all named IDs from one verified Campaign snapshot, so a measurement has one read boundary. */
export type CommittedRolloutResolver = {
  readonly identityDigest: string;
  resolve(campaignId: string, operationIds: readonly string[]):
    Promise<Readonly<Record<string, CommittedRollout>>> | Readonly<Record<string, CommittedRollout>>;
};

/** Immutable host policy. Refs and metric semantics are never accepted from author input. */
export type FrozenAuthorMeasurementProfile = {
  campaignId: string;
  profileDigest: string;
  executionProfileDigest: string;
  accessPolicyDigest: string;
  resolverIdentityDigest: string;
  rolloutAdapterDigest: string;
  rolloutAdapterManifestDigest: string;
  rolloutPhysicalDigest: string;
  allowedExperienceViewDigests: readonly string[];
  repeatCount: number;
  recipePhase: string;
  samplingDigest: string;
  environmentDigest: string;
  /** Hitch's frozen one-task condition, excluding only the projected dataset and its derived ID. */
  rolloutCondition: Omit<EvaluationCondition, 'dataset' | 'conditionId'>;
  condition: Omit<MeasurementCondition, 'taskViewRef'>;
  metricContract: RawMetricContract;
};
export type AuthorMeasurementOptions = { artifacts: FileArtifactStore; bindings: BindingStore;
  authority: TaskViewAuthority; profile: FrozenAuthorMeasurementProfile;
  resolveCommitted: CommittedRolloutResolver };

type SealedRollout = { schemaVersion: 1; kind: 'hitch-daemon-evaluation';
  evidence: EvaluationEvidence; submittedIdentity: JsonValue; requestDigest: string };
type PhysicalReceipt = ExecutionReceipt & { executedHarnessCommit?: string; skillOverlayReceiptRef?: ArtifactRef;
  injectedSkillDigests?: string[] };

function same(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (!same(Object.keys(value).sort(), [...keys].sort())) throw new Error(`${label} fields differ from contract`);
}
function gearDigest(value: unknown, label: string): void {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value))
    throw new Error(`${label} needs namespaced SHA-256 digest`);
}
function ref(value: unknown, schemaId: string, label: string): ArtifactRef {
  const item = object(value, label) as ArtifactRef;
  if (item.kind !== 'artifact' || item.schemaId !== schemaId || item.mediaType !== 'application/json'
    || !Number.isSafeInteger(item.size) || item.size < 0) throw new Error(`${label} artifact schema mismatch`);
  assertDigest(item.digest);
  return item;
}
function completionIdentity(envelope: OperationEnvelope, completion: CompletionEnvelope): void {
  if (completion.operationId !== envelope.operationId || completion.idempotencyKey !== envelope.idempotencyKey
    || completion.inputDigest !== envelope.inputDigest || completion.implementationDigest !== envelope.implementationDigest)
    throw new Error('Rollout completion identity mismatch');
}
function frozenProfile(options: AuthorMeasurementOptions): FrozenAuthorMeasurementProfile {
  const { profile, authority, artifacts, bindings } = options;
  if (authority.artifacts !== artifacts || bindings.artifacts !== artifacts
    || typeof options.resolveCommitted?.resolve !== 'function')
    throw new Error('Author measurement host capabilities do not share one CAS');
  for (const [name, value] of Object.entries({ profileDigest: profile.profileDigest,
    executionProfileDigest: profile.executionProfileDigest, accessPolicyDigest: profile.accessPolicyDigest,
    resolverIdentityDigest: profile.resolverIdentityDigest, rolloutAdapterDigest: profile.rolloutAdapterDigest,
    rolloutAdapterManifestDigest: profile.rolloutAdapterManifestDigest, rolloutPhysicalDigest: profile.rolloutPhysicalDigest })) {
    try { assertDigest(value); } catch { throw new Error(`Invalid author measurement ${name}`); }
  }
  if (options.resolveCommitted.identityDigest !== profile.resolverIdentityDigest)
    throw new Error('Author measurement committed resolver identity drift');
  if (!profile.campaignId || !profile.recipePhase || !Number.isSafeInteger(profile.repeatCount)
    || profile.repeatCount < 1 || profile.repeatCount > 100
    || !Array.isArray(profile.allowedExperienceViewDigests) || profile.allowedExperienceViewDigests.length === 0
    || new Set(profile.allowedExperienceViewDigests).size !== profile.allowedExperienceViewDigests.length)
    throw new Error('Invalid author measurement frozen scope');
  for (const digest of profile.allowedExperienceViewDigests) assertDigest(digest);
  gearDigest(profile.samplingDigest, 'Sampling'); gearDigest(profile.environmentDigest, 'Environment');
  const rolloutCondition = object(profile.rolloutCondition, 'Frozen rollout condition');
  exact(rolloutCondition, ['partition', 'repetitions', 'model', 'sampling', 'timeoutMs', 'rolloutProviderDigest'],
    'Frozen rollout condition');
  if (rolloutCondition.partition !== 'seed' || rolloutCondition.repetitions !== 1
    || typeof rolloutCondition.model !== 'string' || !rolloutCondition.model
    || !Number.isSafeInteger(rolloutCondition.timeoutMs) || (rolloutCondition.timeoutMs as number) < 1
    || digestJson(rolloutCondition.sampling) !== profile.samplingDigest)
    throw new Error('Frozen rollout condition does not match Hitch sampling or one-task scope');
  gearDigest(rolloutCondition.rolloutProviderDigest, 'Rollout provider');
  if (profile.condition.providerImplementationDigest !== profile.rolloutPhysicalDigest
    || profile.condition.subjectSchemaId !== bindings.schema.id) throw new Error('Measurement condition/physical provider mismatch');
  for (const child of [profile.condition.evaluatorRef, profile.condition.rubricRef,
    profile.condition.environmentRef, profile.condition.samplingRef, profile.condition.budgetRef,
    profile.condition.metricSchemaRef]) artifacts.getBytes(child);
  const { digest: _digest, schemaVersion: _schemaVersion, ...metricDefinition } = profile.metricContract;
  if (!same(resolveMetric(metricDefinition), profile.metricContract) || profile.metricContract.granularity !== 'trial')
    throw new Error('Author metric contract is not a resolved per-trial metric');
  if (profile.condition.metricSchemaRef.schemaId !== 'measurement.metric-schema.v1')
    throw new Error('Author metric schema reference has wrong type');
  const schema = object(artifacts.getJson(profile.condition.metricSchemaRef), 'Author metric schema');
  if (schema.schemaVersion !== 1) throw new Error('Author metric schema version mismatch');
  const rules = object(schema.metrics, 'Author metric schema metrics');
  exact(rules, [profile.metricContract.id], 'Author metric schema metrics');
  const rule = object(rules[profile.metricContract.id], 'Author metric rule');
  if (rule.contractDigest !== profile.metricContract.digest || rule.unit !== profile.metricContract.unit)
    throw new Error('Author metric schema does not bind the raw metric contract');
  return structuredClone(profile);
}

/** A pure CAS projection over already committed work; it owns neither a ledger nor a clock. */
export function createAuthorMeasurementProvider(options: AuthorMeasurementOptions): OperationProvider {
  const { artifacts, bindings, authority, resolveCommitted } = options;
  const profile = frozenProfile(options);
  const manifest: ProviderManifest = { kind: 'author.measurement',
    implementationDigest: implementationClosureDigest(['author/measurement'], {
      profile, issuerId: authority.issuerId, authorityKeyDigest: authority.keyDigest }),
    execution: 'trusted-local', supportsInspect: true, meteredDimensions: [], hardLimitDimensions: [],
    inputSchema: { type: 'object', required: ['subject', 'selection', 'producerOperationIds'], properties: {
      subject: { type: 'any' }, selection: { type: 'any' },
      producerOperationIds: { type: 'array', items: { type: 'string' } },
    }, additionalProperties: false },
    outputSchema: { type: 'object', required: ['schemaVersion', 'subject', 'taskViewRef', 'status', 'comparable', 'trials', 'evidenceRefs'],
      properties: { schemaVersion: { type: 'integer' }, subject: { type: 'any' }, taskViewRef: { type: 'any' },
        status: { type: 'string' }, comparable: { type: 'boolean' }, trials: { type: 'array', items: { type: 'any' } },
        evidenceRefs: { type: 'array', items: { type: 'any' } }, comparisonKey: { type: 'string' },
        metrics: { type: 'object', additionalProperties: { type: 'number' } }, measurementRef: { type: 'any' } },
      additionalProperties: false },
  };

  const inputFor = (envelope: OperationEnvelope): { input: AuthorMeasurementInput; tasks: TaskEntry[];
    harnessCommit: string; condition: MeasurementCondition } => {
    if (envelope.kind !== manifest.kind || envelope.implementationDigest !== manifest.implementationDigest
      || envelope.campaignId !== profile.campaignId || envelope.inputDigest !== jsonDigest(envelope.input))
      throw new Error('Author measurement operation identity drift');
    if (Object.keys(envelope.limits).length !== 0 || envelope.startsBudgetClock === true)
      throw new Error('Author measurement cannot meter or start budget clock');
    validateSchema(manifest.inputSchema, envelope.input);
    assertJson(envelope.input);
    const input = envelope.input as AuthorMeasurementInput;
    assertHarnessAgentV1(input.subject); assertTaskSelectionV1(input.selection);
    if (!same(envelope.bindingSetRef, input.subject.bindingSetRef)
      || input.subject.executionProfileDigest !== profile.executionProfileDigest)
      throw new Error('Author measurement subject binding or execution profile drift');
    if (!Array.isArray(input.producerOperationIds)
      || input.producerOperationIds.length > input.selection.selectedTaskIds.length * profile.repeatCount
      || new Set(input.producerOperationIds).size !== input.producerOperationIds.length)
      throw new Error('Author measurement producer operation list invalid');
    for (const id of input.producerOperationIds) assertDigest(id);
    const view = authority.verify(input.selection.taskViewRef, profile.allowedExperienceViewDigests);
    if (!view.parentTaskViewDigest || view.tasks.length === 0
      || !same(input.selection.selectedTaskIds, view.tasks.map(task => task.id))
      || view.tasks.some(task => task.purpose === 'final-test'))
      throw new Error('Author measurement needs one exact signed research TaskSelection');
    const slots = bindings.read(input.subject.bindingSetRef).slots;
    // The initial physical A1 host has a single Harness slot; overlay execution needs its own proof contract.
    if (!same(Object.keys(slots), ['harness']) || slots.harness?.schemaId !== 'harness.directory.v1')
      throw new Error('Author measurement requires an exact physical Harness binding');
    const harness = object(artifacts.getJson(slots.harness), 'Bound Harness') as { schemaVersion?: number;
      kind?: string; commitOid?: string; manifestDigest?: string };
    if (harness.schemaVersion !== 1 || harness.kind !== 'git-harness'
      || typeof harness.commitOid !== 'string' || !/^[a-f0-9]{40}$/u.test(harness.commitOid)
      || typeof harness.manifestDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(harness.manifestDigest))
      throw new Error('Author measurement Harness physical identity missing');
    return { input, tasks: view.tasks, harnessCommit: harness.commitOid,
      condition: { ...profile.condition, taskViewRef: input.selection.taskViewRef } };
  };

  const evaluate = async (envelope: OperationEnvelope, seal: boolean): Promise<EvaluationV1> => {
    const { input, tasks, harnessCommit, condition } = inputFor(envelope);
    const slots = bindings.read(input.subject.bindingSetRef).slots;
    const bySlot = new Map<string, TrialV1>();
    const raw: RawTrialMetrics[] = [];
    const evidenceRefs: ArtifactRef[] = [];
    const evalIds = new Set<string>(), runIds = new Set<string>();
    const committed = await resolveCommitted.resolve(envelope.campaignId, input.producerOperationIds);
    if (!committed || typeof committed !== 'object' || Array.isArray(committed)
      || Object.keys(committed).some(id => !input.producerOperationIds.includes(id)))
      throw new Error('Committed rollout resolver returned an invalid snapshot');
    for (const operationId of input.producerOperationIds) {
      const source = Object.hasOwn(committed, operationId) ? committed[operationId] : undefined;
      // A supplied ID cannot be allowed to transition from pending to completed under this same
      // measurement key. Missing coverage is represented by an omitted ID, not a pending one.
      if (!source) throw new Error('Named rollout producer is not committed and terminal');
      const producer = source.envelope, physical = source.physical;
      if (source.status !== 'completed' || physical.status !== 'completed' || producer.operationId !== operationId
        || producer.operationId === envelope.operationId || producer.campaignId !== envelope.campaignId
        || producer.kind !== 'execution.rollout' || producer.implementationDigest !== profile.rolloutAdapterDigest
        || source.providerManifestDigest !== profile.rolloutAdapterManifestDigest
        || producer.inputDigest !== jsonDigest(producer.input)
        || !same(producer.bindingSetRef, input.subject.bindingSetRef)
        || !same(physical.envelope, { ...producer, implementationDigest: profile.rolloutPhysicalDigest }))
        throw new Error('Producer is not a committed rollout for this subject and campaign');
      completionIdentity(physical.envelope, physical.completion);
      if (!same(physical.completion.outcome, source.outcome))
        throw new Error('Physical rollout outcome differs from committed Campaign outcome');
      const request = object(producer.input, 'Producer rollout input');
      const task = tasks.find(item => item.id === (request.task as { id?: unknown } | undefined)?.id);
      const repeatIndex = request.repeatIndex === undefined ? 0 : request.repeatIndex;
      if (!task || !same(request.task, task) || !same(request.taskViewRef, input.selection.taskViewRef)
        || !Number.isSafeInteger(repeatIndex) || (repeatIndex as number) < 0 || (repeatIndex as number) >= profile.repeatCount
        || request.recipePhase !== profile.recipePhase || request.samplingDigest !== profile.samplingDigest
        || request.environmentDigest !== profile.environmentDigest
        || request.executedRevisionDigest !== input.subject.bindingSetRef.digest
        || request.skillBindingSetDigest !== undefined || request.injectedSkillRefs !== undefined)
        throw new Error('Producer task, repeat, or execution condition drift');
      const index = repeatIndex as number, key = JSON.stringify([task.id, index]);
      if (bySlot.has(key)) throw new Error('Two producer operations claim one measurement slot');
      const submittedRequest = physical.request;
      if (!submittedRequest || typeof submittedRequest !== 'object' || Array.isArray(submittedRequest)
        || submittedRequest.phase !== 'author-candidate' || submittedRequest.harnessRef !== harnessCommit
        || !submittedRequest.condition || typeof submittedRequest.dataset !== 'string' || !submittedRequest.dataset
        || submittedRequest.condition.dataset?.ref !== submittedRequest.dataset
        || !same(Object.fromEntries(Object.entries(submittedRequest.condition)
          .filter(([field]) => field !== 'dataset' && field !== 'conditionId')), profile.rolloutCondition)
        || typeof submittedRequest.condition.conditionId !== 'string'
        || submittedRequest.condition.conditionId !== digestJson(Object.fromEntries(Object.entries(submittedRequest.condition)
          .filter(([field]) => field !== 'conditionId')))
        || typeof submittedRequest.condition.dataset.digest !== 'string'
        || !/^sha256:[a-f0-9]{64}$/u.test(submittedRequest.condition.dataset.digest)
        || physical.requestDigest !== digestJson(submittedRequest))
        throw new Error('Saved Hitch request, condition, or request digest differs from frozen profile');
      if (source.outcome.kind !== 'result') {
        const code = source.outcome.kind === 'error' ? source.outcome.code : source.outcome.kind;
        bySlot.set(key, { taskId: task.id, repeatIndex: index, status: 'failed', code });
        continue;
      }
      const result = object(source.outcome.value, 'Rollout result') as ExecutionResult;
      const evidenceRef = ref(result.evidenceRef, 'execution.rollout.evidence.v1', 'Rollout evidence');
      const receiptRef = ref(result.receiptRef, 'execution.receipt.v1', 'Rollout receipt');
      if (result.requestedBindingSetDigest !== input.subject.bindingSetRef.digest
        || !same(result.actualBindings, slots) || !same(Object.keys(result).sort(),
          ['requestedBindingSetDigest', 'actualBindings', 'evidenceRef', 'receiptRef'].sort()))
        throw new Error('Rollout did not execute the subject binding');
      const receipt = artifacts.getJson(receiptRef) as unknown as PhysicalReceipt;
      if (receipt.schemaVersion !== 1 || receipt.providerImplementationDigest !== profile.rolloutPhysicalDigest
        || receipt.operationId !== operationId || receipt.inputDigest !== producer.inputDigest
        || receipt.loadedBindingSetDigest !== input.subject.bindingSetRef.digest
        || receipt.evidenceDigest !== evidenceRef.digest || receipt.bindingUse !== 'executed'
        || !same(receipt.actualBindings, Object.fromEntries(Object.entries(slots).map(([slot, ref]) => [slot, ref.digest])))
        || receipt.samplingDigest !== profile.samplingDigest || receipt.environmentDigest !== profile.environmentDigest
        || receipt.executedHarnessCommit !== harnessCommit || receipt.skillOverlayReceiptRef !== undefined
        || receipt.injectedSkillDigests !== undefined)
        throw new Error('Physical rollout receipt or actual bindings drift');
      const sealedEvidence = artifacts.getJson(evidenceRef) as unknown as SealedRollout;
      const evidence = sealedEvidence.evidence;
      if (sealedEvidence.schemaVersion !== 1 || sealedEvidence.kind !== 'hitch-daemon-evaluation'
        || sealedEvidence.requestDigest !== physical.requestDigest
        || !same(sealedEvidence.submittedIdentity, physical.submittedIdentity)
        || !evidence || evidence.provider !== 'hitch-cli'
        || evidence.provider !== (physical.submittedIdentity as { provider?: unknown })?.provider
        || evidence.effectiveConfigDigest !== (physical.submittedIdentity as { effectiveConfigDigest?: unknown })?.effectiveConfigDigest
        || ((physical.submittedIdentity as { evalId?: unknown })?.evalId !== undefined
          && evidence.evalId !== (physical.submittedIdentity as { evalId?: unknown })?.evalId)
        || evidence.invocationFingerprint !== (physical.submittedIdentity as { invocationFingerprint?: unknown })?.invocationFingerprint
        || !/^eval_[a-f0-9]{32}$/u.test(evidence.evalId)
        || evidence.requestedCommit !== submittedRequest.harnessRef || evidence.actualCommit !== submittedRequest.harnessRef
        || evidence.conditionId !== submittedRequest.condition.conditionId
        || evidence.dataset !== submittedRequest.dataset
        || evidence.plannedTrialCount !== submittedRequest.condition.repetitions
        || evidence.trials.length + evidence.invalidTrials.length !== 1
        || [...evidence.trials, ...evidence.invalidTrials][0]?.taskName !== task.id
        || receipt.executionIdentity !== digestJson({ evalId: evidence.evalId,
          submittedIdentity: physical.submittedIdentity, evidenceDigest: evidenceRef.digest, overlayReceiptDigest: null }))
        throw new Error('Physical Hitch evidence or submitted evaluation identity drift');
      if (evalIds.has(evidence.evalId)) throw new Error('Hitch evalId reused across measurement slots');
      evalIds.add(evidence.evalId);
      const physicalTrial = [...evidence.trials, ...evidence.invalidTrials][0]!;
      if (typeof physicalTrial.runId !== 'string' || !physicalTrial.runId
        || !Number.isSafeInteger(physicalTrial.attempt) || (physicalTrial.attempt ?? 0) < 1)
        throw new Error('Hitch trial run identity missing');
      if (runIds.has(physicalTrial.runId)) throw new Error('Hitch runId reused across measurement slots');
      runIds.add(physicalTrial.runId);
      evidenceRefs.push(evidenceRef);
      const invalid = evidence.completeness !== 'complete' || evidence.invalidTrials.length !== 0
        || evidence.trials.length !== 1 || physicalTrial.status !== 'completed';
      if (invalid) {
        bySlot.set(key, { taskId: task.id, repeatIndex: index, status: 'invalid', evidenceRef, receiptRef,
          code: evidence.invalidTrials[0]?.invalidReason ?? 'physical_trial_invalid' });
        continue;
      }
      const trial = evidence.trials[0]!;
      if (trial.scores?.normalization !== 'standard' || typeof trial.scores.totalScore !== 'number'
        || !Number.isFinite(trial.scores.totalScore)) {
        bySlot.set(key, { taskId: task.id, repeatIndex: index, status: 'invalid', evidenceRef, receiptRef,
          code: 'nonstandard_trial_score' });
        continue;
      }
      const projected = extractRawMetrics({ contracts: [profile.metricContract], trial, certified: true,
        identity: { taskId: task.id, repetition: index, runId: trial.runId!, attempt: trial.attempt!,
          harnessCommit, conditionDigest: evidence.conditionId,
          originalArtifactRefs: [evidenceRef.digest] } });
      const metric = projected.metrics[profile.metricContract.id];
      if (metric?.status !== 'available') {
        bySlot.set(key, { taskId: task.id, repeatIndex: index, status: 'invalid', evidenceRef, receiptRef,
          code: `metric_${metric?.status ?? 'missing'}` });
        continue;
      }
      raw.push(projected);
      bySlot.set(key, { taskId: task.id, repeatIndex: index, status: 'completed', evidenceRef, receiptRef });
    }
    const trials = tasks.flatMap(task => Array.from({ length: profile.repeatCount }, (_, index) =>
      bySlot.get(JSON.stringify([task.id, index])))).filter((trial): trial is TrialV1 => trial !== undefined);
    const uniqueEvidence = [...new Map(evidenceRefs.map(ref => [ref.digest, ref])).values()];
    const expectedCount = tasks.length * profile.repeatCount;
    const hasInvalid = trials.some(trial => trial.status === 'invalid');
    const complete = trials.length === expectedCount && trials.every(trial => trial.status === 'completed');
    const partial: EvaluationV1 = { schemaVersion: 1, subject: input.subject,
      taskViewRef: input.selection.taskViewRef, status: hasInvalid ? 'invalid' : 'incomplete',
      comparable: false, trials, evidenceRefs: uniqueEvidence };
    if (!complete) { assertEvaluationV1(partial); return partial; }
    const aggregate = aggregateRawMetrics([profile.metricContract], tasks.map(task => ({ id: task.id,
      repetitions: Array.from({ length: profile.repeatCount }, (_, index) => index), weight: 1 })), raw);
    const metric = aggregate[profile.metricContract.id];
    if (metric?.status !== 'available' || typeof metric.value !== 'number' || !Number.isFinite(metric.value))
      throw new Error('Complete raw metric scope did not aggregate');
    const metrics = { [profile.metricContract.id]: metric.value };
    const measurementInput = { subjectBindings: input.subject.bindingSetRef, condition,
      evidenceRefs: uniqueEvidence, metrics,
      evaluatedAtCursor: jsonDigest({ producerOperationIds: input.producerOperationIds.slice().sort(),
        evalIds: [...evalIds].sort(), runIds: [...runIds].sort() }) };
    validateMeasurementInput(artifacts, measurementInput);
    if (!seal) { // Admission may read/validate, but never writes a CAS object.
      const check: EvaluationV1 = { ...partial, status: 'incomplete' };
      assertEvaluationV1(check); return check;
    }
    const measurementRef = sealMeasurement(artifacts, measurementInput);
    const evaluation: EvaluationV1 = { schemaVersion: 1, subject: input.subject,
      taskViewRef: input.selection.taskViewRef, status: 'complete', comparable: true,
      comparisonKey: measurementComparisonKey(condition), metrics, measurementRef,
      trials, evidenceRefs: uniqueEvidence };
    assertEvaluationV1(evaluation);
    return evaluation;
  };
  const completion = async (envelope: OperationEnvelope): Promise<CompletionEnvelope> => ({
    operationId: envelope.operationId, idempotencyKey: envelope.idempotencyKey,
    inputDigest: envelope.inputDigest, implementationDigest: envelope.implementationDigest,
    outcome: { kind: 'result', value: await evaluate(envelope, true) as unknown as JsonValue },
  });
  return { describe: () => structuredClone(manifest),
    preflight: async envelope => { await evaluate(envelope, false); },
    inspect: async envelope => { await evaluate(envelope, false); return { status: 'not-started' } as ProviderInspection; },
    submit: async envelope => ({ status: 'completed', completion: await completion(envelope) } as ProviderSubmission),
    collect: completion,
    cancel: async envelope => { inputFor(envelope); return { status: 'cancelled', releaseConfirmed: true } as ProviderInspection; },
  } satisfies OperationProvider;
}
