import { expect, it } from 'vitest'
import { hitchTrialDetails } from '../../src/adapters/hitch/trial-details.js'
import type { HitchArtifactReader } from '../../src/adapters/hitch/trajectory.js'
import type { TrialArtifact } from '../../src/domain/algorithm-wire.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
const artifact: TrialArtifact = {
  kind: 'trajectory',
  format: 'fixture',
  task_id: 'a',
  repetition: 0,
  status: 'available',
  content_digest: canonicalDigest('trace'),
  reason: null,
  locator: { run_id: 'run_' + 'a'.repeat(32) },
}
const call = async () => ({
  schema_version: '1',
  record_status: 'valid',
  record: { run_id: 'run_' + 'a'.repeat(32), status: 'succeeded' },
})
it('keeps missing target metering unknown and does not publish an intermediate answer after a failed page', async () => {
  let reads = 0
  const reader = {
    async read() {
      if (reads++) throw new Error('page unavailable')
      return {
        events: [
          {
            data: {
              message: { content: [{ type: 'text', text: 'intermediate' }] },
              usage: { inputTokens: 5, outputTokens: 3 },
            },
          },
        ],
        eof: false,
        next_cursor: 'next',
      }
    },
  } as unknown as HitchArtifactReader
  const result = await hitchTrialDetails(call, reader, artifact, new AbortController().signal)
  expect(result).toMatchObject({ execution_status: 'finished', output: null, usage: null })
})
it('returns complete bounded text while marking assistant-only token counts partial', async () => {
  const reader = {
    async read() {
      return {
        events: [
          {
            data: {
              message: { content: [{ type: 'text', text: 'final answer' }] },
              usage: { inputTokens: 5, outputTokens: 3 },
            },
          },
        ],
        eof: true,
      }
    },
  } as unknown as HitchArtifactReader
  const result = await hitchTrialDetails(call, reader, artifact, new AbortController().signal)
  expect(result.output).toBe('final answer')
  expect(result.usage).toMatchObject({ total_tokens: 8, complete: false })
  const oversized = {
    async read() {
      return {
        events: [{ data: { message: { content: [{ type: 'text', text: 'x'.repeat(65537) }] } } }],
        eof: true,
      }
    },
  } as unknown as HitchArtifactReader
  expect((await hitchTrialDetails(call, oversized, artifact, new AbortController().signal)).output).toBeNull()
})
