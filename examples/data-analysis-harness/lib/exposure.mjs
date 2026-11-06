import { assert, digest, seal, verify } from './contracts.mjs'
import { locked } from './store.mjs'

/** Use one controller-owned registry across projects. Aliases do not reset exposure. */
export class ExposureLedger {
  constructor(store) { this.store = store }
  async freeze({ suiteDigest, sourceDigests, taskFamilyIds, finalist, reference, budgetDigest, provenanceVerified }) {
    assert(sourceDigests.length > 0 && sourceDigests.length === taskFamilyIds.length, 'source provenance required')
    const prior = await Promise.all(sourceDigests.map(d => this.store.load('exposures', d.replace(/^sha256:/, ''))))
    const plan = seal({ protocol: 'analysis-transfer-plan@1', suiteDigest, sourceDigests, taskFamilyIds, finalist, reference, budgetDigest,
      exposure: !provenanceVerified ? 'exposure_unknown' : prior.some(Boolean) ? 'already_exposed' : 'untouched',
      frozenAt: new Date().toISOString() })
    await this.store.put(plan); return plan
  }
  async disclose(plan, reportDigest) {
    verify(plan)
    return locked(this.store.path('locks', 'exposure-registry'), async () => {
      const event = seal({ protocol: 'analysis-transfer-exposure@1', planDigest: plan.digest, suiteDigest: plan.suiteDigest,
        sourceDigests: plan.sourceDigests, taskFamilyIds: plan.taskFamilyIds, finalist: plan.finalist,
        reportDigest, disclosedAt: new Date().toISOString() })
      const eventRef = await this.store.put(event)
      for (const source of plan.sourceDigests) {
        const id = source.replace(/^sha256:/, ''), prior = await this.store.load('exposures', id)
        await this.store.save('exposures', id, { first: prior?.first ?? eventRef, events: [...(prior?.events ?? []), eventRef] })
      }
      return event
    })
  }
}
