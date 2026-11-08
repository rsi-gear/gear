import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { assert, digest, sha, seal, verify } from './contracts.mjs'
import { Store, json, locked } from './store.mjs'
import { HitchBackend } from './hitch-backend.mjs'
import { ResearchProject } from './project.mjs'
import { SequenceRunner, sequencePlan } from './sequence.mjs'
import { carrierForTarget, copyRegisteredTarget } from './target-source.mjs'
import { internalScore, internalQuality, metricName } from './metrics.mjs'
import { experimentValidationDigest } from './validation.mjs'
import { HitchArtifactReader } from '../../../lib/adapters/hitch/trajectory.js'

export const objective = { terms: [{ metric: 'total_score', weight: 1 }], constraints: [{ metric: 'valid_output', rule: 'minimum', value: 1 }] }
export function metrics(task) {
  return ['total_score', 'valid_output', 'task_score', 'completed'].map(id => ({ id,
    revision: 'analysis-research-sequence@1', unit: id === 'task_score' ? metricName(task) : 'ratio',
    direction: id === 'task_score' && metricName(task) === 'mean-column-wise-rmsle' ? 'minimize' : 'maximize',
    source: { path: `scores.${id}`, extractor: 'number-v1' },
    ...(id === 'task_score' && metricName(task) === 'mean-column-wise-rmsle' ? {} : { range: { min: 0, max: 1 } }),
    granularity: 'trial', repetitionReducer: 'mean', taskReducer: 'weighted-mean', comparisonPrecision: 1e-9 }))
}
export async function implementationDigest() {
  const names = ['operation-provider.mjs', 'target-source.mjs', 'sequence.mjs', 'contracts.mjs', 'schemas.mjs', 'metrics.mjs',
    'store.mjs', 'budget.mjs', 'research-config.mjs', 'validation.mjs', 'pipeline.mjs', 'records.mjs', 'workflow.mjs', 'deadline.mjs', 'hitch-backend.mjs', 'project.mjs', 'common.mjs', '../provider.mjs', '../prepare.mjs',
    '../target-carrier/fixed/check.mjs', '../target-carrier/fixed/integrity.mjs', '../../../lib/adapters/hitch/run-artifacts.js']
  return digest(Object.fromEntries(await Promise.all(names.map(async name => [name, sha(await readFile(new URL(name, import.meta.url)))]))))
}

/** Public OperationProvider protocol: one seed slot evaluates one complete budgeted research sequence. */
export class AnalysisOperationProvider {
  static async open(configuration, context) {
    const project = await json(join(configuration.project, 'project.json'))
    assert(digest(project) === configuration.projectDigest, 'research project changed since admission')
    const store = new Store(join(configuration.project, 'research'))
    const checkpoint = await store.get(configuration.checkpointRef)
    verify(checkpoint)
    return new AnalysisOperationProvider(store, new HitchBackend(store, project.backend), project, checkpoint, configuration, context)
  }
  constructor(store, backend, project, checkpoint, configuration, context) {
    Object.assign(this, { store, backend, project, checkpoint, configuration, context })
    this.controller = new ResearchProject(store, project)
    if (project.backend?.executorExecutable && project.backend?.root)
      this.trajectoryReader = new HitchArtifactReader(project.backend.executorExecutable, project.backend.root)
    this.capabilities = { seeds: false, temperature: false, subsets: true, idempotentSubmission: true, inspect: true,
      cancel: true, physicalAttemptAccounting: true, hardDollarBudget: false, generationBudget: false, evidenceProjection: false }
  }
  async describe() {
    return { version: 1, identity: digest({ implementation: await implementationDigest(), project: digest(this.project),
      checkpoint: this.checkpoint.digest, registered: this.configuration.registered }), capabilities: this.capabilities,
      ...(this.trajectoryReader ? { artifactReader: this.trajectoryReader.descriptor } : {}) }
  }
  key(request) {
    assert(/^sha256:[a-f0-9]{64}$/.test(request.operationId), 'invalid operation identity')
    assert(request.runId === this.context.runId && request.partition === 'seed' && request.repetitions === 1,
      'analysis requires one seed repetition; held-out executions are forbidden')
    assert(!request.repair && !request.projection && !request.generationLimits, 'sequence budget cannot be reset by repair or projection')
    return request.operationId.slice(7)
  }
  async allowed(key) {
    assert(!await this.store.load('operation-cancellations', key), 'operation cancelled')
  }
  async verifyRecord(record, request) {
    verify(record)
    assert(record.requestDigest === digest(request), 'operation request changed')
    if (record.sequence) {
      verify(record.sequence)
      assert(record.sequence.startingCheckpointDigest === this.checkpoint.digest, 'checkpoint changed')
      const harness = await carrierForTarget(this.store, this.project, join(this.context.targets, request.operation.candidate_id), this.configuration.registered)
      assert(digest(harness) === digest(record.sequence.harness), 'target resources changed')
      await this.backend.admit(this.plan(harness))
      await this.backend.verifyReceipt(record.sequence)
    }
    return record.receipt
  }
  plan(harness) { return sequencePlan({ task: this.project.task, checkpoint: this.checkpoint, harness,
    model: this.project.model, budget: this.project.budget, research: this.project.research, runtimeDigest: this.project.task.runtimeDigest }) }
  async inspect(request) {
    const key = this.key(request), record = await this.store.load('operations', key)
    if (!record) return { state: 'not_submitted' }
    assert(record.requestDigest === digest(request), 'operation request changed')
    if (record.receipt) return { state: 'complete', receipt: await this.verifyRecord(record, request) }
    const lock = await stat(this.store.path('locks', `operation-${key}`)).catch(e => { if (e.code !== 'ENOENT') throw e; return null })
    if (lock) return { state: 'unknown' }
    // SequenceRunner retains its pending request and original wall/CPU reservation.
    // Hitch inspects that exact eval ID; only proof of non-admission permits its
    // idempotent submission. Recovery cannot replace it with a fresh experiment.
    return { state: request.operation.kind === 'evaluate_seed' ? 'resumable' : 'unknown' }
  }
  async cancel(request) {
    const key = this.key(request)
    await this.store.save('operation-cancellations', key, { requestDigest: digest(request) })
    const record = await this.store.load('operations', key)
    if (record?.plan) {
      const sequence = await this.store.load('sequences', record.plan.digest.slice(7))
      if (sequence?.pending) await this.backend.cancel(sequence.pending.request)
    }
    // The durable fence prevents a future start. A live/abandoned owner lock must
    // be resolved before claiming that an already admitted sequence has stopped.
    const owner = await stat(this.store.path('locks', `operation-${key}`)).catch(e => { if (e.code !== 'ENOENT') throw e; return null })
    return { cancelled: !owner }
  }
  async submit(request, signal = new AbortController().signal) {
    const key = this.key(request)
    return locked(this.store.path('locks', `operation-${key}`), async () => {
      await this.allowed(key); signal.throwIfAborted()
      const previous = await this.store.load('operations', key)
      if (previous) {
        assert(previous.requestDigest === digest(request), 'operation request changed')
        if (previous.receipt) return this.verifyRecord(previous, request)
      }
      const record = previous ?? { requestDigest: digest(request) }
      await this.store.save('operations', key, record)
      const operation = request.operation
      let sequence = null, candidate = null, evidence = [], data = null, artifacts = []
      if (operation.kind === 'evaluate_seed') {
        assert(request.slots.length === 1 && request.slots[0].taskId === this.project.task.taskId && request.slots[0].repetition === 0,
          'one task and one sequential research sequence required')
        const harness = await carrierForTarget(this.store, this.project, join(this.context.targets, operation.candidate_id), this.configuration.registered)
        const plan = this.plan(harness)
        assert(!record.plan || record.plan.digest === plan.digest, 'frozen sequence changed')
        record.plan = plan; await this.store.save('operations', key, record)
        await this.controller.reserveSequence(plan)
        const backend = this.backend, allowed = () => this.allowed(key)
        const guarded = Object.create(backend)
        for (const method of ['admit', 'rollout', 'deliver', 'recover'].filter(method => typeof backend[method] === 'function')) guarded[method] = async (...args) => {
          await allowed(); signal.throwIfAborted(); return backend[method](...args)
        }
        sequence = await new SequenceRunner(this.store, guarded).run(plan, this.checkpoint, { signal })
        await backend.verifyReceipt(sequence)
        await this.controller.settleSequence(plan, sequence)
        const state = await this.store.load('sequences', plan.digest.slice(7))
        if (this.trajectoryReader) for (const step of state.steps)
          artifacts.push(await this.trajectoryReader.capture(step.runId, this.project.task.taskId, 0, signal))
        const summary = state.steps.map(step => ({ slot: step.experiment.slotIndex, operator: step.experiment.operator,
          status: step.experiment.execution.status, hypothesis: step.experiment.claim.hypothesis.slice(0, 1000),
          validationPlanDigest: experimentValidationDigest(step.experiment),
          ...(step.experiment.analysis?.validation ? { foldMetrics: step.experiment.execution.foldMetrics,
            stdScore: step.experiment.execution.stdScore, evaluationKind: 'round_five_fold_cv' } : {}),
          internalScore: internalScore(step.experiment), utility: internalQuality(step.experiment),
          selected: step.selectedSolutionDigest, interpretation: step.experiment.interpretation }))
        const scores = { total_score: sequence.total_score, valid_output: sequence.valid_output, completed: sequence.completed,
          task_score: sequence.delivery.score ?? sequence.delivery.accuracy ?? null }
        const raw_metrics = Object.fromEntries((request.metrics ?? []).filter(c => c.id in scores).map(c => [c.id,
          { contractDigest: c.digest, unit: c.unit, status: scores[c.id] === null ? 'missing' : 'available',
            ...(scores[c.id] === null ? { reason: 'selected result unavailable' } : { value: scores[c.id] }), evidenceRefs: [sequence.digest] }]))
        evidence = [{ candidate_id: operation.candidate_id, task_id: this.project.task.taskId, repetition: 0,
          score: sequence.total_score, status: 'valid', scope: operation.scope, raw_metrics,
          feedback: `Development evidence. ${sequence.planned} experiment slots at checkpoint ${this.checkpoint.digest}. Selected result=${sequence.total_score}. `
            + `Do not treat research validation as external reward or claim task transfer. ${JSON.stringify(summary).slice(0, 20000)}` }]
      } else {
        assert(this.configuration.registered.length === 2 && request.evidence.length > 0,
          'registered comparison requires actual seed evidence; autonomous authoring uses the configured Meta profile')
        assert(request.evidence.every(e => e.task_id === this.project.task.taskId), 'foreign seed evidence')
        if (operation.kind === 'diagnose_seed') data = { hypotheses: ['Compare the pre-registered research method under the identical checkpoint and admitted experiment budget.'] }
        else {
          assert(operation.kind === 'generate_candidate' && operation.parent_id === 'anchor', 'unexpected registered proposal')
          await copyRegisteredTarget(this.project.targetRepository, this.configuration.registered[1], join(this.context.targets, operation.candidate_id))
          candidate = { id: operation.candidate_id, parent_id: operation.parent_id, digest: digest(this.configuration.registered[1]) }
        }
      }
      const receipt = { result: { operation_id: request.operationId, kind: operation.kind, status: 'complete',
        candidate_id: operation.candidate_id, data }, candidate, evidence,
        ...(this.trajectoryReader ? { artifacts } : {}), physicalAttempts: sequence ? 1 : 0,
        usage: sequence ? { model_requests: sequence.cost.used.requests, tokens: sequence.cost.used.tokens,
          analysis_rollouts: sequence.attempted, analysis_deliveries: sequence.delivery.protocol === 'analysis-cv-selection@1' ? 0 : sequence.delivery.runId ? 1 : 0, cpu_seconds: sequence.cost.used.cpuSeconds }
          : { model_requests: 0, tokens: 0 },
        provenance: { protocol: 'analysis-operation@1', attempt_unit: 'research-sequence', checkpoint: this.checkpoint.digest,
          sequence: sequence?.digest ?? null, plan: record.plan?.digest ?? null, harness: sequence?.harness ?? null,
          authoring: this.configuration.registered.length === 2 ? 'pre-registered; no autonomous Meta generation claimed' : 'configured Meta profile' } }
      await this.store.save('operations', key, seal({ ...record, receipt, sequence }))
      return receipt
    })
  }
}
