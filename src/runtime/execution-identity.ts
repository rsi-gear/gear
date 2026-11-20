import type { RunJournal } from '../domain/run.js'
import type { ExecutionIdentity } from '../ports/operations.js'

export function effectiveExecutionIdentity(journal: RunJournal): ExecutionIdentity {
  return (
    journal.metaRecoveries?.findLast((recovery) => recovery.execution)?.execution?.to ?? {
      provider: journal.spec.providerIdentity,
      evaluation: journal.spec.evaluationIdentity ?? journal.spec.providerIdentity,
    }
  )
}
