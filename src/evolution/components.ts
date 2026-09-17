import type { ParentSelectionPolicy } from '../search/parent-selection.js'
import { championGepaPolicy, parentPolicyImplementation, scopedFrontierPolicy } from '../search/policies/parents.js'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type {
  CandidateAssessmentContext,
  CandidateAssessmentRequest,
  CandidateAssessmentResult,
  CandidateSelectionRequest,
  CandidateSelectionInput,
  ComponentKind,
  ComponentRef,
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
import { assertComponentRef, componentRef, type ComponentImplementation } from './component-ref.js'
import { builtinImplementation, LegacyComponentVerifier } from './component-identity.js'
import {
  DatasetTaskSampler,
  EvaluationMetricsCandidateAssessor,
  ForkedProposalCandidateGenerator,
  HighestQualityCandidateSelector,
  PairedGatePromotionPolicy,
  TaskRewardJudge,
} from './builtin-algorithms.js'

export { assertComponentRef, componentRef, type ComponentImplementation } from './component-ref.js'
export {
  DatasetTaskSampler,
  EvaluationMetricsCandidateAssessor,
  ForkedProposalCandidateGenerator,
  HighestQualityCandidateSelector,
  PairedGatePromotionPolicy,
  TaskRewardJudge,
} from './builtin-algorithms.js'

export function builtinComponentRef<C>(kind: ComponentKind, id: string, config: C): ComponentRef<C> {
  return componentRef(kind, id, builtinImplementation(kind, id), config)
}

/**
 * Builds the stable identity used to decide whether rollout evidence is semantically reusable.
 * Callers must pass only settings that can change the evaluated result. Operational placement,
 * credentials, concurrency, and logging/output limits belong in the provider config, not here.
 */
export function rolloutProviderSemanticDigest(
  provider: ComponentRef<unknown>,
  semanticConfig: JsonValue,
  agentConfig: JsonValue,
): string {
  return digestJson({
    provider: {
      kind: provider.kind,
      id: provider.id,
      apiVersion: provider.apiVersion,
      implementation: provider.implementation,
    },
    semanticConfig,
    agentConfig,
  })
}
export { implementationFromFiles } from './implementation-files.js'

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

export interface TaskSampler {
  readonly ref: ComponentRef<unknown>
  resolve(roundId: string, datasets: EvolutionSpec['datasets'], rollout: RolloutSpec, timeoutMs: number): ResolvedRoundPlan
}

export interface CandidateSelector {
  readonly ref: ComponentRef<unknown>
  select(request: CandidateSelectionRequest): SelectionDecision
}

export interface CandidateAssessor {
  readonly ref: ComponentRef<unknown>
  assess(
    request: CandidateAssessmentRequest,
    context: CandidateAssessmentContext,
    signal: AbortSignal,
  ): Promise<CandidateAssessmentResult>
}

export interface Judge {
  readonly ref: ComponentRef<unknown>
  evaluate(evidence: EvaluationEvidence): Partial<MetricSet> | Promise<Partial<MetricSet>>
}

export interface RolloutProvider {
  readonly ref: ComponentRef<unknown>
  createEvaluator(spec: EvolutionSpec): RefineEvaluator
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

interface RegisteredComponent<C, T> {
  implementation: ComponentImplementation
  factory: (ref: ComponentRef<C>) => T
}

export class ComponentRegistry {
  private readonly parentPolicies = new Map<string, RegisteredComponent<unknown, ParentSelectionPolicy>>()
  private readonly candidateGenerators = new Map<string, RegisteredComponent<unknown, CandidateGenerator>>()
  private readonly taskSamplers = new Map<string, RegisteredComponent<unknown, TaskSampler>>()
  private readonly rolloutProviders = new Map<string, RegisteredComponent<unknown, RolloutProvider>>()
  private readonly assessors = new Map<string, RegisteredComponent<unknown, CandidateAssessor>>()
  private readonly selectors = new Map<string, RegisteredComponent<unknown, CandidateSelector>>()
  private readonly judges = new Map<string, RegisteredComponent<unknown, Judge>>()
  private readonly promotionPolicies = new Map<string, RegisteredComponent<PromotionPolicy, PromotionPolicyProvider>>()
  private readonly legacy: LegacyComponentVerifier

  constructor(options: { legacyComponentRoots?: readonly string[] } = {}) {
    this.legacy = new LegacyComponentVerifier(options.legacyComponentRoots)
    this.registerParentSelectionPolicy('scoped-frontier-membership-v1', parentPolicyImplementation, scopedFrontierPolicy)
    this.registerParentSelectionPolicy('epsilon-greedy-gepa-v1', parentPolicyImplementation, championGepaPolicy)
    this.registerCandidateGenerator('dsh-meta-forked-proposals', builtinImplementation('candidate-generator', 'dsh-meta-forked-proposals'), ref => new ForkedProposalCandidateGenerator(ref))
    this.registerCandidateGenerator('meta-forked-proposals', builtinImplementation('candidate-generator', 'meta-forked-proposals'), ref => new ForkedProposalCandidateGenerator(ref))
    this.registerTaskSampler('dataset', builtinImplementation('task-sampler', 'dataset'), ref => new DatasetTaskSampler(ref))
    this.registerCandidateAssessor('evaluation-metrics', builtinImplementation('candidate-assessor', 'evaluation-metrics'), ref => new EvaluationMetricsCandidateAssessor(ref))
    this.registerCandidateSelector('highest-quality', builtinImplementation('candidate-selector', 'highest-quality'), ref => new HighestQualityCandidateSelector(ref))
    this.registerJudge('task-reward', builtinImplementation('judge', 'task-reward'), ref => new TaskRewardJudge(ref))
    this.registerPromotionPolicy('paired-gate', builtinImplementation('promotion-policy', 'paired-gate'), ref => new PairedGatePromotionPolicy(ref))
  }

  registerParentSelectionPolicy(id: string, implementation: ComponentImplementation, factory: (ref: ComponentRef<unknown>) => ParentSelectionPolicy): () => void {
    return this.register(this.parentPolicies, id, implementation, factory)
  }

  parentSelectionPolicy(ref: ComponentRef<unknown>): ParentSelectionPolicy {
    const policy = this.resolve(this.parentPolicies, ref, 'parent-selection')
    if (digestJson(policy.ref) !== digestJson(ref) || typeof policy.requiresChampion !== 'boolean' || typeof policy.select !== 'function') {
      throw new TypeError('parent policy factory returned a different identity or invalid implementation')
    }
    return policy
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

  registerCandidateAssessor(id: string, implementation: ComponentImplementation, factory: (ref: ComponentRef<unknown>) => CandidateAssessor): () => void {
    return this.register(this.assessors, id, implementation, factory)
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

  assessor(ref: ComponentRef<unknown>): CandidateAssessor {
    return this.resolve(this.assessors, ref, 'candidate-assessor')
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
    if (digestJson(registered.implementation) !== digestJson(ref.implementation)
      && !this.legacy.accepts(ref as ComponentRef<unknown>, registered.implementation, kind, ref.id)) {
      if (ref.implementation.package === 'dsh-plugin-refine') {
        const detail = this.legacy.roots.length === 0
          ? 'opaque V1 identity requires an absolute evolutionState.legacyComponentRoots package path'
          : 'configured legacy package artifacts do not prove the same implementation'
        throw new Error(`component implementation identity mismatch: ${ref.id}; ${detail}`)
      }
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
