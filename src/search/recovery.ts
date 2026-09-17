import { invariant, SearchProtocolError } from './contracts.js';
import { SearchBudgetExceeded, type SearchJournal } from './store.js';
import type { EvidenceCell, ExternalRecovery, PendingSearchOperation, SearchStageFailure } from './types.js';

/** Providers may throw this only after verifying that the external execution is terminal. */
export class SearchExecutionFailure extends Error {
  readonly failure: SearchStageFailure
  constructor(code: string, message: string, evidenceRef: string, readonly cells: EvidenceCell[] = []) {
    super(message); this.name = 'SearchExecutionFailure'
    invariant(code.length > 0 && evidenceRef.length > 0, 'terminal execution failure requires provider provenance')
    this.failure = { kind: 'execution-failure', code, message, evidenceRef }
  }
}
export class SearchOperationPending extends Error {
  constructor(readonly operation: PendingSearchOperation) {
    super(`${operation.kind} operation pending: ${operation.reason}`); this.name = 'SearchOperationPending'
  }
}
export function budgetFailure(resource: string): SearchStageFailure {
  return { kind: 'budget-exhausted', code: resource, message: `search budget exhausted: ${resource}` }
}
/** The deadline stops new work; immutable result reads and commit reconciliation remain possible. */
export function searchDeadline(caller: AbortSignal, deadlineAt: number): { signal: AbortSignal; dispose(): void } {
  const budget = new AbortController()
  const expire = () => budget.abort(new SearchBudgetExceeded('time'))
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = () => {
    const duration = deadlineAt - Date.now()
    if (duration <= 0) expire()
    else { timer = setTimeout(tick, Math.min(duration, 2 ** 31 - 1)); timer.unref() }
  }
  tick()
  return { signal: AbortSignal.any([caller, budget.signal]), dispose: () => { if (timer) clearTimeout(timer) } }
}
/** Only provider calls belong inside run. Journal/verification errors must escape unchanged. */
export async function recoverExternal<T>(input: {
  store: SearchJournal; roundId: string; operation: Omit<PendingSearchOperation, 'state' | 'reason'>
  signal: AbortSignal; inspectionSignal: AbortSignal; previouslyReserved: boolean
  run(): Promise<T>; inspect?(signal: AbortSignal): Promise<ExternalRecovery<T>>
  failed(failure: SearchStageFailure, cells: EvidenceCell[]): T
}): Promise<{ value: T; notStarted: boolean }> {
  const { signal, inspectionSignal } = input
  const expired = () => signal.aborted && signal.reason instanceof SearchBudgetExceeded
  inspectionSignal.throwIfAborted()
  if (signal.aborted && !expired()) signal.throwIfAborted()
  if (expired() && !input.previouslyReserved) return { value: input.failed(budgetFailure('time'), []), notStarted: true }
  let reason = 'deadline reached while external execution was unresolved'
  if (!expired()) {
    try { return { value: await input.run(), notStarted: false } }
    catch (error) {
      inspectionSignal.throwIfAborted()
      if (error instanceof SearchProtocolError) throw error
      if (error instanceof SearchExecutionFailure) return { value: input.failed(error.failure, error.cells), notStarted: false }
      reason = error instanceof Error ? error.message : String(error)
    }
  }
  let state: ExternalRecovery<T> = { status: 'unknown', reason }
  if (input.inspect) {
    try { state = await input.inspect(AbortSignal.any([inspectionSignal, AbortSignal.timeout(10000)])) }
    catch (error) {
      inspectionSignal.throwIfAborted()
      if (error instanceof SearchProtocolError) throw error
      if (error instanceof SearchExecutionFailure) return { value: input.failed(error.failure, error.cells), notStarted: false }
      state = { status: 'unknown', reason: error instanceof Error ? error.message : String(error) }
    }
  }
  invariant(state && ['complete', 'not-started', 'partially-complete', 'running', 'unknown'].includes(state.status), 'invalid external recovery state')
  if (state.status === 'running') invariant(typeof state.handle === 'string' && state.handle.length > 0, 'running recovery needs its original handle')
  if (state.status === 'complete') return { value: state.result, notStarted: false }
  if (state.status === 'partially-complete') {
    invariant(input.operation.kind === 'evaluation' && Array.isArray(state.cells) && state.cells.length > 0, 'partial recovery requires completed evaluation cells')
    if (expired()) return { value: input.failed(budgetFailure('time'), state.cells), notStarted: false }
    reason = 'completed evaluation cells are saved; remaining batches have not started'
  }
  if (state.status === 'not-started' && expired()) return { value: input.failed(budgetFailure('time'), []), notStarted: true }
  return pendingOperation(input.store, input.roundId, { ...input.operation,
    state: state.status, ...(state.status === 'running' ? { handle: state.handle } : {}),
    reason: state.status === 'unknown' ? state.reason ?? reason : reason })
}
export async function pendingOperation(store: SearchJournal, roundId: string, operation: PendingSearchOperation): Promise<never> {
  await store.write(`rounds/${roundId}/pending-operation`, operation)
  throw new SearchOperationPending(operation)
}
export async function resolvePendingOperation(store: SearchJournal, roundId: string, key: string): Promise<void> {
  const pending = await store.read<PendingSearchOperation | null>(`rounds/${roundId}/pending-operation`)
  if (pending?.operationKey === key) await store.write(`rounds/${roundId}/pending-operation`, null)
}
