import type { Evidence } from './algorithm-wire.js'
import type { RunSpec } from './run.js'
import { GearError } from './errors.js'
import { validateAlgorithmWire } from './algorithm-schema.js'
import { bindRawMetrics } from './objective-evidence.js'

/** Verified seed observations copied at admission; their historical cost is never a new charge. */
export interface BaselineReuse {
  version: 1
  sourceRunId: string
  sourceCandidateId: string
  sourceJournalDigest: string
  sourceDigest: string
  evidence: Evidence[]
  historicalUsage: Record<string, number | null>
  historicalPhysicalAttempts: number
}

export function validateBaseline(spec: RunSpec): void {
  const baseline = spec.baseline
  if (!baseline) return
  const seen = new Set<string>()
  if (
    spec.kind !== 'refine' ||
    baseline.version !== 1 ||
    !baseline.sourceCandidateId ||
    !/^run_[a-f0-9]{32}$/u.test(baseline.sourceRunId) ||
    ![baseline.sourceDigest, baseline.sourceJournalDigest].every((value) =>
      /^sha256:[a-f0-9]{64}$/u.test(value),
    ) ||
    !Array.isArray(baseline.evidence) ||
    !baseline.evidence.length ||
    !Number.isSafeInteger(baseline.historicalPhysicalAttempts) ||
    baseline.historicalPhysicalAttempts < baseline.evidence.length ||
    !baseline.historicalUsage ||
    typeof baseline.historicalUsage !== 'object' ||
    Array.isArray(baseline.historicalUsage) ||
    Object.values(baseline.historicalUsage).some(
      (value) => value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0),
    )
  )
    throw new GearError('invalid-baseline-reuse', 'Invalid frozen baseline provenance')
  for (const cell of baseline.evidence) {
    validateAlgorithmWire('Evidence', cell)
    const key = JSON.stringify([cell.task_id, cell.repetition])
    if (
      cell.candidate_id !== spec.anchor.id ||
      cell.scope !== 'global' ||
      cell.score === null ||
      !['valid', 'task_failed'].includes(cell.status) ||
      !spec.seedTasks.some((task) => task.id === cell.task_id) ||
      cell.repetition >= spec.budget.repetitions ||
      seen.has(key)
    )
      throw new GearError(
        'invalid-baseline-reuse',
        'Baseline may only reuse distinct valid seed slots for the frozen Target',
      )
    seen.add(key)
    bindRawMetrics(cell, spec, spec.anchor.digest)
  }
}
