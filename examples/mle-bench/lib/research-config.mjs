/** Admission settings, never editable harness resources. */
export const defaultResearchConfig = Object.freeze({
  maxExperiments: 5,
  validation: Object.freeze({ fraction: 0.2, seed: 42 }),
})

export function researchConfig(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(k => !['maxExperiments', 'validation'].includes(k))) throw new Error('invalid research configuration')
  const supplied = value.validation ?? {}
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)
    || Object.keys(supplied).some(k => !['fraction', 'seed'].includes(k))) throw new Error('invalid validation configuration')
  const result = { maxExperiments: value.maxExperiments ?? defaultResearchConfig.maxExperiments,
    validation: { ...defaultResearchConfig.validation, ...supplied } }
  if (!Number.isSafeInteger(result.maxExperiments) || result.maxExperiments < 1) throw new Error('maxExperiments must be a positive integer')
  const { fraction, seed } = result.validation
  if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction <= 0 || fraction >= 1
    || !Number.isSafeInteger(seed) || seed < 0) throw new Error('invalid validation fraction or seed')
  return result
}

export function experimentBudget(request) {
  const total = request.maxExperiments ?? defaultResearchConfig.maxExperiments
  return { current: request.slotIndex, total, remaining: total - request.slotIndex,
    includingCurrent: total - request.slotIndex + 1 }
}
