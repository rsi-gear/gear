import { constants } from 'node:fs'
import { access, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ChampionState, MetaSessionState, RefinementRound } from '../types.js'

interface LockRecord {
  pid: number
  token: string
  acquiredAt: string
  roundId?: string
}

export interface WorkspaceLock {
  readonly token: string
  retarget(roundId: string): Promise<void>
  release(): Promise<void>
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
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
    super(owner === undefined
      ? 'a refinement round already owns the workspace lock'
      : `refinement round lock is owned by pid ${owner.pid} since ${owner.acquiredAt}`)
    this.name = 'RoundAlreadyRunningError'
  }
}

export class RefineStateStore {
  readonly roundsPath: string
  readonly locksPath: string
  readonly verifiersPath: string
  readonly workersPath: string
  readonly metaHarnessPath: string

  constructor(readonly root: string) {
    this.roundsPath = join(root, 'rounds')
    this.locksPath = join(root, 'locks')
    this.verifiersPath = join(root, 'verifiers')
    this.workersPath = join(root, 'workers')
    this.metaHarnessPath = join(root, 'meta-harness')
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.roundsPath, { recursive: true }),
      mkdir(this.locksPath, { recursive: true }),
      mkdir(this.verifiersPath, { recursive: true }),
      mkdir(this.workersPath, { recursive: true }),
      mkdir(this.metaHarnessPath, { recursive: true }),
    ])
  }

  async readChampion(): Promise<ChampionState | undefined> {
    return this.readJson<ChampionState>(join(this.root, 'champion.json'))
  }

  async writeChampion(value: ChampionState): Promise<void> {
    await this.atomicWrite(join(this.root, 'champion.json'), value)
  }

  async compareAndSwapChampion(expectedRef: string, value: ChampionState): Promise<void> {
    const current = await this.readChampion()
    if (current?.ref !== expectedRef) {
      throw new Error(`champion CAS failed: expected ${expectedRef}, found ${current?.ref ?? '<missing>'}`)
    }
    await this.writeChampion(value)
  }

  async readMeta(): Promise<MetaSessionState | undefined> {
    return this.readJson<MetaSessionState>(join(this.root, 'meta.json'))
  }

  async writeMeta(value: MetaSessionState): Promise<void> {
    await this.atomicWrite(join(this.root, 'meta.json'), value)
  }

  async readRound(roundId: string): Promise<RefinementRound | undefined> {
    return this.readJson<RefinementRound>(this.roundFile(roundId))
  }

  async writeRound(value: RefinementRound): Promise<void> {
    await this.atomicWrite(this.roundFile(value.roundId), value)
  }

  async listRounds(): Promise<RefinementRound[]> {
    await this.initialize()
    const names = (await readdir(this.roundsPath)).filter(name => name.endsWith('.json')).sort()
    const rounds = await Promise.all(names.map(name => this.readJson<RefinementRound>(join(this.roundsPath, name))))
    return rounds.filter((round): round is RefinementRound => round !== undefined)
  }

  async writeWorkerRecord(workerId: string, value: unknown): Promise<void> {
    if (!/^[a-zA-Z0-9_-]+$/u.test(workerId)) throw new TypeError('invalid worker id')
    await this.atomicWrite(join(this.workersPath, `${workerId}.json`), value)
  }

  async acquireRoundLock(roundId?: string): Promise<WorkspaceLock> {
    await this.initialize()
    const lockPath = join(this.locksPath, 'round.lock')
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = crypto.randomUUID()
      const record: LockRecord = {
        pid: process.pid, token, acquiredAt: new Date().toISOString(),
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
          retarget: async (roundId: string): Promise<void> => {
            if (released) throw new Error('cannot retarget a released workspace lock')
            const current = await this.readJson<LockRecord>(lockPath)
            if (current?.token !== token) throw new Error('refusing to retarget a workspace lock owned by another process')
            await this.atomicWrite(lockPath, { ...current, roundId })
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
            if (current.token !== token) throw new Error('refusing to release a workspace lock owned by another process')
            await unlink(lockPath)
          },
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const owner = await this.readJson<LockRecord>(lockPath)
        if (attempt === 0 && owner !== undefined && !isAlive(owner.pid)) {
          await unlink(lockPath).catch((unlinkError: NodeJS.ErrnoException) => {
            if (unlinkError.code !== 'ENOENT') throw unlinkError
          })
          continue
        }
        throw new RoundAlreadyRunningError(owner)
      }
    }
    throw new RoundAlreadyRunningError()
  }

  async resetForTests(): Promise<void> {
    await rm(this.root, { recursive: true, force: true })
  }

  private roundFile(roundId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/u.test(roundId)) throw new TypeError('invalid round id')
    return join(this.roundsPath, `${roundId}.json`)
  }

  private async readJson<T>(path: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private async atomicWrite(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(json(value), 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
    try {
      const directory = await open(dirname(path), 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EPERM' && code !== 'EISDIR') throw error
    }
    await stat(path)
  }
}

export { exists as pathExists }
