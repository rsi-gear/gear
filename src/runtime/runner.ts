import { confirmCancellation, finishCancellation } from './cancellation.js'
import {
  mergeProjectedEvidence,
  reserveProjections,
  validateProjectionReservation,
  validateProjectionReceipt,
} from './evidence-projection.js'
import { setTimeout as delay } from 'node:timers/promises'
import { evaluationRepairPolicy, requireEvaluationCapabilities } from '../domain/evaluation.js'
import { mergeEvaluationEvidence, reserveRepairs, validateRepairReservation } from './evaluation-repair.js'
import type { Json, Operation, SearchView } from '../domain/algorithm-wire.js'
import { canonicalDigest } from '../domain/canonical.js'
import { GearError } from '../domain/errors.js'
import type { AlgorithmDriver, JournalOperation, RunJournal } from '../domain/run.js'
import type { OperationProvider, OperationReceipt, OperationRequest } from '../ports/operations.js'
import type { RunJournalStore } from '../ports/run-store.js'
import type { ExperiencePreparation } from '../ports/experience.js'
import { validateDecision } from './decision-validation.js'
import { validateAlgorithmWire } from '../domain/algorithm-schema.js'
import type { ObjectiveProjector } from '../ports/objective.js'
import { bindRawMetrics } from '../domain/objective-evidence.js'
import { requireGenerationCapability, validateGenerationBudget } from '../domain/generation-budget.js'
import { validateBaseline } from '../domain/baseline.js'
import {
  generationLedger,
  generationReceiptViolation,
  isGeneration,
  reserveGeneration,
  validateGenerationReservations,
} from './generation-budget.js'
import { evaluateWithCritic } from './evaluation-screen.js'

export class DurableRunner {
  constructor(
    readonly store: RunJournalStore,
    readonly algorithm: AlgorithmDriver,
    readonly provider: OperationProvider,
    readonly objective: ObjectiveProjector,
    readonly experience?: ExperiencePreparation,
  ) {}

  async run(id: string, signal: AbortSignal): Promise<RunJournal> {
    return this.store.locked(id, async () => {
      const journal = await this.store.read(id)
      if (journal.status === 'completed' || journal.status === 'cancelled') return journal
      if (await this.store.cancelled(id)) {
        await finishCancellation(this.store, journal, (request) => this.cancelOperation(request))
        throw new GearError('run-cancelled', 'Cancellation requested', { run_id: id })
      }
      this.admit(journal)
      journal.generation++
      journal.status = 'running'
      delete journal.failure
      await this.store.write(journal)
      const cancellation = new AbortController()
      const executionSignal = AbortSignal.any([signal, cancellation.signal])
      let checkingCancellation = false
      const poll = setInterval(() => {
        if (checkingCancellation) return
        checkingCancellation = true
        void this.store
          .cancelled(id)
          .then((cancelled) => {
            if (cancelled)
              cancellation.abort(new GearError('run-cancelled', 'Cancellation requested', { run_id: id }))
          })
          .catch((error) => cancellation.abort(error))
          .finally(() => {
            checkingCancellation = false
          })
      }, 250)
      signal = executionSignal
      try {
        // Decisions already committed are never recomputed, even after a worker crash.
        await this.drain(journal, signal)
        if (journal.spec.kind === 'evaluate') {
          journal.status = 'completed'
          await this.store.write(journal)
          return journal
        }
        while (journal.status === 'running') {
          await this.checkOwner(journal, signal)
          if (journal.nomineeId) {
            await this.finalize(journal, signal)
            break
          }
          if (journal.decisions.at(-1)?.decision.operations[0]?.kind === 'stop') {
            journal.status = 'completed'
            await this.store.write(journal)
            break
          }
          if (journal.decisions.length >= 10_000)
            throw new GearError('algorithm-step-limit', 'Run exhausted its durable decision step limit')
          const view = this.view(journal)
          const decision = await this.algorithm.step(
            view,
            structuredClone(journal.state),
            journal.spec.algorithm,
            signal,
          )
          await this.checkOwner(journal, signal)
          validateDecision(view, decision)
          const operations = decision.operations
            .filter((operation) => !['nominate', 'stop'].includes(operation.kind))
            .map((operation, index) => this.reserve(journal, operation, `${view.step_id}:${index}`, 'seed'))
          this.checkBudget(journal, operations)
          for (const entry of operations) {
            if (this.experience && isGeneration(entry.request.operation.kind)) {
              entry.request.experience = await this.experience.prepare(journal, entry.request, signal)
              entry.request.operationId = canonicalDigest([
                entry.request.operationId,
                entry.request.experience.digest,
              ])
            }
          }
          await this.checkOwner(journal, signal)
          const terminal = decision.operations[0]!
          if (terminal.kind === 'nominate') journal.nomineeId = terminal.candidate_id
          journal.decisions.push({
            stepId: view.step_id,
            inputDigest: canonicalDigest(view),
            decision,
            operationIds: operations.map((operation) => operation.request.operationId),
          })
          journal.state = decision.state
          journal.operations.push(...operations)
          // State, decision and every reserved side-effect ID commit together.
          await this.store.write(journal)
          await this.drain(journal, signal)
        }
      } catch (error) {
        if ((await this.store.read(id)).generation !== journal.generation) throw error
        journal.status = (await this.store.cancelled(id)) ? 'cancelled' : 'needs_recovery'
        let cancellationUnconfirmed = false
        if (journal.status === 'cancelled') {
          cancellationUnconfirmed = !(await this.confirmCancellation(journal))
          if (cancellationUnconfirmed) journal.status = 'needs_recovery'
        }
        journal.failure = {
          code: error instanceof GearError ? error.code : 'run-execution-failed',
          message: error instanceof Error ? error.message : String(error),
          retryable: error instanceof GearError && error.details.retryable === true,
        }
        if (cancellationUnconfirmed)
          journal.failure = {
            code: 'cancellation-unconfirmed',
            message: 'Cancellation requested; external work has not been confirmed stopped',
            retryable: true,
          }
        await this.store.write(journal)
        throw error
      } finally {
        clearInterval(poll)
      }
      return journal
    })
  }

  private async cancelOperation(request: OperationRequest): Promise<void> {
    if (!this.provider.capabilities.cancel)
      throw new GearError('provider-cancel-unsupported', 'Provider cannot confirm cancellation')
    await this.provider.cancel(request)
  }
  private async confirmCancellation(journal: RunJournal): Promise<boolean> {
    return confirmCancellation(journal, (request) => this.cancelOperation(request))
  }

  private admit(journal: RunJournal): void {
    validateBaseline(journal.spec)
    validateGenerationBudget(journal.spec.generationBudget)
    if (journal.spec.kind === 'refine')
      requireGenerationCapability(journal.spec.generationBudget, this.provider.capabilities.generationBudget)
    if (!journal.spec.evaluationRepair)
      throw new GearError(
        'frozen-repair-policy-missing',
        'This run has no frozen evaluation repair policy; create a new run',
      )
    evaluationRepairPolicy(journal.spec.evaluationRepair)
    const { capabilities } = this.provider,
      { spec } = journal
    if (spec.objective && spec.objectiveIdentity !== this.objective.identity)
      throw new GearError(
        'objective-identity-mismatch',
        'Frozen objective implementation changed; use the matching runtime',
      )
    if (spec.providerIdentity !== this.provider.identity)
      throw new GearError(
        'provider-identity-mismatch',
        'Provider implementation or execution conditions changed',
      )
    requireEvaluationCapabilities(capabilities)
    if (spec.validationMode === 'holdout' && !spec.heldOutTaskIds.length)
      throw new GearError(
        'held-out-required',
        'Holdout mode requires independent tasks; explicitly select research mode for shared-set research',
      )
    if (spec.seedTasks.some((task) => spec.heldOutTaskIds.includes(task.id)))
      throw new GearError('split-overlap', 'Seed and held-out task IDs overlap')
    if (!spec.seedTasks.length || !spec.seedTasks.some((task) => task.id))
      throw new GearError('empty-seed', 'Seed tasks are required')
    if (Object.values(spec.budget).some((value) => !Number.isSafeInteger(value) || value < 1))
      throw new GearError('invalid-budget', 'Run budgets must be positive safe integers')
    const minimum = spec.seedTasks.length * spec.budget.repetitions - (spec.baseline?.evidence.length ?? 0)
    if (spec.kind === 'refine' && spec.budget.maxEvaluations < minimum)
      throw new GearError(
        'budget-baseline-unaffordable',
        `Baseline requires at least ${minimum} physical trials`,
      )
  }

  private view(journal: RunJournal): SearchView {
    const generation = generationLedger(journal)
    return structuredClone({
      run_id: journal.id,
      step_id: journal.decisions.length,
      seed: journal.spec.seed,
      tasks: journal.spec.seedTasks,
      candidates: journal.candidates,
      evidence: journal.seedEvidence,
      completed: journal.completed,
      budget: {
        evaluations_remaining: journal.spec.budget.maxEvaluations - this.used(journal),
        candidates_remaining:
          journal.spec.budget.maxCandidates -
          journal.operations.filter((operation) => operation.request.operation.kind === 'generate_candidate')
            .length,
        rounds: journal.spec.budget.rounds,
        repetitions: journal.spec.budget.repetitions,
        generation_requests_remaining: generation.metrics.model_requests.remaining,
        generation_tokens_remaining: generation.metrics.tokens.remaining,
        generation_batch_capacity: generation.batch_capacity,
      },
      anchor_id: journal.spec.anchor.id,
      objective: journal.spec.objective
        ? ({
            ...journal.spec.objective,
            protection: journal.spec.objective.protection.filter((rule) => rule.partition === 'seed'),
            ...(journal.spec.objective.assertion_protection
              ? {
                  assertion_protection: journal.spec.objective.assertion_protection.filter(
                    (rule) => rule.partition === 'seed',
                  ),
                }
              : {}),
          } as unknown as Json)
        : null,
    })
  }

  private used(journal: RunJournal): number {
    return journal.operations.reduce(
      (sum, operation) => sum + (operation.receipt?.physicalAttempts ?? operation.reservedAttempts),
      0,
    )
  }
  private reserve(
    journal: RunJournal,
    operation: Operation,
    key: string,
    partition: 'seed' | 'held_out',
  ): JournalOperation {
    const evidence = partition === 'seed' ? journal.seedEvidence : journal.heldOutEvidence
    const slots =
      operation.kind === 'evaluate_seed'
        ? operation.task_ids.flatMap((taskId) =>
            Array.from({ length: journal.spec.budget.repetitions }, (_, repetition) => ({
              taskId,
              repetition,
            })).filter(
              (slot) =>
                !evidence.some(
                  (cell) =>
                    cell.candidate_id === operation.candidate_id &&
                    cell.task_id === slot.taskId &&
                    cell.repetition === slot.repetition,
                ),
            ),
          )
        : []
    const next = {
      ...operation,
      task_ids:
        operation.kind === 'evaluate_seed'
          ? [...new Set(slots.map((slot) => slot.taskId))]
          : operation.task_ids,
    }
    const inputs =
      operation.kind === 'diagnose_seed' || operation.kind === 'generate_candidate'
        ? journal.seedEvidence.filter(
            (cell) =>
              cell.candidate_id === (operation.parent_id ?? operation.candidate_id) &&
              operation.task_ids.includes(cell.task_id),
          )
        : []
    const generationLimits = isGeneration(operation.kind) ? reserveGeneration(journal) : undefined
    return {
      request: {
        operationId: canonicalDigest([
          journal.id,
          key,
          partition,
          next,
          slots,
          inputs,
          generationLimits ?? null,
        ]),
        runId: journal.id,
        generation: journal.generation,
        operation: next,
        partition,
        repetitions: journal.spec.budget.repetitions,
        slots,
        evidence: structuredClone(inputs),
        ...(generationLimits ? { generationLimits } : {}),
        ...(operation.kind === 'evaluate_seed' && journal.spec.objective
          ? {
              metrics: journal.spec.objective.metrics,
              ...(journal.spec.objective.assertions?.length
                ? { assertions: journal.spec.objective.assertions }
                : {}),
            }
          : {}),
      },
      status: 'reserved',
      reservedAttempts: slots.length,
    }
  }

  private checkBudget(journal: RunJournal, operations: JournalOperation[]): void {
    validateGenerationReservations(journal, operations)
    if (
      this.used(journal) + operations.reduce((sum, item) => sum + item.reservedAttempts, 0) >
      journal.spec.budget.maxEvaluations
    ) {
      throw new GearError(
        'budget-exhausted',
        'Insufficient physical trial budget for the complete operation batch',
        { run_id: journal.id },
      )
    }
  }

  private async drain(journal: RunJournal, signal: AbortSignal): Promise<void> {
    for (;;) {
      await this.checkOwner(journal, signal)
      validateGenerationReservations(journal)
      for (const operation of journal.operations.filter((item) => item.status !== 'complete')) {
        await this.checkOwner(journal, signal)
        validateRepairReservation(journal, operation)
        validateProjectionReservation(journal, operation)
        let receipt: OperationReceipt
        if (
          operation.request.operation.kind === 'evaluate_seed' &&
          operation.reservedAttempts === 0 &&
          !operation.request.projection
        ) {
          receipt = {
            result: {
              operation_id: operation.request.operationId,
              kind: 'evaluate_seed',
              status: 'complete',
              candidate_id: operation.request.operation.candidate_id,
              data: null,
            },
            evidence: [],
            candidate: null,
            physicalAttempts: 0,
            usage: {
              model_requests: 0,
              tokens: 0,
              input_tokens: 0,
              cached_input_tokens: 0,
              output_tokens: 0,
              dollars: 0,
            },
            provenance: null,
          }
        } else {
          if (operation.status === 'submitted') {
            const inspection = await this.provider.inspect(structuredClone(operation.request), signal)
            if (inspection.state === 'complete') {
              receipt = inspection.receipt
              await this.settle(journal, operation, receipt, signal)
              continue
            }
            if (
              inspection.state !== 'not_submitted' &&
              !(inspection.state === 'resumable' && this.provider.capabilities.idempotentSubmission)
            )
              throw new GearError(
                'operation-needs-recovery',
                'Submission outcome remains unknown; inspect again before retrying',
                { run_id: journal.id, operation_id: operation.request.operationId, retryable: true },
              )
          }
          while (operation.notBefore !== undefined && Date.now() < operation.notBefore) {
            await this.checkOwner(journal, signal)
            const remaining = operation.notBefore - Date.now()
            if (remaining <= 0) break
            try {
              await delay(Math.min(30_000, remaining), undefined, { signal })
            } catch (error) {
              signal.throwIfAborted()
              throw error
            }
          }
          await this.checkOwner(journal, signal)
          operation.status = 'submitted'
          await this.store.write(journal)
          if (operation.request.projection) {
            if (!this.provider.capabilities.evidenceProjection || !this.provider.completeEvidence)
              throw new GearError(
                'evidence-projection-unsupported',
                'Frozen provider cannot complete original evidence',
              )
            receipt = await this.provider.completeEvidence(structuredClone(operation.request), signal)
          } else
            receipt = await evaluateWithCritic(structuredClone(operation.request), (request) =>
              this.provider.submit(request, signal),
            )
        }
        await this.settle(journal, operation, receipt, signal)
      }
      await this.checkOwner(journal, signal)
      const repairs = reserveRepairs(journal, journal.spec.budget.maxEvaluations - this.used(journal))
      const projections = reserveProjections(journal, this.provider)
      if (repairs.changed || projections.changed) {
        this.checkBudget(journal, repairs.operations)
        journal.operations.push(...repairs.operations, ...projections.operations)
        await this.store.write(journal)
      }
      if (!repairs.operations.length && !projections.operations.length) return
    }
  }

  private async settle(
    journal: RunJournal,
    operation: JournalOperation,
    receipt: OperationReceipt,
    signal: AbortSignal,
  ): Promise<void> {
    await this.checkOwner(journal, signal)
    validateAlgorithmWire('OperationReceipt', receipt)
    const request = operation.request,
      expected = request.operation
    if (
      receipt.result.operation_id !== request.operationId ||
      receipt.result.kind !== expected.kind ||
      receipt.result.candidate_id !== expected.candidate_id ||
      !Number.isSafeInteger(receipt.physicalAttempts) ||
      receipt.physicalAttempts < 0 ||
      receipt.physicalAttempts > operation.reservedAttempts
    ) {
      throw new GearError(
        'invalid-operation-receipt',
        'Receipt identity or physical attempt accounting violates the reserved operation',
      )
    }
    const seen = new Set<string>()
    const violation = generationReceiptViolation(operation, receipt)
    if (violation) {
      operation.generationViolation = { reason: violation, receipt: structuredClone(receipt) }
      await this.store.write(journal)
      throw new GearError('generation-budget-violation', violation, {
        operation_id: request.operationId,
        run_id: journal.id,
      })
    }
    for (const cell of receipt.evidence) {
      const key = `${cell.task_id}:${cell.repetition}`
      if (
        expected.kind !== 'evaluate_seed' ||
        cell.candidate_id !== expected.candidate_id ||
        cell.scope !== expected.scope ||
        !expected.task_ids.includes(cell.task_id) ||
        !Number.isSafeInteger(cell.repetition) ||
        cell.repetition < 0 ||
        cell.repetition >= request.repetitions ||
        !request.slots.some((slot) => slot.taskId === cell.task_id && slot.repetition === cell.repetition) ||
        seen.has(key) ||
        (cell.score !== null && (!Number.isFinite(cell.score) || cell.score < 0 || cell.score > 1)) ||
        ['valid', 'task_failed'].includes(cell.status) !== (cell.score !== null)
      )
        throw new GearError(
          'invalid-evidence-slot',
          'Provider evidence contains an invalid or duplicate logical slot',
        )
      seen.add(key)
    }
    if (expected.kind === 'evaluate_seed' && receipt.evidence.length !== request.slots.length) {
      throw new GearError(
        'incomplete-operation-evidence',
        'Every requested slot needs a valid result or an explicit failure; missing slots cannot be zero-filled',
      )
    }
    const artifactSlots = new Set<string>()
    for (const artifact of receipt.artifacts ?? []) {
      const key = JSON.stringify([artifact.kind, artifact.format, artifact.task_id, artifact.repetition])
      if (
        expected.kind !== 'evaluate_seed' ||
        request.projection ||
        artifactSlots.has(key) ||
        !seen.has(`${artifact.task_id}:${artifact.repetition}`) ||
        (artifact.status === 'available') !== (artifact.content_digest !== null) ||
        (artifact.status === 'available' && artifact.reason !== null)
      )
        throw new GearError(
          'invalid-trial-artifact',
          'Trial artifact must belong to a distinct accepted observation slot',
        )
      artifactSlots.add(key)
    }
    if (
      !request.projection &&
      receipt.physicalAttempts <
        receipt.evidence.filter((cell) => cell.status !== 'environment_failed').length
    ) {
      throw new GearError(
        'unmetered-physical-attempt',
        'Scored and scoring-failed slots require metered physical attempts',
      )
    }
    if (
      expected.kind === 'generate_candidate' &&
      receipt.result.status === 'complete' &&
      !receipt.candidate
    ) {
      throw new GearError(
        'missing-generated-candidate',
        'Successful generation requires an immutable candidate identity',
      )
    }
    if (
      receipt.candidate &&
      (expected.kind !== 'generate_candidate' ||
        receipt.candidate.id !== expected.candidate_id ||
        receipt.candidate.parent_id !== expected.parent_id ||
        !/^sha256:[0-9a-f]{64}$/u.test(receipt.candidate.digest))
    ) {
      throw new GearError(
        'invalid-generated-candidate',
        'Generated candidate identity does not match the operation',
      )
    }
    validateProjectionReceipt(request, receipt)
    receipt = {
      ...receipt,
      evidence: receipt.evidence.map((cell) =>
        bindRawMetrics(
          cell,
          journal.spec,
          journal.candidates.find((candidate) => candidate.id === cell.candidate_id)!.digest,
        ),
      ),
    }
    const merged = request.projection
      ? mergeProjectedEvidence(journal, request, receipt.evidence)
      : mergeEvaluationEvidence(journal, operation, receipt.evidence)
    operation.status = 'complete'
    operation.receipt = receipt
    journal.physicalAttempts += receipt.physicalAttempts
    if (receipt.candidate) journal.candidates.push(receipt.candidate)
    if (request.partition === 'seed') journal.seedEvidence = merged
    else journal.heldOutEvidence = merged
    if (request.partition === 'seed') journal.completed.push(receipt.result)
    await this.store.write(journal)
  }

  private async finalize(journal: RunJournal, signal: AbortSignal): Promise<void> {
    const nominee = journal.nomineeId!,
      spec = journal.spec
    const seed = this.compare(journal, 'seed', nominee)
    if (!seed.complete) journal.gate = { status: 'incomplete', reason: 'Incomplete comparable seed evidence' }
    else if (!seed.constraints_passed)
      journal.gate = { status: 'rejected', reason: 'Frozen seed objective constraints or protection failed' }
    else if (seed.gain! <= spec.acceptance.minimumGain)
      journal.gate = {
        status: 'rejected',
        reason: 'Seed improvement does not meet the frozen acceptance rule',
      }
    else if (spec.validationMode === 'research')
      journal.gate = { status: 'accepted', reason: 'Shared-set research; no independent validation' }
    else {
      if (!journal.operations.some((item) => item.request.partition === 'held_out')) {
        const operations = [spec.anchor.id, nominee].map((candidate) =>
          this.reserve(
            journal,
            {
              kind: 'evaluate_seed',
              candidate_id: candidate,
              parent_id: null,
              task_ids: spec.heldOutTaskIds,
              scope: 'held_out',
              rationale: 'Frozen final gate',
              payload: null,
            },
            `gate:${candidate}`,
            'held_out',
          ),
        )
        this.checkBudget(journal, operations)
        journal.operations.push(...operations)
        await this.store.write(journal)
      }
      await this.drain(journal, signal)
      const compared = this.compare(journal, 'held_out', nominee)
      journal.gate = !compared.complete
        ? { status: 'incomplete', reason: 'Incomplete held-out evidence' }
        : !compared.constraints_passed
          ? { status: 'rejected', reason: 'Frozen held-out objective constraints or protection failed' }
          : compared.gain! < -spec.acceptance.maxHeldOutRegression
            ? { status: 'rejected', reason: 'Held-out regression exceeds the frozen limit' }
            : { status: 'accepted', reason: 'Independent held-out gate passed' }
    }
    await this.checkOwner(journal, signal)
    // Persist gate/nomination intent before the global champion CAS.
    await this.store.write(journal)
    if (journal.gate.status === 'accepted') {
      await this.store.commitChampion(journal)
      journal.championId = nominee
    }
    journal.status = 'completed'
    await this.store.write(journal)
  }

  private compare(journal: RunJournal, partition: 'seed' | 'held_out', candidate: string) {
    return this.objective.compare({
      evidence: partition === 'seed' ? journal.seedEvidence : journal.heldOutEvidence,
      task_ids:
        partition === 'seed' ? journal.spec.seedTasks.map((task) => task.id) : journal.spec.heldOutTaskIds,
      repetitions: journal.spec.budget.repetitions,
      candidate_id: candidate,
      anchor_id: journal.spec.anchor.id,
      partition,
      objective: journal.spec.objective ?? null,
    })
  }
  private async checkOwner(journal: RunJournal, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (await this.store.cancelled(journal.id))
      throw new GearError('run-cancelled', 'Cancellation requested', { run_id: journal.id })
    if ((await this.store.read(journal.id)).generation !== journal.generation)
      throw new GearError('stale-run-owner', 'A newer worker owns this run')
  }
}
