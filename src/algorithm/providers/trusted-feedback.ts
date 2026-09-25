import type { ArtifactRef, CompletionEnvelope, OperationEnvelope, ProviderInspection, ProviderManifest, ProviderSubmission } from '../contracts.js';
import { FileArtifactStore, assertDigest } from '../artifacts.js';
import { BindingStore } from '../bindings.js';
import { canonicalJson, jsonDigest, type JsonSchema, type JsonValue } from '../schema.js';
import { TaskViewAuthority, readTaskView, type TaskEntry, type TaskViewRef } from '../data/tasks.js';
import { implementationClosureDigest } from '../data/identity.js';
import { LocalDurableProvider } from '../runtime/providers.js';
import { VerifiedExecutionAdapter, executionResultSchema, type ExecutionReceipt, type ExecutionResult, type PhysicalExecutionPort } from './execution.js';
import { verifyCompletedRolloutProducer, type RolloutEvidenceAuthorization } from './rollout-evidence.js';

export type TrustedFeedbackOptions = {
  root: string;
  stateRoot: string;
  artifacts: FileArtifactStore;
  bindings: BindingStore;
  taskAuthority: TaskViewAuthority;
  allowedExperienceViewDigests(campaignId: string): readonly string[];
  /** Frozen host scoring policy, applied to the mean of observed normalized scores. */
  passThreshold: number;
  expectedAheRepeats: number;
  accessPolicyDigest: string;
};

type FeedbackInput = {
  mode: 'ahe.task-measurement' | 'evo.task-feedback';
  task: TaskEntry;
  taskViewRef: TaskViewRef;
  authorizedRollouts: RolloutEvidenceAuthorization[];
  rolloutEvidenceRefs?: ArtifactRef[];
  rolloutEvidenceRef?: ArtifactRef;
  executedRevisionDigest?: string;
  injectedSkillRefs?: ArtifactRef[];
};

const resultSchema: JsonSchema = { type: 'object', required: ['score', 'passed'],
  properties: { score: { type: 'number' }, passed: { type: 'boolean' } }, additionalProperties: false };
function same(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }
function finiteUnit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Scores only completed, identity-bound one-task Hitch observations; no model can report a score. */
export class TrustedRolloutFeedbackPort implements PhysicalExecutionPort {
  private readonly manifest: ProviderManifest & { kind: 'execution.feedback'; structuredResultSchema: JsonSchema };
  private readonly durable: LocalDurableProvider;
  private readonly passThreshold: number;
  private readonly expectedAheRepeats: number;
  private readonly authorityIdentity: { issuerId: string; keyDigest: string };
  private readonly allowedExperienceViewDigests: TrustedFeedbackOptions['allowedExperienceViewDigests'];

  constructor(readonly options: TrustedFeedbackOptions) {
    if (!finiteUnit(options.passThreshold) || !Number.isSafeInteger(options.expectedAheRepeats)
      || options.expectedAheRepeats < 1 || options.expectedAheRepeats > 100) throw new Error('Invalid trusted feedback scoring policy');
    assertDigest(options.accessPolicyDigest);
    this.passThreshold = options.passThreshold;
    this.expectedAheRepeats = options.expectedAheRepeats;
    this.authorityIdentity = { issuerId: options.taskAuthority.issuerId, keyDigest: options.taskAuthority.keyDigest };
    this.allowedExperienceViewDigests = options.allowedExperienceViewDigests;
    const implementationDigest = implementationClosureDigest(['providers/trusted-feedback'], {
      passThreshold: this.passThreshold, expectedAheRepeats: this.expectedAheRepeats,
      accessPolicyDigest: options.accessPolicyDigest, authorityIdentity: this.authorityIdentity });
    this.manifest = { kind: 'execution.feedback', implementationDigest, execution: 'trusted-local',
      supportsInspect: true, meteredDimensions: [],
      inputSchema: { type: 'object', required: ['mode', 'task', 'taskViewRef', 'authorizedRollouts'],
        properties: { mode: { type: 'string' }, task: { type: 'any' }, taskViewRef: { type: 'any' },
          authorizedRollouts: { type: 'array', items: { type: 'any' } }, rolloutEvidenceRefs: { type: 'array', items: { type: 'any' } },
          rolloutEvidenceRef: { type: 'any' }, executedRevisionDigest: { type: 'string' },
          injectedSkillRefs: { type: 'array', items: { type: 'any' } } }, additionalProperties: false },
      outputSchema: executionResultSchema, structuredResultSchema: resultSchema };
    this.durable = new LocalDurableProvider(options.root, this.manifest, envelope => ({
      outcome: { kind: 'result', value: this.evaluate(envelope, true)! as unknown as JsonValue },
    }));
  }

  describe(): typeof this.manifest { return structuredClone(this.manifest); }

  private evaluate(envelope: OperationEnvelope, seal: boolean): ExecutionResult | undefined {
    if (envelope.kind !== 'execution.feedback' || envelope.implementationDigest !== this.manifest.implementationDigest)
      throw new Error('Trusted feedback implementation identity drift');
    const input = envelope.input as FeedbackInput;
    if (!input || !['ahe.task-measurement', 'evo.task-feedback'].includes(input.mode)
      || !input.task || typeof input.task.id !== 'string' || !Array.isArray(input.authorizedRollouts))
      throw new Error('Invalid trusted feedback input');
    if (this.options.taskAuthority.issuerId !== this.authorityIdentity.issuerId
      || this.options.taskAuthority.keyDigest !== this.authorityIdentity.keyDigest)
      throw new Error('Trusted feedback task authority identity drift');
    this.options.taskAuthority.verify(input.taskViewRef, this.allowedExperienceViewDigests(envelope.campaignId));
    const view = readTaskView(this.options.artifacts, input.taskViewRef);
    const task = view.tasks.find(item => item.id === input.task.id);
    if (!task || !same(task, input.task) || task.purpose === 'final-test')
      throw new Error('Feedback task is not in the authorized research view');
    const expected = input.mode === 'ahe.task-measurement' ? this.expectedAheRepeats : 1;
    if (input.authorizedRollouts.length !== expected) throw new Error('Trusted feedback rollout count mismatch');
    if (input.mode === 'ahe.task-measurement') {
      if (input.executedRevisionDigest !== envelope.bindingSetRef.digest
        || !Array.isArray(input.rolloutEvidenceRefs) || input.rolloutEvidenceRefs.length !== expected
        || input.rolloutEvidenceRef !== undefined || input.injectedSkillRefs !== undefined)
        throw new Error('AHE feedback input or revision mismatch');
    } else {
      if (!input.rolloutEvidenceRef || !same(input.rolloutEvidenceRef, input.authorizedRollouts[0]?.evidenceRef)
        || input.rolloutEvidenceRefs !== undefined || input.executedRevisionDigest !== undefined
        || !Array.isArray(input.injectedSkillRefs)) throw new Error('Evo feedback input mismatch');
    }
    const seen = new Set<string>();
    const seenEvaluations = new Set<string>();
    const seenRunAttempts = new Set<string>();
    const scores: number[] = [];
    const producerOperationIds: string[] = [];
    let frozenCondition: { samplingDigest: string; environmentDigest: string } | undefined;
    for (const [index, authorization] of input.authorizedRollouts.entries()) {
      if (!authorization || !authorization.evidenceRef || !authorization.receiptRef
        || input.mode === 'ahe.task-measurement' && !same(input.rolloutEvidenceRefs![index], authorization.evidenceRef))
        throw new Error('Feedback rollout authorization tuple mismatch');
      const producer = verifyCompletedRolloutProducer({ stateRoot: this.options.stateRoot,
        artifacts: this.options.artifacts }, envelope, authorization);
      if (producer.taskId !== task.id || producer.bindingSetDigest !== envelope.bindingSetRef.digest
        || seen.has(producer.producerOperationId)) throw new Error('Feedback producer task, binding or repetition mismatch');
      const source = producer.producerInput;
      if (!same(source.task, task) || !same(source.taskViewRef, input.taskViewRef)
        || !source.samplingDigest || !source.environmentDigest) throw new Error('Feedback producer task view or condition mismatch');
      const condition = { samplingDigest: source.samplingDigest, environmentDigest: source.environmentDigest };
      if (frozenCondition && !same(condition, frozenCondition)) throw new Error('Feedback producer condition mismatch');
      frozenCondition = condition;
      if (input.mode === 'ahe.task-measurement') {
        if (source.recipePhase !== 'ahe.measure' || source.repeatIndex !== index
          || source.executedRevisionDigest !== envelope.bindingSetRef.digest
          || source.skillBindingSetDigest !== undefined || source.injectedSkillRefs !== undefined)
          throw new Error('AHE producer repeat slot or executed revision mismatch');
      } else {
        const physicalReceipt = producer.receipt as ExecutionReceipt & { injectedSkillDigests?: string[];
          skillOverlayReceiptRef?: ArtifactRef };
        if (source.recipePhase !== 'evo.batch' || source.repeatIndex !== undefined
          || source.skillBindingSetDigest !== envelope.bindingSetRef.digest
          || !same(source.injectedSkillRefs, input.injectedSkillRefs)
          || new Set(input.injectedSkillRefs!.map(ref => ref.digest)).size !== input.injectedSkillRefs!.length
          || !Array.isArray(physicalReceipt.injectedSkillDigests)
          || !same([...physicalReceipt.injectedSkillDigests].sort(), input.injectedSkillRefs!.map(ref => ref.digest).sort())
          || !physicalReceipt.skillOverlayReceiptRef) {
          throw new Error('Evo producer did not prove exact physical Skill injection');
        }
      }
      seen.add(producer.producerOperationId); producerOperationIds.push(producer.producerOperationId);
      const evidence = producer.evidence, trial = evidence.trials[0];
      if (evidence.completeness !== 'complete' || evidence.plannedTrialCount !== 1
        || evidence.invalidTrials.length !== 0 || evidence.trials.length !== 1
        || !trial || trial.status !== 'completed' || trial.taskName !== task.id
        || !evidence.evalId || typeof trial.runId !== 'string' || !trial.runId
        || !Number.isSafeInteger(trial.attempt) || (trial.attempt ?? 0) < 1
        || trial.scores?.normalization !== 'standard' || !finiteUnit(trial.scores.totalScore)
        || !finiteUnit(evidence.primaryReward) || !finiteUnit(evidence.summary.score)
        || Math.abs(evidence.primaryReward - trial.scores.totalScore) > 1e-12
        || Math.abs(evidence.summary.score - trial.scores.totalScore) > 1e-12) {
        throw new Error('Feedback requires a complete standard normalized physical trial');
      }
      const runAttempt = `${trial.runId}:${trial.attempt}`;
      if (seenEvaluations.has(evidence.evalId) || seenRunAttempts.has(runAttempt)) {
        throw new Error('Feedback physical evaluation or trial attempt was counted twice');
      }
      seenEvaluations.add(evidence.evalId); seenRunAttempts.add(runAttempt);
      scores.push(trial.scores.totalScore);
    }
    const score = scores.reduce((sum, item) => sum + item, 0) / scores.length;
    const structuredResult = { score, passed: score >= this.passThreshold };
    const actualBindings = this.options.bindings.read(envelope.bindingSetRef).slots;
    if (!actualBindings.harness || input.mode === 'evo.task-feedback' && !actualBindings.skills)
      throw new Error('Trusted feedback is missing a bound harness or Skill library');
    if (!seal) return undefined;
    const structuredResultRef = this.options.artifacts.putJson(structuredResult, 'execution.feedback.structured.v1');
    const evidenceRef = this.options.artifacts.putJson({ schemaVersion: 1, mode: input.mode,
      taskId: task.id, bindingSetDigest: envelope.bindingSetRef.digest, producerOperationIds,
      rolloutEvidenceDigests: input.authorizedRollouts.map(item => item.evidenceRef.digest), scores,
      policy: { passThreshold: this.passThreshold, expectedAheRepeats: this.expectedAheRepeats },
    } as JsonValue, 'execution.feedback.evidence.v1');
    const receipt: ExecutionReceipt = { schemaVersion: 1, providerImplementationDigest: this.manifest.implementationDigest,
      operationId: envelope.operationId, inputDigest: envelope.inputDigest,
      loadedBindingSetDigest: envelope.bindingSetRef.digest, evidenceDigest: evidenceRef.digest,
      actualBindings: Object.fromEntries(Object.entries(actualBindings).map(([slot, ref]) => [slot, ref.digest])),
      bindingUse: 'host-admission-only', executionIdentity: jsonDigest({ producerOperationIds,
        rolloutEvidenceDigests: input.authorizedRollouts.map(item => item.evidenceRef.digest), scores }),
      structuredResultDigest: jsonDigest(structuredResult) };
    const receiptRef = this.options.artifacts.putJson(receipt as unknown as JsonValue, 'execution.receipt.v1');
    return { requestedBindingSetDigest: envelope.bindingSetRef.digest, actualBindings, evidenceRef, receiptRef,
      structuredResult, structuredResultRef };
  }

  preflight(envelope: OperationEnvelope): void { this.evaluate(envelope, false); }
  submit(envelope: OperationEnvelope): Promise<ProviderSubmission> { return this.durable.submit(envelope); }
  inspect(envelope: OperationEnvelope): Promise<ProviderInspection> { return this.durable.inspect(envelope); }
  cancel(envelope: OperationEnvelope): Promise<ProviderInspection> { return this.durable.cancel(envelope); }
  collect(envelope: OperationEnvelope): Promise<CompletionEnvelope> { return this.durable.collect(envelope); }
}

export function createTrustedRolloutFeedbackAdapter(options: TrustedFeedbackOptions): VerifiedExecutionAdapter {
  return new VerifiedExecutionAdapter(new TrustedRolloutFeedbackPort(options), options.artifacts, options.bindings, ['harness']);
}
