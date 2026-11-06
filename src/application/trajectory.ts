import { join } from 'node:path'
import type { Evidence } from '../domain/algorithm-wire.js'
import type { JournalOperation, RunJournal } from '../domain/run.js'
import type { TrajectoryReference } from '../domain/trajectory.js'
import { canonicalDigest } from '../domain/canonical.js'
import { TrajectoryStore } from '../adapters/storage/trajectory.js'
import type { BaselineProof } from './baseline.js'

const slot = (cell: Evidence) => JSON.stringify([cell.candidate_id, cell.task_id, cell.repetition])
const outcome = (cell: Evidence) => canonicalDigest([cell.score, cell.status])

/** Bind current seed observations to original executions, excluding metric-only projections. */
export class SeedTrajectoryArchive {
  readonly sources = new Map<string, { operation: JournalOperation; cell: Evidence }>()
  readonly store: TrajectoryStore
  private readonly saved = new Map<string, TrajectoryReference>()
  private readonly receiptDigests = new Map<JournalOperation, string>()
  constructor(
    readonly runRoot: string,
    readonly journal: RunJournal,
    baseline?: BaselineProof | null,
  ) {
    this.store = new TrajectoryStore(join(runRoot, 'trajectory-sources'))
    for (const operation of [...(baseline?.operations ?? []), ...journal.operations]) {
      if (
        operation.status !== 'complete' ||
        operation.request.partition !== 'seed' ||
        operation.request.operation.kind !== 'evaluate_seed' ||
        operation.request.projection ||
        !operation.receipt
      )
        continue
      for (const original of operation.receipt.evidence) {
        const cell =
          operation.request.runId === journal.id
            ? original
            : { ...original, candidate_id: journal.spec.anchor.id }
        this.sources.set(slot(cell), { operation, cell })
      }
    }
  }
  async references(candidates: string[], tasks: string[]): Promise<TrajectoryReference[]> {
    const descriptor = this.journal.spec.artifactReader
    if (!descriptor) return []
    const output: TrajectoryReference[] = []
    for (const cell of this.journal.seedEvidence) {
      if (!candidates.includes(cell.candidate_id) || !tasks.includes(cell.task_id)) continue
      const source = this.sources.get(slot(cell))
      if (!source || outcome(source.cell) !== outcome(cell)) continue
      const artifact = source.operation.receipt!.artifacts?.find(
        (item) =>
          item.kind === 'trajectory' &&
          item.format === descriptor.format &&
          item.task_id === cell.task_id &&
          item.repetition === cell.repetition,
      )
      if (!artifact) continue
      const cached = this.saved.get(slot(cell))
      if (cached) {
        output.push(cached)
        continue
      }
      let receiptDigest = this.receiptDigests.get(source.operation)
      if (!receiptDigest) {
        receiptDigest = canonicalDigest(source.operation.receipt)
        this.receiptDigests.set(source.operation, receiptDigest)
      }
      const binding = await this.store.save({
        version: 1,
        run_id: this.journal.id,
        candidate_id: cell.candidate_id,
        operation_id: source.operation.request.operationId,
        origin_run_id: source.operation.request.runId,
        origin_candidate_id: source.operation.request.operation.candidate_id!,
        receipt_digest: receiptDigest,
        reader_identity: canonicalDigest(descriptor),
        partition: 'seed',
        artifact,
      })
      const reference: TrajectoryReference = {
        ref: 'trajectory:' + binding.digest.slice(7),
        candidate_id: cell.candidate_id,
        task_id: cell.task_id,
        repetition: cell.repetition,
        status: artifact.status,
        content_digest: artifact.content_digest,
        reason: artifact.reason,
      }
      output.push(reference)
      this.saved.set(slot(cell), reference)
    }
    return output
  }
}
