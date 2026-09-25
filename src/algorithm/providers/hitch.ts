import { mkdir } from 'node:fs/promises';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
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
import { materializeSkillOverlay, validateSkillOverlaySelection, SkillOverlayUnknown,
  type SkillOverlayResult } from './skill-overlay.js';
import type { CandidateWorkspaceManager } from '../../candidate/workspace.js';
import { describeDataset, projectDataset } from '../../search/dataset-projection.js';
import type { DatasetDescription, DatasetProjectionSource } from '../../search/dataset-projection.js';
import { inspectStandardCompiledDatasetV1, type StandardCompiledDatasetV1 } from '../../search/compiled-dataset-v1.js';
import { readBoundedRegularFile } from '../../state/bounded-file.js';
import type { HitchEvaluationContext, AuthorHitchEvaluationContext } from '../../evaluator/hitch-cli.js';
import { RefineStateStore, type WorkspaceLock } from '../../state/store.js';
import { digestJson } from '../../state/digest.js';
import { digestDatasetRef } from '../../state/dataset.js';
import { durableCreate } from './provider-record.js';
import type { EvaluationCondition, EvaluationRequest, EvaluationReservation, EvaluationSubmissionIntent, RefinementRound, EvolutionSpec } from '../../types.js';

function requireAlgorithmDatasetV1(description: DatasetDescription): void {
  if (description.resourceManifest || description.manifest.schema_version !== '1')
    throw new Error('Algorithm Hitch rollout supports compiled dataset schema v1 only; resource v2 requires algorithm resource preflight, plan identity, and retention support');
}

/** The upstream projector and storage audit share a real lock. Queue only this process's short projection sections. */
const projectionQueues = new Map<string, Promise<void>>();
async function withProjectionLock<T>(root: string, work: (lock: WorkspaceLock) => Promise<T>): Promise<T> {
  root = resolve(root);
  const prior = projectionQueues.get(root) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const turn = new Promise<void>(resolveTurn => { releaseQueue = resolveTurn; });
  projectionQueues.set(root, turn);
  await prior;
  try {
    const lock = await new RefineStateStore(root).acquireRoundLock();
    try { return await work(lock); }
    finally { await lock.release(); }
  } finally {
    releaseQueue();
    if (projectionQueues.get(root) === turn) projectionQueues.delete(root);
  }
}

/** Match HitchCliEvaluator.run's child env exactly; only the digest is persisted or exposed. */
function hitchSubprocessEnvironmentDigest(): string {
  const environment = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  return digestJson(Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] =>
    entry[1] !== undefined)));
}

export type GitHarnessBinding = { schemaVersion: 1; kind: 'git-harness'; commitOid: string; manifestDigest: string };
export type HitchRolloutInput = { task: TaskEntry; taskViewRef: TaskViewRef; repeatIndex?: number;
  samplingDigest: string; environmentDigest: string; recipePhase: string; executedRevisionDigest?: string;
  skillBindingSetDigest?: string; injectedSkillRefs?: ArtifactRef[] };
type HitchRolloutHostCommon = { workspaceRoot: string; stateRoot: string; artifacts: FileArtifactStore; bindings: BindingStore;
  taskAuthority: TaskViewAuthority; allowedExperienceViewDigests(campaignId: string): readonly string[];
  accessPolicyDigest: string; builder: HarnessBuilder; evaluator: HitchCliEvaluator; campaignBudget: BudgetPlan;
  skillOverlay?: { workspaceManager: CandidateWorkspaceManager; hostIdentityDigest: string } };
/** Host-sealed A1 execution inputs. The task source is independently checked against a compiled dataset. */
export type AuthorHitchRolloutPlanV1 = { schemaVersion: 1; kind: 'author.hitch-plan.v1'; campaignId: string;
  workspaceRoot: string; datasetRoot: string; datasetDigest: string; taskIds: string[]; repetitions: number;
  taskBudgetMs: number; sandboxProfileRef: string; model: string; rolloutProviderDigest: string;
  recipePhase: string; allowedExperienceViewDigests: string[] };
export type HitchRolloutHostOptions = HitchRolloutHostCommon & (
  { registry: EvolutionRegistryStore; evolutionId: string; roundId: string; freshContext?: never; authorPlan?: never }
  | { freshContext: FreshHitchRolloutContext; registry?: never; evolutionId?: never; roundId?: never; authorPlan?: never }
  | { authorPlan: AuthorHitchRolloutPlanV1; registry?: never; evolutionId?: never; roundId?: never;
    freshContext?: never; skillOverlay?: never });

type HitchSource = { kind: 'legacy'; spec: EvolutionSpec; round: RefinementRound }
  | { kind: 'author'; plan: AuthorHitchRolloutPlanV1; dataset: StandardCompiledDatasetV1 };

type Prepared = { input: HitchRolloutInput; task: TaskEntry; bindingSlots: Record<string, ArtifactRef>;
  request: EvaluationRequest; contextRound: HitchEvaluationContext; intent: EvaluationSubmissionIntent;
  baseHarness: GitHarnessBinding; skillsLibraryRef?: ArtifactRef; selectedSkillDigests?: string[] };
type SubmittedIdentity = NonNullable<Awaited<ReturnType<HitchCliEvaluator['submittedEvaluationIdentity']>>>;
type Journal = { envelope: OperationEnvelope; requestDigest: string; intent: EvaluationSubmissionIntent;
  schemaVersion?: 2; kind?: 'author.hitch-rollout.v2'; request?: EvaluationRequest;
  status: 'intent' | 'reserved' | 'cancelling' | 'cancelled' | 'completed';
  overlay?: SkillOverlayResult; reservation?: EvaluationReservation; identity?: SubmittedIdentity;
  completion?: CompletionEnvelope; receipt?: UsageReceipt };
export type AuthorRolloutJournalSnapshot = { status: Journal['status']; envelope: OperationEnvelope;
  request: EvaluationRequest; requestDigest: string; intent: EvaluationSubmissionIntent;
  submittedIdentity?: JsonValue; completion?: CompletionEnvelope };

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

  private constructor(readonly options: HitchRolloutHostOptions, private readonly source: HitchSource) {
    if (options.evaluator.options.controlPlane?.mode !== 'daemon') throw new Error('Durable Hitch rollout requires daemon mode');
    if (resolve(options.workspaceRoot) !== resolve(source.kind === 'author' ? source.plan.workspaceRoot : source.round.workspaceRoot)
      || options.builder.repositoryPath !== options.evaluator.repositoryPath) throw new Error('Hitch rollout host/source workspace mismatch');
    assertDigest(options.accessPolicyDigest);
    if (options.skillOverlay) assertDigest(options.skillOverlay.hostIdentityDigest);
    const budget = options.campaignBudget['rollout.trials'];
    this.meterSource = budget?.source;
    this.metered = budget !== undefined;
    if (this.meterSource && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(this.meterSource)) throw new Error('Invalid Hitch meter source');
    this.sourceRoundDigest = digestJson(source.kind === 'author' ? source.plan : source.round);
    this.sourceSpecDigest = source.kind === 'author' ? source.dataset.sourceDigest : digestJson(source.spec);
    this.samplingDigest = digestJson(source.kind === 'author' ? {} : source.round.plan.seed.sampling);
    this.environmentDigest = this.currentEnvironmentDigest();
    this.records = join(options.stateRoot, 'algorithm-hitch-operations');
    mkdirSync(this.records, { recursive: true });
    this.manifest = { kind: 'execution.rollout',
      implementationDigest: implementationClosureDigest(['providers/hitch', 'providers/execution'], {
        sourceKind: source.kind === 'author' ? 'author-plan' : options.freshContext ? 'fresh-context' : 'legacy-round',
        sourceSpecDigest: this.sourceSpecDigest, sourceRoundDigest: this.sourceRoundDigest,
        environmentDigest: this.environmentDigest, samplingDigest: this.samplingDigest,
        accessPolicyDigest: options.accessPolicyDigest, issuerId: options.taskAuthority.issuerId,
        keyDigest: options.taskAuthority.keyDigest, meterSource: this.meterSource ?? null,
        metered: this.metered, hard: budget?.capability === 'hard',
        skillOverlay: options.skillOverlay ? { hostIdentityDigest: options.skillOverlay.hostIdentityDigest,
          workspaceRoot: options.skillOverlay.workspaceManager.options.rootForEvolution('algorithm-skill-overlay-identity'),
          repositoryPath: options.skillOverlay.workspaceManager.options.repositoryPath,
          targetRoot: options.skillOverlay.workspaceManager.options.targetRoot,
          maxFiles: options.skillOverlay.workspaceManager.options.maxFiles,
          maxBytes: options.skillOverlay.workspaceManager.options.maxBytes,
          maxDiffBytes: options.skillOverlay.workspaceManager.options.maxDiffBytes,
          allowedPathGrantDigest: options.skillOverlay.workspaceManager.allowedPathGrantDigest } : null }),
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
    if (options.authorPlan) {
      const plan = structuredClone(options.authorPlan);
      assertJson(plan as unknown as JsonValue);
      if (canonicalJson(Object.keys(plan).sort()) !== canonicalJson(['schemaVersion', 'kind', 'campaignId',
        'workspaceRoot', 'datasetRoot', 'datasetDigest', 'taskIds', 'repetitions', 'taskBudgetMs',
        'sandboxProfileRef', 'model', 'rolloutProviderDigest', 'recipePhase',
        'allowedExperienceViewDigests'].sort())
        || plan.schemaVersion !== 1 || plan.kind !== 'author.hitch-plan.v1'
        || !plan.campaignId || !plan.workspaceRoot || !plan.datasetRoot
        || !isAbsolute(plan.workspaceRoot) || !isAbsolute(plan.datasetRoot)
        || !/^sha256:[a-f0-9]{64}$/u.test(plan.datasetDigest)
        || !Array.isArray(plan.taskIds) || plan.taskIds.length === 0
        || new Set(plan.taskIds).size !== plan.taskIds.length
        || !Array.isArray(plan.allowedExperienceViewDigests)
        || plan.allowedExperienceViewDigests.length === 0
        || new Set(plan.allowedExperienceViewDigests).size !== plan.allowedExperienceViewDigests.length
        || plan.allowedExperienceViewDigests.some(digest => !/^[a-f0-9]{64}$/u.test(digest))
        || !Number.isSafeInteger(plan.repetitions) || plan.repetitions < 1
        || !Number.isSafeInteger(plan.taskBudgetMs) || plan.taskBudgetMs < 1
        || !plan.sandboxProfileRef || !plan.model || !plan.recipePhase
        || !/^sha256:[a-f0-9]{64}$/u.test(plan.rolloutProviderDigest)
        || plan.model !== options.evaluator.options.model
        || plan.sandboxProfileRef !== options.builder.options.sandboxProfileRef)
        throw new Error('Author Hitch execution plan invalid');
      const dataset = await inspectStandardCompiledDatasetV1(plan.datasetRoot);
      if (dataset.sourceDigest !== plan.datasetDigest
        || canonicalJson(dataset.tasks.map(task => task.id)) !== canonicalJson(plan.taskIds))
        throw new Error('Author Hitch task source differs from frozen plan');
      await mkdir(options.stateRoot, { recursive: true });
      return new HitchRolloutPort(options, { kind: 'author', plan, dataset });
    }
    if (options.freshContext) {
      const { spec, round, specDigest, roundDigest, datasetDigest } = options.freshContext;
      if (options.freshContext.schemaVersion !== 1 || digestJson(spec) !== specDigest
        || digestJson(round) !== roundDigest || round.evolutionId !== spec.evolutionId
        || round.seedTaskRef !== spec.datasets.seed.ref || round.plan.seed.dataset.digest !== spec.datasets.seed.digest
        || round.plan.seed.partition !== 'seed') throw new Error('Fresh Hitch rollout context identity mismatch');
      const description = await describeDataset(spec, 'seed', options.workspaceRoot);
      requireAlgorithmDatasetV1(description);
      if (description.sourceDigest !== datasetDigest) throw new Error('Fresh Hitch rollout context dataset drift');
      await mkdir(options.stateRoot, { recursive: true });
      return new HitchRolloutPort(options, { kind: 'legacy', spec: structuredClone(spec), round: structuredClone(round) });
    }
    const spec = await options.registry.requireSpec(options.evolutionId);
    const entry = await options.registry.readEntry(options.evolutionId);
    const round = await options.registry.stateStore(options.evolutionId).readRound(options.roundId);
    if (!entry || entry.specDigest !== digestJson(spec) || !round || round.evolutionId !== spec.evolutionId
      || round.seedTaskRef !== spec.datasets.seed.ref || round.plan.seed.dataset.digest !== spec.datasets.seed.digest)
      throw new Error('Hitch rollout source evolution/round unavailable or mismatched');
    requireAlgorithmDatasetV1(await describeDataset(spec, 'seed', options.workspaceRoot));
    await mkdir(options.stateRoot, { recursive: true });
    return new HitchRolloutPort(options, { kind: 'legacy', spec, round });
  }

  /** Host records these concrete digests in Campaign config; recipes must echo them. */
  profile(): { samplingDigest: string; environmentDigest: string } {
    return { samplingDigest: this.samplingDigest, environmentDigest: this.environmentDigest };
  }
  describe(): ProviderManifest & { kind: 'execution.rollout' } { return structuredClone(this.manifest); }
  private currentEnvironmentDigest(): string {
    const { compiler, ...builderOptions } = this.options.builder.options;
    const physical = {
      evaluator: JSON.parse(JSON.stringify(this.options.evaluator.options)),
      subprocessEnvironmentDigest: hitchSubprocessEnvironmentDigest(),
      builder: { repositoryPath: this.options.builder.repositoryPath, targetRoot: this.options.builder.targetRoot,
        options: builderOptions, compiler: { name: compiler.constructor.name,
          runtimeValidation: compiler.runtimeValidation === true } } };
    return this.source.kind === 'author'
      ? digestJson({ authorPlan: this.sourceRoundDigest, dataset: this.sourceSpecDigest, ...physical })
      : digestJson({ evolution: this.sourceSpecDigest, roundPlan: this.source.round.plan.digest, ...physical });
  }
  private async currentRound(): Promise<void> {
    if (this.source.kind === 'author') {
      if (digestJson(this.source.plan) !== this.sourceRoundDigest) throw new Error('Author Hitch plan changed');
      const inspected = await inspectStandardCompiledDatasetV1(this.source.plan.datasetRoot);
      if (inspected.sourceDigest !== this.source.dataset.sourceDigest
        || canonicalJson(inspected.tasks) !== canonicalJson(this.source.dataset.tasks))
        throw new Error('Author Hitch task source changed');
      return;
    }
    if (this.options.freshContext) {
      if (digestJson(this.options.freshContext.round) !== this.sourceRoundDigest)
        throw new Error('Fresh Hitch rollout context round changed');
      return;
    }
    if (!this.options.registry || !this.options.evolutionId || !this.options.roundId)
      throw new Error('Legacy Hitch source registry missing');
    const current = await this.options.registry.stateStore(this.options.evolutionId).readRound(this.options.roundId);
    if (!current || digestJson(current) !== this.sourceRoundDigest) throw new Error('Hitch rollout source round changed');
  }
  private async currentSpec(): Promise<void> {
    if (this.source.kind === 'author') return;
    if (this.options.freshContext) {
      if (digestJson(this.options.freshContext.spec) !== this.sourceSpecDigest)
        throw new Error('Fresh Hitch rollout context spec changed');
      return;
    }
    if (!this.options.registry || !this.options.evolutionId)
      throw new Error('Legacy Hitch source registry missing');
    const current = await this.options.registry.requireSpec(this.options.evolutionId);
    if (digestJson(current) !== this.sourceSpecDigest) throw new Error('Hitch rollout source spec changed');
  }
  private async prepared(envelope: OperationEnvelope): Promise<Prepared> {
    if (envelope.kind !== this.manifest.kind || envelope.implementationDigest !== this.manifest.implementationDigest)
      throw new Error('Hitch rollout implementation identity drift');
    if (this.currentEnvironmentDigest() !== this.environmentDigest)
      throw new Error('Hitch rollout evaluator, builder, or subprocess environment drift');
    await this.currentSpec(); await this.currentRound();
    if (this.metered && (!Number.isSafeInteger(envelope.limits['rollout.trials']) || envelope.limits['rollout.trials']! < 1))
      throw new Error('Hitch trial reservation missing or insufficient');
    const input = envelope.input as HitchRolloutInput;
    if (input.samplingDigest !== this.samplingDigest || input.environmentDigest !== this.environmentDigest
      || !input.recipePhase) {
      throw new Error('Hitch rollout configuration mismatch');
    }
    if (input.executedRevisionDigest && input.executedRevisionDigest !== envelope.bindingSetRef.digest)
      throw new Error('Hitch executed revision does not match bound version');
    this.options.taskAuthority.verify(input.taskViewRef, this.source.kind === 'author'
      ? this.source.plan.allowedExperienceViewDigests
      : this.options.allowedExperienceViewDigests(envelope.campaignId));
    const view = readTaskView(this.options.artifacts, input.taskViewRef);
    const task = view.tasks.find(item => item.id === input.task?.id);
    if (!task || canonicalJson(task) !== canonicalJson(input.task) || task.purpose === 'final-test')
      throw new Error('Hitch rollout task is not an authorized research task');
    const content = this.options.artifacts.getJson(task.contentRef) as unknown as { prompt?: string; executionSource?: {
      kind?: string; datasetDigest?: string; taskContentDigest?: string } };
    let description: DatasetDescription | DatasetProjectionSource;
    if (this.source.kind === 'author') {
      const inspected = await inspectStandardCompiledDatasetV1(this.source.plan.datasetRoot);
      if (inspected.sourceDigest !== this.source.dataset.sourceDigest
        || canonicalJson(inspected.tasks) !== canonicalJson(this.source.dataset.tasks))
        throw new Error('Author Hitch task source changed');
      description = { root: inspected.root, sourceDigest: inspected.sourceDigest,
        manifest: inspected.manifest, taskContentDigests: inspected.tasks };
    } else {
      description = await describeDataset(this.source.spec, 'seed', this.options.workspaceRoot);
      requireAlgorithmDatasetV1(description);
    }
    const declared = ('taskContentDigests' in description ? description.taskContentDigests
      : description.universe.tasks).find(item => item.id === task.id);
    if (!declared || content.executionSource?.kind !== (this.source.kind === 'author'
      ? 'compiled-author-dataset' : 'compiled-seed-dataset')
      || content.executionSource.datasetDigest !== description.sourceDigest
      || content.executionSource.taskContentDigest !== declared.contentDigest) {
      throw new Error('Hitch rollout task source bytes are not physically bound');
    }
    const bindingSlots = this.options.bindings.read(envelope.bindingSetRef).slots;
    const skillRun = input.skillBindingSetDigest !== undefined || input.injectedSkillRefs !== undefined;
    if (skillRun) {
      if (!this.options.skillOverlay || input.recipePhase !== 'evo.batch'
        || input.skillBindingSetDigest !== envelope.bindingSetRef.digest
        || !Array.isArray(input.injectedSkillRefs)
        || Object.keys(bindingSlots).sort().join('\0') !== 'harness\0skills') {
        throw new Error('Hitch unsupported skill injection: requires a bound overlay host and exact harness/skills slots');
      }
    } else if (Object.keys(bindingSlots).sort().join('\0') !== 'harness') {
      throw new Error('Hitch rollout requires an exact harness binding');
    }
    const harnessRef = bindingSlots.harness!;
    if (harnessRef.schemaId !== 'harness.directory.v1') throw new Error('Hitch harness binding schema mismatch');
    const harness = this.options.artifacts.getJson(harnessRef) as unknown as GitHarnessBinding;
    if (harness.schemaVersion !== 1 || harness.kind !== 'git-harness'
      || !/^[0-9a-f]{40}$/u.test(harness.commitOid) || !/^sha256:[0-9a-f]{64}$/u.test(harness.manifestDigest)) {
      throw new Error('Invalid physical Git harness binding');
    }
    const actualManifest = await this.options.builder.readManifest(harness.commitOid);
    if (actualManifest.digest !== harness.manifestDigest) throw new Error('Hitch harness manifest version drift');
    const selectedSkillDigests = skillRun ? validateSkillOverlaySelection({ baseHarness: harness,
      bindingSetRef: envelope.bindingSetRef, skillsLibraryRef: bindingSlots.skills!,
      selectedSkillRefs: input.injectedSkillRefs!, artifacts: this.options.artifacts,
      bindings: this.options.bindings }).injectedSkillDigests : undefined;
    const repeatIndex = input.repeatIndex ?? 0;
    if (this.source.kind === 'author') {
      if (envelope.campaignId !== this.source.plan.campaignId
        || input.recipePhase !== this.source.plan.recipePhase
        || !Number.isSafeInteger(repeatIndex) || repeatIndex < 0 || repeatIndex >= this.source.plan.repetitions)
        throw new Error('Author Hitch campaign, phase, or repetition differs from frozen plan');
    } else {
      if (!('universe' in description)) throw new Error('Legacy Hitch source has no frozen task universe');
      const repetition = description.universe.repetitions.find(item => item.index === repeatIndex);
      if (!repetition || repetition.seed !== null) throw new Error('Hitch repetition not in supported frozen plan');
    }
    const storageRoot = resolve(this.options.stateRoot, 'hitch-storage');
    const projected = await withProjectionLock(storageRoot, async lock => {
      const result = await projectDataset(description, [task.id], join(storageRoot, 'search'),
        { lock, signal: new AbortController().signal });
      // A preflight may be followed by another process's storage audit before the
      // operation journal exists. Publish this campaign-owned reference under the
      // same lock so an accepted projection is never treated as an orphan.
      const reference = { protocol: 'algorithm-hitch-projection@1', campaignId: envelope.campaignId,
        sourceDigest: description.sourceDigest, taskIds: [task.id], ref: result.ref, digest: result.digest };
      const key = jsonDigest({ campaignId: envelope.campaignId, sourceDigest: description.sourceDigest,
        taskIds: [task.id] }).slice(7);
      const path = join(storageRoot, 'projection-refs', `${key}.json`);
      mkdirSync(join(storageRoot, 'projection-refs'), { recursive: true });
      await lock.assertHeld(storageRoot);
      if (!durableCreate(path, canonicalJson(reference))) {
        const previous = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        assertJson(previous);
        if (canonicalJson(previous) !== canonicalJson(reference))
          throw new Error('Hitch campaign projection reference drift');
      }
      return result;
    });
    // Hitch's current EvaluationCondition calls this physical research slot "seed";
    // author-candidate phase and the signed TaskView retain the profile's development scope.
    const base = this.source.kind === 'author' ? {
      partition: 'seed' as const, model: this.source.plan.model, sampling: {},
      timeoutMs: this.source.plan.taskBudgetMs,
      rolloutProviderDigest: this.source.plan.rolloutProviderDigest,
    } : (({ conditionId: _ignored, seeds: _seeds, ...condition }) => condition)(this.source.round.plan.seed);
    const body = { ...base, dataset: projected, repetitions: 1 };
    const condition: EvaluationCondition = { ...body, conditionId: digestJson(body) };
    const request: EvaluationRequest = { phase: this.source.kind === 'author' ? 'author-candidate' : 'seed-candidate',
      dataset: projected.ref, harnessRef: harness.commitOid, condition };
    const contextRound: HitchEvaluationContext = this.source.kind === 'author' ? {
      workspaceRoot: this.source.plan.workspaceRoot, taskBudgetMs: this.source.plan.taskBudgetMs,
      sandboxProfileRef: this.source.plan.sandboxProfileRef,
      author: { campaignId: envelope.campaignId, operationId: envelope.operationId,
        planDigest: this.sourceRoundDigest },
    } satisfies AuthorHitchEvaluationContext
      : { ...this.source.round, roundId: `${this.source.round.roundId}-algorithm-${envelope.operationId.slice(0, 16)}` };
    const intent = this.options.evaluator.prepareSubmission(contextRound, request);
    if (!intent) throw new Error('Hitch daemon submission has no idempotent intent');
    return { input, task, bindingSlots, request, contextRound, intent, baseHarness: harness,
      ...(skillRun ? { skillsLibraryRef: bindingSlots.skills!, selectedSkillDigests: selectedSkillDigests! } : {}) };
  }
  async preflight(envelope: OperationEnvelope): Promise<void> {
    await this.prepared(envelope);
    await this.options.evaluator.preflight();
  }
  private path(envelope: OperationEnvelope): string { assertDigest(envelope.operationId); return join(this.records, `${envelope.operationId}.json`); }
  private newJournal(envelope: OperationEnvelope, prepared: Prepared,
    status: Journal['status'], receipt?: UsageReceipt): Journal {
    const shared: Journal = { envelope, requestDigest: digestJson(prepared.request), intent: prepared.intent, status,
      ...(receipt ? { receipt } : {}) };
    return this.source.kind === 'author'
      ? { ...shared, schemaVersion: 2, kind: 'author.hitch-rollout.v2', request: prepared.request }
      : shared;
  }
  private read(envelope: OperationEnvelope): Journal | undefined {
    const path = this.path(envelope);
    if (!existsSync(path)) return undefined;
    const saved = JSON.parse(readFileSync(path, 'utf8')) as Journal;
    assertJson(saved);
    if (canonicalJson(saved.envelope) !== canonicalJson(envelope)) throw new Error('Hitch operation envelope identity drift');
    if (this.source.kind === 'author' && (saved.schemaVersion !== 2 || saved.kind !== 'author.hitch-rollout.v2'
      || !saved.request || saved.requestDigest !== digestJson(saved.request)))
      throw new Error('Author Hitch saved request identity missing or changed');
    return saved;
  }

  /** Read only the persisted physical journal; never prepares a projection or contacts Hitch. */
  async readAuthorRolloutJournal(operationId: string): Promise<AuthorRolloutJournalSnapshot | undefined> {
    if (this.source.kind !== 'author') throw new Error('Only author Hitch plans expose v2 journal snapshots');
    assertDigest(operationId);
    let bytes: Buffer;
    try { bytes = await readBoundedRegularFile(join(this.records, `${operationId}.json`), 4 * 1024 * 1024,
      'Author Hitch journal'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    const saved = JSON.parse(bytes.toString('utf8')) as Journal;
    assertJson(saved);
    if (saved.schemaVersion !== 2 || saved.kind !== 'author.hitch-rollout.v2'
      || !['intent', 'reserved', 'cancelling', 'cancelled', 'completed'].includes(saved.status)
      || saved.envelope.operationId !== operationId
      || saved.envelope.campaignId !== this.source.plan.campaignId
      || saved.envelope.kind !== 'execution.rollout'
      || saved.envelope.implementationDigest !== this.manifest.implementationDigest
      || !saved.request || saved.request.phase !== 'author-candidate'
      || saved.request.dataset !== saved.request.condition.dataset.ref
      || saved.request.condition.partition !== 'seed'
      || saved.request.condition.repetitions !== 1
      || saved.request.condition.seeds !== undefined
      || saved.request.condition.model !== this.source.plan.model
      || saved.request.condition.timeoutMs !== this.source.plan.taskBudgetMs
      || saved.request.condition.rolloutProviderDigest !== this.source.plan.rolloutProviderDigest
      || canonicalJson(saved.request.condition.sampling) !== canonicalJson({})
      || (({ conditionId: _ignored, ...body }) => digestJson(body))(saved.request.condition)
        !== saved.request.condition.conditionId
      || saved.requestDigest !== digestJson(saved.request))
      throw new Error('Author Hitch journal source, envelope, or request identity mismatch');
    if (saved.status !== 'completed' && saved.completion)
      throw new Error('Author Hitch nonterminal journal has a completion');
    if (saved.status === 'completed' && (!saved.completion
      || saved.completion.operationId !== operationId
      || saved.completion.idempotencyKey !== saved.envelope.idempotencyKey
      || saved.completion.inputDigest !== saved.envelope.inputDigest
      || saved.completion.implementationDigest !== this.manifest.implementationDigest))
      throw new Error('Author Hitch journal completion identity mismatch');
    return { status: saved.status, envelope: saved.envelope, request: saved.request,
      requestDigest: saved.requestDigest, intent: saved.intent,
      ...(saved.identity ? { submittedIdentity: saved.identity as unknown as JsonValue } : {}),
      ...(saved.completion ? { completion: saved.completion } : {}) };
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
  /** The overlay is an operation-owned Git effect. It is never created by preflight. */
  private async withOverlay(envelope: OperationEnvelope, prepared: Prepared,
    overlay: SkillOverlayResult): Promise<Prepared> {
    if (!prepared.skillsLibraryRef || !prepared.selectedSkillDigests || !this.options.skillOverlay)
      throw new Error('Unexpected Hitch Skill overlay');
    const receipt = this.options.artifacts.getJson(overlay.receiptRef) as Record<string, unknown>;
    if (overlay.receiptRef.schemaId !== 'skills.overlay.receipt.v1'
      || receipt.operationId !== envelope.operationId
      || canonicalJson(receipt.baseHarness as JsonValue) !== canonicalJson(prepared.baseHarness)
      || receipt.bindingSetDigest !== envelope.bindingSetRef.digest
      || receipt.skillsLibraryDigest !== prepared.skillsLibraryRef.digest
      || canonicalJson(receipt.injectedSkillDigests as JsonValue) !== canonicalJson(prepared.selectedSkillDigests)
      || canonicalJson(overlay.injectedSkillDigests) !== canonicalJson(prepared.selectedSkillDigests)
      || receipt.commitOid !== overlay.commitOid || receipt.manifestDigest !== overlay.manifestDigest) {
      throw new Error('Hitch Skill overlay receipt identity mismatch');
    }
    const actual = await this.options.builder.readManifest(overlay.commitOid);
    if (actual.digest !== overlay.manifestDigest) throw new Error('Hitch Skill overlay Git manifest changed');
    const request: EvaluationRequest = { ...prepared.request, harnessRef: overlay.commitOid };
    const intent = this.options.evaluator.prepareSubmission(prepared.contextRound, request);
    if (!intent) throw new Error('Hitch Skill overlay has no durable daemon submission intent');
    return { ...prepared, request, intent };
  }

  private async materialize(envelope: OperationEnvelope, prepared: Prepared): Promise<SkillOverlayResult> {
    const overlay = this.options.skillOverlay;
    if (!overlay || !prepared.skillsLibraryRef || !prepared.input.injectedSkillRefs)
      throw new Error('Hitch Skill overlay host unavailable');
    return materializeSkillOverlay({ operationId: envelope.operationId, baseHarness: prepared.baseHarness,
      bindingSetRef: envelope.bindingSetRef, skillsLibraryRef: prepared.skillsLibraryRef,
      selectedSkillRefs: prepared.input.injectedSkillRefs, artifacts: this.options.artifacts,
      bindings: this.options.bindings, builder: this.options.builder,
      workspaceManager: overlay.workspaceManager, stateRoot: this.options.stateRoot,
      hostIdentityDigest: overlay.hostIdentityDigest });
  }

  private async journalPrepared(envelope: OperationEnvelope, base: Prepared,
    saved: Journal, createOverlay: boolean): Promise<{ prepared: Prepared; saved: Journal } | null> {
    if (!base.skillsLibraryRef) {
      if (saved.overlay) throw new Error('Hitch unrequested Skill overlay');
      return { prepared: base, saved };
    }
    if (!saved.overlay) {
      if (!['intent', 'cancelling'].includes(saved.status) || saved.requestDigest !== digestJson(base.request)
        || canonicalJson(saved.intent) !== canonicalJson(base.intent))
        throw new Error('Hitch Skill overlay intent or lifecycle drift');
      if (!createOverlay) return null;
      let overlay: SkillOverlayResult;
      try { overlay = await this.materialize(envelope, base); }
      catch (error) {
        if (error instanceof SkillOverlayUnknown) return null;
        throw error;
      }
      const prepared = await this.withOverlay(envelope, base, overlay);
      saved = { ...saved, overlay, requestDigest: digestJson(prepared.request), intent: prepared.intent };
      durableWrite(this.path(envelope), canonicalJson(saved));
      return { prepared, saved };
    }
    return { prepared: await this.withOverlay(envelope, base, saved.overlay), saved };
  }
  private async settle(envelope: OperationEnvelope, prepared: Prepared, saved: Journal): Promise<ProviderInspection> {
    if (prepared.skillsLibraryRef && !saved.overlay) throw new Error('Hitch Skill rollout has no sealed overlay');
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
    const receipt: ExecutionReceipt & { executedHarnessCommit: string; skillOverlayReceiptRef?: ArtifactRef;
      injectedSkillDigests?: string[] } = { schemaVersion: 1, providerImplementationDigest: this.manifest.implementationDigest,
      operationId: envelope.operationId, inputDigest: envelope.inputDigest, loadedBindingSetDigest: envelope.bindingSetRef.digest,
      evidenceDigest: evidenceRef.digest, actualBindings: Object.fromEntries(Object.entries(prepared.bindingSlots).map(([slot, ref]) => [slot, ref.digest])),
      bindingUse: 'executed', executedHarnessCommit: prepared.request.harnessRef,
      executionIdentity: digestJson({ evalId: evidence.evalId, submittedIdentity: identity,
        evidenceDigest: evidenceRef.digest, overlayReceiptDigest: saved.overlay?.receiptRef.digest ?? null }),
      samplingDigest: this.samplingDigest, environmentDigest: this.environmentDigest,
      ...(saved.overlay ? { skillOverlayReceiptRef: saved.overlay.receiptRef,
        injectedSkillDigests: saved.overlay.injectedSkillDigests } : {}) };
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
    const base = await this.prepared(envelope);
    const existing = this.read(envelope);
    if (existing?.status === 'cancelled') throw new Error('Hitch operation was cancelled before submission');
    if (existing?.status === 'completed') return { status: 'completed', completion: existing.completion! };
    if (existing) {
      const inspected = await this.inspect(envelope);
      if (inspected.status === 'completed') return inspected;
      if (inspected.status === 'running') return inspected;
      throw new Error('Existing Hitch submission is unresolved; inspect before retrying');
    }
    const initial = this.newJournal(envelope, base, 'intent');
    if (!this.establish(initial)) return this.submit(envelope);
    const stage = await this.journalPrepared(envelope, base, initial, true);
    if (!stage) throw new SkillOverlayUnknown('Hitch Skill overlay operation outcome is unresolved');
    const { prepared, saved } = stage;
    const reservation = await this.options.evaluator.reserve(prepared.contextRound, prepared.request,
      new AbortController().signal, prepared.intent);
    durableWrite(this.path(envelope), canonicalJson({ ...saved, status: 'reserved', reservation }));
    return { status: 'running', handle: reservation.evalId };
  }
  async inspect(envelope: OperationEnvelope): Promise<ProviderInspection> {
    const base = await this.prepared(envelope);
    let saved = this.read(envelope);
    if (!saved) return { status: 'not-started' };
    if (saved.status === 'cancelled') return { status: 'cancelled', releaseConfirmed: true,
      ...(saved.receipt ? { receipt: saved.receipt } : {}) };
    const stage = await this.journalPrepared(envelope, base, saved, saved.status === 'intent');
    if (!stage) return { status: 'unknown' };
    const prepared = stage.prepared;
    saved = stage.saved;
    if (saved.requestDigest !== digestJson(prepared.request) || canonicalJson(saved.intent) !== canonicalJson(prepared.intent)) {
      throw new Error('Hitch frozen submission request drift');
    }
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
    const base = await this.prepared(envelope);
    let saved = this.read(envelope);
    if (!saved) {
      const receipt = this.usage(envelope, 0);
      const tombstone = this.newJournal(envelope, base, 'cancelled', receipt);
      if (this.establish(tombstone)) return { status: 'cancelled', releaseConfirmed: true,
        ...(receipt ? { receipt } : {}) };
      saved = this.read(envelope);
    }
    if (!saved) return { status: 'unknown' };
    if (saved.status === 'cancelled') return { status: 'cancelled', releaseConfirmed: true,
      ...(saved.receipt ? { receipt: saved.receipt } : {}) };
    if (saved.status === 'completed') return { status: 'completed', completion: saved.completion! };
    if (saved.status !== 'cancelling') { saved = { ...saved, status: 'cancelling' }; durableWrite(this.path(envelope), canonicalJson(saved)); }
    const stage = await this.journalPrepared(envelope, base, saved, false);
    if (!stage) return { status: 'unknown' };
    const prepared = stage.prepared;
    saved = stage.saved;
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
