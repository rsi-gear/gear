import { createHash } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  ChampionState,
  EvolutionId,
  EvolutionRegistryEntry,
  EvolutionRegistryState,
  EvolutionSpec,
  PublishedHarnessState,
} from '../types.js'
import { isExactGitCommit } from '../types.js'
import { RefineStateStore } from './store.js'

const SHA256 = /^sha256:[0-9a-f]{64}$/u
const SAFE_ID = /^[a-zA-Z0-9_-]+$/u

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function digestJson(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new TypeError(`${label} is invalid`)
}

function validateChampion(value: ChampionState): ChampionState {
  if (value.schemaVersion !== 2 || !isExactGitCommit(value.ref) || !SHA256.test(value.manifestDigest)
    || typeof value.updatedAt !== 'string' || value.updatedAt.length === 0) {
    throw new TypeError('evolution champion is invalid')
  }
  return value
}

function validateSpec(value: EvolutionSpec): EvolutionSpec {
  if (value.schemaVersion !== 1 || (value.source !== 'native' && value.source !== 'legacy-migration')) {
    throw new TypeError('evolution spec schema/source is invalid')
  }
  assertSafeId(value.evolutionId, 'evolutionId')
  if (!isExactGitCommit(value.initialHarnessRef) || !SHA256.test(value.initialHarnessDigest)) {
    throw new TypeError('evolution initial harness identity is invalid')
  }
  for (const [name, field] of Object.entries({
    createdAt: value.createdAt,
    seedTaskRef: value.seedTaskRef,
    heldOutRef: value.heldOutRef,
    metaHarnessRef: value.metaHarnessRef,
    toolchainRef: value.toolchainRef,
    sandboxProfileRef: value.sandboxProfileRef,
  })) {
    if (typeof field !== 'string' || field.length === 0) throw new TypeError(`evolution ${name} is required`)
  }
  if (!SHA256.test(value.seedTaskDigest) || !SHA256.test(value.heldOutDigest)) {
    throw new TypeError('evolution dataset digests are invalid')
  }
  if (!Number.isSafeInteger(value.taskBudgetMs) || value.taskBudgetMs <= 0) {
    throw new TypeError('evolution taskBudgetMs is invalid')
  }
  return value
}

export interface CreateEvolutionOptions {
  spec: EvolutionSpec
  champion: ChampionState
  name?: string
  status?: EvolutionRegistryEntry['status']
}

export class EvolutionRegistryStore {
  readonly evolutionsRoot: string
  readonly registryPath: string
  readonly publishedPath: string
  private registryQueue: Promise<void> = Promise.resolve()

  constructor(readonly root: string) {
    this.evolutionsRoot = join(root, 'evolutions')
    this.registryPath = join(root, 'registry.json')
    this.publishedPath = join(root, 'published.json')
  }

  async initialize(): Promise<void> {
    await mkdir(this.evolutionsRoot, { recursive: true })
    const existing = await this.readJson<unknown>(this.registryPath)
    if (existing === undefined) {
      await this.atomicWrite(this.registryPath, { schemaVersion: 1, evolutions: [] } satisfies EvolutionRegistryState)
    } else {
      this.validateRegistry(existing)
    }
  }

  evolutionRoot(evolutionId: EvolutionId): string {
    assertSafeId(evolutionId, 'evolutionId')
    return join(this.evolutionsRoot, evolutionId)
  }

  stateStore(evolutionId: EvolutionId): RefineStateStore {
    return new RefineStateStore(this.evolutionRoot(evolutionId), evolutionId)
  }

  async createEvolution(options: CreateEvolutionOptions): Promise<EvolutionRegistryEntry> {
    const spec = validateSpec(options.spec)
    const champion = validateChampion(options.champion)
    const root = this.evolutionRoot(spec.evolutionId)
    await this.initialize()
    try {
      await mkdir(root, { recursive: false, mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`evolution already exists: ${spec.evolutionId}`)
      }
      throw error
    }
    const store = this.stateStore(spec.evolutionId)
    try {
      await Promise.all([
        this.atomicWrite(join(root, 'spec.json'), spec),
        store.writeChampion(champion),
        store.initialize(),
      ])
      const timestamp = new Date().toISOString()
      const entry: EvolutionRegistryEntry = {
        evolutionId: spec.evolutionId,
        ...(options.name === undefined ? {} : { name: options.name }),
        specDigest: digestJson(spec),
        status: options.status ?? 'active',
        createdAt: spec.createdAt,
        updatedAt: timestamp,
      }
      await this.updateRegistry((state) => ({ ...state, evolutions: [...state.evolutions, entry] }))
      return entry
    } catch (error) {
      // Keep the owned directory for forensic recovery. An unindexed directory
      // is never opened as an evolution and can be reconciled explicitly.
      throw error
    }
  }

  async readSpec(evolutionId: EvolutionId): Promise<EvolutionSpec | undefined> {
    const value = await this.readJson<EvolutionSpec>(join(this.evolutionRoot(evolutionId), 'spec.json'))
    return value === undefined ? undefined : validateSpec(value)
  }

  async requireSpec(evolutionId: EvolutionId): Promise<EvolutionSpec> {
    const spec = await this.readSpec(evolutionId)
    if (spec === undefined) throw new Error(`unknown evolution: ${evolutionId}`)
    return spec
  }

  async list(): Promise<EvolutionRegistryEntry[]> {
    await this.initialize()
    return [...(await this.readRegistry()).evolutions].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  async readEntry(evolutionId: EvolutionId): Promise<EvolutionRegistryEntry | undefined> {
    return (await this.list()).find(entry => entry.evolutionId === evolutionId)
  }

  async touch(evolutionId: EvolutionId, update: { batchId?: string; roundId?: string }): Promise<void> {
    await this.updateRegistry((state) => {
      let found = false
      const evolutions = state.evolutions.map((entry) => {
        if (entry.evolutionId !== evolutionId) return entry
        found = true
        return {
          ...entry,
          updatedAt: new Date().toISOString(),
          ...(update.batchId === undefined ? {} : { lastBatchId: update.batchId }),
          ...(update.roundId === undefined ? {} : { lastRoundId: update.roundId }),
        }
      })
      if (!found) throw new Error(`unknown evolution: ${evolutionId}`)
      return { ...state, evolutions }
    })
  }

  async archive(evolutionId: EvolutionId): Promise<void> {
    await this.updateRegistry((state) => {
      let found = false
      const evolutions = state.evolutions.map((entry) => {
        if (entry.evolutionId !== evolutionId) return entry
        found = true
        return { ...entry, status: 'archived' as const, updatedAt: new Date().toISOString() }
      })
      if (!found) throw new Error(`unknown evolution: ${evolutionId}`)
      return { ...state, evolutions }
    })
  }

  async readPublished(): Promise<PublishedHarnessState | undefined> {
    const value = await this.readJson<PublishedHarnessState>(this.publishedPath)
    if (value === undefined) return undefined
    if (value.schemaVersion !== 1 || !isExactGitCommit(value.ref) || !SHA256.test(value.manifestDigest)
      || typeof value.publishedAt !== 'string' || value.publishedAt.length === 0
      || (value.sourceEvolutionId !== undefined && !SAFE_ID.test(value.sourceEvolutionId))) {
      throw new TypeError('published harness state is invalid')
    }
    return value
  }

  async compareAndSwapPublished(expectedRef: string | undefined, value: PublishedHarnessState): Promise<void> {
    if (value.schemaVersion !== 1 || !isExactGitCommit(value.ref) || !SHA256.test(value.manifestDigest)
      || typeof value.publishedAt !== 'string' || value.publishedAt.length === 0
      || (value.sourceEvolutionId !== undefined && !SAFE_ID.test(value.sourceEvolutionId))
      || (value.roundId !== undefined && typeof value.roundId !== 'string')) {
      throw new TypeError('published harness state is invalid')
    }
    await this.withFileLock('published', async () => {
      const current = await this.readPublished()
      if (current?.ref !== expectedRef) {
        throw new Error(`published CAS failed: expected ${expectedRef ?? '<missing>'}, found ${current?.ref ?? '<missing>'}`)
      }
      await this.atomicWrite(this.publishedPath, value)
    })
  }

  async unindexedEvolutionIds(): Promise<string[]> {
    await this.initialize()
    const indexed = new Set((await this.readRegistry()).evolutions.map(entry => entry.evolutionId))
    const entries = await readdir(this.evolutionsRoot, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory() && !indexed.has(entry.name)).map(entry => entry.name).sort()
  }

  private async readRegistry(): Promise<EvolutionRegistryState> {
    const value = await this.readJson<unknown>(this.registryPath)
    if (value === undefined) throw new Error('evolution registry is missing')
    return this.validateRegistry(value)
  }

  private validateRegistry(value: unknown): EvolutionRegistryState {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('evolution registry must be an object')
    const state = value as Partial<EvolutionRegistryState>
    if (state.schemaVersion !== 1 || !Array.isArray(state.evolutions)) throw new TypeError('evolution registry schema is invalid')
    const ids = new Set<string>()
    for (const entry of state.evolutions) {
      if (typeof entry !== 'object' || entry === null) throw new TypeError('evolution registry entry is invalid')
      assertSafeId(entry.evolutionId, 'registry evolutionId')
      if (ids.has(entry.evolutionId)) throw new TypeError(`duplicate evolution registry entry: ${entry.evolutionId}`)
      ids.add(entry.evolutionId)
      if (!SHA256.test(entry.specDigest) || (entry.status !== 'active' && entry.status !== 'archived')
        || typeof entry.createdAt !== 'string' || typeof entry.updatedAt !== 'string') {
        throw new TypeError(`evolution registry entry is invalid: ${entry.evolutionId}`)
      }
    }
    return state as EvolutionRegistryState
  }

  private async updateRegistry(update: (state: EvolutionRegistryState) => EvolutionRegistryState): Promise<void> {
    const operation = this.registryQueue.then(async () => {
      await this.withFileLock('registry', async () => {
        await this.initialize()
        const next = update(await this.readRegistry())
        this.validateRegistry(next)
        await this.atomicWrite(this.registryPath, next)
      })
    })
    this.registryQueue = operation.catch(() => {})
    await operation
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
      try { await directory.sync() } finally { await directory.close() }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EPERM' && code !== 'EISDIR') throw error
    }
    await stat(path)
  }

  private async withFileLock<T>(name: string, callback: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true })
    const lockPath = join(this.root, `.${name}.lock`)
    const deadline = Date.now() + 10_000
    while (true) {
      try {
        await mkdir(lockPath, { mode: 0o700 })
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        try {
          const info = await stat(lockPath)
          if (Date.now() - info.mtimeMs > 5 * 60_000) {
            await rm(lockPath, { recursive: true, force: true })
            continue
          }
        } catch (inspectError) {
          if ((inspectError as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw inspectError
        }
        if (Date.now() >= deadline) throw new Error(`timed out acquiring evolution ${name} lock`)
        await new Promise(resolveWait => setTimeout(resolveWait, 25))
      }
    }
    try { return await callback() } finally { await rm(lockPath, { recursive: true, force: true }) }
  }
}
