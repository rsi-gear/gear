import { canonicalDigest } from './canonical.js'
import { GearError } from './errors.js'
import type { RunJournal } from './run.js'

/** Authorization progress is reconstructed solely from successful exclusive completion receipts. */
export function validateTaskStream(journal: RunJournal): void {
  const order = journal.spec.operatorPolicy?.access?.task_order,
    progress = journal.operators?.stream
  const fail = () => {
    throw new GearError(
      'task-stream-identity',
      'Task stream progress differs from its committed completion receipts',
    )
  }
  if (!order) {
    if (progress) fail()
    return
  }
  if (!progress || progress.index !== progress.completed.length || progress.index > order.length)
    return fail()
  let revision = canonicalDigest([journal.id, 'task-stream', order])
  for (const [index, completion] of progress.completed.entries()) {
    const call = journal.operators!.calls.find((entry) => entry.id === completion.call_id)
    if (
      !call ||
      call.call.effect.kind !== 'stream' ||
      call.result?.status !== 'succeeded' ||
      call.call.effect.input.expected_revision !== revision ||
      call.call.effect.input.task_id !== order[index]
    )
      return fail()
    const input = call.call.effect.input
    const next = canonicalDigest([revision, call.id, input])
    const expected = {
      call_id: call.id,
      task_id: input.task_id,
      sample_id: input.sample_id,
      output: input.output,
      library_refs: input.library_refs,
      previous_revision: revision,
      revision: next,
    }
    if (
      canonicalDigest(expected) !== canonicalDigest(completion) ||
      !journal.operators!.decisions.some(
        (decision) => decision.callIds.length === 1 && decision.callIds[0] === call.id,
      )
    )
      return fail()
    revision = next
  }
  if (progress.revision !== revision) fail()
}
