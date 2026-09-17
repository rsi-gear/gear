import { mkdir, open, readFile, rename, link, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { digestJson } from '../state/digest.js'
import { validateSearchSchema } from './schema.js'
import { digest, invariant, safeId, seal, verifyDigest } from './contracts.js'
import type { BudgetLimits, ResearchArchive, Snapshot } from './types.js'

export type Usage = Record<'cells' | 'repairCells' | 'diagnosisInputTokens' | 'diagnosisOutputTokens' | 'generationTokens' | 'generationRequests', number>
/** null means no configured limit, not zero remaining or measured zero usage. */
export type RemainingBudget = Omit<Usage, 'generationTokens' | 'generationRequests'> & { generationTokens: number | null; generationRequests: number | null }
export const zeroUsage = (): Usage => ({ cells: 0, repairCells: 0, diagnosisInputTokens: 0, diagnosisOutputTokens: 0, generationTokens: 0, generationRequests: 0 })
export const usageLimit = (v: BudgetLimits): RemainingBudget => ({ cells: v.maxNewRolloutCells, repairCells: v.maxRepairCells, diagnosisInputTokens: v.maxDiagnosisInputTokens, diagnosisOutputTokens: v.maxDiagnosisOutputTokens, generationTokens: v.maxGenerationTokens ?? null, generationRequests: v.maxGenerationRequests ?? null })
export interface Operation {
  key: string; roundId: string; requestDigest: string; reserved: Usage; status: 'reserved' | 'complete'; outputDigest?: string; actual?: Usage
}
export interface Ledger { startedAt: number; operations: Operation[]; digest: string }
export class SearchBudgetExceeded extends Error { constructor(readonly resource: string) { super(`search budget exhausted: ${resource}`); this.name = 'SearchBudgetExceeded' } }

/** Single-writer journal operations shared by durable and in-memory execution. */
export interface SearchJournal {
  read<T>(name: string): Promise<T | undefined>
  write(name: string, value: unknown): Promise<void>
  put<T extends { digest: string }>(value: T): Promise<string>
  object<T extends { digest: string }>(ref: string): Promise<T>
  freeze<T extends { digest: string }>(roundId: string, name: string, create: () => Promise<T> | T): Promise<T>
  freezeEvolution<T extends { digest: string }>(name: string, create: () => Promise<T> | T): Promise<T>
  archive(): Promise<ResearchArchive | undefined>
  casArchive(expected: string | undefined, next: ResearchArchive): Promise<void>
  operation(roundId: string, key: string): Promise<Operation | undefined>
  reserve(roundId: string, key: string, request: unknown, cost: Usage, limits: { round: BudgetLimits; evolution: BudgetLimits }, roundStartedAt: number): Promise<Operation>
  settle(operation: Operation, output: { digest: string }, actual?: Usage): Promise<void>
  remaining(roundId: string, limits: { round: BudgetLimits; evolution: BudgetLimits }): Promise<RemainingBudget>
}

/** All writers run under the owning evolution's single-writer lock. */
export abstract class SearchJournalBase implements SearchJournal {
  abstract read<T>(name: string): Promise<T | undefined>
  abstract write(name: string, value: unknown): Promise<void>
  abstract put<T extends { digest: string }>(value: T): Promise<string>
  async object<T extends { digest: string }>(ref: string): Promise<T> {
    digest(ref)
    const value = await this.read<T>(`objects/${ref.slice(7)}`)
    invariant(value, `missing immutable object ${ref}`); verifyDigest(value); invariant(value.digest === ref, 'object address mismatch')
    return value
  }
  async freeze<T extends { digest: string }>(roundId: string, name: string, create: () => Promise<T> | T): Promise<T> {
    safeId(roundId); safeId(name)
    return this.freezeKey(`rounds/${roundId}/${name}`, create)
  }
  async freezeEvolution<T extends { digest: string }>(name: string, create: () => Promise<T> | T): Promise<T> {
    safeId(name)
    return this.freezeKey(`evolution/${name}`, create)
  }
  private async freezeKey<T extends { digest: string }>(key: string, create: () => Promise<T> | T): Promise<T> {
    const saved = await this.read<{ ref: string }>(key)
    if (saved) return this.object<T>(saved.ref)
    const value = await create(); await this.put(value); await this.write(key, { ref: value.digest }); return value
  }
  async archive(): Promise<ResearchArchive | undefined> {
    const pointer = await this.read<{ ref: string }>('archive')
    if (!pointer) return undefined
    const archive = await this.object<ResearchArchive>(pointer.ref)
    validateSearchSchema('ResearchArchive', archive)
    return archive
  }
  async casArchive(expected: string | undefined, next: ResearchArchive): Promise<void> {
    validateSearchSchema('ResearchArchive', next)
    const current = await this.archive()
    if (current?.digest === next.digest) return
    invariant(current?.digest === expected, 'archive CAS conflict')
    await this.put(next); await this.write('archive', { ref: next.digest })
  }
  async operation(roundId: string, key: string): Promise<Operation | undefined> {
    const ledger = await this.read<Ledger>('budget')
    if (!ledger) return undefined
    verifyDigest(ledger)
    const operation = ledger.operations.find(o => o.key === key)
    invariant(!operation || operation.roundId === roundId, 'operation belongs to another round')
    return operation
  }
  async reserve(roundId: string, key: string, request: unknown, cost: Usage, limits: { round: BudgetLimits; evolution: BudgetLimits }, roundStartedAt: number): Promise<Operation> {
    const ledger = await this.read<Ledger>('budget') ?? seal({ startedAt: Date.now(), operations: [] as Operation[] })
    verifyDigest(ledger)
    const found = ledger.operations.find(o => o.key === key)
    if (found) { invariant(found.requestDigest === digestJson(request) && found.roundId === roundId, 'idempotency key reused for a different operation'); return found }
    if (Date.now() >= roundStartedAt + limits.round.timeoutMs || Date.now() >= ledger.startedAt + limits.evolution.timeoutMs) throw new SearchBudgetExceeded('time')
    for (const [kind, maximum] of [['round', usageLimit(limits.round)], ['evolution', usageLimit(limits.evolution)]] as const) {
      const selected = ledger.operations.filter(o => kind === 'evolution' || o.roundId === roundId)
      for (const resource of Object.keys(cost) as Array<keyof Usage>) {
        invariant(Number.isSafeInteger(cost[resource]) && cost[resource] >= 0, 'invalid budget reservation')
        const used = selected.reduce((sum, o) => sum + (o.actual ?? o.reserved)[resource], 0)
        const bound = maximum[resource]
        if (bound !== null && used + cost[resource] > bound) throw new SearchBudgetExceeded(`${kind}.${resource}`)
      }
    }
    const operation: Operation = { key, roundId, requestDigest: digestJson(request), reserved: cost, status: 'reserved' }
    await this.write('budget', seal({ startedAt: ledger.startedAt, operations: [...ledger.operations, operation] }))
    return operation
  }
  async settle(operation: Operation, output: { digest: string }, actual = operation.reserved): Promise<void> {
    await this.put(output)
    const ledger = await this.read<Ledger>('budget'); invariant(ledger, 'missing budget reservation'); verifyDigest(ledger)
    const current = ledger.operations.find(o => o.key === operation.key); invariant(current, 'unreserved operation')
    invariant(current.status !== 'complete' || current.outputDigest === output.digest, 'operation result changed after settlement')
    for (const resource of Object.keys(actual) as Array<keyof Usage>) invariant(Number.isSafeInteger(actual[resource]) && actual[resource] >= 0 && actual[resource] <= current.reserved[resource], 'provider exceeded reserved budget')
    await this.write('budget', seal({ startedAt: ledger.startedAt, operations: ledger.operations.map(o => o.key === current.key ? { ...o, status: 'complete' as const, actual, outputDigest: output.digest } : o) }))
  }
  async remaining(roundId: string, limits: { round: BudgetLimits; evolution: BudgetLimits }): Promise<RemainingBudget> {
    const ledger = await this.read<Ledger>('budget')
    if (ledger) verifyDigest(ledger)
    const remaining: RemainingBudget = zeroUsage()
    for (const key of Object.keys(remaining) as Array<keyof Usage>) {
      const bounds = (['round', 'evolution'] as const).flatMap(kind => {
        const limit = usageLimit(limits[kind])[key]
        return limit === null ? [] : [limit - (ledger?.operations ?? []).filter(o => kind === 'evolution' || o.roundId === roundId).reduce((sum, o) => sum + (o.actual ?? o.reserved)[key], 0)]
      })
      if (key === 'generationTokens' || key === 'generationRequests') remaining[key] = bounds.length ? Math.min(...bounds) : null
      else remaining[key] = Math.min(...bounds)
    }
    return remaining
  }
}

export class SearchStore extends SearchJournalBase {
  constructor(readonly root: string) { super() }
  private async atomic(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${crypto.randomUUID()}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync() } finally { await handle.close() }
    await rename(temporary, path)
  }
  async read<T>(name: string): Promise<T | undefined> {
    invariant(/^[a-zA-Z0-9_/-]+$/u.test(name) && !name.includes('..'), 'unsafe state path')
    try {
      const value: unknown = JSON.parse(await readFile(join(this.root, `${name}.json`), 'utf8'))
      if (name === 'budget') validateSearchSchema('Ledger', value)
      return value as T
    }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e }
  }
  async write(name: string, value: unknown): Promise<void> {
    invariant(/^[a-zA-Z0-9_/-]+$/u.test(name) && !name.includes('..'), 'unsafe state path')
    await this.atomic(join(this.root, `${name}.json`), value)
  }
  async put<T extends { digest: string }>(value: T): Promise<string> {
    verifyDigest(value); digest(value.digest)
    const path = join(this.root, 'objects', `${value.digest.slice(7)}.json`)
    await mkdir(dirname(path), { recursive: true })
    const existing = await this.read<T>(`objects/${value.digest.slice(7)}`)
    if (existing) { verifyDigest(existing); invariant(digestJson(existing) === digestJson(value), 'immutable object conflict'); return value.digest }
    const temp = `${path}.${crypto.randomUUID()}.tmp`, file = await open(temp, 'wx', 0o600)
    try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync() } finally { await file.close() }
    try { await link(temp, path) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e } finally { await unlink(temp) }
    return value.digest
  }
}
