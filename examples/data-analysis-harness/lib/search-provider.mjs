import { readFile } from 'node:fs/promises'
import { assert, digest, seal, sha, verify } from './contracts.mjs'
import { sequencePlan, SequenceRunner } from './sequence.mjs'
import { resolveMetric, resolveObjective } from '../../../lib/objective/contracts.js'
import { cellKey } from '../../../lib/search/evidence.js'
import { metricName, internalScore, internalQuality } from './metrics.mjs'

export const objective = { terms: [{ metric: 'total_score', weight: 1 }], constraints: [{ metric: 'valid_output', rule: 'minimum', value: 1 }] }

/** One Gear cell is a whole five-experiment sequence, with repetitions=1. */
export class AnalysisSearchProvider {
  constructor(store, backend, project, checkpoint, { reserveSequence = async () => {}, settleSequence = async () => {} } = {}) {
    Object.assign(this, { store, backend, project, checkpoint, reserveSequence, settleSequence })
    this.capabilities = { taskSubsetPlans: true, batchIndependentCells: true, idempotentExecution: true, objectives: 1 }
    this.integrity = digest({ implementation: 'analysis-five-rollout@1', revision: 1, runtime: project.runtime,
      checkpoint: checkpoint.digest, model: project.model, budget: project.budget, executionBindingDigest: backend.bindingDigest ?? null })
    this.raw = ['total_score', 'valid_output', project.task.protocol === 'analysis-task@2' ? 'task_score' : 'accuracy', 'completed'].map(id => resolveMetric({ id,
      revision: 'analysis-five-rollout@1', unit: id === 'task_score' ? metricName(project.task) : 'ratio',
      direction: id === 'task_score' && metricName(project.task) === 'mean-column-wise-rmsle' ? 'minimize' : 'maximize', source: { path: `scores.${id}`, extractor: 'number-v1' },
      ...(id === 'task_score' && metricName(project.task) === 'mean-column-wise-rmsle' ? {} : { range: { min: 0, max: 1 } }),
      granularity: 'trial', repetitionReducer: 'mean', taskReducer: 'weighted-mean', comparisonPrecision: 1e-9 }))
    this.conditionDigest = digest({ provider: this.integrity, task: project.task.digest, checkpoint: checkpoint.digest, repetitions: 1 })
    this.task = { id: project.task.taskId, contentDigest: digest({ task: project.task.digest, checkpoint: checkpoint.digest }),
      outcome: seal({ id: 'total_score', revision: 'analysis-five-rollout@1', channel: 'outcome', evidenceKind: 'final-outcome', granularity: 'trial',
        direction: 'maximize', range: { min: 0, max: 1 }, comparisonQuantum: 1e-9, repetitionReducer: 'mean',
        applicableTaskSetDigest: digest([digest({ task: project.task.digest, checkpoint: checkpoint.digest })]), group: metricName(project.task) }), successUtility: 1, weight: 1,
      stratum: project.task.taskFamilyId, estimatedCost: project.budget.wallSeconds }
    this.verifySeedPromotionReuse = async () => {
      await this.store.verifySources(this.checkpoint)
      assert(this.checkpoint.baseTaskDigest === this.project.task.digest, 'shared-set task changed')
      await this.backend.admit(this.plan(this.project.harness))
    }
    this.diagnosis = { integrity: digest('analysis-evidence-diagnosis@1'), sanitizationPolicyDigest: digest('internal-facts-plus-seed-C5@1'),
      diagnose: input => this.diagnose(input) }
  }
  async describe(partition) {
    return seal({ partition, tasks: [this.task], conditionDigest: this.conditionDigest, repetitions: [{ index: 0, seed: null }],
      rawMetricContracts: this.raw, objective: resolveObjective(objective, this.raw) })
  }
  plan(harness) { return sequencePlan({ task: this.project.task, checkpoint: this.checkpoint, harness,
    model: this.project.model, budget: this.project.budget, runtimeDigest: this.project.task.runtimeDigest }) }
  async evaluate(input) {
    assert(input.plan.partition === 'seed', 'shared-set protocol must reuse seed evidence, not launch held-out runs')
    const result = []
    for (const identity of input.cells) {
      assert(identity.taskId === this.task.id && identity.taskContentDigest === this.task.contentDigest
        && identity.repetition === 0 && identity.conditionDigest === this.conditionDigest, 'cell outside frozen sequence conditions')
      const key = cellKey(identity).slice(7), cached = await this.store.load('cells', key)
      if (cached) { assert(await this.verifyCell(cached.cell, identity), 'cached sequence evidence unavailable'); result.push(cached.cell); continue }
      const plan = this.plan({ commit: input.snapshot.commit, manifestDigest: input.snapshot.manifestDigest })
      await this.reserveSequence(plan)
      const receipt = await new SequenceRunner(this.store, this.backend).run(plan, this.checkpoint, { signal: input.signal })
      await this.backend.verifyReceipt(receipt)
      await this.settleSequence(plan, receipt)
      // Expose a real research child as the bounded trajectory entry point.
      // The separate receipt retains every child and the actual delivery run.
      const evidenceRef = receipt.steps.at(-1)?.runId ?? receipt.delivery.runId ?? `sequence_${plan.digest.slice(7)}`
      const rawMetrics = seal({ schemaVersion: 1, kind: 'raw-metrics', taskId: identity.taskId, repetition: 0, runId: evidenceRef,
        attempt: 1, harnessCommit: identity.harnessCommit, conditionDigest: identity.conditionDigest,
        originalArtifactRefs: [receipt.digest, ...receipt.steps.map(s => s.outputManifestDigest)],
        metrics: Object.fromEntries(this.raw.map(c => {
          const value = (c.id === 'accuracy' ? receipt.delivery.accuracy : c.id === 'task_score' ? receipt.delivery.score : receipt[c.id]) ?? null
          return [c.id, { contractDigest: c.digest, unit: c.unit, status: value === null ? 'missing' : 'available',
            ...(value === null ? { reason: 'actual delivery has no metric score' } : { value }), evidenceRefs: [receipt.digest] }]
        })) })
      const cell = seal({ identity, status: 'available', envelope: 'score-envelope-v2', outcomeCertified: true, evidenceRef,
        outcome: { status: 'available', rawValue: receipt.total_score, contractDigest: this.task.outcome.digest, evidenceRef },
        rawMetrics, completedAt: new Date().toISOString() })
      const record = { cell, receipt, plan, partition: 'seed' }
      await this.store.save('cells', key, record)
      await this.store.save('seed-runs', evidenceRef, { cellKey: key, childRuns: receipt.steps.map(s => s.runId) })
      result.push(cell)
    }
    return result
  }
  async verifyCell(cell, identity) {
    try {
      verify(cell)
      assert(cellKey(cell.identity) === cellKey(identity) && identity.conditionDigest === this.conditionDigest
        && identity.taskContentDigest === this.task.contentDigest, 'cell identity changed')
      const stored = await this.store.load('cells', cellKey(identity).slice(7))
      assert(stored?.cell.digest === cell.digest && stored.plan.startingCheckpointDigest === this.checkpoint.digest
        && stored.plan.harness.commit === identity.harnessCommit && stored.plan.harness.manifestDigest === identity.harnessManifestDigest, 'sequence provenance mismatch')
      return await this.backend.verifyReceipt(stored.receipt)
    } catch { return false }
  }
  async inspectEvaluation(input) {
    const cells = []
    for (const identity of input.cells) {
      const stored = await this.store.load('cells', cellKey(identity).slice(7))
      if (stored) { if (!await this.verifyCell(stored.cell, identity)) return { status: 'unknown', reason: 'required artifacts unavailable' }; cells.push(stored.cell); continue }
      const plan = this.plan({ commit: input.snapshot.commit, manifestDigest: input.snapshot.manifestDigest })
      const state = await this.store.load('sequences', plan.digest.slice(7))
      if (state) return { status: 'unknown', reason: 'sequence has durable state; use explicit controller recovery, never resample' }
    }
    return cells.length === input.cells.length ? { status: 'complete', result: { cells } }
      : cells.length ? { status: 'partially-complete', cells } : { status: 'not-started' }
  }
  async diagnose(input) {
    assert(input.universe.partition === 'seed', 'diagnosis is seed-only')
    const facts = []
    for (const cell of input.cells) {
      assert(await this.verifyCell(cell, cell.identity), 'unavailable seed evidence')
      const { receipt, plan } = await this.store.load('cells', cellKey(cell.identity).slice(7))
      const state = await this.store.load('sequences', plan.digest.slice(7))
      const summary = state.steps.map(s => ({ slot: s.experiment.slotIndex, run: s.runId,
        operator: s.experiment.operator, status: s.experiment.execution.status, hypothesis: s.experiment.claim.hypothesis.slice(0, 1000),
        metric: s.experiment.execution.metric ?? 'accuracy', internalScore: internalScore(s.experiment), utility: internalQuality(s.experiment), selected: s.selectedSolutionDigest,
        interpretation: s.experiment.interpretation }))
      facts.push({ taskId: cell.identity.taskId, evidenceRefs: [cell.evidenceRef], status: 'supported-hypothesis',
        familyId: 'analysis-research-method', modificationPaths: ['prompts', 'skills', 'workflows/research'],
        hypothesis: `Investigate the research/selection mechanism at the same checkpoint. Actual C5=${receipt.total_score}; planned=5, attempted=${receipt.attempted}. Internal observations: ${JSON.stringify(summary).slice(0, 10000)}`,
        mechanism: 'Use experiment failures, hypotheses and internal evidence to improve a general method; a single task does not establish generalization.',
        submode: 'analysis-five-rollout' })
    }
    return { facts, inputTokens: 0, outputTokens: 0 }
  }
}

/** Hash implementation bytes, not just a version string, into the provider identity. */
export async function implementationDigest() {
  const names = ['search-provider.mjs', 'sequence.mjs', 'contracts.mjs', 'schemas.mjs', 'metrics.mjs', 'store.mjs', 'budget.mjs', 'hitch-backend.mjs', 'project.mjs']
  return digest(Object.fromEntries(await Promise.all(names.map(async n => [n, sha(await readFile(new URL(n, import.meta.url)))]))))
}
