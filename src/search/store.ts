import { mkdir, open, readFile, rename, link, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { digestJson } from '../state/digest.js'
import { digest, invariant, safeId, seal, verifyDigest } from './contracts.js'
import type { BudgetLimits, ResearchArchive, Snapshot } from './types.js'

export type Usage = Record<'cells' | 'repairCells' | 'diagnosisInputTokens' | 'diagnosisOutputTokens' | 'generationTokens' | 'generationRequests', number>
export const zeroUsage = (): Usage => ({ cells: 0, repairCells: 0, diagnosisInputTokens: 0, diagnosisOutputTokens: 0, generationTokens: 0, generationRequests: 0 })
export const usageLimit = (v: BudgetLimits): Usage => ({ cells: v.maxNewRolloutCells, repairCells: v.maxRepairCells, diagnosisInputTokens: v.maxDiagnosisInputTokens, diagnosisOutputTokens: v.maxDiagnosisOutputTokens, generationTokens: v.maxGenerationTokens, generationRequests: v.maxGenerationRequests })
export interface Operation {
  key: string; roundId: string; requestDigest: string; reserved: Usage; status: 'reserved' | 'complete'; outputDigest?: string; actual?: Usage
}
interface Ledger { startedAt: number; operations: Operation[]; digest: string }
export class SearchBudgetExceeded extends Error { constructor(readonly resource: string) { super(`search budget exhausted: ${resource}`); this.name = 'SearchBudgetExceeded' } }

/** All writers are called under the owning evolution's existing single-writer lock. */
export class SearchStore {
  constructor(readonly root: string) {}
  private async atomic(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${crypto.randomUUID()}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync() } finally { await handle.close() }
    await rename(temporary, path)
  }
  async read<T>(name: string): Promise<T | undefined> {
    invariant(/^[a-zA-Z0-9_/-]+$/u.test(name) && !name.includes('..'), 'unsafe state path')
    try { return JSON.parse(await readFile(join(this.root, `${name}.json`), 'utf8')) as T }
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
  async object<T extends { digest: string }>(ref: string): Promise<T> {
    digest(ref)
    const value = await this.read<T>(`objects/${ref.slice(7)}`)
    invariant(value, `missing immutable object ${ref}`); verifyDigest(value); invariant(value.digest === ref, 'object address mismatch')
    return value
  }
  async freeze<T extends { digest: string }>(roundId: string, name: string, create: () => Promise<T> | T): Promise<T> {
    safeId(roundId); safeId(name)
    const key = `rounds/${roundId}/${name}`, saved = await this.read<{ ref: string }>(key)
    if (saved) return this.object<T>(saved.ref)
    const value = await create(); await this.put(value); await this.write(key, { ref: value.digest }); return value
  }
  async archive(): Promise<ResearchArchive | undefined> {
    const pointer = await this.read<{ ref: string }>('archive')
    return pointer ? this.object<ResearchArchive>(pointer.ref) : undefined
  }
  async casArchive(expected: string | undefined, next: ResearchArchive): Promise<void> {
    const current = await this.archive()
    if (current?.digest === next.digest) return
    invariant(current?.digest === expected, 'archive CAS conflict')
    await this.put(next); await this.write('archive', { ref: next.digest })
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
        if (used + cost[resource] > maximum[resource]) throw new SearchBudgetExceeded(`${kind}.${resource}`)
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
  async remaining(roundId: string, limits: { round: BudgetLimits; evolution: BudgetLimits }): Promise<Usage> {
    const ledger = await this.read<Ledger>('budget')
    if (ledger) verifyDigest(ledger)
    const remaining = zeroUsage()
    for (const key of Object.keys(remaining) as Array<keyof Usage>) remaining[key] = Math.min(...(['round', 'evolution'] as const).map(kind => usageLimit(limits[kind])[key] - (ledger?.operations ?? []).filter(o => kind === 'evolution' || o.roundId === roundId).reduce((sum, o) => sum + (o.actual ?? o.reserved)[key], 0)))
    return remaining
  }
}
