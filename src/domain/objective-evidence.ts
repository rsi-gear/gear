import { validateAssertionEvidence } from './assertion-evidence.js'
import type { Evidence, RawMetricValue } from './algorithm-wire.js'
import type { RunSpec } from './run.js'
import { canonicalDigest } from './canonical.js'
import { GearError } from './errors.js'
import { validateVerifierEvidence } from './verifier-evidence.js'

/** Bind declared measurement semantics; objective weights never enter raw identity. */
export function bindRawMetrics(cell: Evidence, spec: RunSpec, candidateDigest: string): Evidence {
  validateAssertionEvidence(cell, spec.objective?.assertions ?? [])
  validateVerifierEvidence(cell)
  if (!spec.objective) return cell
  const contracts = spec.objective.metrics
  const values: Record<string, RawMetricValue> = structuredClone(cell.raw_metrics ?? {})
  for (const [id, value] of Object.entries(values)) {
    const contract = contracts.find((item) => item.id === id)
    if (
      !contract ||
      value.contractDigest !== contract.digest ||
      value.unit !== contract.unit ||
      value.evidenceRefs.some((ref) => !/^sha256:[a-f0-9]{64}$/u.test(ref)) ||
      (value.status !== 'available' && value.value !== undefined) ||
      (value.status === 'available' &&
        (!value.evidenceRefs.length ||
          typeof value.value !== 'number' ||
          !Number.isFinite(value.value) ||
          (contract.range && (value.value < contract.range.min || value.value > contract.range.max))))
    )
      throw new GearError(
        'raw-metric-contract-mismatch',
        'Raw metric does not match its frozen measurement contract',
      )
    if (['scoring_failed', 'environment_failed'].includes(cell.status) && value.status === 'available')
      throw new GearError('uncertified-raw-metric', 'An invalid trial cannot supply available raw metrics')
  }
  const pass = contracts.find((item) => item.id === 'pass_rate')!
  const available = ['valid', 'task_failed'].includes(cell.status)
  const value = cell.score === 1 ? 1 : 0
  if (
    (values.pass_rate && (values.pass_rate.status === 'available') !== available) ||
    (values.pass_rate?.status === 'available' && values.pass_rate.value !== value)
  )
    throw new GearError('pass-predicate-mismatch', 'pass_rate must use the frozen complete-pass predicate')
  values.pass_rate = {
    contractDigest: pass.digest,
    unit: pass.unit,
    status: available ? 'available' : 'invalid',
    ...(available ? { value } : { reason: 'original observation is not certified' }),
    evidenceRefs: [
      canonicalDigest({
        benchmark: spec.benchmarkDigest,
        provider: spec.evaluationIdentity ?? spec.providerIdentity,
        candidate: candidateDigest,
        task: cell.task_id,
        repetition: cell.repetition,
        score: cell.score,
        status: cell.status,
      }),
    ],
  }
  return { ...cell, raw_metrics: values }
}
