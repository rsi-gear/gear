import { assert, addCost, digest, mergeCheckpoints, seal, verify, zeroCost } from './contracts.mjs'
import { locked } from './store.mjs'

/** Project budget and public checkpoint survive evolution/cohort replacement. */
export class ResearchProject {
  constructor(store, project) { this.store = store; this.project = project; this.id = project.projectId }
  async reserveSequence(plan) {
    return this.reserveSequences([plan])
  }
  async reserveSequences(plans) {
    return locked(this.store.path('locks', `${this.id}-budget`), async () => {
      const ledger = await this.store.load('ledgers', this.id) ?? { sequences: {}, audit: {}, deployments: {}, meta: {}, bootstrap: {} }
      const fresh = [...new Map(plans.map(p => [p.digest, p])).values()].filter(p => !ledger.sequences[p.digest])
      assert(Object.keys(ledger.sequences).length + fresh.length <= this.project.projectLimits.maxSequences, 'project sequence limit exhausted')
      const cpu = Object.values(ledger).flatMap(Object.values).reduce((n, e) => n + e.cpuSeconds, 0)
      const wall = Object.values(ledger).flatMap(Object.values).reduce((n, e) => n + e.wallSeconds, 0)
      assert(cpu + fresh.reduce((n, p) => n + p.budget.cpuSeconds, 0) <= this.project.projectLimits.cpuSeconds
        && wall + fresh.reduce((n, p) => n + p.budget.wallSeconds, 0) <= this.project.projectLimits.wallSeconds, 'project total budget exhausted')
      for (const plan of fresh) ledger.sequences[plan.digest] = { status: 'reserved', cpuSeconds: plan.budget.cpuSeconds, wallSeconds: plan.budget.wallSeconds }
      await this.store.save('ledgers', this.id, ledger)
    })
  }
  async settleSequence(plan, receipt) {
    return locked(this.store.path('locks', `${this.id}-budget`), async () => {
      const ledger = await this.store.load('ledgers', this.id), prior = ledger.sequences[plan.digest]
      assert(prior, 'sequence not pre-registered')
      if (prior.status === 'complete') { assert(prior.receiptDigest === receipt.digest, 'completed sequence changed'); return }
      ledger.sequences[plan.digest] = { status: 'complete', cpuSeconds: receipt.cost.used.cpuSeconds,
        wallSeconds: Math.min(plan.budget.wallSeconds, Math.max(0, (Date.now() - receipt.cost.startedAt) / 1000)),
        cost: receipt.cost.used, receiptDigest: receipt.digest }
      await this.store.save('ledgers', this.id, ledger)
    })
  }
  async stage(stageId, harnesses) {
    assert(harnesses.length > 0 && new Set(harnesses.map(h => h.commit)).size === harnesses.length, 'stage harnesses must be unique')
    return locked(this.store.path('locks', `${this.id}-stage-${stageId}`), async () => {
    const head = await this.store.load('projects', this.id)
    const body = seal({ protocol: 'analysis-stage@1', projectId: this.id, stageId, checkpointRef: head.checkpoint,
      harnesses, budget: this.project.budget, auditBudget: { wallSeconds: 1500, cpuSeconds: 3000, maxAdditionalRefits: 5 },
      mergePolicy: 'all-compatible-facts@1', repetitions: 1, experiments: 5 })
    const existing = await this.store.load('stages', stageId)
    if (existing) { assert(existing.plan.digest === body.digest, 'stage is already frozen with different conditions'); return existing.plan }
    // Admission reserves every branch before any branch starts.
    const { sequencePlan } = await import('./sequence.mjs'), checkpoint = await this.store.get(head.checkpoint)
    await this.reserveSequences(harnesses.map(harness => sequencePlan({ task: this.project.task, checkpoint, harness,
      budget: this.project.budget, model: this.project.model, runtimeDigest: this.project.task.runtimeDigest })))
    await this.store.save('stages', stageId, { plan: body, status: 'planned' }); return body
    })
  }
  async merge(stageId, receipts, adoptedCommit, decisionRef) {
    const state = await this.store.load('stages', stageId); assert(state, 'stage not planned')
    if (state.status === 'complete') {
      assert(state.adoptedCommit === adoptedCommit, 'stage already completed')
      if (state.event.decisionRef.startsWith('sha256:')) assert(state.event.decisionRef === decisionRef, 'stage decision changed')
      return state.checkpointRef
    }
    const decision = await this.store.get(decisionRef)
    assert(decision.adoptedCommit === adoptedCommit, 'decision does not nominate the adopted harness')
    assert(receipts.length === state.plan.harnesses.length && new Set(receipts.map(r => r.harness.commit)).size === receipts.length
      && receipts.every(r => state.plan.harnesses.some(h => h.commit === r.harness.commit && h.manifestDigest === r.harness.manifestDigest)), 'missing or foreign stage branch')
    const base = await this.store.get(state.plan.checkpointRef)
    const branches = []
    const { sequencePlan } = await import('./sequence.mjs')
    for (const r of receipts) {
      verify(r)
      const plan = sequencePlan({ task: this.project.task, checkpoint: base, harness: r.harness,
        budget: state.plan.budget, model: this.project.model, runtimeDigest: this.project.task.runtimeDigest })
      const recorded = await this.store.load('sequences', plan.digest.slice(7))
      assert(r.startingCheckpointDigest === base.digest && r.planDigest === plan.digest && recorded?.status === 'complete'
        && recorded.receipt.digest === r.digest, 'unsealed or incompatible stage branch')
      branches.push(await this.store.get(r.checkpointRef))
    }
    const index = receipts.findIndex(r => r.harness.commit === adoptedCommit); assert(index >= 0, 'adopted harness not in stage')
    const next = mergeCheckpoints(base, branches, branches[index])
    const event = { protocol: 'analysis-stage-completion@1', planDigest: state.plan.digest, receiptDigests: receipts.map(r => r.digest),
      adoptedCommit, decisionRef, costLedger: await this.store.load('ledgers', this.id) }
    const ref = await this.store.advanceProject(this.id, state.plan.checkpointRef, next, event)
    await this.store.save('stages', stageId, { ...state, status: 'complete', adoptedCommit, checkpointRef: ref, event })
    return ref
  }
  async reserveAuxiliary(kind, id, allowance) {
    assert(['audit', 'deployments', 'meta', 'bootstrap'].includes(kind), 'invalid cost category')
    return locked(this.store.path('locks', `${this.id}-budget`), async () => {
      const ledger = await this.store.load('ledgers', this.id) ?? { sequences: {}, audit: {}, deployments: {}, meta: {}, bootstrap: {} }
      if (ledger[kind][id]) return
      const entries = Object.values(ledger).flatMap(Object.values)
      assert(entries.reduce((n, e) => n + e.cpuSeconds, 0) + allowance.cpuSeconds <= this.project.projectLimits.cpuSeconds
        && entries.reduce((n, e) => n + e.wallSeconds, 0) + allowance.wallSeconds <= this.project.projectLimits.wallSeconds, 'project auxiliary budget exhausted')
      ledger[kind][id] = { status: 'reserved', ...allowance }; await this.store.save('ledgers', this.id, ledger)
    })
  }
  async settleAuxiliary(kind, id, value) {
    return locked(this.store.path('locks', `${this.id}-budget`), async () => {
      const ledger = await this.store.load('ledgers', this.id); assert(ledger[kind][id], 'missing auxiliary reservation')
      if (ledger[kind][id].status === 'complete') { assert(digest(ledger[kind][id].result) === digest(value), 'auxiliary result changed'); return }
      ledger[kind][id] = { status: 'complete', cpuSeconds: value.cost.cpuSeconds, wallSeconds: value.wallSeconds, result: value }
      await this.store.save('ledgers', this.id, ledger)
    })
}
}
