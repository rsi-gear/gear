import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type {
  ArtifactRef,
  CandidateSelectionInput,
  ComponentKind,
  ComponentRef,
  EvaluationCondition,
  EvolutionSpec,
  EvaluationEvidence,
  MetricSet,
  PairedTrial,
  PromotionPolicy,
  RefineEvaluator,
  ResolvedRoundPlan,
  RolloutSpec,
  SelectionDecision,
} from '../types.js'
import { digestJson } from '../state/digest.js'

const PACKAGE_NAME = 'dsh-plugin-refine'
const PACKAGE_MANIFEST_BYTES = readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)))
const PACKAGE_VERSION = (JSON.parse(PACKAGE_MANIFEST_BYTES.toString('utf8')) as { version: string }).version

export type ComponentImplementation = ComponentRef<unknown>['implementation']

function builtinImplementation(kind: ComponentKind, id: string): ComponentImplementation {
  const moduleBytes = readFileSync(fileURLToPath(import.meta.url))
  return {
    package: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    integrity: `sha256:${createHash('sha256')
      .update(moduleBytes)
      .update('\0')
      .update(PACKAGE_MANIFEST_BYTES)
      .update('\0')
      .update(JSON.stringify({ package: PACKAGE_NAME, version: PACKAGE_VERSION, kind, id, apiVersion: 1 }))
      .digest('hex')}`,
  }
}

export function componentRef<C>(
  kind: ComponentKind,
  id: string,
  implementation: ComponentImplementation,
  config: C,
): ComponentRef<C> {
  const configDigest = digestJson(config)
  return {
    kind,
    id,
    apiVersion: 1,
    implementation,
    config,
    configDigest,
  }
}

export function builtinComponentRef<C>(kind: ComponentKind, id: string, config: C): ComponentRef<C> {
  return componentRef(kind, id, builtinImplementation(kind, id), config)
}

export function assertComponentRef(value: ComponentRef<unknown>, expectedKind?: ComponentKind): void {
  if (expectedKind !== undefined && value.kind !== expectedKind) {
    throw new TypeError(`component ${value.id} has kind ${value.kind}; expected ${expectedKind}`)
  }
  if (value.apiVersion !== 1 || value.id.length === 0 || value.implementation.package.length === 0
    || value.implementation.version.length === 0 || value.implementation.integrity.length === 0) {
    throw new TypeError('component identity is invalid')
  }
  if (digestJson(value.config) !== value.configDigest) {
    throw new TypeError(`component config digest mismatch: ${value.id}`)
  }
}

export interface CandidateGenerationSlot {
  candidateId: string
  parentHarnessRef: string
  parentCandidateIds: string[]
}

export interface CandidateGenerationParent {
  candidateId: string
  harnessRef: string
  harnessDigest: string
  parentCandidateIds: string[]
  lineageRootId: string
  metrics: MetricSet
}

export interface CandidateGenerator {
  readonly ref: ComponentRef<unknown>
  plan(roundId: string, parents: readonly CandidateGenerationParent[], maxCandidates: number): CandidateGenerationSlot[]
}

export class ForkedProposalCandidateGenerator implements CandidateGenerator {
  readonly ref: ComponentRef<unknown>

  constructor(ref: ComponentRef<unknown>) {
    assertComponentRef(ref, 'candidate-generator')
    this.ref = ref
  }

  plan(roundId: string, parents: readonly CandidateGenerationParent[], maxCandidates: number): CandidateGenerationSlot[] {
    if (!Number.isSafeInteger(maxCandidates) || maxCandidates <= 0) {
      throw new TypeError('candidateGeneration.maxCandidates must be a positive integer')
    }
    if (parents.length === 0) throw new TypeError('candidate generation requires at least one parent')
    const ordered = [...parents].sort((left, right) => left.candidateId.localeCompare(right.candidateId))
    return Array.from({ length: maxCandidates }, (_, index) => ({
      candidateId: `${roundId}-candidate-${index + 1}`,
      parentHarnessRef: ordered[index % ordered.length]!.harnessRef,
      parentCandidateIds: [ordered[index % ordered.length]!.candidateId],
    }))
  }
}

export interface TaskSampler {
  readonly ref: ComponentRef<unknown>
  resolve(roundId: string, datasets: EvolutionSpec['datasets'], rollout: RolloutSpec, timeoutMs: number): ResolvedRoundPlan
}

function condition(
  partition: EvaluationCondition['partition'],
  dataset: ArtifactRef,
  rollout: RolloutSpec,
  timeoutMs: number,
): EvaluationCondition {
  const identity = {
    partition,
    dataset,
    repetitions: rollout.repetitions,
    ...(rollout.seeds === undefined ? {} : { seeds: rollout.seeds }),
    model: rollout.model,
    sampling: rollout.sampling,
    timeoutMs,
    rolloutProviderDigest: digestJson(rollout.provider),
  }
  return { conditionId: digestJson(identity), ...identity }
}

export class DatasetTaskSampler implements TaskSampler {
  readonly ref: ComponentRef<unknown>

  constructor(ref: ComponentRef<unknown>) {
    assertComponentRef(ref, 'task-sampler')
    this.ref = ref
  }

  resolve(roundId: string, datasets: EvolutionSpec['datasets'], rollout: RolloutSpec, timeoutMs: number): ResolvedRoundPlan {
    const seed = condition('seed', datasets.seed, rollout, timeoutMs)
    const heldOut = condition('held-out', datasets.heldOut, rollout, timeoutMs)
    const identity = { roundId, taskSampler: this.ref, seed, heldOut }
    return { planId: `${roundId}-plan`, digest: digestJson(identity), taskSampler: this.ref, seed, heldOut }
  }
}

export interface CandidateSelector {
  readonly ref: ComponentRef<unknown>
  select(candidates: readonly CandidateSelectionInput[], survivors: number): SelectionDecision
}

export interface Judge {
  readonly ref: ComponentRef<unknown>
  evaluate(evidence: EvaluationEvidence): Partial<MetricSet> | Promise<Partial<MetricSet>>
}

export interface RolloutProvider {
  readonly ref: ComponentRef<unknown>
  createEvaluator(spec: EvolutionSpec): RefineEvaluator
}

export class TaskRewardJudge implements Judge {
  readonly ref: ComponentRef<unknown>

  constructor(ref: ComponentRef<unknown>) {
    assertComponentRef(ref, 'judge')
    this.ref = ref
  }

  evaluate(evidence: EvaluationEvidence): Partial<MetricSet> {
    return {
      quality: evidence.primaryReward,
      taskSuccessRate: evidence.summary.total === 0 ? 0 : evidence.summary.passed / evidence.summary.total,
    }
  }
}

export class HighestQualityCandidateSelector implements CandidateSelector {
  readonly ref: ComponentRef<unknown>

  constructor(ref: ComponentRef<unknown>) {
    assertComponentRef(ref, 'candidate-selector')
    this.ref = ref
  }

  select(candidates: readonly CandidateSelectionInput[], survivors: number): SelectionDecision {
    if (!Number.isSafeInteger(survivors) || survivors <= 0) throw new TypeError('selection.survivors must be positive')
    const scored = [...candidates]
      .sort((left, right) => (right.metrics?.quality ?? right.seedEvaluation.primaryReward)
        - (left.metrics?.quality ?? left.seedEvaluation.primaryReward)
        || left.candidateId.localeCompare(right.candidateId))
      .filter((candidate, index, ordered) => ordered.findIndex(value => value.sealedVersion.treeOid === candidate.sealedVersion.treeOid) === index)
    if (scored.length < survivors) throw new Error(`selector needs ${survivors} evaluated candidates, found ${scored.length}`)
    const selected = scored.slice(0, survivors)
    return {
      selectedCandidateIds: selected.map(candidate => candidate.candidateId),
      promotionCandidateId: selected[0]!.candidateId,
      reason: 'highest primary reward on seed/dev evaluation',
      component: this.ref,
      metrics: Object.fromEntries(scored.map(candidate => [candidate.candidateId, candidate.metrics?.quality ?? candidate.seedEvaluation.primaryReward])),
    }
  }
}

export interface PromotionDecisionRequest {
  policy: PromotionPolicy
  seedBaseline: EvaluationEvidence
  seedCandidate: EvaluationEvidence
  heldOutBaseline: EvaluationEvidence
  heldOutCandidate: EvaluationEvidence
  pairedTrials: {
    seed: readonly PairedTrial[]
    heldOut: readonly PairedTrial[]
  }
  metrics: MetricSet
  requiredRegressions: number
}

export interface PromotionDecision {
  accepted: boolean
  reason: string
}

export interface PromotionPolicyProvider {
  readonly ref: ComponentRef<PromotionPolicy>
  decide(request: PromotionDecisionRequest): PromotionDecision
}

export class PairedGatePromotionPolicy implements PromotionPolicyProvider {
  readonly ref: ComponentRef<PromotionPolicy>

  constructor(ref: ComponentRef<PromotionPolicy>) {
    assertComponentRef(ref, 'promotion-policy')
    this.ref = ref
  }

  decide(request: PromotionDecisionRequest): PromotionDecision {
    const seedDelta = request.seedCandidate.primaryReward - request.seedBaseline.primaryReward
    const heldOutDelta = request.heldOutCandidate.primaryReward - request.heldOutBaseline.primaryReward
    const accepted = request.seedCandidate.primaryReward >= request.policy.minimumCandidateScore
      && seedDelta >= request.policy.minimumAbsoluteGain
      && heldOutDelta >= -request.policy.maxHeldOutRegression
      && request.requiredRegressions <= request.policy.maxRequiredRegressions
      && (!request.policy.requireNoRegression
        || (request.seedCandidate.summary.passed >= request.seedBaseline.summary.passed
          && request.heldOutCandidate.summary.passed >= request.heldOutBaseline.summary.passed))
    return {
      accepted,
      reason: accepted ? 'paired seed and held-out gates passed' : 'paired promotion gate rejected candidate',
    }
  }
}

interface RegisteredComponent<C, T> {
  implementation: ComponentImplementation
  factory: (ref: ComponentRef<C>) => T
}

export class ComponentRegistry {
  private readonly candidateGenerators = new Map<string, RegisteredComponent<unknown, CandidateGenerator>>()
  private readonly taskSamplers = new Map<string, RegisteredComponent<unknown, TaskSampler>>()
  private readonly rolloutProviders = new Map<string, RegisteredComponent<unknown, RolloutProvider>>()
  private readonly selectors = new Map<string, RegisteredComponent<unknown, CandidateSelector>>()
  private readonly judges = new Map<string, RegisteredComponent<unknown, Judge>>()
  private readonly promotionPolicies = new Map<string, RegisteredComponent<PromotionPolicy, PromotionPolicyProvider>>()

  constructor() {
    this.registerCandidateGenerator('dsh-meta-forked-proposals', builtinImplementation('candidate-generator', 'dsh-meta-forked-proposals'), ref => new ForkedProposalCandidateGenerator(ref))
    this.registerTaskSampler('dataset', builtinImplementation('task-sampler', 'dataset'), ref => new DatasetTaskSampler(ref))
    this.registerCandidateSelector('highest-quality', builtinImplementation('candidate-selector', 'highest-quality'), ref => new HighestQualityCandidateSelector(ref))
    this.registerJudge('task-reward', builtinImplementation('judge', 'task-reward'), ref => new TaskRewardJudge(ref))
    this.registerPromotionPolicy('paired-gate', builtinImplementation('promotion-policy', 'paired-gate'), ref => new PairedGatePromotionPolicy(ref))
  }

  registerCandidateGenerator(id: string, implementation: ComponentImplementation, factory: (ref: ComponentRef<unknown>) => CandidateGenerator): () => void {
    return this.register(this.candidateGenerators, id, implementation, factory)
  }

  registerTaskSampler(id: string, implementation: ComponentImplementation, factory: (ref: ComponentRef<unknown>) => TaskSampler): () => void {
    return this.register(this.taskSamplers, id, implementation, factory)
  }

  registerRolloutProvider(id: string, implementation: ComponentImplementation, factory: (ref: ComponentRef<unknown>) => RolloutProvider): () => void {
    return this.register(this.rolloutProviders, id, implementation, factory)
  }

  registerCandidateSelector(id: string, implementation: ComponentImplementation, factory: (ref: ComponentRef<unknown>) => CandidateSelector): () => void {
    return this.register(this.selectors, id, implementation, factory)
  }

  registerJudge(id: string, implementation: ComponentImplementation, factory: (ref: ComponentRef<unknown>) => Judge): () => void {
    return this.register(this.judges, id, implementation, factory)
  }

  registerPromotionPolicy(
    id: string,
    implementation: ComponentImplementation,
    factory: (ref: ComponentRef<PromotionPolicy>) => PromotionPolicyProvider,
  ): () => void {
    return this.register(this.promotionPolicies, id, implementation, factory)
  }

  candidateGenerator(ref: ComponentRef<unknown>): CandidateGenerator {
    return this.resolve(this.candidateGenerators, ref, 'candidate-generator')
  }

  taskSampler(ref: ComponentRef<unknown>): TaskSampler {
    return this.resolve(this.taskSamplers, ref, 'task-sampler')
  }

  rolloutProvider(ref: ComponentRef<unknown>): RolloutProvider {
    return this.resolve(this.rolloutProviders, ref, 'rollout-provider')
  }

  hasRolloutProvider(id: string): boolean {
    return this.rolloutProviders.has(id)
  }

  selector(ref: ComponentRef<unknown>): CandidateSelector {
    return this.resolve(this.selectors, ref, 'candidate-selector')
  }

  judge(ref: ComponentRef<unknown>): Judge {
    return this.resolve(this.judges, ref, 'judge')
  }

  promotionPolicy(ref: ComponentRef<PromotionPolicy>): PromotionPolicyProvider {
    return this.resolve(this.promotionPolicies, ref, 'promotion-policy')
  }

  private resolve<T, C>(registry: Map<string, RegisteredComponent<C, T>>, ref: ComponentRef<C>, kind: ComponentKind): T {
    assertComponentRef(ref as ComponentRef<unknown>, kind)
    const registered = registry.get(ref.id)
    if (registered === undefined) throw new Error(`unknown ${kind} component: ${ref.id}`)
    if (digestJson(registered.implementation) !== digestJson(ref.implementation)) {
      throw new Error(`component implementation identity mismatch: ${ref.id}`)
    }
    return registered.factory(ref)
  }

  private register<T, C>(
    registry: Map<string, RegisteredComponent<C, T>>,
    id: string,
    implementation: ComponentImplementation,
    factory: (ref: ComponentRef<C>) => T,
  ): () => void {
    if (id.length === 0) throw new TypeError('component id must not be empty')
    if (registry.has(id)) throw new Error(`component already registered: ${id}`)
    if (implementation.package.length === 0 || implementation.version.length === 0 || implementation.integrity.length === 0) {
      throw new TypeError('component implementation identity is invalid')
    }
    const registration = { implementation, factory }
    registry.set(id, registration)
    return () => {
      if (registry.get(id) === registration) registry.delete(id)
    }
  }
}
