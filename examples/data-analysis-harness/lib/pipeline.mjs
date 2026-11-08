import { assert, digest, seal, verify, sourcePath } from './contracts.mjs'

export function validateSearchPlan(plan, { roundValidation } = {}) {
  assert(plan?.version === 1 && Array.isArray(plan.variants) && plan.variants.length >= 1 && plan.variants.length <= 100, 'declare 1..100 variants')
  assert(new Set(plan.variants.map(v => v.id)).size === plan.variants.length, 'duplicate variant ID')
  sourcePath(plan.entrypoint); assert(plan.entrypoint.endsWith('.py'), 'pipeline factory must be Python')
  assert(['kfold', 'stratified', 'group', 'time'].includes(plan.validation?.kind), 'declare training validation strategy')
  const folds = plan.validation.folds
  assert(Number.isSafeInteger(folds) && folds >= 2 && folds <= 10, 'training folds must be 2..10')
  if (['group', 'time'].includes(plan.validation.kind)) assert(typeof plan.validation.column === 'string' && plan.validation.column, 'group/time column required')
  if (roundValidation) {
    assert(folds === 5 && plan.validation.kind === roundValidation.kind && plan.validation.shuffle !== false
      && (plan.validation.seed === undefined || plan.validation.seed === roundValidation.seed)
      && !plan.validation.column, 'use the runtime-owned shuffled five-fold split; Target cannot change it')
    plan = { ...plan, validation: { kind: roundValidation.kind, folds: 5, shuffle: true, seed: roundValidation.seed } }
  }
  assert(plan.selection === 'best_mean_utility' && Number.isSafeInteger(plan.seed), 'declare selection rule and seed')
  assert(Number.isSafeInteger(plan.maxFits) && plan.maxFits >= plan.variants.length * folds + 1 && plan.refitReserve === 1,
    roundValidation ? 'fit budget must include five fits per variant and one final-refit reserve' : 'fit budget must include trials, formal fit and one delivery reserve')
  if (plan.maxFitCalls !== undefined) assert(Number.isSafeInteger(plan.maxFitCalls) && plan.maxFitCalls >= plan.maxFits, 'invalid component fit-call budget')
  for (const v of plan.variants) {
    assert(/^[A-Za-z0-9_-]+$/.test(v.id), 'invalid variant ID')
    validateConfig(v.config)
  }
  assert(Buffer.byteLength(JSON.stringify(plan)) <= 65536, 'search plan too large')
  return plan
}
export function validateConfig(config) {
  assert(config && ['inputSchema', 'preprocessing', 'features', 'model', 'hyperparameters', 'prediction', 'seed'].every(k => Object.hasOwn(config, k)), 'pipeline configuration is incomplete')
  assert(Number.isSafeInteger(config.seed) && config.model && typeof config.hyperparameters === 'object', 'invalid model configuration')
  assert(['label', 'probability', 'regression'].includes(config.prediction?.kind), 'prediction kind required')
  if (config.prediction.kind === 'probability') assert(config.prediction.positiveLabel !== undefined, 'positive probability label required')
  if (config.prediction.threshold !== undefined) assert(config.prediction.threshold >= 0 && config.prediction.threshold <= 1, 'invalid threshold')
  return config
}
export function resolvePipeline({ plan, variantId, experimentId, codeDigest, runtimeDigest, actualParameters }) {
  validateSearchPlan(plan)
  const variant = plan.variants.find(v => v.id === variantId); assert(variant, 'unregistered variant')
  return seal({ protocol: 'analysis-resolved-pipeline@1', experimentId, variantId, entrypoint: plan.entrypoint,
    actualParameters, config: variant.config, configDigest: digest(variant.config), codeDigest, runtimeDigest, trainingEntry: 'build_pipeline', fitCount: 1 })
}
export function validateResolved(value) {
  verify(value); assert(value.protocol === 'analysis-resolved-pipeline@1' && value.trainingEntry === 'build_pipeline' && value.fitCount === 1, 'not a frozen fit-only pipeline')
  validateConfig(value.config); assert(value.configDigest === digest(value.config), 'resolved configuration changed')
  assert(value.actualParameters && typeof value.actualParameters === 'object', 'actual parameter manifest required'); sourcePath(value.entrypoint); return value
}
