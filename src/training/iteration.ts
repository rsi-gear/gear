import { ModelTrainingCoordinator } from './coordinator.js'
import { proposalInputsDigest } from './iteration-policy.js'
import { requireContract } from './schema.js'
import type { ModelExperimentState, ModelIterationState } from './types.js'

function control(state: ModelExperimentState, action: 'start' | 'pause'): void {
  const iteration = state.iteration!
  iteration.control = { sequence: iteration.control.sequence + 1, action }
  requireContract(Number.isSafeInteger(iteration.control.sequence), 'iteration-control-overflow', 'iteration control sequence is exhausted')
  if (state.endpointControl) {
    state.endpointControl.sequence = iteration.control.sequence
    state.endpointControl.action = action
  }
}

function markStopping(state: ModelExperimentState, reason: string, failed = false, error?: unknown): void {
  const iteration = state.iteration!
  if (['completed', 'failed'].includes(iteration.status)) return
  if (!iteration.stopOutcome) {
    iteration.stopOutcome = failed ? 'failed' : 'completed'
    iteration.stopReason = reason
  }
  if (iteration.status !== 'pausing') control(state, 'pause')
  iteration.status = 'pausing'
  delete iteration.recovery
  if (error) {
    iteration.error = error instanceof Error ? error.message : String(error)
    if (failed) iteration.failureReason = iteration.error
  }
}

/** The experiment loop owns admission; the existing coordinator owns each run. */
export class ModelIterationController {
  constructor(readonly coordinator: ModelTrainingCoordinator) {}
  get store() { return this.coordinator.store }

  async inspect(id: string): Promise<ModelExperimentState> {
    const state = await this.store.load(id)
    requireContract(state.spec.iteration && state.iteration, 'iteration-not-authorized', 'create a new experiment with a frozen iteration policy')
    return state
  }

  async advance(id: string): Promise<ModelExperimentState> {
    let state = await this.inspect(id), iteration = state.iteration!
    if (iteration.status === 'completed' || iteration.status === 'failed' || iteration.status === 'paused') return state
    if (iteration.status === 'pausing') return this.reconcilePause(id)
    if (Date.now() >= Date.parse(iteration.deadlineAt)) return this.stop(id, 'wall-clock-exhausted')
    if (iteration.recovery) return this.recover(id)
    if (iteration.activeRoundIndex === undefined) {
      const reason = this.stopCondition(state)
      if (reason) return this.stop(id, reason)
      try { await this.coordinator.admit(id, iteration.control.sequence) }
      catch (error) {
        const code = errorCode(error)
        if (code === 'iteration-control-stale') return this.inspect(id)
        if (['budget-exhausted', 'offline-dataset-exhausted', 'held-out-budget-exhausted', 'iteration-deadline-exceeded', 'iteration-round-limit'].includes(code)) return this.stop(id, code)
        return this.stop(id, `admission-failed:${code}`, true, error)
      }
      state = await this.inspect(id); iteration = state.iteration!
    }
    const roundIndex = iteration.activeRoundIndex!, round = iteration.rounds[String(roundIndex)]!, run = state.runs[round.runId]!
    if (run.decision) return this.commitRound(id, roundIndex)
    try {
      if (['blocked', 'interrupted', 'failed', 'paused'].includes(run.execution)) return this.beginRecovery(id, roundIndex, run.error ?? run.execution)
      const current = await this.coordinator.advance(id, run.id)
      state = await this.inspect(id)
      if (state.iteration!.status !== 'running') return this.reconcilePause(id)
      if (current.decision) return this.commitRound(id, roundIndex)
      if (['blocked', 'interrupted', 'failed', 'paused'].includes(current.execution)) return this.beginRecovery(id, roundIndex, current.error ?? current.execution)
      return state
    } catch (error) {
      state = await this.inspect(id)
      if (state.iteration!.status !== 'running') return this.reconcilePause(id)
      const code = errorCode(error)
      // Contract/certification failures cannot become automatic experiments by retrying.
      if (['gpu-probes-pending', 'training-preflight-blocked', 'checkpoint-incompatible', 'invalid-contract', 'managed-endpoint-not-authorized',
        'managed-endpoint-unconfigured', 'evaluation-attempt-budget-exhausted', 'valid-slot-rerun'].includes(code)) {
        return this.stop(id, code, true, error)
      }
      return this.beginRecovery(id, roundIndex, error instanceof Error ? error.message : String(error))
    }
  }

  private stopCondition(state: ModelExperimentState): string | undefined {
    const iteration = state.iteration!, policy = state.spec.iteration!
    if (Date.now() >= Date.parse(iteration.deadlineAt)) return 'wall-clock-exhausted'
    if (Object.keys(iteration.rounds).length >= policy.maxRounds) return 'max-rounds'
    if (iteration.consecutiveRejected >= policy.maxConsecutiveRejected) return 'max-consecutive-rejected'
    if (state.usage.gpuSeconds >= state.spec.budgets.totalGpuSeconds) return 'training-gpu-budget-exhausted'
    if (state.usage.rolloutTokens >= state.spec.budgets.maxRolloutTokens) return 'rollout-token-budget-exhausted'
    if (Object.values(state.runs).reduce((sum, run) => sum + run.heldOutQueries, 0) >= state.spec.evaluation.policy.maxHeldOutEvaluations) return 'held-out-budget-exhausted'
    return undefined
  }

  private async commitRound(id: string, roundIndex: number): Promise<ModelExperimentState> {
    const reason = await this.store.transaction(id, state => {
      const iteration = state.iteration!, round = iteration.rounds[String(roundIndex)]!, run = state.runs[round.runId]!
      if (round.outcome) return undefined
      requireContract(iteration.activeRoundIndex === roundIndex && run.decision, 'iteration-decision-missing', 'round finalization requires its committed run decision')
      requireContract(run.resourcesReleased && run.evaluationTasksCompleted && run.inferenceResourcesReleased !== false,
        'iteration-cleanup-pending', 'training, tasks and managed inference must each confirm cleanup')
      round.outcome = run.decision.outcome
      delete iteration.activeRoundIndex
      let reason: string | undefined
      if (run.decision.outcome === 'accepted') iteration.consecutiveRejected = 0
      else if (run.decision.outcome === 'rejected') {
        iteration.consecutiveRejected++
        const currentInputs = run.iterationRound!.inputsDigest
        const next = state.spec.iteration!.proposals.findIndex((_proposal, index) => index > round.proposalIndex
          && proposalInputsDigest(state.spec, index) !== currentInputs
          && !Object.values(state.runs).some(prior => prior.decision?.outcome === 'rejected'
            && prior.parent.modelRef.digest === state.champion.modelRef.digest
            && prior.iterationRound?.inputsDigest === proposalInputsDigest(state.spec, index)))
        if (next < 0) reason = 'no-new-proposal'
        else iteration.nextProposalIndex = next
      } else reason = run.decision.outcome === 'inconclusive' ? 'inconclusive' : 'champion-superseded'
      reason ??= this.stopCondition(state)
      if (reason) markStopping(state, reason, reason === 'inconclusive' || reason === 'champion-superseded')
      return reason
    })
    if (reason) return this.reconcilePause(id)
    return this.inspect(id)
  }

  async pause(id: string): Promise<ModelExperimentState> {
    await this.store.transaction(id, state => {
      const iteration = state.iteration
      requireContract(iteration, 'iteration-not-authorized', 'experiment has no frozen automatic loop')
      if (['completed', 'failed', 'paused'].includes(iteration.status)) return
      if (iteration.status !== 'pausing') control(state, 'pause')
      iteration.status = 'pausing'
      delete iteration.recovery
    })
    return this.reconcilePause(id)
  }

  async resume(id: string): Promise<ModelExperimentState> {
    await this.store.transaction(id, state => {
      const iteration = state.iteration
      requireContract(iteration?.status === 'paused' && !iteration.stopOutcome, 'iteration-not-resumable', 'only an explicitly paused unfinished experiment can resume')
      requireContract(Date.now() < Date.parse(iteration.deadlineAt), 'iteration-deadline-exceeded', 'resuming cannot refresh the original wall clock deadline')
      iteration.status = 'running'
      control(state, 'start')
      if (iteration.activeRoundIndex !== undefined) iteration.recovery = { roundIndex: iteration.activeRoundIndex, phase: 'resuming' }
      delete iteration.error
    })
    return this.advance(id)
  }

  async stop(id: string, reason = 'closed-by-user', failed = false, error?: unknown): Promise<ModelExperimentState> {
    await this.store.transaction(id, state => {
      const iteration = state.iteration
      requireContract(iteration, 'iteration-not-authorized', 'experiment has no frozen automatic loop')
      markStopping(state, reason, failed, error)
    })
    return this.reconcilePause(id)
  }

  private async reconcilePause(id: string): Promise<ModelExperimentState> {
    let state = await this.inspect(id), iteration = state.iteration!
    if (iteration.status !== 'pausing') return state
    try {
      await this.coordinator.fenceEndpoints(id)
      if (iteration.activeRoundIndex !== undefined) {
        const runId = iteration.rounds[String(iteration.activeRoundIndex)]!.runId
        let run = await this.coordinator.pause(id, runId, true)
        if (!run.resourcesReleased || !run.evaluationTasksCompleted || !run.decision && run.execution !== 'paused') return this.inspect(id)
        if (iteration.stopOutcome && !run.decision) run = await this.coordinator.close(id, runId, iteration.stopReason!, true)
      }
      if (!await this.coordinator.retireEndpoints(id)) return this.inspect(id)
      if (iteration.stopOutcome && !await this.coordinator.releaseEndpointOwnership(id)) return this.inspect(id)
      await this.store.transaction(id, current => {
        const saved = current.iteration!
        if (saved.status !== 'pausing' || saved.control.sequence !== iteration.control.sequence) return
        if (saved.stopOutcome && saved.activeRoundIndex !== undefined) {
          const round = saved.rounds[String(saved.activeRoundIndex)]!, run = current.runs[round.runId]!
          requireContract(run.decision, 'iteration-decision-missing', 'stopped round must retain its final reason')
          round.outcome = run.decision.outcome
          delete saved.activeRoundIndex
        }
        saved.status = saved.stopOutcome ?? 'paused'
        if (saved.status === 'failed') saved.error = saved.failureReason ?? saved.stopReason ?? 'experiment failed'
        else delete saved.error
      })
    } catch (error) {
      await this.store.transaction(id, current => {
        if (current.iteration!.control.sequence === iteration.control.sequence) current.iteration!.error = error instanceof Error ? error.message : String(error)
      })
    }
    return this.inspect(id)
  }

  private async beginRecovery(id: string, roundIndex: number, reason: string): Promise<ModelExperimentState> {
    const result = await this.store.transaction(id, state => {
      const iteration = state.iteration!, round = iteration.rounds[String(roundIndex)]!
      if (iteration.status !== 'running' || iteration.activeRoundIndex !== roundIndex) return 'stale'
      if (iteration.recovery) return 'recovering'
      if (round.recoveries >= state.spec.iteration!.recovery.maxRunRecoveries) return 'exhausted'
      round.recoveries++
      iteration.recovery = { roundIndex, phase: 'pausing' }
      iteration.error = reason
      control(state, 'pause')
      return 'recovering'
    })
    if (result === 'stale') return this.inspect(id)
    return result === 'recovering' ? this.recover(id) : this.stop(id, 'run-recovery-budget-exhausted', true, new Error(reason))
  }

  private async recover(id: string): Promise<ModelExperimentState> {
    let state = await this.inspect(id), recovery = state.iteration!.recovery
    if (!recovery || state.iteration!.status !== 'running') return state
    const runId = state.iteration!.rounds[String(recovery.roundIndex)]!.runId
    try {
      if (recovery.phase === 'pausing') {
        await this.coordinator.fenceEndpoints(id)
        const paused = await this.coordinator.pause(id, runId, true)
        if (!paused.resourcesReleased || !paused.evaluationTasksCompleted || paused.execution !== 'paused') return this.inspect(id)
        if (!await this.coordinator.retireEndpoints(id)) return this.inspect(id)
        await this.store.transaction(id, current => {
          const iteration = current.iteration!
          if (iteration.status !== 'running' || iteration.control.sequence !== state.iteration!.control.sequence || !iteration.recovery) return
          iteration.recovery.phase = 'resuming'
          control(current, 'start')
        })
        state = await this.inspect(id)
        recovery = state.iteration!.recovery
      }
      if (state.iteration!.status !== 'running' || recovery?.phase !== 'resuming') return state
      await this.coordinator.resume(id, runId)
      await this.store.transaction(id, current => {
        if (current.iteration!.status === 'running' && current.iteration!.control.sequence === state.iteration!.control.sequence) {
          delete current.iteration!.recovery
          delete current.iteration!.error
        }
      })
    } catch (error) {
      // Cleanup uncertainty stays visible and prevents another incarnation.
      await this.store.transaction(id, current => {
        if (current.iteration!.status === 'running') current.iteration!.error = error instanceof Error ? error.message : String(error)
      })
      if (recovery?.phase === 'resuming') {
        await this.store.transaction(id, current => { if (current.iteration!.status === 'running') delete current.iteration!.recovery })
        return this.beginRecovery(id, recovery.roundIndex, error instanceof Error ? error.message : String(error))
      }
    }
    return this.inspect(id)
  }
}

function errorCode(error: unknown): string { return error instanceof Error && 'code' in error ? String(error.code) : 'controller-error' }

export async function runIteration(controller: Pick<ModelIterationController, 'inspect' | 'advance' | 'pause'>, id: string,
  options: { intervalMs?: number; signal?: AbortSignal; onProgress?: (state: ModelExperimentState) => void } = {}): Promise<ModelExperimentState> {
  const interval = options.intervalMs ?? 1000
  requireContract(Number.isSafeInteger(interval) && interval > 0 && interval <= 60_000, 'invalid-poll-interval', 'poll interval must be 1–60000 ms')
  let state = await controller.inspect(id)
  while (state.iteration!.status === 'running' || state.iteration!.status === 'pausing') {
    state = options.signal?.aborted ? await controller.pause(id) : await controller.advance(id)
    options.onProgress?.(state)
    if (state.iteration!.status !== 'running' && state.iteration!.status !== 'pausing') return state
    if (state.iteration!.status === 'pausing' && state.iteration!.error) return state
    await new Promise(resolve => setTimeout(resolve, interval))
  }
  return state
}
