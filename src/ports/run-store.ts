import type { RunJournal } from '../domain/run.js'

/** Runtime persistence authority; no provider or algorithm receives this port. */
export interface RunJournalStore {
  read(id: string): Promise<RunJournal>
  /** Cancellation-only writes may preserve damaged derived archives; facts cannot change. */
  write(journal: RunJournal, options?: { cancellationOnly?: boolean }): Promise<void>
  locked<T>(id: string, action: () => Promise<T>): Promise<T>
  cancelled(id: string): Promise<boolean>
  commitChampion(journal: RunJournal): Promise<void>
}
