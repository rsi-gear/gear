import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RefineStateStore, RoundAlreadyRunningError } from '../../src/state/store.js'
import { evidence, roundFixture } from '../helpers/research-fixture.js'

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
    const parent = 'a'.repeat(40)
    const candidate = 'b'.repeat(40)
    await state.writeChampion({ schemaVersion: 2, ref: parent, manifestDigest: `sha256:${'1'.repeat(64)}`, updatedAt: 'now' })
    await state.compareAndSwapChampion(parent, {
      schemaVersion: 2, ref: candidate, manifestDigest: `sha256:${'2'.repeat(64)}`, updatedAt: 'later', roundId: 'round-1',
    })
    expect((await state.readChampion())?.ref).toBe(candidate)
    await expect(state.compareAndSwapChampion(parent, {
      schemaVersion: 2, ref: 'c'.repeat(40), manifestDigest: `sha256:${'3'.repeat(64)}`, updatedAt: 'never',
    })).rejects.toThrow(/CAS failed/)
    expect(JSON.parse(await readFile(join(state.root, 'champion.json'), 'utf8'))).toMatchObject({ ref: candidate })
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

  it('rejects persisted artifact-era state instead of confusing sha256 identities with commits', async () => {
    const state = await store()
    await state.initialize()
    await writeFile(join(state.root, 'champion.json'), JSON.stringify({
      ref: `sha256:${'a'.repeat(64)}`, digest: `sha256:${'b'.repeat(64)}`, artifactPath: '/old', updatedAt: 'old',
    }))
    await expect(state.readChampion()).rejects.toThrow(/unsupported champion state schema/)
  })

  it('persists provider-neutral evaluation evidence without Hitch-only transport fields', async () => {
    const state = await store()
    const round = roundFixture({ status: 'preparing-candidate' })
    const hitch = evidence(round.plan.seed, round.targetHarnessRef)
    const { invocationFingerprint: _fingerprint, localSourceTransport: _transport, ...generic } = hitch
    round.baseline = { ...generic, provider: 'custom-runner', evalId: 'custom-eval-1' }
    await state.writeRound(round)
    await expect(state.readRound(round.roundId)).resolves.toMatchObject({
      baseline: { provider: 'custom-runner', evalId: 'custom-eval-1' },
    })
  })
})
