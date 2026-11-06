import type { RunJournal } from '../domain/run.js'
import type { OperationCancellation } from '../ports/operations.js'
import type { RunJournalStore } from '../ports/run-store.js'
import { GearError } from '../domain/errors.js'

/** A failure to stop one operation must not prevent fencing the others. */
export async function confirmCancellation(
  journal: RunJournal,
  cancel: OperationCancellation['cancel'],
): Promise<boolean> {
  const results = await Promise.allSettled(
    journal.operations
      .filter((operation) => operation.status === 'submitted')
      .map(async (operation) => cancel(structuredClone(operation.request))),
  )
  return results.every((result) => result.status === 'fulfilled')
}

/** Call only while holding the run owner lock, after persisting the cancellation fence. */
export async function finishCancellation(
  store: RunJournalStore,
  journal: RunJournal,
  cancel: OperationCancellation['cancel'],
): Promise<void> {
  const confirmed = await confirmCancellation(journal, cancel)
  journal.generation++
  journal.status = confirmed ? 'cancelled' : 'needs_recovery'
  journal.failure = {
    code: confirmed ? 'run-cancelled' : 'cancellation-unconfirmed',
    message: confirmed ? 'Cancellation requested' : 'External work has not been confirmed stopped',
    retryable: !confirmed,
  }
  await store.write(journal, { cancellationOnly: true })
  if (!confirmed)
    throw new GearError('cancellation-unconfirmed', journal.failure.message, {
      retryable: true,
      run_id: journal.id,
    })
}
