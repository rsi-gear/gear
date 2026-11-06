import { assert } from './contracts.mjs'

/** Include task setup, execution and collection in the caller's persisted wall budget. */
export async function withinDeadline(backend, request, expiresAt, execute, { signal } = {}) {
  const remaining = expiresAt - Date.now()
  if (remaining <= 0) await backend.cancel?.(request)
  assert(remaining > 0, 'operation wall budget expired; inspect the original run without resubmitting')
  const deadline = new AbortController()
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal
  const timer = setTimeout(() => deadline.abort(new Error('operation wall budget exhausted')), Math.ceil(remaining))
  try { combined.throwIfAborted(); return await execute(combined) }
  catch (error) {
    if (combined.aborted) await backend.cancel?.(request)
    throw error
  } finally { clearTimeout(timer) }
}

export async function withOperatorCancellation(execute) {
  const controller = new AbortController(), cancel = () => controller.abort(new Error('operator cancelled'))
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel)
  try { return await execute(controller.signal) }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel) }
}
