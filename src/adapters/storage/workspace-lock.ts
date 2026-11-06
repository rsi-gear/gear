import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { publishFile } from './atomic.js'

interface LockRecord {
  pid: number
  token: string
  acquiredAt: string
  roundId?: string
}

export interface WorkspaceLock {
  readonly token: string
  assertHeld(stateRoot: string): Promise<void>
  retarget(roundId: string): Promise<void>
  release(): Promise<void>
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}
async function readRecord(path: string): Promise<LockRecord | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as LockRecord
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
async function atomicWrite(path: string, value: unknown): Promise<void> {
  await publishFile(path, json(value))
}

function isAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class RoundAlreadyRunningError extends Error {
  constructor(readonly owner?: LockRecord) {
    super(
      owner === undefined
        ? 'a refinement round already owns the workspace lock'
        : `refinement round lock is owned by pid ${owner.pid} since ${owner.acquiredAt}`,
    )
    this.name = 'RoundAlreadyRunningError'
  }
}

// Retains the ownership protocol used by existing resource-retention records.
export async function acquireWorkspaceLock(root: string, roundId?: string): Promise<WorkspaceLock> {
  const locksPath = join(root, 'locks')
  await mkdir(locksPath, { recursive: true })
  const lockPath = join(locksPath, 'round.lock')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = crypto.randomUUID()
    const record: LockRecord = {
      pid: process.pid,
      token,
      acquiredAt: new Date().toISOString(),
      ...(roundId === undefined ? {} : { roundId }),
    }
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      try {
        await handle.writeFile(json(record), 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      let released = false
      return {
        token,
        assertHeld: async (stateRoot: string): Promise<void> => {
          if (released || resolve(stateRoot) !== resolve(root))
            throw new Error('workspace lock is released or belongs to another evolution')
          const current = await readRecord(lockPath)
          if (current?.token !== token || current.pid !== process.pid)
            throw new Error('workspace lock ownership changed')
        },
        retarget: async (roundId: string): Promise<void> => {
          if (released) throw new Error('cannot retarget a released workspace lock')
          const current = await readRecord(lockPath)
          if (current?.token !== token)
            throw new Error('refusing to retarget a workspace lock owned by another process')
          await atomicWrite(lockPath, { ...current, roundId })
        },
        async release(): Promise<void> {
          if (released) return
          released = true
          let current: LockRecord | undefined
          try {
            current = JSON.parse(await readFile(lockPath, 'utf8')) as LockRecord
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
            throw error
          }
          if (current.token !== token)
            throw new Error('refusing to release a workspace lock owned by another process')
          await unlink(lockPath)
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const owner = await readRecord(lockPath)
      if (attempt === 0 && owner !== undefined && !isAlive(owner.pid)) {
        // Serialize stale-owner recovery. A crashed recovery guard requires
        // explicit inspection; it may retain a lock, never delete a new one.
        const guardPath = `${lockPath}.recovery`
        let guard
        try {
          guard = await open(guardPath, 'wx', 0o600)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new RoundAlreadyRunningError(owner)
          throw error
        }
        try {
          const current = await readRecord(lockPath)
          if (current?.token === owner.token && current.pid === owner.pid && !isAlive(current.pid))
            await unlink(lockPath)
        } finally {
          await guard.close()
          await unlink(guardPath)
        }
        continue
      }
      throw new RoundAlreadyRunningError(owner)
    }
  }
  throw new RoundAlreadyRunningError()
}
