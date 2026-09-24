import { mkdir } from 'node:fs/promises';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { ArtifactRef, BudgetPlan, CompletionEnvelope, OperationEnvelope, ProviderInspection, ProviderManifest, ProviderSubmission, UsageReceipt } from '../contracts.js';
import { FileArtifactStore, assertDigest, durableWrite } from '../artifacts.js';
import { BindingStore } from '../bindings.js';
import { assertJson, canonicalJson, jsonDigest, type JsonValue } from '../schema.js';
import { implementationClosureDigest } from '../data/identity.js';
import { TaskViewAuthority, readTaskView, type TaskEntry, type TaskViewRef } from '../data/tasks.js';
import type { FreshHitchRolloutContext } from '../data/fresh-rollout-context.js';
import { VerifiedExecutionAdapter, executionResultSchema, type ExecutionReceipt, type ExecutionResult, type PhysicalExecutionPort } from './execution.js';
import { EvolutionRegistryStore } from '../../state/evolution.js';
import { HarnessBuilder } from '../../harness/builder.js';
import { HitchCliEvaluator } from '../../evaluator/hitch-cli.js';
import { findSubmittedHitchReservationReadOnly } from './hitch-readonly.js';
import { describeDataset, projectDataset } from '../../search/dataset-projection.js';
import { digestJson } from '../../state/digest.js';
import { digestDatasetRef } from '../../state/dataset.js';
import type { EvaluationCondition, EvaluationRequest, EvaluationReservation, EvaluationSubmissionIntent, RefinementRound, EvolutionSpec } from '../../types.js';

export type GitHarnessBinding = { schemaVersion: 1; kind: 'git-harness'; commitOid: string; manifestDigest: string };
export type HitchRolloutInput = { task: TaskEntry; taskViewRef: TaskViewRef; repeatIndex?: number;
  samplingDigest: string; environmentDigest: string; recipePhase: string; executedRevisionDigest?: string;
  skillBindingSetDigest?: string; injectedSkillRefs?: ArtifactRef[] };
type HitchRolloutHostCommon = { workspaceRoot: string; stateRoot: string; artifacts: FileArtifactStore; bindings: BindingStore;
  taskAuthority: TaskViewAuthority; allowedExperienceViewDigests(campaignId: string): readonly string[];
  accessPolicyDigest: string; builder: HarnessBuilder; evaluator: HitchCliEvaluator; campaignBudget: BudgetPlan };
export type HitchRolloutHostOptions = HitchRolloutHostCommon & (
  { registry: EvolutionRegistryStore; evolutionId: string; roundId: string; freshContext?: never }
  | { freshContext: FreshHitchRolloutContext; registry?: never; evolutionId?: never; roundId?: never });

type Prepared = { input: HitchRolloutInput; task: TaskEntry; bindingSlots: Record<string, ArtifactRef>;
  request: EvaluationRequest; contextRound: RefinementRound; intent: EvaluationSubmissionIntent };
type SubmittedIdentity = NonNullable<Awaited<ReturnType<HitchCliEvaluator['submittedEvaluationIdentity']>>>;
type Journal = { envelope: OperationEnvelope; requestDigest: string; intent: EvaluationSubmissionIntent;
  status: 'intent' | 'reserved' | 'cancelling' | 'cancelled' | 'completed';
  reservation?: EvaluationReservation; identity?: SubmittedIdentity; completion?: CompletionEnvelope; receipt?: UsageReceipt };

/** Physical seed rollout. It reuses Gear's durable staged search bridge into Hitch daemon, not a synthetic result. */
export class HitchRolloutPort implements PhysicalExecutionPort {
  private readonly manifest: ProviderManifest & { kind: 'execution.rollout' };
  private readonly records: string;
  private readonly meterSource: string | undefined;
  private readonly metered: boolean;
  private readonly environmentDigest: string;
  private readonly samplingDigest: string;
  private readonly sourceRoundDigest: string;
  private readonly sourceSpecDigest: string;

  private constructor(readonly options: HitchRolloutHostOptions, readonly spec: EvolutionSpec,
    readonly round: RefinementRound) {
    if (options.evaluator.options.controlPlane?.mode !== 'daemon') throw new Error('Durable Hitch rollout requires daemon mode');
    if (resolve(options.workspaceRoot) !== resolve(round.workspaceRoot)
      || options.builder.repositoryPath !== options.evaluator.repositoryPath) throw new Error('Hitch rollout host/source workspace mismatch');
    assertDigest(options.accessPolicyDigest);
    const budget = options.campaignBudget['rollout.trials'];
    this.meterSource = budget?.source;
    this.metered = budget !== undefined;
    if (this.meterSource && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(this.meterSource)) throw new Error('Invalid Hitch meter source');
    this.sourceRoundDigest = digestJson(round);
    this.sourceSpecDigest = digestJson(spec);
    this.samplingDigest = digestJson(round.plan.seed.sampling);
    this.environmentDigest = digestJson({ evolution: this.sourceSpecDigest, roundPlan: round.plan.digest,
      evaluator: JSON.parse(JSON.stringify(options.evaluator.options)),
      forwardedEnvironment: Object.fromEntries(options.evaluator.options.passEnv.map(name =>
        [name, process.env[name] === undefined ? null : jsonDigest(process.env[name])])),
      builder: { repositoryPath: options.builder.repositoryPath,
        targetRoot: options.builder.targetRoot, toolchainRef: options.builder.options.toolchainRef,
        sandboxProfileRef: options.builder.options.sandboxProfileRef } });
    this.records = join(options.stateRoot, 'algorithm-hitch-operations');
    mkdirSync(this.records, { recursive: true });
    this.manifest = { kind: 'execution.rollout',
      implementationDigest: implementationClosureDigest(['providers/hitch', 'providers/execution'], {
        sourceKind: options.freshContext ? 'fresh-context' : 'legacy-round',
        sourceSpecDigest: this.sourceSpecDigest, sourceRoundDigest: this.sourceRoundDigest,
        environmentDigest: this.environmentDigest, samplingDigest: this.samplingDigest,
        accessPolicyDigest: options.accessPolicyDigest, issuerId: options.taskAuthority.issuerId,
        keyDigest: options.taskAuthority.keyDigest, meterSource: this.meterSource ?? null,
        metered: this.metered, hard: budget?.capability === 'hard' }),
      execution: 'external', supportsInspect: true, meteredDimensions: this.metered ? ['rollout.trials'] : [],
      hardLimitDimensions: budget?.capability === 'hard' ? ['rollout.trials'] : [],
      inputSchema: { type: 'object', required: ['task', 'taskViewRef', 'samplingDigest', 'environmentDigest', 'recipePhase'],
        properties: { task: { type: 'any' }, taskViewRef: { type: 'any' }, samplingDigest: { type: 'string' },
          environmentDigest: { type: 'string' }, recipePhase: { type: 'string' }, repeatIndex: { type: 'integer' },
          executedRevisionDigest: { type: 'string' }, skillBindingSetDigest: { type: 'string' },
          injectedSkillRefs: { type: 'array', items: { type: 'any' } } }, additionalProperties: false },
      outputSchema: executionResultSchema };
  }

  static async create(options: HitchRolloutHostOptions): Promise<HitchRolloutPort> {
    if (options.freshContext) {
      const { spec, round, specDigest, roundDigest, datasetDigest } = options.freshContext;
      if (options.freshContext.schemaVersion !== 1 || digestJson(spec) !== specDigest
        || digestJson(round) !== roundDigest || round.evolutionId !== spec.evolutionId
        || round.seedTaskRef !== spec.datasets.seed.ref || round.plan.seed.dataset.digest !== spec.datasets.seed.digest
        || round.plan.seed.partition !== 'seed') throw new Error('Fresh Hitch rollout context identity mismatch');
      const description = await describeDataset(spec, 'seed', options.workspaceRoot);
      if (description.sourceDigest !== datasetDigest) throw new Error('Fresh Hitch rollout context dataset drift');
      await mkdir(options.stateRoot, { recursive: true });
      return new HitchRolloutPort(options, structuredClone(spec), structuredClone(round));
    }
    const spec = await options.registry.requireSpec(options.evolutionId);
    const entry = await options.registry.readEntry(options.evolutionId);
    const round = await options.registry.stateStore(options.evolutionId).readRound(options.roundId);
    if (!entry || entry.specDigest !== digestJson(spec) || !round || round.evolutionId !== spec.evolutionId
      || round.seedTaskRef !== spec.datasets.seed.ref || round.plan.seed.dataset.digest !== spec.datasets.seed.digest)
      throw new Error('Hitch rollout source evolution/round unavailable or mismatched');
    await mkdir(options.stateRoot, { recursive: true });
    return new HitchRolloutPort(options, spec, round);
  }

  /** Host records these concrete digests in Campaign config; recipes must echo them. */
  profile(): { samplingDigest: string; environmentDigest: string } {
    return { samplingDigest: this.samplingDigest, environmentDigest: this.environmentDigest };
  }
  describe(): ProviderManifest & { kind: 'execution.rollout' } { return structuredClone(this.manifest); }
  private async currentRound(): Promise<RefinementRound> {
    if (this.options.freshContext) {
      if (digestJson(this.options.freshContext.round) !== this.sourceRoundDigest)
        throw new Error('Fresh Hitch rollout context round changed');
      return this.round;
    }
    const current = await this.options.registry.stateStore(this.options.evolutionId).readRound(this.options.roundId);
    if (!current || digestJson(current) !== this.sourceRoundDigest) throw new Error('Hitch rollout source round changed');
    return current;
  }
  private async currentSpec(): Promise<void> {
    if (this.options.freshContext) {
      if (digestJson(this.options.freshContext.spec) !== this.sourceSpecDigest)
        throw new Error('Fresh Hitch rollout context spec changed');
      return;
    }
    const current = await this.options.registry.requireSpec(this.options.evolutionId);
    if (digestJson(current) !== this.sourceSpecDigest) throw new Error('Hitch rollout source spec changed');
  }
  private async prepared(envelope: OperationEnvelope): Promise<Prepared> {
    if (envelope.kind !== this.manifest.kind || envelope.implementationDigest !== this.manifest.implementationDigest)
      throw new Error('Hitch rollout implementation identity drift');
    await this.currentSpec(); await this.currentRound();
    if (this.metered && (!Number.isSafeInteger(envelope.limits['rollout.trials']) || envelope.limits['rollout.trials']! < 1))
      throw new Error('Hitch trial reservation missing or insufficient');
    const input = envelope.input as HitchRolloutInput;
    if (input.samplingDigest !== this.samplingDigest || input.environmentDigest !== this.environmentDigest
      || !input.recipePhase || input.injectedSkillRefs?.length || input.skillBindingSetDigest) {
      throw new Error('Hitch rollout configuration or unsupported skill injection mismatch');
    }
    if (input.executedRevisionDigest && input.executedRevisionDigest !== envelope.bindingSetRef.digest)
      throw new Error('Hitch executed revision does not match bound version');
    this.options.taskAuthority.verify(input.taskViewRef, this.options.allowedExperienceViewDigests(envelope.campaignId));
    const view = readTaskView(this.options.artifacts, input.taskViewRef);
    const task = view.tasks.find(item => item.id === input.task?.id);
    if (!task || canonicalJson(task) !== canonicalJson(input.task) || task.purpose === 'final-test')
      throw new Error('Hitch rollout task is not an authorized research task');
    const content = this.options.artifacts.getJson(task.contentRef) as unknown as { prompt?: string; executionSource?: {
      kind?: string; datasetDigest?: string; taskContentDigest?: string } };
    const description = await describeDataset(this.spec, 'seed', this.options.workspaceRoot);
    const declared = description.universe.tasks.find(item => item.id === task.id);
    if (!declared || content.executionSource?.kind !== 'compiled-seed-dataset'
      || content.executionSource.datasetDigest !== description.sourceDigest
      || content.executionSource.taskContentDigest !== declared.contentDigest) {
      throw new Error('Hitch rollout task source bytes are not physically bound');
    }
    const bindingSlots = this.options.bindings.read(envelope.bindingSetRef).slots;
    if (Object.keys(bindingSlots).sort().join('\0') !== 'harness') throw new Error('Hitch rollout requires an exact harness binding');
    const harnessRef = bindingSlots.harness!;
    if (harnessRef.schemaId !== 'harness.directory.v1') throw new Error('Hitch harness binding schema mismatch');
    const harness = this.options.artifacts.getJson(harnessRef) as unknown as GitHarnessBinding;
    if (harness.schemaVersion !== 1 || harness.kind !== 'git-harness'
      || !/^[0-9a-f]{40}$/u.test(harness.commitOid) || !/^sha256:[0-9a-f]{64}$/u.test(harness.manifestDigest)) {
      throw new Error('Invalid physical Git harness binding');
    }
    const actualManifest = await this.options.builder.readManifest(harness.commitOid);
    if (actualManifest.digest !== harness.manifestDigest) throw new Error('Hitch harness manifest version drift');
    const repeatIndex = input.repeatIndex ?? 0;
    const repetition = description.universe.repetitions.find(item => item.index === repeatIndex);
    if (!repetition || repetition.seed !== null) throw new Error('Hitch repetition not in supported frozen plan');
    const projected = await projectDataset(description, [task.id], this.options.stateRoot);
    const { conditionId: _ignored, seeds: _seeds, ...base } = this.round.plan.seed;
    const body = { ...base, dataset: projected, repetitions: 1 };
    const condition: EvaluationCondition = { ...body, conditionId: digestJson(body) };
    const request: EvaluationRequest = { phase: 'seed-candidate', dataset: projected.ref, harnessRef: harness.commitOid, condition };
    const contextRound: RefinementRound = { ...this.round, roundId: `${this.round.roundId}-algorithm-${envelope.operationId.slice(0, 16)}` };
    const intent = this.options.evaluator.prepareSubmission(contextRound, request);
    if (!intent) throw new Error('Hitch daemon submission has no idempotent intent');
    return { input, task, bindingSlots, request, contextRound, intent };
  }
  async preflight(envelope: OperationEnvelope): Promise<void> {
    await this.prepared(envelope);
    await this.options.evaluator.preflight();
  }
  private path(envelope: OperationEnvelope): string { assertDigest(envelope.operationId); return join(this.records, `${envelope.operationId}.json`); }
  private read(envelope: OperationEnvelope): Journal | undefined {
    const path = this.path(envelope);
    if (!existsSync(path)) return undefined;
    const saved = JSON.parse(readFileSync(path, 'utf8')) as Journal;
    assertJson(saved);
    if (canonicalJson(saved.envelope) !== canonicalJson(envelope)) throw new Error('Hitch operation envelope identity drift');
    return saved;
  }
  /** Link an fsynced whole record: start and cancellation cannot both win. */
  private establish(record: Journal): boolean {
    const path = this.path(record.envelope), temporary = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, canonicalJson(record)); fsyncSync(fd); } finally { closeSync(fd); }
    let created = false;
    try { linkSync(temporary, path); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    finally { unlinkSync(temporary); }
    const directory = openSync(this.records, 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
    return created;
  }
  /** A trial is charged once the daemon accepted its one-task submission, including cancellation/failure. */
  private usage(envelope: OperationEnvelope, trials: number): UsageReceipt | undefined {
    if (!this.meterSource) return undefined;
    const cumulative = { 'rollout.trials': trials };
    return { source: this.meterSource, scope: 'operation', operationId: envelope.operationId,
      cursor: jsonDigest({ operationId: envelope.operationId, cumulative }), cumulative };
  }
  private async settle(envelope: OperationEnvelope, prepared: Prepared, saved: Journal): Promise<ProviderInspection> {
    if (!saved.reservation) return { status: 'unknown' };
    const reservation = saved.reservation;
    const identity = await this.options.evaluator.submittedEvaluationIdentity(prepared.contextRound,
      prepared.request, reservation, new AbortController().signal, saved.intent);
    if (!identity) return { status: 'unknown' };
    if (saved.identity && canonicalJson(saved.identity) !== canonicalJson(identity)) throw new Error('Hitch submitted daemon identity drift');
    if (!saved.identity) { saved = { ...saved, identity }; durableWrite(this.path(envelope), canonicalJson(saved)); }
    const inspection = await this.options.evaluator.inspectResult(prepared.contextRound, prepared.request,
      reservation, new AbortController().signal, saved.intent);
    const usage = this.usage(envelope, 1);
    if (inspection.status === 'failed') {
      if (saved.status === 'cancelling') {
        durableWrite(this.path(envelope), canonicalJson({ ...saved, status: 'cancelled', ...(usage ? { receipt: usage } : {}) }));
        return { status: 'cancelled', releaseConfirmed: true, ...(usage ? { receipt: usage } : {}) };
      }
      const completion: CompletionEnvelope = { operationId: envelope.operationId, idempotencyKey: envelope.idempotencyKey,
        inputDigest: envelope.inputDigest, implementationDigest: this.manifest.implementationDigest,
        outcome: { kind: 'error', code: inspection.code, message: inspection.message, retryable: false },
        ...(usage ? { receipt: usage } : {}) };
      durableWrite(this.path(envelope), canonicalJson({ ...saved, status: 'completed', completion }));
      return { status: 'completed', completion };
    }
    if (inspection.status !== 'complete') return inspection.status === 'running'
      ? { status: 'running', handle: reservation.evalId } : { status: 'unknown' };
    const evidence = inspection.evidence;
    if (evidence.provider !== identity.provider || evidence.effectiveConfigDigest !== identity.effectiveConfigDigest
      || (identity.invocationFingerprint !== undefined && evidence.invocationFingerprint !== identity.invocationFingerprint)
      || evidence.evalId !== reservation.evalId || evidence.dataset !== prepared.request.dataset
      || evidence.conditionId !== prepared.request.condition.conditionId
      || evidence.requestedCommit !== prepared.request.harnessRef || evidence.actualCommit !== prepared.request.harnessRef
      || evidence.plannedTrialCount !== 1 || evidence.trials.length + evidence.invalidTrials.length !== 1
      || [...evidence.trials, ...evidence.invalidTrials][0]?.taskName !== prepared.task.id
      || await digestDatasetRef(prepared.request.dataset) !== prepared.request.condition.dataset.digest) {
      throw new Error('Hitch physical daemon evaluation identity or task slot mismatch');
    }
    const evidenceRef = this.options.artifacts.putJson({ schemaVersion: 1, kind: 'hitch-daemon-evaluation',
      evidence: evidence as unknown as JsonValue, submittedIdentity: identity as unknown as JsonValue,
      requestDigest: digestJson(prepared.request) } as unknown as JsonValue, 'execution.rollout.evidence.v1');
    const receipt: ExecutionReceipt = { schemaVersion: 1, providerImplementationDigest: this.manifest.implementationDigest,
      operationId: envelope.operationId, inputDigest: envelope.inputDigest, loadedBindingSetDigest: envelope.bindingSetRef.digest,
      evidenceDigest: evidenceRef.digest, actualBindings: Object.fromEntries(Object.entries(prepared.bindingSlots).map(([slot, ref]) => [slot, ref.digest])),
      executionIdentity: digestJson({ evalId: evidence.evalId, submittedIdentity: identity, evidenceDigest: evidenceRef.digest }),
      samplingDigest: this.samplingDigest, environmentDigest: this.environmentDigest };
    const receiptRef = this.options.artifacts.putJson(receipt as unknown as JsonValue, 'execution.receipt.v1');
    const result: ExecutionResult = { requestedBindingSetDigest: envelope.bindingSetRef.digest,
      actualBindings: prepared.bindingSlots, evidenceRef, receiptRef };
    const completion: CompletionEnvelope = { operationId: envelope.operationId, idempotencyKey: envelope.idempotencyKey,
      inputDigest: envelope.inputDigest, implementationDigest: this.manifest.implementationDigest,
      outcome: { kind: 'result', value: result as unknown as JsonValue }, ...(usage ? { receipt: usage } : {}) };
    durableWrite(this.path(envelope), canonicalJson({ ...saved, status: 'completed', completion }));
    return { status: 'completed', completion };
  }
  async submit(envelope: OperationEnvelope): Promise<ProviderSubmission> {
    const prepared = await this.prepared(envelope);
    const existing = this.read(envelope);
    if (existing?.status === 'cancelled') throw new Error('Hitch operation was cancelled before submission');
    if (existing?.status === 'completed') return { status: 'completed', completion: existing.completion! };
    if (existing) {
      const inspected = await this.inspect(envelope);
      if (inspected.status === 'completed') return inspected;
      if (inspected.status === 'running') return inspected;
      throw new Error('Existing Hitch submission is unresolved; inspect before retrying');
    }
    const initial: Journal = { envelope, requestDigest: digestJson(prepared.request), intent: prepared.intent, status: 'intent' };
    if (!this.establish(initial)) return this.submit(envelope);
    const reservation = await this.options.evaluator.reserve(prepared.contextRound, prepared.request,
      new AbortController().signal, prepared.intent);
    durableWrite(this.path(envelope), canonicalJson({ ...initial, status: 'reserved', reservation }));
    return { status: 'running', handle: reservation.evalId };
  }
  async inspect(envelope: OperationEnvelope): Promise<ProviderInspection> {
    const prepared = await this.prepared(envelope);
    let saved = this.read(envelope);
    if (!saved) return { status: 'not-started' };
    if (saved.requestDigest !== digestJson(prepared.request) || canonicalJson(saved.intent) !== canonicalJson(prepared.intent)) {
      throw new Error('Hitch frozen submission request drift');
    }
    if (saved.status === 'cancelled') return { status: 'cancelled', releaseConfirmed: true,
      ...(saved.receipt ? { receipt: saved.receipt } : {}) };
    if (saved.status === 'completed') return { status: 'completed', completion: saved.completion! };
    if (!saved.reservation) {
      const reservation = saved.status === 'cancelling'
        ? await findSubmittedHitchReservationReadOnly(this.options.evaluator, saved.intent)
        : await this.options.evaluator.recoverReservation(prepared.contextRound, prepared.request,
          new AbortController().signal, saved.intent);
      if (!reservation) return { status: 'unknown' };
      saved = { ...saved, status: saved.status === 'cancelling' ? 'cancelling' : 'reserved', reservation };
      durableWrite(this.path(envelope), canonicalJson(saved));
    }
    return this.settle(envelope, prepared, saved);
  }
  async cancel(envelope: OperationEnvelope): Promise<ProviderInspection> {
    const prepared = await this.prepared(envelope);
    let saved = this.read(envelope);
    if (!saved) {
      const receipt = this.usage(envelope, 0);
      const tombstone: Journal = { envelope, requestDigest: digestJson(prepared.request), intent: prepared.intent,
        status: 'cancelled', ...(receipt ? { receipt } : {}) };
      if (this.establish(tombstone)) return { status: 'cancelled', releaseConfirmed: true,
        ...(receipt ? { receipt } : {}) };
      saved = this.read(envelope);
    }
    if (!saved) return { status: 'unknown' };
    if (saved.status === 'cancelled') return { status: 'cancelled', releaseConfirmed: true,
      ...(saved.receipt ? { receipt: saved.receipt } : {}) };
    if (saved.status === 'completed') return { status: 'completed', completion: saved.completion! };
    if (saved.status !== 'cancelling') { saved = { ...saved, status: 'cancelling' }; durableWrite(this.path(envelope), canonicalJson(saved)); }
    if (!saved.reservation) {
      try {
        // A cancel request must never turn a pre-reservation crash into a new
        // physical job. The normal inspection path may replay the idempotent
        // submit, but cancellation only searches existing daemon records.
        const reservation = await findSubmittedHitchReservationReadOnly(this.options.evaluator, saved.intent);
        if (!reservation) return { status: 'unknown' };
        saved = { ...saved, reservation };
        durableWrite(this.path(envelope), canonicalJson(saved));
      } catch { return { status: 'unknown' }; }
    }
    try { await this.options.evaluator.cancelReservation(saved.reservation!, saved.intent); }
    catch { return { status: 'unknown' }; }
    return this.settle(envelope, prepared, saved);
  }
  async collect(envelope: OperationEnvelope): Promise<CompletionEnvelope> {
    const inspected = await this.inspect(envelope);
    if (inspected.status !== 'completed') throw new Error('Hitch rollout has no completed physical result');
    return inspected.completion;
  }

}

export async function createHitchRolloutAdapter(options: HitchRolloutHostOptions): Promise<VerifiedExecutionAdapter> {
  const port = await HitchRolloutPort.create(options);
  return new VerifiedExecutionAdapter(port, options.artifacts, options.bindings, ['harness']);
}
