import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { JsonRpcPeer } from '../../src/worker/peer.js'

describe('JsonRpcPeer', () => {
  it('supports symmetric server-to-client requests over one line transport', async () => {
    const aToB = new PassThrough()
    const bToA = new PassThrough()
    const a = new JsonRpcPeer(bToA, aToB)
    const b = new JsonRpcPeer(aToB, bToA)
    b.handle('session/open', params => ({ opened: true, id: params.sessionId }))
    a.handle('control/refine.run', params => ({ roundId: `round-${params.workerSessionId}` }))
    await expect(a.request('session/open', { sessionId: 's1' })).resolves.toEqual({ opened: true, id: 's1' })
    await expect(b.request('control/refine.run', { workerSessionId: 's1' })).resolves.toEqual({ roundId: 'round-s1' })
    a.close()
    b.close()
  })

  it('returns a protocol error for unknown methods', async () => {
    const aToB = new PassThrough()
    const bToA = new PassThrough()
    const a = new JsonRpcPeer(bToA, aToB)
    const b = new JsonRpcPeer(aToB, bToA)
    await expect(a.request('missing')).rejects.toThrow(/unknown method/)
    a.close()
    b.close()
  })
})
