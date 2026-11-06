import type { Evidence } from './algorithm-wire.js'
import { GearError } from './errors.js'

/** Fixed protocol invariants; provider-specific parsing and diagnosis live in Python. */
export function validateVerifierEvidence(cell: Evidence): void {
  const value = cell.verifier
  if (!value) return
  const fail = () => {
    throw new GearError(
      'invalid-verifier-evidence',
      'Verifier observation violates its certified trial or bounded evidence contract',
    )
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 16 * 1024) fail()
  if (value.status !== 'available') {
    if (
      value.reason === null ||
      value.primary_score !== null ||
      value.result_digest !== null ||
      value.detail_status !== null ||
      value.process !== null ||
      value.feedback.length ||
      value.failure_codes.length ||
      value.omitted_feedback ||
      value.omitted_failure_codes
    )
      fail()
    return
  }
  if (
    !['valid', 'task_failed'].includes(cell.status) ||
    value.primary_score !== cell.score ||
    !value.source_digest ||
    !value.result_digest ||
    !value.detail_status ||
    value.reason !== null ||
    new Set(value.failure_codes).size !== value.failure_codes.length
  )
    fail()
  const process = value.process
  if (!process) return
  if (
    new Set(process.components.map((item) => item.id)).size !== process.components.length ||
    process.components.some(
      (item) =>
        !Number.isFinite(item.weight) ||
        item.weight <= 0 ||
        (item.public_details !== null && Buffer.byteLength(JSON.stringify(item.public_details)) > 256),
    )
  )
    fail()
  if (process.detail_status === 'aggregate-only') {
    if (
      process.passed !== null ||
      process.total !== null ||
      process.excluded !== null ||
      process.components.length ||
      process.omitted_components
    )
      fail()
  } else if (
    process.passed === null ||
    process.total === null ||
    process.excluded === null ||
    process.passed > process.total ||
    process.components.length + process.omitted_components !== process.total + process.excluded ||
    process.components.filter((item) => item.status === 'passed').length > process.passed ||
    process.components.filter((item) => item.status !== 'excluded').length > process.total ||
    process.components.filter((item) => item.status === 'excluded').length > process.excluded
  )
    fail()
}
