import type { TrialArtifact, TrialDetail, Json } from '../../domain/algorithm-wire.js'
import type { ObservationCall } from './observation.js'
import type { HitchArtifactReader } from './trajectory.js'

/** Read-only public observations. Missing metering stays unknown rather than becoming zero. */
export async function hitchTrialDetails(
  call: ObservationCall,
  reader: HitchArtifactReader,
  artifact: TrialArtifact,
  signal: AbortSignal,
): Promise<TrialDetail> {
  const detail: TrialDetail = {
    task_id: artifact.task_id,
    repetition: artifact.repetition,
    output: null,
    usage: null,
    execution_status: null,
  }
  const run = artifact.locator as { run_id: string }
  try {
    const inspected = await call(['runs', 'inspect', run.run_id, '--json'], signal, 30000)
    const record = inspected.record as { run_id?: string; status?: string } | undefined
    if (
      inspected.schema_version === '1' &&
      inspected.record_status === 'valid' &&
      record?.run_id === run.run_id
    )
      detail.execution_status =
        record.status === 'succeeded'
          ? 'finished'
          : ['failed', 'timed_out', 'cancelled'].includes(record.status ?? '')
            ? 'error'
            : null
  } catch {
    signal.throwIfAborted()
  }
  if (artifact.status !== 'available') return detail
  try {
    let cursor: string | undefined,
      complete = false,
      input = 0,
      output = 0,
      metered = 0,
      finalText: string | null = null
    for (let pageIndex = 0; pageIndex < 128; pageIndex++) {
      const page = (await reader.read(
        artifact,
        { limit: 20, types: ['assistant/message'], ...(cursor ? { cursor } : {}) },
        signal,
      )) as {
        events: Array<{
          data?: {
            message?: { content?: Array<{ type?: string; text?: string }> }
            usage?: Record<string, Json>
          }
        }>
        eof: boolean
        next_cursor?: string
      }
      for (const event of page.events) {
        const text = event.data?.message?.content
          ?.filter((block) => block.type === 'text')
          .map((block) => block.text ?? '')
          .join('')
        if (text) finalText = text.length <= 65536 ? text : null
        const usage = event.data?.usage
        if (
          usage &&
          ['inputTokens', 'outputTokens'].every(
            (key) => Number.isSafeInteger(usage[key]) && (usage[key] as number) >= 0,
          )
        ) {
          input += usage.inputTokens as number
          output += usage.outputTokens as number
          metered++
        }
      }
      if (page.eof) {
        complete = true
        break
      }
      cursor = page.next_cursor
    }
    if (complete) detail.output = finalText
    // Assistant-event counts do not certify hidden delegated work or unreported cache usage.
    if (complete && metered)
      detail.usage = {
        input_tokens: input,
        output_tokens: output,
        total_tokens: input + output,
        complete: false,
        source: 'hitch-canonical-assistant-messages',
      }
  } catch {
    signal.throwIfAborted()
  }
  return detail
}
