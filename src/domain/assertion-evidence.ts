import type { Evidence } from './algorithm-wire.js'
import type { AssertionContract } from './assertions.js'
import { GearError } from './errors.js'

/** The provider cannot change the meaning or provenance of a frozen assertion. */
export function validateAssertionEvidence(cell: Evidence, contracts: AssertionContract[]): void {
  const seen = new Set<string>()
  for (const value of cell.assertions ?? []) {
    const contract = contracts.find((item) => item.id === value.id)
    if (
      !contract ||
      seen.has(value.id) ||
      value.schemaDigest !== contract.digest ||
      value.evidenceRefs.some((ref) => !/^sha256:[a-f0-9]{64}$/u.test(ref)) ||
      (['passed', 'failed', 'excluded'].includes(value.status) &&
        (!value.evidenceRefs.length || !['valid', 'task_failed'].includes(cell.status)))
    )
      throw new GearError(
        'assertion-contract-mismatch',
        'Assertion identity or provenance does not match its frozen contract',
      )
    seen.add(value.id)
  }
}
