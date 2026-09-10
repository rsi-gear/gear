import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { digestJson } from '../state/digest.js';
const PACKAGE_NAME = 'dsh-plugin-refine';
const PACKAGE_MANIFEST_BYTES = readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)));
const PACKAGE_VERSION = JSON.parse(PACKAGE_MANIFEST_BYTES.toString('utf8')).version;
function builtinImplementation(kind, id) {
    const moduleBytes = readFileSync(fileURLToPath(import.meta.url));
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
    };
}
export function componentRef(kind, id, implementation, config) {
    const configDigest = digestJson(config);
    return {
        kind,
        id,
        apiVersion: 1,
        implementation,
        config,
        configDigest,
    };
}
export function builtinComponentRef(kind, id, config) {
    return componentRef(kind, id, builtinImplementation(kind, id), config);
}
/**
 * Builds the stable identity used to decide whether rollout evidence is semantically reusable.
 * Callers must pass only settings that can change the evaluated result. Operational placement,
 * credentials, concurrency, and logging/output limits belong in the provider config, not here.
 */
export function rolloutProviderSemanticDigest(provider, semanticConfig, agentConfig) {
    return digestJson({
        provider: {
            kind: provider.kind,
            id: provider.id,
            apiVersion: provider.apiVersion,
            implementation: provider.implementation,
        },
        semanticConfig,
        agentConfig,
    });
}
export function assertComponentRef(value, expectedKind) {
    if (expectedKind !== undefined && value.kind !== expectedKind) {
        throw new TypeError(`component ${value.id} has kind ${value.kind}; expected ${expectedKind}`);
    }
    if (value.apiVersion !== 1 || value.id.length === 0 || value.implementation.package.length === 0
        || value.implementation.version.length === 0 || value.implementation.integrity.length === 0) {
        throw new TypeError('component identity is invalid');
    }
    if (digestJson(value.config) !== value.configDigest) {
        throw new TypeError(`component config digest mismatch: ${value.id}`);
    }
}
export class ForkedProposalCandidateGenerator {
    ref;
    constructor(ref) {
        assertComponentRef(ref, 'candidate-generator');
        this.ref = ref;
    }
    plan(roundId, parents, maxCandidates) {
        if (!Number.isSafeInteger(maxCandidates) || maxCandidates <= 0) {
            throw new TypeError('candidateGeneration.maxCandidates must be a positive integer');
        }
        if (parents.length === 0)
            throw new TypeError('candidate generation requires at least one parent');
        const ordered = [...parents].sort((left, right) => left.candidateId.localeCompare(right.candidateId));
        return Array.from({ length: maxCandidates }, (_, index) => ({
            candidateId: `${roundId}-candidate-${index + 1}`,
            parentHarnessRef: ordered[index % ordered.length].harnessRef,
            parentCandidateIds: [ordered[index % ordered.length].candidateId],
        }));
    }
}
function condition(partition, dataset, rollout, timeoutMs) {
    const identity = {
        partition,
        dataset,
        repetitions: rollout.repetitions,
        ...(rollout.seeds === undefined ? {} : { seeds: rollout.seeds }),
        model: rollout.model,
        sampling: rollout.sampling,
        timeoutMs,
        // Legacy specs retain their original identity so they remain readable. New specs provide the
        // path-independent semantic digest explicitly; their first round after this change establishes
        // evidence under the new identity.
        rolloutProviderDigest: rollout.providerSemanticDigest ?? digestJson(rollout.provider),
    };
    return { conditionId: digestJson(identity), ...identity };
}
export class DatasetTaskSampler {
    ref;
    constructor(ref) {
        assertComponentRef(ref, 'task-sampler');
        this.ref = ref;
    }
    resolve(roundId, datasets, rollout, timeoutMs) {
        const seed = condition('seed', datasets.seed, rollout, timeoutMs);
        const heldOut = condition('held-out', datasets.heldOut, rollout, timeoutMs);
        const identity = { roundId, taskSampler: this.ref, seed, heldOut };
        return { planId: `${roundId}-plan`, digest: digestJson(identity), taskSampler: this.ref, seed, heldOut };
    }
}
export class TaskRewardJudge {
    ref;
    constructor(ref) {
        assertComponentRef(ref, 'judge');
        this.ref = ref;
    }
    evaluate(evidence) {
        return {
            quality: evidence.primaryReward,
            taskSuccessRate: evidence.summary.total === 0 ? 0 : evidence.summary.passed / evidence.summary.total,
        };
    }
}
export class EvaluationMetricsCandidateAssessor {
    ref;
    constructor(ref) {
        assertComponentRef(ref, 'candidate-assessor');
        this.ref = ref;
    }
    async assess(request, _context, signal) {
        signal.throwIfAborted();
        const ordered = [...request.candidates].sort((left, right) => left.candidateId.localeCompare(right.candidateId));
        return {
            candidateMetrics: Object.fromEntries(ordered.map(candidate => [candidate.candidateId, structuredClone(candidate.metrics)])),
            rankingCandidateIds: ordered
                .sort((left, right) => right.metrics.quality - left.metrics.quality || left.candidateId.localeCompare(right.candidateId))
                .map(candidate => candidate.candidateId),
            reason: 'used persisted seed evaluation metrics without additional model calls',
            evidence: {
                kind: 'evaluation-metrics',
                evalIds: Object.fromEntries(ordered.map(candidate => [candidate.candidateId, candidate.seedEvaluation.evalId])),
            },
            usage: { modelRequests: 0, inputTokens: 0, outputTokens: 0 },
        };
    }
}
export class HighestQualityCandidateSelector {
    ref;
    constructor(ref) {
        assertComponentRef(ref, 'candidate-selector');
        this.ref = ref;
    }
    select(request) {
        const { candidates, survivors, assessment } = request;
        if (!Number.isSafeInteger(survivors) || survivors <= 0)
            throw new TypeError('selection.survivors must be positive');
        const scored = [...candidates]
            .sort((left, right) => (right.metrics?.quality ?? right.seedEvaluation.primaryReward)
            - (left.metrics?.quality ?? left.seedEvaluation.primaryReward)
            || left.candidateId.localeCompare(right.candidateId))
            .filter((candidate, index, ordered) => ordered.findIndex(value => value.sealedVersion.treeOid === candidate.sealedVersion.treeOid) === index);
        if (scored.length < survivors)
            throw new Error(`selector needs ${survivors} evaluated candidates, found ${scored.length}`);
        const selected = scored.slice(0, survivors);
        return {
            selectedCandidateIds: selected.map(candidate => candidate.candidateId),
            promotionCandidateId: selected[0].candidateId,
            reason: 'highest assessed quality on seed/dev evaluation',
            component: this.ref,
            assessmentDigest: assessment.digest,
            metrics: Object.fromEntries(scored.map(candidate => [candidate.candidateId, candidate.metrics?.quality ?? candidate.seedEvaluation.primaryReward])),
        };
    }
}
function pairedRewards(trials, side) {
    const rewards = trials.map(trial => side === 'baseline' ? trial.baselineReward : trial.candidateReward);
    return {
        score: rewards.length === 0 ? 0 : rewards.reduce((sum, reward) => sum + reward, 0) / rewards.length,
        passed: rewards.filter(reward => reward > 0).length,
    };
}
export class PairedGatePromotionPolicy {
    ref;
    constructor(ref) {
        assertComponentRef(ref, 'promotion-policy');
        this.ref = ref;
    }
    decide(request) {
        if (request.pairedTrials.seed.length === 0 || request.pairedTrials.heldOut.length === 0) {
            return { accepted: false, reason: 'paired promotion gate requires at least one valid seed and held-out pair' };
        }
        const seedBaseline = pairedRewards(request.pairedTrials.seed, 'baseline');
        const seedCandidate = pairedRewards(request.pairedTrials.seed, 'candidate');
        const heldOutBaseline = pairedRewards(request.pairedTrials.heldOut, 'baseline');
        const heldOutCandidate = pairedRewards(request.pairedTrials.heldOut, 'candidate');
        const seedDelta = seedCandidate.score - seedBaseline.score;
        const heldOutDelta = heldOutCandidate.score - heldOutBaseline.score;
        const accepted = seedCandidate.score >= request.policy.minimumCandidateScore
            && seedDelta >= request.policy.minimumAbsoluteGain
            && heldOutDelta >= -request.policy.maxHeldOutRegression
            && request.requiredRegressions <= request.policy.maxRequiredRegressions
            && (!request.policy.requireNoRegression
                || (seedCandidate.passed >= seedBaseline.passed
                    && heldOutCandidate.passed >= heldOutBaseline.passed));
        return {
            accepted,
            reason: accepted ? 'paired seed and held-out gates passed' : 'paired promotion gate rejected candidate',
        };
    }
}
export class ComponentRegistry {
    candidateGenerators = new Map();
    taskSamplers = new Map();
    rolloutProviders = new Map();
    assessors = new Map();
    selectors = new Map();
    judges = new Map();
    promotionPolicies = new Map();
    constructor() {
        this.registerCandidateGenerator('dsh-meta-forked-proposals', builtinImplementation('candidate-generator', 'dsh-meta-forked-proposals'), ref => new ForkedProposalCandidateGenerator(ref));
        this.registerCandidateGenerator('meta-forked-proposals', builtinImplementation('candidate-generator', 'meta-forked-proposals'), ref => new ForkedProposalCandidateGenerator(ref));
        this.registerTaskSampler('dataset', builtinImplementation('task-sampler', 'dataset'), ref => new DatasetTaskSampler(ref));
        this.registerCandidateAssessor('evaluation-metrics', builtinImplementation('candidate-assessor', 'evaluation-metrics'), ref => new EvaluationMetricsCandidateAssessor(ref));
        this.registerCandidateSelector('highest-quality', builtinImplementation('candidate-selector', 'highest-quality'), ref => new HighestQualityCandidateSelector(ref));
        this.registerJudge('task-reward', builtinImplementation('judge', 'task-reward'), ref => new TaskRewardJudge(ref));
        this.registerPromotionPolicy('paired-gate', builtinImplementation('promotion-policy', 'paired-gate'), ref => new PairedGatePromotionPolicy(ref));
    }
    registerCandidateGenerator(id, implementation, factory) {
        return this.register(this.candidateGenerators, id, implementation, factory);
    }
    registerTaskSampler(id, implementation, factory) {
        return this.register(this.taskSamplers, id, implementation, factory);
    }
    registerRolloutProvider(id, implementation, factory) {
        return this.register(this.rolloutProviders, id, implementation, factory);
    }
    registerCandidateAssessor(id, implementation, factory) {
        return this.register(this.assessors, id, implementation, factory);
    }
    registerCandidateSelector(id, implementation, factory) {
        return this.register(this.selectors, id, implementation, factory);
    }
    registerJudge(id, implementation, factory) {
        return this.register(this.judges, id, implementation, factory);
    }
    registerPromotionPolicy(id, implementation, factory) {
        return this.register(this.promotionPolicies, id, implementation, factory);
    }
    candidateGenerator(ref) {
        return this.resolve(this.candidateGenerators, ref, 'candidate-generator');
    }
    taskSampler(ref) {
        return this.resolve(this.taskSamplers, ref, 'task-sampler');
    }
    rolloutProvider(ref) {
        return this.resolve(this.rolloutProviders, ref, 'rollout-provider');
    }
    hasRolloutProvider(id) {
        return this.rolloutProviders.has(id);
    }
    assessor(ref) {
        return this.resolve(this.assessors, ref, 'candidate-assessor');
    }
    selector(ref) {
        return this.resolve(this.selectors, ref, 'candidate-selector');
    }
    judge(ref) {
        return this.resolve(this.judges, ref, 'judge');
    }
    promotionPolicy(ref) {
        return this.resolve(this.promotionPolicies, ref, 'promotion-policy');
    }
    resolve(registry, ref, kind) {
        assertComponentRef(ref, kind);
        const registered = registry.get(ref.id);
        if (registered === undefined)
            throw new Error(`unknown ${kind} component: ${ref.id}`);
        if (digestJson(registered.implementation) !== digestJson(ref.implementation)) {
            throw new Error(`component implementation identity mismatch: ${ref.id}`);
        }
        return registered.factory(ref);
    }
    register(registry, id, implementation, factory) {
        if (id.length === 0)
            throw new TypeError('component id must not be empty');
        if (registry.has(id))
            throw new Error(`component already registered: ${id}`);
        if (implementation.package.length === 0 || implementation.version.length === 0 || implementation.integrity.length === 0) {
            throw new TypeError('component implementation identity is invalid');
        }
        const registration = { implementation, factory };
        registry.set(id, registration);
        return () => {
            if (registry.get(id) === registration)
                registry.delete(id);
        };
    }
}
//# sourceMappingURL=components.js.map