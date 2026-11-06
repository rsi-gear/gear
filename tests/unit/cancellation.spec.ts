import { expect, it, vi } from 'vitest'
import { confirmCancellation } from '../../src/runtime/cancellation.js'
import type { RunJournal } from '../../src/domain/run.js'
import type { OperationRequest } from '../../src/ports/operations.js'
import { configuredCancellation } from '../../src/application/cancellation.js'
import { canonicalDigest } from '../../src/domain/canonical.js'

it('tries every submitted operation after a synchronous stop failure and never cancels completed or reserved facts', async () => {
  const requests = ['first', 'second', 'reserved', 'complete'].map(operationId => ({ operationId }) as OperationRequest)
  const journal = { operations: requests.map((request, i) => ({ request, status: ['submitted', 'submitted', 'reserved', 'complete'][i] })) } as RunJournal
  const cancel = vi.fn((request: OperationRequest) => {
    if (request.operationId === 'first') throw new Error('unreachable provider')
    return Promise.resolve()
  })
  expect(await confirmCancellation(journal, cancel)).toBe(false)
  expect(cancel.mock.calls.map(([request]) => request.operationId)).toEqual(['first', 'second'])
})
it('does not accept malformed or unspecified cancellation connections', async () => {
  for (const snapshot of [null, {}, { version: 1, kind: 'unknown' }, { version: 1, kind: 'hitch', identity: canonicalDigest('provider'), executable: 'hitch', root: '/tmp', directory: '/tmp' }])
    await expect(configuredCancellation(snapshot)).rejects.toMatchObject({ code: 'cancellation-connection-unavailable' })
})
