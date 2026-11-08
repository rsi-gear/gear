import { assert, clone, cost, digest, dimensions, seal, validateBudget, validateCheckpoint, validateExperiment, validateSolution, validCandidate, verify, advance, PROTOCOL } from './contracts.mjs'
import { Budget } from './budget.mjs'
import { locked } from './store.mjs'
import { validateSchema } from './schemas.mjs'
import { internalScore, internalQuality, metricName, utility } from './metrics.mjs'
import { roundValidation, requestValidationDigest, experimentValidationDigest, isRoundCvTask, cvSelection } from './validation.mjs'

export function sequencePlan({ task, checkpoint, harness, model, budget, runtimeDigest }) {
  validateCheckpoint(checkpoint); validateBudget(budget)
  validateSchema('Task', task); verify(task)
  assert(runtimeDigest === task.runtimeDigest && runtimeDigest === checkpoint.runtimeDigest, 'sequence runtime mismatch')
  assert(/^[a-f0-9]{40,64}$/.test(harness.commit), 'exact harness commit required')
  assert(task.taskFamilyId === checkpoint.taskFamilyId && task.digest === checkpoint.baseTaskDigest, 'task/checkpoint mismatch')
  const validation = roundValidation(task, checkpoint.digest)
  return validateSchema('SequencePlan', seal({ protocol: PROTOCOL, task, startingCheckpointDigest: checkpoint.digest,
    ...(validation ? { roundValidation: validation } : {}),
    harness, model, budget, runtimeDigest, experiments: 5, repetitions: 1 }))
}

function remainingPool(start, steps, checkpoint, validationDigest) {
  const allowed = new Set([start.currentSolutionDigest, ...steps.map(s => s.experiment.sourceDigest)].filter(Boolean))
  return checkpoint.history.filter(e => allowed.has(e.sourceDigest) && validCandidate(e) && experimentValidationDigest(e) === validationDigest)
}
export function validateRollout(result, request, checkpoint, steps, start) {
  verify(result)
  assert(result.protocol === 'analysis-rollout-receipt@1' && result.requestDigest === request.digest, 'rollout receipt is not bound to request')
  assert(typeof result.runId === 'string' && result.runId.length > 0 && result.outputManifestDigest, 'missing physical run or output manifest')
  const e = validateExperiment(result.experiment)
  assert(e.validationPlanDigest === request.task.validationPlanDigest, 'experiment validation scope changed')
  assert(isRoundCvTask(request.task) ? e.protocol === 'analysis-experiment@5' && e.execution.metric === request.task.prediction.metric
    && experimentValidationDigest(e) === requestValidationDigest(request)
    : ['analysis-task@3', 'analysis-task@4'].includes(request.task.protocol) ? ['analysis-experiment@3', 'analysis-experiment@4'].includes(e.protocol) && e.execution.metric === request.task.prediction.metric
    : request.task.protocol === 'analysis-task@2' ? e.protocol === 'analysis-experiment@2' && e.execution.metric === request.task.prediction.metric
    : e.protocol === 'analysis-experiment@1', 'experiment metric contract changed')
  assert(e.sequenceId === request.sequenceId && e.slotIndex === request.slotIndex && e.rolloutRunId === result.runId, 'experiment run/slot mismatch')
  for (const s of result.solutions) { validateSolution(s); assert(s.runtimeDigest === request.runtimeDigest, 'solution runtime mismatch') }
  assert(result.solutions.every(s => s.digest === e.sourceDigest), 'unregistered source in rollout')
  assert(!e.sourceDigest || [...checkpoint.solutions, ...result.solutions].some(s => s.digest === e.sourceDigest), 'experiment source absent')
  assert(e.parentExperimentId === null || checkpoint.history.some(p => p.experimentId === e.parentExperimentId), 'parent outside visible history')
  if (e.execution.status === 'reused') {
    const prior = checkpoint.history.find(p => e.execution.reusedEvidenceRefs.includes(p.digest))
    assert(validCandidate(prior) && prior.sourceDigest === e.sourceDigest && experimentValidationDigest(prior) === experimentValidationDigest(e)
      && prior.trainingSeed === e.trainingSeed && internalScore(prior) === internalScore(e) && internalQuality(prior) === internalQuality(e)
      && digest(prior.execution.foldMetrics ?? null) === digest(e.execution.foldMetrics ?? null), 'invalid cached validation evidence')
  }
  const nextPool = [...remainingPool(start, steps, checkpoint, requestValidationDigest(request)), ...(validCandidate(e) ? [e] : [])]
  assert(result.selectedSolutionDigest === null || nextPool.some(p => p.sourceDigest === result.selectedSolutionDigest), 'selection is outside this sequence candidate pool')
  assert(result.selectedSolutionDigest !== null || nextPool.length === 0, 'cannot erase an available incumbent')
  assert(result.availableEvidenceRefs.every(ref => [...checkpoint.history, e].some(p => p.digest === ref)), 'future or foreign selection evidence')
  cost(result.cost); assert(digest(result.cost) === digest(e.execution.cost), 'cost ledger mismatch')
  return result
}

/** A backend must verify Hitch manifests and fixed receipts, not just return model text. */
export class SequenceRunner {
  constructor(store, backend, { now = () => Date.now() } = {}) { this.store = store; this.backend = backend; this.now = now }
  async run(plan, start, { signal = new AbortController().signal } = {}) {
    verify(plan); validateCheckpoint(start)
    assert(plan.protocol === PROTOCOL && plan.experiments === 5 && plan.repetitions === 1 && plan.startingCheckpointDigest === start.digest, 'invalid five-rollout plan')
    assert(digest(plan.roundValidation ?? null) === digest(roundValidation(plan.task, start.digest)), 'sequence round CV plan changed')
    await this.store.verifySources(start)
    await this.backend.admit(plan)
    const id = plan.digest.slice(7)
    return locked(this.store.path('locks', id), async () => {
      let state = await this.store.load('sequences', id)
      if (state) assert(state.plan.digest === plan.digest && state.startingCheckpointDigest === start.digest, 'sequence plan changed')
      else {
        state = { plan: clone(plan), startingCheckpointDigest: start.digest, startCheckpointRef: await this.store.put(start), checkpointRef: await this.store.put(start),
          steps: [], selections: [], pending: null, stopped: null, delivery: null, status: 'researching',
          budget: new Budget(plan.budget, null, this.now).snapshot() }
        await this.store.save('sequences', id, state)
      }
      if (state.status === 'complete') { verify(state.receipt); return state.receipt }
      assert(state.status !== 'cancelled', 'cancelled sequence cannot restart')
      const budget = new Budget(plan.budget, state.budget, this.now)
      const save = async () => { state.budget = budget.snapshot(); await this.store.save('sequences', id, state) }
      const bounded = async (final, execute) => {
        const remaining = budget.available(final).wallSeconds
        assert(remaining > 0, 'sequence deadline expired; pending execution requires inspection, not a new budget')
        const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(new Error('sequence wall budget exhausted')), Math.ceil(remaining * 1000))
        try { return await execute(AbortSignal.any([signal, deadline.signal])) }
        catch (error) { if (deadline.signal.aborted) await this.backend.cancel?.(state.pending?.request); throw error }
        finally { clearTimeout(timer) }
      }
      try {
        let checkpoint = validateCheckpoint(await this.store.get(state.checkpointRef))
        for (let k = state.steps.length + 1; k <= 5 && !state.stopped; k++) {
          signal.throwIfAborted()
          const allowance = budget.available()
          if (!state.pending && (allowance.wallSeconds <= 0 || allowance.requests !== null && allowance.requests < 1 || allowance.tools < 1 || allowance.cpuSeconds <= 0)) { state.stopped = 'research_budget_exhausted'; break }
          let request = state.pending?.request
          if (!request) {
            request = seal({ protocol: 'analysis-rollout-request@1', sequenceId: id, slotIndex: k, planDigest: plan.digest,
              task: plan.task, harness: plan.harness, model: plan.model, runtimeDigest: plan.runtimeDigest,
              ...(plan.roundValidation ? { roundValidation: plan.roundValidation } : {}),
              checkpointDigest: checkpoint.digest, checkpointRef: state.checkpointRef,
              previousRolloutReceiptDigest: state.steps.at(-1)?.digest ?? null,
              eligibleSolutionDigests: [...new Set([start.currentSolutionDigest, ...state.steps.map(s => s.experiment.sourceDigest)].filter(Boolean))],
              allowance, experimentWallSeconds: plan.budget.experimentWallSeconds, experimentCpuSeconds: plan.budget.experimentCpuSeconds })
            budget.reserve(`rollout-${k}`, Object.fromEntries(dimensions.map(d => [d, allowance[d] ?? 0])))
            state.pending = { request, status: 'reserved' }; await save()
          }
          // Backend execution is itself idempotent; a submitted run is inspected,
          // never replaced by a fresh model sample after an error or controller restart.
          const result = validateRollout(await bounded(false, signal => this.backend.rollout(request, checkpoint, { signal })), request, checkpoint, state.steps, start)
          for (const s of result.solutions) for (const f of s.files) assert((await this.store.bytes(f.digest)).length === f.bytes, 'missing exported source')
          budget.settle(`rollout-${k}`, result.cost)
          const selected = seal({ protocol: 'analysis-slot-selection@1', slotIndex: k, experimentId: result.experiment.experimentId,
            status: 'attempted', stopReason: null, incumbentSolutionDigest: result.selectedSolutionDigest,
            carryForward: result.selectedSolutionDigest === (state.selections.at(-1)?.incumbentSolutionDigest ?? start.currentSolutionDigest),
            availableEvidenceRefs: result.availableEvidenceRefs, selectionPolicyDigest: result.selectionPolicyDigest,
            cumulativeCostDigest: digest(budget.snapshot()), sealedAt: result.sealedAt, rolloutReceiptDigest: result.digest })
          checkpoint = advance(checkpoint, result.experiment, result.solutions, result.selectedSolutionDigest, result.outputManifestDigest)
          state.checkpointRef = await this.store.put(checkpoint)
          state.steps.push(result); state.selections.push(selected); state.pending = null
          if (result.stop) state.stopped = 'target_stopped'
          await save()
        }
        while (state.selections.length < 5) state.selections.push(seal({ protocol: 'analysis-slot-selection@1',
          slotIndex: state.selections.length + 1, experimentId: null, status: 'not_started', stopReason: state.stopped,
          incumbentSolutionDigest: state.selections.length ? state.selections.at(-1).incumbentSolutionDigest : isRoundCvTask(plan.task) ? null : start.currentSolutionDigest,
          carryForward: true, availableEvidenceRefs: [], selectionPolicyDigest: null,
          cumulativeCostDigest: digest(budget.snapshot()), sealedAt: new Date(this.now()).toISOString(), rolloutReceiptDigest: null }))
        state.status = 'selected'; await save()
        signal.throwIfAborted()
        const solutionDigest = state.selections[4].incumbentSolutionDigest
        if (!state.delivery) {
          if (isRoundCvTask(plan.task)) {
            state.delivery = cvSelection(plan, state.steps, solutionDigest)
            await save()
          } else if (!solutionDigest) state.delivery = seal({ protocol: 'analysis-delivery@1', status: 'candidate_failed',
            solutionDigest: null, quality: 0, accuracy: null, runId: null, outputManifestDigest: null, cost: Object.fromEntries(dimensions.map(d => [d, 0])) })
          else {
            let request = state.pending?.request
            if (!request) {
              const allowance = budget.available(true)
              if (allowance.wallSeconds <= 0) throw new Error('finalization deadline exceeded without trusted delivery receipt')
              request = seal({ protocol: 'analysis-delivery-request@1', sequenceId: id, planDigest: plan.digest, task: plan.task,
                harness: plan.harness, runtimeDigest: plan.runtimeDigest, solution: checkpoint.solutions.find(s => s.digest === solutionDigest),
                selectionsDigest: digest(state.selections), allowance })
              budget.reserve('delivery', Object.fromEntries(dimensions.map(d => [d, allowance[d] ?? 0])), true)
              state.pending = { request, status: 'reserved' }; await save()
            }
            const delivered = verify(await bounded(true, signal => this.backend.deliver(request, { signal })))
            assert(delivered.protocol === 'analysis-delivery@1' && delivered.requestDigest === request.digest
              && delivered.solutionDigest === solutionDigest && ['completed', 'candidate_failed'].includes(delivered.status), 'delivery is unavailable or identity mismatched')
            assert(delivered.modelRequests === 0, 'sealed refit must not call a model')
            const raw = plan.task.protocol !== 'analysis-task@1' ? delivered.score : delivered.accuracy
            assert(delivered.status !== 'completed' || delivered.runId && delivered.outputManifestDigest
              && typeof raw === 'number' && delivered.quality === utility(metricName(plan.task), raw), 'invalid delivery score')
            assert(delivered.status !== 'candidate_failed' || delivered.quality === 0 && delivered.accuracy === null, 'failure score mismatch')
            budget.settle('delivery', delivered.cost); state.delivery = delivered; state.pending = null; await save()
          }
        }
        const receipt = seal({ protocol: 'analysis-sequence-receipt@1', planDigest: plan.digest, startingCheckpointDigest: start.digest,
          harness: plan.harness, taskDigest: plan.task.digest, checkpointRef: state.checkpointRef,
          steps: state.steps.map(s => ({ runId: s.runId, receiptDigest: s.digest, outputManifestDigest: s.outputManifestDigest })),
          selections: state.selections, delivery: state.delivery, cost: budget.snapshot(), planned: 5, attempted: state.steps.length,
          validCandidates: state.steps.filter(s => validCandidate(s.experiment)).length, unused: 5 - state.steps.length,
          uniqueSolutions: new Set(state.steps.map(s => s.experiment.sourceDigest).filter(Boolean)).size,
          total_score: state.delivery.quality, valid_output: state.delivery.status === 'completed' ? 1 : 0,
          completed: state.delivery.status === 'completed' ? 1 : 0 })
        state.status = 'complete'; state.receipt = receipt; await save(); return receipt
      } catch (e) {
        if (signal.aborted) { state.status = 'cancelled'; await this.backend.cancel?.(state.pending?.request); await save() }
        // Pending cost remains reserved and the run stays inspectable. No invented zero score.
        throw e
      }
    })
  }
}
