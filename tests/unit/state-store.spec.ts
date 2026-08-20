import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RefineStateStore, RoundAlreadyRunningError } from '../../src/state/store.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => new RefineStateStore(root).resetForTests()))
})

async function store(): Promise<RefineStateStore> {
  const root = await mkdtemp(join(tmpdir(), 'refine-state-'))
  roots.push(root)
  return new RefineStateStore(root)
}

describe('RefineStateStore', () => {
  it('atomically persists state and enforces champion CAS', async () => {
    const state = await store()
    await state.initialize()
    await state.writeChampion({ ref: 'parent', digest: 'd1', artifactPath: '/artifact', updatedAt: 'now' })
    await state.compareAndSwapChampion('parent', {
      ref: 'candidate', digest: 'd2', artifactPath: '/candidate', updatedAt: 'later', roundId: 'round-1',
    })
    expect((await state.readChampion())?.ref).toBe('candidate')
    await expect(state.compareAndSwapChampion('parent', {
      ref: 'bad', digest: 'bad', artifactPath: '/bad', updatedAt: 'never',
    })).rejects.toThrow(/CAS failed/)
    expect(JSON.parse(await readFile(join(state.root, 'champion.json'), 'utf8'))).toMatchObject({ ref: 'candidate' })
  })

  it('admits one cross-process owner and release is idempotent', async () => {
    const state = await store()
    const lock = await state.acquireRoundLock()
    await expect(state.acquireRoundLock()).rejects.toBeInstanceOf(RoundAlreadyRunningError)
    await lock.release()
    await lock.release()
    const next = await state.acquireRoundLock()
    await next.release()
  })

  it('reclaims a dead process lock', async () => {
    const state = await store()
    await state.initialize()
    await writeFile(join(state.locksPath, 'round.lock'), JSON.stringify({
      pid: 2_147_483_647, token: 'dead', acquiredAt: 'before',
    }))
    const lock = await state.acquireRoundLock()
    await lock.release()
  })
})
