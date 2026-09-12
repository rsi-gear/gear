import { join } from 'node:path'
import type { EvaluationCondition, EvaluationEvidence, EvaluationRequest, EvaluationReservation, EvaluationSubmissionIntent, EvolutionSpec, HarnessManifest, HitchTrajectoryReader, RefineEvaluator, RefinementRound } from '../types.js'
import { digestJson } from '../state/digest.js'
import { digestDatasetRef } from '../state/dataset.js'
import { describeDataset, projectDataset, type DatasetDescription } from './dataset-projection.js'
import { cellKey, validOutcome } from './evidence.js'
import { invariant, numeric, seal, sorted, utility, verifyDigest } from './contracts.js'
import { SearchBudgetExceeded, SearchStore } from './store.js'
import { SearchExecutionFailure, budgetFailure } from './recovery.js'
import type { CellIdentity, DiagnosisFact, DiagnosisProvider, EvidenceCell, ExternalRecovery, EvaluationExecutionResult, SearchProvider, Snapshot, TaskUniverse } from './types.js'

type Input = Parameters<SearchProvider['evaluate']>[0]
interface Batch {
  cells: CellIdentity[]; request: EvaluationRequest; round: RefinementRound; intent?: EvaluationSubmissionIntent; key: string
  identity?: { provider: string; effectiveConfigDigest: string }
}
interface Source {
  batch: Batch; evidence: EvaluationEvidence; completedAt: string; cells: EvidenceCell[]; digest: string
}
interface Operation { reservation?: EvaluationReservation; reserving?: boolean; started: boolean; sourceDigest?: string }
export interface EvaluationSearchOptions {
  spec: EvolutionSpec; workspaceRoot: string; stateRoot: string
  round(): Promise<RefinementRound>
  manifest(snapshot: Snapshot): Promise<HarnessManifest>
}

/** Gear owns task selection, cache identity and staging. The evaluator receives ordinary requests. */
export class EvaluationSearchAdapter implements SearchProvider {
  readonly integrity = digestJson({ implementation: 'gear-existing-evaluator-search', revision: 1 })
  readonly capabilities = { taskSubsetPlans: true, batchIndependentCells: true, idempotentExecution: true }
  readonly store: SearchStore
  readonly diagnosis: DiagnosisProvider
  private readonly datasets = new Map<string, Promise<DatasetDescription>>()
  constructor(readonly evaluator: RefineEvaluator, readonly options: EvaluationSearchOptions) {
    this.store = new SearchStore(options.stateRoot)
    this.diagnosis = {
      integrity: digestJson({ implementation: 'gear-verifier-failure-hypotheses', revision: 1 }),
      sanitizationPolicyDigest: digestJson('gear-verifier-codes-and-component-ids-only-v1'),
      diagnose: input => this.diagnose(input),
    }
  }
  private dataset(partition: 'seed' | 'held-out'): Promise<DatasetDescription> {
    let value = this.datasets.get(partition)
    if (!value) { value = describeDataset(this.options.spec, partition, this.options.workspaceRoot); this.datasets.set(partition, value) }
    return value
  }
  async describe(partition: 'seed' | 'held-out'): Promise<TaskUniverse> { return structuredClone((await this.dataset(partition)).universe) }

  private async batches(input: Input, create: boolean): Promise<Batch[] | undefined> {
    const name = `evaluator-input-${input.idempotencyKey.slice(7)}`
    const pointer = await this.store.read<{ ref: string }>(`evolution/${name}`)
    if (pointer) {
      const saved = await this.store.object<{ inputDigest: string; batches: Batch[]; digest: string }>(pointer.ref)
      invariant(saved.inputDigest === digestJson({ plan: input.plan, snapshot: input.snapshot, cells: input.cells }), 'evaluation operation input changed')
      return saved.batches
    }
    if (!create) return undefined
    const source = await this.dataset(input.plan.partition), round = await this.options.round()
    invariant(source.universe.digest === input.plan.universeDigest, 'evaluation universe changed')
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
        const identity = await this.evaluator.evaluationIdentity?.(context, request, input.signal)
        batches.push({ cells, request, round: context, key, ...(intent ? { intent } : {}), ...(identity ? { identity } : {}) })
      }
      return seal({ inputDigest: digestJson({ plan: input.plan, snapshot: input.snapshot, cells: input.cells }), batches })
    })
    return prepared.batches
  }

  private async source(batch: Batch, evidence: EvaluationEvidence): Promise<Source> {
    invariant(evidence.requestedCommit === batch.request.harnessRef && evidence.actualCommit === batch.request.harnessRef
      && evidence.dataset === batch.request.dataset && evidence.conditionId === batch.request.condition.conditionId, 'evaluation evidence does not match its frozen request')
    if (batch.identity) invariant(evidence.provider === batch.identity.provider && evidence.effectiveConfigDigest === batch.identity.effectiveConfigDigest, 'evaluation runtime configuration changed')
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
    const source = seal({ batch, evidence, completedAt, cells })
    await this.store.put(source)
    for (const cell of cells) {
      await this.store.write(`evaluator-cells/${cellKey(cell.identity).slice(7)}`, { ref: source.digest })
      await this.store.write(`evaluator-runs/${digestJson(cell.evidenceRef).slice(7)}`, { ref: source.digest })
    }
    return source
  }

  private async batch(batch: Batch, signal: AbortSignal, inspectOnly: boolean): Promise<ExternalRecovery<EvaluationExecutionResult>> {
    const path = `evaluator-operations/${batch.key.slice(7)}`
    let operation = await this.store.read<Operation>(path)
    if (operation?.sourceDigest) return { status: 'complete', result: { cells: (await this.store.object<Source>(operation.sourceDigest)).cells } }
    if (operation?.started) {
      if (!operation.reservation || !this.evaluator.inspectResult) return { status: 'unknown', reason: 'original evaluation requires recovery; no new execution was started' }
      const inspection = await this.evaluator.inspectResult(batch.round, batch.request, operation.reservation, signal, batch.intent)
      if (inspection.status === 'failed') throw new SearchExecutionFailure(inspection.code, inspection.message, operation.reservation.evalId)
      if (inspection.status !== 'complete') return inspection.status === 'running' ? { status: 'running', handle: operation.reservation.evalId }
        : { status: 'unknown', ...(inspection.reason ? { reason: inspection.reason } : {}) }
      const source = await this.source(batch, inspection.evidence)
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
    operation = { ...operation, started: true }
    await this.store.write(path, operation)
    const evidence = await this.evaluator.evaluate(batch.round, batch.request, signal, operation.reservation)
    if (operation.reservation) invariant(evidence.evalId === operation.reservation.evalId && evidence.provider === operation.reservation.provider, 'evaluation reservation changed')
    const source = await this.source(batch, evidence)
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
        if (error instanceof SearchBudgetExceeded) await this.store.write(`evaluator-budget-stops/${input.idempotencyKey.slice(7)}`, true)
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
    for (const batch of batches) {
      let result: ExternalRecovery<EvaluationExecutionResult>
      try { result = await this.batch(batch, input.signal, true) }
      catch (error) {
        if (error instanceof SearchExecutionFailure) throw new SearchExecutionFailure(error.failure.code, error.message, error.failure.evidenceRef!, [...cells, ...error.cells])
        throw error
      }
      if (result.status === 'not-started') {
        if (!cells.length) return result
        return await this.store.read<boolean>(`evaluator-budget-stops/${input.idempotencyKey.slice(7)}`)
          ? { status: 'complete', result: { cells, failure: budgetFailure('time') } }
          : { status: 'unknown', reason: 'remaining repetitions have not started; no terminal failure is recorded' }
      }
      if (result.status !== 'complete') return result
      cells.push(...result.result.cells)
    }
    return { status: 'complete', result: { cells } }
  }
  async verifyCell(cell: EvidenceCell, identity: CellIdentity): Promise<boolean> {
    verifyDigest(cell)
    const pointer = await this.store.read<{ ref: string }>(`evaluator-cells/${cellKey(identity).slice(7)}`)
    if (!pointer) return false
    const source = await this.store.object<Source>(pointer.ref)
    return source.evidence.actualCommit === identity.harnessCommit && source.cells.some(c => c.digest === cell.digest && cellKey(c.identity) === cellKey(identity))
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
  return new Proxy(evaluator, { get(target, property) { if (property === 'search') return search; const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value } })
}
