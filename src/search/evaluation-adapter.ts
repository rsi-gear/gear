import { join } from 'node:path'
import type { EvaluationCondition, EvaluationEvidence, EvaluationRequest, EvaluationReservation, EvaluationSubmissionIntent, EvolutionSpec, HarnessManifest, HitchTrajectoryReader, RefineEvaluator, RefinementRound } from '../types.js'
import { digestJson } from '../state/digest.js'
import { digestDatasetRef } from '../state/dataset.js'
import { describeDataset, projectDataset, type DatasetDescription } from './dataset-projection.js'
import { cellKey, validOutcome } from './evidence.js'
import { digest, invariant, numeric, seal, sorted, utility, verifyDigest } from './contracts.js'
import { SearchStore } from './store.js'
import { SearchExecutionFailure } from './recovery.js'
import type { CellIdentity, DiagnosisFact, DiagnosisProvider, EvidenceCell, ExternalRecovery, EvaluationExecutionResult, SearchProvider, Snapshot, StageEvaluationPlan, StageResult, TaskUniverse } from './types.js'

type Input = Parameters<SearchProvider['evaluate']>[0]
type ExecutionIdentity = NonNullable<Awaited<ReturnType<NonNullable<RefineEvaluator['evaluationIdentity']>>>>
type SubmittedIdentity = NonNullable<Awaited<ReturnType<NonNullable<RefineEvaluator['submittedEvaluationIdentity']>>>>
interface Batch {
  cells: CellIdentity[]; request: EvaluationRequest; round: RefinementRound; intent?: EvaluationSubmissionIntent; key: string
  identity?: ExecutionIdentity
  cohortDigest: string
}
interface Source {
  batch: Batch; executionIdentity: ExecutionIdentity; submittedIdentity?: SubmittedIdentity; evidence: EvaluationEvidence; completedAt: string; cells: EvidenceCell[]; digest: string
}
interface Operation { submittedIdentity?: SubmittedIdentity; reservation?: EvaluationReservation; reserving?: boolean; started: boolean; sourceDigest?: string }
export interface EvaluationSearchOptions {
  spec: EvolutionSpec; workspaceRoot: string; stateRoot: string
  /** Stable full-dataset request context, available before the first round exists. */
  identityRound: Readonly<RefinementRound>
  round(): Promise<RefinementRound>
  manifest(snapshot: Snapshot): Promise<HarnessManifest>
}

/** Gear owns task selection, cache identity and staging. The evaluator receives ordinary requests. */
export class EvaluationSearchAdapter implements SearchProvider {
  readonly integrity = digestJson({ implementation: 'gear-existing-evaluator-search', revision: 5 })
  readonly capabilities = { taskSubsetPlans: true, batchIndependentCells: true, idempotentExecution: true }
  readonly store: SearchStore
  readonly diagnosis: DiagnosisProvider
  private readonly datasets = new Map<string, Promise<DatasetDescription>>()
  private readonly cohorts = new Map<string, { digest: string }>()
  constructor(readonly evaluator: RefineEvaluator, readonly options: EvaluationSearchOptions) {
    this.store = new SearchStore(options.stateRoot)
    this.diagnosis = {
      integrity: digestJson({ implementation: 'gear-verifier-failure-hypotheses', revision: 1 }),
      sanitizationPolicyDigest: digestJson('gear-verifier-codes-and-component-ids-only-v1'),
      diagnose: input => this.diagnose(input),
    }
  }
  private async executionIdentity(round: Readonly<RefinementRound>, request: EvaluationRequest, signal?: AbortSignal): Promise<ExecutionIdentity | undefined> {
    const identity = await this.evaluator.evaluationIdentity?.(round, request, signal)
    if (!identity) {
      invariant(this.evaluator.submittedEvaluationIdentity, 'staged search requires a resolvable evaluation runtime identity before admission or from a verified submission')
      return undefined
    }
    invariant(typeof identity.provider === 'string' && identity.provider.length > 0, 'invalid evaluation provider identity')
    digest(identity.effectiveConfigDigest)
    if (identity.invocationFingerprint !== undefined) digest(identity.invocationFingerprint)
    return structuredClone(identity)
  }
  private async dataset(partition: 'seed' | 'held-out'): Promise<DatasetDescription> {
    let value = this.datasets.get(partition)
    if (!value) { value = describeDataset(this.options.spec, partition, this.options.workspaceRoot); this.datasets.set(partition, value) }
    const source = await value, round = this.options.identityRound
    const condition = partition === 'seed' ? round.plan.seed : round.plan.heldOut
    const request: EvaluationRequest = { phase: partition === 'seed' ? 'seed-baseline' : 'held-out-baseline',
      dataset: condition.dataset.ref, harnessRef: round.targetHarnessRef, condition }
    const identity = await this.executionIdentity(round, request)
    const binding = identity ?? { mode: 'verified-submission', evolutionId: this.options.spec.evolutionId }
    const cohort = seal({ round, request, identity: binding })
    const pointer = await this.store.read<{ ref: string }>(`evolution/evaluator-cohort-${partition}`)
    const frozen = pointer ? await this.store.object<{ digest: string }>(pointer.ref) : this.cohorts.get(partition) ?? cohort
    invariant(frozen.digest === cohort.digest, 'evaluation runtime configuration changed; start a new evolution')
    this.cohorts.set(partition, cohort)
    const { digest: ignored, ...universe } = source.universe
    return { ...source, universe: seal({ ...universe, conditionDigest: digestJson({ declared: universe.conditionDigest, execution: binding }) }) }
  }
  async describe(partition: 'seed' | 'held-out'): Promise<TaskUniverse> { return structuredClone((await this.dataset(partition)).universe) }

  private async batches(input: Input, create: boolean): Promise<Batch[] | undefined> {
    const source = await this.dataset(input.plan.partition)
    invariant(source.universe.digest === input.plan.universeDigest, 'evaluation universe changed')
    const name = `evaluator-input-${input.idempotencyKey.slice(7)}`
    const pointer = await this.store.read<{ ref: string }>(`evolution/${name}`)
    if (pointer) {
      const saved = await this.store.object<{ inputDigest: string; batches: Batch[]; digest: string }>(pointer.ref)
      invariant(saved.inputDigest === digestJson({ plan: input.plan, snapshot: input.snapshot, cells: input.cells }), 'evaluation operation input changed')
      return saved.batches
    }
    if (!create) return undefined
    await this.store.freezeEvolution(`evaluator-cohort-${input.plan.partition}`, () => this.cohorts.get(input.plan.partition)!)
    const round = await this.options.round()
    invariant((await this.options.manifest(input.snapshot)).digest === input.snapshot.manifestDigest, 'evaluation harness manifest changed')
    const prepared = await this.store.freezeEvolution(name, async () => {
      const batches: Batch[] = []
      for (const repetition of [...new Set(input.cells.map(c => c.repetition))].sort((a, b) => a - b)) {
        input.signal.throwIfAborted()
        const cells = input.cells.filter(c => c.repetition === repetition)
        invariant(cells.every(c => c.harnessCommit === input.snapshot.commit && c.conditionDigest === source.universe.conditionDigest), 'requested cells have inconsistent execution identity')
        const dataset = await projectDataset(source, cells.map(c => c.taskId), this.options.stateRoot)
        const key = digestJson([input.idempotencyKey, repetition]), base = input.plan.partition === 'seed' ? round.plan.seed : round.plan.heldOut
        const { conditionId: ignored, seeds: ignoredSeeds, ...body } = base
        const conditionBody = { ...body, dataset, repetitions: 1, ...(cells[0]!.seed === null ? {} : { seeds: [cells[0]!.seed!] }) }
        const condition: EvaluationCondition = { ...conditionBody, conditionId: digestJson(conditionBody) }
        const request: EvaluationRequest = { phase: input.plan.partition === 'seed' ? 'seed-candidate' : 'held-out-candidate', dataset: dataset.ref, harnessRef: input.snapshot.commit, condition }
        const context = { ...round, roundId: `${round.roundId}-stage-${key.slice(7, 23)}` }
        const intent = this.evaluator.prepareSubmission?.(context, request)
        const identity = await this.executionIdentity(context, request, input.signal)
        batches.push({ cells, request, round: context, key, ...(intent ? { intent } : {}), ...(identity ? { identity } : {}), cohortDigest: source.universe.conditionDigest })
      }
      return seal({ inputDigest: digestJson({ plan: input.plan, snapshot: input.snapshot, cells: input.cells }), batches })
    })
    return prepared.batches
  }

  private async source(batch: Batch, evidence: EvaluationEvidence, submittedIdentity?: SubmittedIdentity): Promise<Source> {
    await this.verifyBatch(batch)
    invariant(evidence.requestedCommit === batch.request.harnessRef && evidence.actualCommit === batch.request.harnessRef
      && evidence.dataset === batch.request.dataset && evidence.conditionId === batch.request.condition.conditionId, 'evaluation evidence does not match its frozen request')
    const executionIdentity = batch.identity ?? submittedIdentity
    invariant(executionIdentity, 'evaluation has no verified runtime identity')
    if (submittedIdentity) await this.verifySubmittedCohort(submittedIdentity)
    invariant(evidence.provider === executionIdentity.provider && evidence.effectiveConfigDigest === executionIdentity.effectiveConfigDigest
      && (executionIdentity.invocationFingerprint === undefined || evidence.invocationFingerprint === executionIdentity.invocationFingerprint), 'evaluation runtime configuration changed')
    invariant(await digestDatasetRef(batch.request.dataset) === batch.request.condition.dataset.digest, 'evaluated task subset changed')
    const ids = batch.cells.map(c => c.taskId), seen = new Set<string>()
    const rows = [...evidence.trials, ...evidence.invalidTrials]
    for (const row of rows) {
      invariant(ids.includes(row.taskName) && !seen.has(row.taskName) && row.attempt === 1 && typeof row.runId === 'string' && row.runId.length > 0, 'evaluation returned duplicate, unplanned or unidentifiable logical slots')
      seen.add(row.taskName)
    }
    invariant(evidence.plannedTrialCount === ids.length && seen.size === ids.length, 'evaluation did not account for the exact requested task subset')
    const saved = await this.store.freezeEvolution(`evaluator-result-${batch.key.slice(7)}`, () => seal({ evidence, completedAt: new Date().toISOString() }))
    invariant(digestJson(saved.evidence) === digestJson(evidence), 'settled evaluation changed during result recovery')
    const completedAt = saved.completedAt
    const cells = batch.cells.map(identity => {
      const trial = evidence.trials.find(t => t.taskName === identity.taskId), invalid = evidence.invalidTrials.find(t => t.taskName === identity.taskId)
      const evidenceRef = (trial ?? invalid)!.runId!
      const raw = trial?.scores?.totalScore
      const process = trial?.scores?.processScore
      const available = raw !== undefined && Number.isFinite(raw) && (!identity.processContractDigest || process !== undefined && Number.isFinite(process))
      return seal({ identity, status: available ? 'available' : 'invalid', envelope: 'legacy-v1', outcomeCertified: available,
        outcome: available ? { status: 'available', rawValue: raw, contractDigest: identity.outcomeContractDigest, evidenceRef }
          : { status: 'invalid', contractDigest: identity.outcomeContractDigest, reason: invalid?.invalidReason ?? 'legacy observation lacks declared scores' },
        ...(identity.processContractDigest ? { process: process !== undefined && available ? { status: 'available', rawValue: process, contractDigest: identity.processContractDigest, evidenceRef }
          : { status: 'invalid', contractDigest: identity.processContractDigest, reason: invalid?.invalidReason ?? 'legacy process unavailable' } } : {}),
        evidenceRef, completedAt } as Omit<EvidenceCell, 'digest'>)
    })
    const source = seal({ batch, executionIdentity, ...(submittedIdentity ? { submittedIdentity } : {}), evidence, completedAt, cells })
    await this.store.put(source)
    for (const cell of cells) {
      await this.store.write(`evaluator-cells/${cellKey(cell.identity).slice(7)}`, { ref: source.digest })
      await this.store.write(`evaluator-runs/${digestJson(cell.evidenceRef).slice(7)}`, { ref: source.digest })
    }
    return source
  }

  private async verifyBatch(batch: Batch, signal?: AbortSignal): Promise<void> {
    const source = await this.dataset(batch.request.condition.partition)
    invariant(batch.cohortDigest === source.universe.conditionDigest && batch.cells.every(cell => cell.conditionDigest === batch.cohortDigest), 'evaluation cell cohort changed')
    const current = await this.executionIdentity(batch.round, batch.request, signal)
    invariant(batch.identity ? current && digestJson(current) === digestJson(batch.identity) : !current, 'evaluation runtime configuration changed')
  }
  private async verifySubmittedCohort(identity: SubmittedIdentity): Promise<void> {
    digest(identity.cohortDigest); digest(identity.effectiveConfigDigest)
    if (identity.invocationFingerprint !== undefined) digest(identity.invocationFingerprint)
    invariant(typeof identity.provider === 'string' && identity.provider.length > 0, 'invalid submitted provider')
    const expected = seal({ provider: identity.provider, cohortDigest: identity.cohortDigest })
    const frozen = await this.store.freezeEvolution('evaluator-submitted-cohort', () => expected)
    invariant(frozen.digest === expected.digest, 'evaluation runtime cohort changed; results cannot be paired')
  }
  private async bindSubmittedIdentity(batch: Batch, operation: Operation, signal: AbortSignal, cancelOnFailure: boolean): Promise<Operation> {
    invariant(operation.reservation, 'deferred evaluation identity requires a durable reservation')
    let identity: SubmittedIdentity | undefined
    try {
      identity = await this.evaluator.submittedEvaluationIdentity!(batch.round, batch.request, operation.reservation, signal, batch.intent)
      invariant(identity, 'submitted evaluation runtime identity is unresolved')
      await this.verifySubmittedCohort(identity)
      invariant(!operation.submittedIdentity || digestJson(operation.submittedIdentity) === digestJson(identity), 'submitted evaluation identity changed')
    } catch (error) {
      // The daemon may have started after submit; stop the mismatching reservation.
      // Inspection reports uncertainty without mutating the external execution.
      if (cancelOnFailure) await this.evaluator.cancelReservation?.(operation.reservation, batch.intent)
      throw error
    }
    const next = { ...operation, submittedIdentity: identity }
    await this.store.write(`evaluator-operations/${batch.key.slice(7)}`, next)
    return next
  }
  private async batch(batch: Batch, signal: AbortSignal, inspectOnly: boolean): Promise<ExternalRecovery<EvaluationExecutionResult>> {
    await this.verifyBatch(batch, signal)
    const path = `evaluator-operations/${batch.key.slice(7)}`
    let operation = await this.store.read<Operation>(path)
    if (operation?.sourceDigest) {
      const source = await this.store.object<Source>(operation.sourceDigest)
      if (source.submittedIdentity) await this.verifySubmittedCohort(source.submittedIdentity)
      return { status: 'complete', result: { cells: source.cells } }
    }
    if (operation?.reservation && !batch.identity) operation = await this.bindSubmittedIdentity(batch, operation, signal, !inspectOnly)
    if (operation?.started || operation?.reservation && !batch.identity) {
      if (!operation.reservation || !this.evaluator.inspectResult) return { status: 'unknown', reason: 'original evaluation requires recovery; no new execution was started' }
      const inspection = await this.evaluator.inspectResult(batch.round, batch.request, operation.reservation, signal, batch.intent)
      if (inspection.status === 'failed') throw new SearchExecutionFailure(inspection.code, inspection.message, operation.reservation.evalId)
      if (inspection.status !== 'complete') return inspection.status === 'running' ? { status: 'running', handle: operation.reservation.evalId }
        : { status: 'unknown', ...(inspection.reason ? { reason: inspection.reason } : {}) }
      const source = await this.source(batch, inspection.evidence, operation.submittedIdentity)
      await this.store.write(path, { ...operation, sourceDigest: source.digest })
      return { status: 'complete', result: { cells: source.cells } }
    }
    if (inspectOnly) return operation?.reserving ? { status: 'unknown', reason: 'original submission needs reservation recovery' } : { status: 'not-started' }
    signal.throwIfAborted()
    if (!operation?.reservation) {
      // The immutable batch includes the submission intent before reserve may start remote work.
      const recovering = operation?.reserving
      if (recovering && (!batch.intent || !this.evaluator.recoverReservation)) return { status: 'unknown', reason: 'original reservation is unresolved; resubmission is unsafe' }
      await this.store.write(path, { started: false, reserving: true })
      const reservation = recovering && batch.intent && this.evaluator.recoverReservation
        ? await this.evaluator.recoverReservation(batch.round, batch.request, signal, batch.intent)
        : await this.evaluator.reserve?.(batch.round, batch.request, signal, batch.intent)
      operation = { ...(reservation ? { reservation } : {}), started: false }
      await this.store.write(path, operation)
    }
    if (!batch.identity) operation = await this.bindSubmittedIdentity(batch, operation, signal, true)
    operation = { ...operation, started: true }
    await this.store.write(path, operation)
    const evidence = await this.evaluator.evaluate(batch.round, batch.request, signal, operation.reservation)
    if (operation.reservation) invariant(evidence.evalId === operation.reservation.evalId && evidence.provider === operation.reservation.provider, 'evaluation reservation changed')
    const source = await this.source(batch, evidence, operation.submittedIdentity)
    await this.store.write(path, { ...operation, sourceDigest: source.digest })
    return { status: 'complete', result: { cells: source.cells } }
  }
  async evaluate(input: Input): Promise<EvidenceCell[]> {
    const batches = (await this.batches(input, true))!, cells: EvidenceCell[] = []
    for (const batch of batches) {
      try {
        const result = await this.batch(batch, input.signal, false)
        if (result.status !== 'complete') throw new Error(`existing evaluation ${result.status}; recover its original operation`)
        cells.push(...result.result.cells)
      } catch (error) {
        if (error instanceof SearchExecutionFailure) throw new SearchExecutionFailure(error.failure.code, error.message, error.failure.evidenceRef!, [...cells, ...error.cells])
        throw error
      }
    }
    return cells
  }
  async inspectEvaluation(input: Input): Promise<ExternalRecovery<EvaluationExecutionResult>> {
    const batches = await this.batches(input, false)
    if (!batches) return { status: 'not-started' }
    const cells: EvidenceCell[] = []
    let notStarted = false
    for (const batch of batches) {
      let result: ExternalRecovery<EvaluationExecutionResult>
      try { result = await this.batch(batch, input.signal, true) }
      catch (error) {
        if (error instanceof SearchExecutionFailure) throw new SearchExecutionFailure(error.failure.code, error.message, error.failure.evidenceRef!, [...cells, ...error.cells])
        throw error
      }
      if (result.status === 'not-started') {
        notStarted = true
        continue
      }
      if (result.status !== 'complete') return result
      cells.push(...result.result.cells)
    }
    // Check every batch before claiming the remainder is unstarted: a reserved
    // or running batch must still go through its original recovery protocol.
    if (notStarted) return cells.length ? { status: 'partially-complete', cells } : { status: 'not-started' }
    return { status: 'complete', result: { cells } }
  }
  async verifyCell(cell: EvidenceCell, identity: CellIdentity): Promise<boolean> {
    verifyDigest(cell)
    const pointer = await this.store.read<{ ref: string }>(`evaluator-cells/${cellKey(identity).slice(7)}`)
    if (!pointer) return false
    const source = await this.store.object<Source>(pointer.ref)
    await this.verifyBatch(source.batch)
    if (source.submittedIdentity) await this.verifySubmittedCohort(source.submittedIdentity)
    return source.evidence.actualCommit === identity.harnessCommit && source.cells.some(c => c.digest === cell.digest && cellKey(c.identity) === cellKey(identity))
  }

  async resolveVerifierRun(evalId: string, runId: string, signal: AbortSignal) {
    signal.throwIfAborted()
    if (!/^sha256:[0-9a-f]{64}$/u.test(evalId)) return undefined
    // Meta sees a StageResult digest, which can combine physical evaluations
    // across subsets and repetitions. Never compare that digest to Hitch's ID.
    const result = await this.store.object<StageResult>(evalId)
    const plan = await this.store.object<StageEvaluationPlan>(result.stagePlanDigest)
    invariant(plan.partition === 'seed', 'Meta verifier resolution requires seed evidence')
    const cells = result.cells.filter(cell => cell.evidenceRef === runId)
    invariant(cells.length === 1, 'run is not uniquely bound to the projected seed result')
    const cell = cells[0]!
    invariant(plan.taskIds.includes(cell.identity.taskId) && await this.verifyCell(cell, cell.identity), 'projected run provenance could not be verified')
    const pointer = await this.store.read<{ ref: string }>(`evaluator-cells/${cellKey(cell.identity).slice(7)}`)
    const source = await this.store.object<Source>(pointer!.ref)
    invariant(source.batch.request.condition.partition === 'seed', 'Meta verifier resolution requires a seed source')
    const trial = [...source.evidence.trials, ...source.evidence.invalidTrials].find(row => row.runId === runId)
    invariant(trial && trial.taskName === cell.identity.taskId, 'physical trial does not match projected run')
    signal.throwIfAborted()
    return { evalId: source.evidence.evalId, ...(trial.trialName === undefined ? {} : { trialName: trial.trialName }),
      ...(trial.attempt === undefined ? {} : { attempt: trial.attempt }) }
  }

  private async diagnose(input: Parameters<DiagnosisProvider['diagnose']>[0]): Promise<Awaited<ReturnType<DiagnosisProvider['diagnose']>>> {
    const reader = this.evaluator as RefineEvaluator & Partial<HitchTrajectoryReader>
    const facts: DiagnosisFact[] = [], manifest = await this.options.manifest(input.snapshot)
    const paths = sorted(manifest.artifacts.map(a => a.path.split('/')[0]!).filter(p => p !== 'manifest.json'))
    for (const cell of input.cells) {
      input.signal.throwIfAborted()
      const task = input.universe.tasks.find(t => t.id === cell.identity.taskId)!
      if (!validOutcome(cell) || cell.outcome.status !== 'available' || numeric(utility(cell.outcome.rawValue, task.outcome)) >= task.successUtility || !reader.inspectVerifierEvidence) continue
      const artifact = await this.store.freezeEvolution(`verifier-${digestJson(cell.evidenceRef).slice(7)}`, async () => {
        const evidence = await reader.inspectVerifierEvidence!(cell.evidenceRef, input.signal)
        invariant(evidence.runId === cell.evidenceRef, 'diagnostic artifact does not match seed run')
        return seal({ evidence })
      })
      if (artifact.evidence.observation?.status !== 'valid') continue
      const verifier = artifact.evidence.verifier
      // Specific verifier failure codes support hypotheses, never authoritative root-cause claims.
      const codes = sorted([...(verifier.process?.components?.filter(c => c.status === 'failed').map(c => c.code ?? c.id) ?? []),
        ...(verifier.feedback?.items.filter(f => f.severity === 'error').map(f => f.code) ?? [])])
        .filter(code => /^[a-zA-Z][a-zA-Z0-9_.-]{2,100}$/u.test(code) && !['error', 'failed', 'unknown', 'failure'].includes(code.toLowerCase()))
      for (const code of codes) if (paths.length) facts.push({ taskId: task.id, evidenceRefs: [cell.evidenceRef], status: 'supported-hypothesis', familyId: `verifier-${code}`,
        hypothesis: `Investigate and repair harness behavior associated with verifier failure ${code}; confirm the change against the assigned controls.`,
        mechanism: `The original valid seed run reports verifier failure code ${code}; shared cause remains a research hypothesis.`, submode: code, modificationPaths: paths })
    }
    return { facts, inputTokens: 0, outputTokens: 0 }
  }
}

export function attachSearchEvaluation(evaluator: RefineEvaluator, options: EvaluationSearchOptions): RefineEvaluator {
  if (evaluator.search) return evaluator
  const provider = new EvaluationSearchAdapter(evaluator, options), search = { provider, diagnosis: provider.diagnosis }
  return new Proxy(evaluator, { get(target, property) {
    if (property === 'search') return search
    if (property === 'resolveVerifierRun') return async (evalId: string, runId: string, signal: AbortSignal) =>
      await provider.resolveVerifierRun(evalId, runId, signal)
        ?? await (target as Partial<HitchTrajectoryReader>).resolveVerifierRun?.(evalId, runId, signal)
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
}
