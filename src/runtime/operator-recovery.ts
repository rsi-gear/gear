import { canonicalDigest } from '../domain/canonical.js'
import { GearError } from '../domain/errors.js'
import {
  generationBudget,
  generationMetrics,
  validateGenerationBudget,
  type GenerationBudget,
} from '../domain/generation-budget.js'
import type { MetaRecovery, ResumeOptions, RunJournal } from '../domain/run.js'
import type { OperationRequest } from '../ports/operations.js'
import {
  effectiveGenerationBudget,
  generationLedger,
  reserveGeneration,
  validateGenerationReservations,
} from './generation-budget.js'

function fail(message: string): never {
  throw new GearError('meta-recovery-not-allowed', message)
}
const body = ({
  operationId: _id,
  generation: _generation,
  generationLimits: _limits,
  ...rest
}: OperationRequest) => rest
const retryId = (id: string, { operationId: _ignored, ...request }: OperationRequest) =>
  canonicalDigest([id, request])

function increasedBudget(previous: GenerationBudget, update: GenerationBudget): GenerationBudget {
  const next: GenerationBudget = {
    version: 1,
    total: { ...previous.total, ...update.total },
    perOperation: { ...previous.perOperation, ...update.perOperation },
  }
  validateGenerationBudget(next)
  for (const group of ['total', 'perOperation'] as const)
    for (const metric of generationMetrics)
      if ((next[group][metric] ?? Infinity) < (previous[group][metric] ?? Infinity))
        fail('Recovery cannot lower historical limits or add limits to previously unbounded work')
  return next
}

/** Validate recovery links without granting an algorithm any retry or budget authority. */
export function validateMetaRecoveries(journal: RunJournal): void {
  let previousBudget = journal.spec.generationBudget
  const sources = new Set<string>(),
    ids = new Set<string>()
  for (const recovery of journal.metaRecoveries ?? []) {
    const source = journal.operations.find((op) => op.request.operationId === recovery.sourceOperationId)
    const retry = journal.operations.find((op) => op.request.operationId === recovery.operationId)
    const call = journal.operators?.calls.find((entry) => entry.id === recovery.callId)
    if (
      recovery.version !== 1 ||
      recovery.stopped !== true ||
      !/^recovery_[a-f0-9]{64}$/u.test(recovery.id) ||
      ids.has(recovery.id) ||
      sources.has(recovery.sourceOperationId) ||
      recovery.id !==
        `recovery_${canonicalDigest([journal.id, recovery.sourceJournalDigest, recovery.sourceOperationId, recovery.requestDigest]).slice(7)}` ||
      recovery.requestDigest !==
        canonicalDigest({ operationId: recovery.sourceOperationId, update: recovery.generationUpdate }) ||
      !source ||
      !retry ||
      !call ||
      call.call.effect.kind !== 'meta' ||
      source.status !== 'complete' ||
      source.receipt?.result.status !== 'failed' ||
      source.generationViolation ||
      canonicalDigest(source.receipt) !== recovery.sourceReceiptDigest ||
      source.request.operation.kind !== 'diagnose_seed' ||
      source.request.operatorCall?.callId !== call.id ||
      retry.request.operationId === source.request.operationId ||
      retry.request.operationId !== retryId(recovery.id, retry.request) ||
      journal.operations.indexOf(source) >= journal.operations.indexOf(retry) ||
      canonicalDigest(body(source.request)) !== canonicalDigest(body(retry.request)) ||
      recovery.previousResult.status !== 'failed' ||
      recovery.previousResult.ref.key !== call.call.key ||
      recovery.previousResult.ref.request_digest !== call.requestDigest ||
      generationMetrics.some(
        (key) => !Number.isSafeInteger(source.receipt!.usage[key]) || Number(source.receipt!.usage[key]) < 0,
      )
    )
      fail('Saved Meta recovery does not match its failed attempt and frozen call')
    if (recovery.terminalStepId !== null) {
      const terminal = journal.operators!.decisions.find((d) => d.stepId === recovery.terminalStepId)
      if (
        terminal?.decision.terminal?.kind !== 'stop' ||
        canonicalDigest(terminal.decision.state) !== recovery.stateDigest
      )
        fail('Saved recovery does not match its stopped algorithm state')
    }
    validateGenerationBudget(recovery.generationUpdate)
    previousBudget = increasedBudget(previousBudget, recovery.generationUpdate)
    if (canonicalDigest(previousBudget) !== canonicalDigest(recovery.generationBudget))
      fail('Saved recovery budget does not match its explicit amendment')
    ids.add(recovery.id)
    sources.add(recovery.sourceOperationId)
  }
}

export function resumedTerminal(journal: RunJournal, stepId: number): boolean {
  return (journal.metaRecoveries ?? []).some((recovery) => recovery.terminalStepId === stepId)
}

/** Pure admission: completed work and author state remain byte-for-byte equivalent. */
export function planMetaRecovery(journal: RunJournal, options: ResumeOptions) {
  if (!options || Object.keys(options).some((key) => !['retry_operation', 'generation'].includes(key)))
    fail('Invalid resume options')
  const operationId = options.retry_operation
  if (!operationId || !/^sha256:[a-f0-9]{64}$/u.test(operationId))
    fail('Recovery requires an exact failed operation ID')
  const update = generationBudget(options.generation ?? {})
  const requestDigest = canonicalDigest({ operationId, update })
  validateMetaRecoveries(journal)
  const existing = journal.metaRecoveries?.find((item) => item.sourceOperationId === operationId)
  if (existing) {
    if (existing.requestDigest !== requestDigest)
      fail('This failed attempt already has different recovery options')
    return { journal, recovery: existing, alreadyApplied: true }
  }
  if (
    journal.status === 'cancelled' ||
    journal.status === 'running' ||
    journal.spec.algorithm.protocol_version !== 2 ||
    !journal.operators
  )
    fail('Only a stopped v2 run can retry a failed Meta operation')
  if (
    journal.nomineeId ||
    journal.operations.some((op) => op.status !== 'complete' || op.generationViolation)
  )
    fail('All prior operations must be settled without metering violations')
  const ledger = generationLedger(journal)
  if (
    generationMetrics.some(
      (key) =>
        ledger.metrics[key].unknown_operations > 0 || ledger.metrics[key].accounted_upper_bound === null,
    )
  )
    fail('Unknown generation usage must remain held and cannot be retried')
  const source = journal.operations.find((op) => op.request.operationId === operationId)
  const call = journal.operators.calls.find((entry) => entry.operationIds.includes(operationId))
  if (
    !source ||
    !call ||
    call.call.effect.kind !== 'meta' ||
    call.status !== 'complete' ||
    call.result?.status !== 'failed' ||
    call.operationIds.length !== 1 ||
    source.request.operation.kind !== 'diagnose_seed' ||
    source.receipt?.result.status !== 'failed' ||
    source.request.operatorCall?.callId !== call.id ||
    source.receipt.candidate
  )
    fail('Retry requires a failed read-only Meta call and its unchanged terminal receipt')
  if (
    journal.operators.calls.some(
      (entry) =>
        entry.id !== call.id && (entry.status !== 'complete' || entry.result?.status !== 'succeeded'),
    )
  )
    fail('Other operator calls must have completed successfully')
  const decisions = journal.operators.decisions
  const producer = decisions.findLast((d) => d.callIds.includes(call.id))
  if (
    !producer ||
    producer.callIds.length !== 1 ||
    canonicalDigest(producer.decision.state) !== canonicalDigest(journal.operators.state)
  )
    fail('The algorithm has advanced beyond the failed Meta checkpoint')
  const later = decisions.filter((d) => d.stepId > producer.stepId)
  if (
    later.some(
      (d) =>
        d.callIds.length ||
        d.decision.terminal?.kind !== 'stop' ||
        canonicalDigest(d.decision.state) !== canonicalDigest(producer.decision.state),
    )
  )
    fail('Only an unchanged terminal stop may follow the failed Meta call')
  const terminal = decisions.at(-1)
  if (journal.status === 'completed' && terminal?.decision.terminal?.kind !== 'stop')
    fail('Completed runs require the failed Meta checkpoint and a terminal stop')
  const next = structuredClone(journal)
  const budget = increasedBudget(effectiveGenerationBudget(journal), update)
  const id = `recovery_${canonicalDigest([journal.id, journal.digest, operationId, requestDigest]).slice(7)}`
  const recovery: MetaRecovery = {
    version: 1,
    id,
    createdAt: new Date().toISOString(),
    requestDigest,
    generationUpdate: update,
    sourceJournalDigest: journal.digest,
    sourceOperationId: operationId,
    sourceReceiptDigest: canonicalDigest(source.receipt),
    operationId: '',
    callId: call.id,
    previousResult: structuredClone(call.result),
    stateDigest: canonicalDigest(journal.operators.state),
    terminalStepId: terminal?.decision.terminal?.kind === 'stop' ? terminal.stepId : null,
    generationBudget: budget,
    stopped: true,
  }
  next.metaRecoveries = [...(next.metaRecoveries ?? []), recovery]
  let limits = reserveGeneration(next)
  const maximum = call.call.effect.input.max_tokens
  if (maximum !== null) limits = { ...limits, tokens: Math.min(limits?.tokens ?? maximum, maximum) }
  const request = { ...structuredClone(source.request), generation: journal.generation + 1 }
  if (limits) request.generationLimits = limits
  else delete request.generationLimits
  request.operationId = retryId(id, request)
  recovery.operationId = request.operationId
  const target = next.operators!.calls.find((entry) => entry.id === call.id)!
  target.operationIds = [request.operationId]
  target.status = 'reserved'
  delete target.result
  next.operations.push({ request, status: 'reserved', reservedAttempts: 0 })
  next.status = 'ready'
  delete next.failure
  validateMetaRecoveries(next)
  validateGenerationReservations(next)
  return { journal: next, recovery, alreadyApplied: false }
}

/** Failed attempts remain visible; only a successful descendant closes their recovery. */
export function recoveredMetaOperations(journal: RunJournal): string[] {
  validateMetaRecoveries(journal)
  return (journal.metaRecoveries ?? []).flatMap((recovery) => {
    let id = recovery.operationId
    for (let count = 0; count < (journal.metaRecoveries?.length ?? 0); count++) {
      const successor = journal.metaRecoveries!.find((item) => item.sourceOperationId === id)
      if (!successor) break
      id = successor.operationId
    }
    const operation = journal.operations.find((op) => op.request.operationId === id)
    const call = journal.operators?.calls.find((entry) => entry.id === recovery.callId)
    return operation?.status === 'complete' &&
      operation.receipt?.result.status === 'complete' &&
      call?.result?.status === 'succeeded' &&
      call.operationIds.includes(id)
      ? [recovery.sourceOperationId]
      : []
  })
}
