import type { MultisignalPromotionConfig, SearchConfig, SearchSettings } from './types.js'

export const defaultSearchConfig: SearchConfig = {
  mode: 'failure-cluster-gepa-v1', seed: 0, parentBatchCount: 1,
  parentSampling: 'scoped-frontier-membership-v1', scopeWeights: 'uniform-by-family', archiveCoverage: 'complete-scope',
  diagnosis: { sharing: 'parent-evidence-dossier', planner: 'evidence-failure-clusters-v1', candidatesPerFamily: 1 },
  taskSetSizing: { basis: 'seed-universe', rounding: 'ceil', local: { ratio: 0.08 }, shared: { ratio: 0.04 }, cross: { ratio: 0.03 }, bridge: { ratio: 0.4 } },
  scopeSampling: { bucketWeights: { local: 0.6, shared: 0.25, cross: 0.15 }, epochPolicy: 'stable' },
  evaluationStages: { bridge: { maxCandidates: 2, groupAllocation: 'weighted-round-robin', taskSelection: 'nominated-scopes-union-then-stratified' }, globalSeed: { maxCandidates: 1 }, reuseValidCells: true },
  process: { mode: 'auto', parentBudgetFraction: 0.25 }, globalTaskWeights: 'uniform', explorationGuards: [],
}
export const defaultMultisignalPromotion: MultisignalPromotionConfig = {
  policy: 'paired-multisignal-v1', validationMode: 'independent-held-out',
  outcome: { minimumGain: 0, maxSeedRegression: 0, maxHeldOutRegression: 0 },
  process: { mode: 'auto', minimumGain: 0, maxSeedRegression: 0, maxHeldOutRegression: 0 },
  allowNeutral: false, protectedTasks: [], protectedAssertions: [],
}
/** Explicit opt-in: existing experiment configurations keep their original selector. */
export const defaultEpsilonGreedySearchConfig: SearchConfig = {
  ...structuredClone(defaultSearchConfig), parentSampling: 'epsilon-greedy-gepa-v1', championProbability: 0.5,
}
export function resolveSearchSettings(input: { search?: SearchConfig; promotion: unknown; budgets?: SearchSettings['budgets']; regression?: SearchSettings['regression'] }): SearchSettings | undefined {
  if (input.search === undefined) return undefined
  if (input.search.mode !== 'failure-cluster-gepa-v1') throw new Error('unsupported search.mode')
  if (!input.budgets) throw new Error('new search mode requires explicit round and evolution budgets')
  const s = input.search, p = input.promotion as Partial<MultisignalPromotionConfig>
  if (p.policy !== 'paired-multisignal-v1') throw new Error('new search mode requires promotion.policy=paired-multisignal-v1')
  for (const legacy of ['localTasks', 'sharedTasks', 'crossTasks']) if (legacy in s) throw new Error(`${legacy} is unsupported; use taskSetSizing ratios`)
  return {
    search: { ...structuredClone(defaultSearchConfig), ...s,
      ...(s.parentSampling === 'epsilon-greedy-gepa-v1' ? { championProbability: s.championProbability ?? 0.5 } : {}),
      diagnosis: { ...defaultSearchConfig.diagnosis, ...s.diagnosis },
      taskSetSizing: { ...defaultSearchConfig.taskSetSizing, ...s.taskSetSizing },
      scopeSampling: { ...defaultSearchConfig.scopeSampling, ...s.scopeSampling, bucketWeights: { ...defaultSearchConfig.scopeSampling.bucketWeights, ...s.scopeSampling?.bucketWeights } },
      evaluationStages: { ...defaultSearchConfig.evaluationStages, ...s.evaluationStages, bridge: { ...defaultSearchConfig.evaluationStages.bridge, ...s.evaluationStages?.bridge } },
      process: { ...defaultSearchConfig.process, ...s.process },
    },
    promotion: { policy: 'paired-multisignal-v1', validationMode: p.validationMode ?? defaultMultisignalPromotion.validationMode,
      ...(p.objective ? { objective: structuredClone(p.objective) } : {}),
      ...(p.allowSharedSetPromotion === undefined ? {} : { allowSharedSetPromotion: p.allowSharedSetPromotion }),
      allowNeutral: p.allowNeutral ?? false, protectedTasks: p.protectedTasks ?? [], protectedAssertions: p.protectedAssertions ?? [],
      outcome: { ...defaultMultisignalPromotion.outcome, ...p.outcome }, process: { ...defaultMultisignalPromotion.process, ...p.process } },
    budgets: structuredClone(input.budgets), regression: structuredClone(input.regression ?? { collectFailures: false, maxProposals: 50 }),
  }
}
