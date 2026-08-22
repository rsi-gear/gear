import { createHash } from 'node:crypto'
import { cp, mkdir, open, readFile, readdir, rename } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ChampionState, EvolutionSpec, RefinementRound, SemanticTarget } from '../types.js'
import { digestDatasetRef } from './dataset.js'
import { digestJson, type EvolutionRegistryStore } from './evolution.js'

interface Journal { schemaVersion: 1; status: 'complete'; migratedAt: string; evolutionIds: string[] }
type LegacyArtifactOp =
  | { type: 'create'; path: string; content: string; expect: 'absent' }
  | { type: 'patch'; path: string; patch: string; expectedDigest: string }
  | { type: 'delete'; path: string; expectedDigest: string }
interface LegacyHarnessMutation {
  parentRef: string; parentDigest: string; target: SemanticTarget; ops: LegacyArtifactOp[]
  rationale: string; evidenceRefs: string[]; expectedOutcome: string
}

function safeBatchId(value: unknown): string {
  const text = typeof value === 'string' && value.length > 0 ? value : 'unbatched'
  return `legacy-${createHash('sha256').update(text).digest('hex').slice(0, 24)}`
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync() } finally { await file.close() }
  await rename(temporary, path)
}

function terminal(status: unknown): status is RefinementRound['status'] {
  return status === 'accepted' || status === 'rejected' || status === 'rejected-for-substrate' || status === 'failed'
}

function migratedRound(raw: Record<string, unknown>, evolutionId: string): RefinementRound {
  const mutation = raw.mutation as LegacyHarnessMutation | null | undefined
  const { mutation: _legacyMutation, ...legacy } = raw
  void _legacyMutation
  const timestamp = new Date().toISOString()
  const status = terminal(raw.status) ? raw.status : 'failed'
  const meta = raw.meta as Record<string, unknown> | undefined
  const evidence = raw.proposalEvidence as Record<string, unknown> | undefined
  const ops = mutation?.ops ?? []
  return {
    ...(legacy as unknown as RefinementRound),
    schemaVersion: 3,
    evolutionId,
    status,
    updatedAt: status === raw.status ? String(raw.updatedAt ?? timestamp) : timestamp,
    ...(status === raw.status ? {} : { failure: { phase: 'recovery', message: 'legacy non-terminal round was archived during v3 migration' } }),
    ...(mutation === undefined ? {} : mutation === null ? { finalization: null } : {
      finalization: {
        rationale: mutation.rationale,
        evidenceRefs: mutation.evidenceRefs,
        expectedOutcome: mutation.expectedOutcome,
        semanticTargets: [mutation.target],
      },
      candidateDiff: {
        parentRef: mutation.parentRef,
        files: ops.map(op => ({ path: op.path, change: op.type === 'create' ? 'created' as const : op.type === 'delete' ? 'deleted' as const : 'modified' as const })),
        totalBytes: ops.reduce((sum, op) => sum + Buffer.byteLength(op.type === 'create' ? op.content : op.type === 'patch' ? op.patch : ''), 0),
        patchDigest: digestJson(ops),
        source: 'legacy-mutation',
      },
    }),
    ...(meta === undefined ? {} : { meta: { ...meta, evolutionId } as RefinementRound['meta'] }),
    ...(evidence === undefined ? {} : { proposalEvidence: { ...evidence, evolutionId } as RefinementRound['proposalEvidence'] }),
  } as unknown as RefinementRound
}

/** Archive the old global v2 state by batch. Migrated evolutions are always
 * archived and can be inspected but never resumed. */
export async function migrateLegacyState(registry: EvolutionRegistryStore): Promise<string[]> {
  const journalPath = join(registry.root, 'migration-v3.json')
  const journal = await readJson<Journal>(journalPath)
  if (journal?.status === 'complete') return journal.evolutionIds
  const roundsRoot = join(registry.root, 'rounds')
  let roundFiles: string[] = []
  try { roundFiles = (await readdir(roundsRoot)).filter(path => path.endsWith('.json')).sort() }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const globalChampion = await readJson<ChampionState>(join(registry.root, 'champion.json'))
  if (roundFiles.length === 0 && globalChampion === undefined) return []

  const backup = join(registry.root, 'legacy-v2-backup')
  await mkdir(backup, { recursive: true, mode: 0o700 })
  for (const name of ['champion.json', 'meta.json']) {
    try { await cp(join(registry.root, name), join(backup, name), { errorOnExist: false, force: false }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  if (roundFiles.length > 0) await cp(roundsRoot, join(backup, 'rounds'), { recursive: true, errorOnExist: false, force: false })

  await registry.initialize()
  const grouped = new Map<string, Array<Record<string, unknown>>>()
  for (const file of roundFiles) {
    const raw = await readJson<Record<string, unknown>>(join(roundsRoot, file))
    if (raw?.schemaVersion !== 2) continue
    const batchId = typeof raw.batchId === 'string' ? raw.batchId : basename(file, '.json')
    const values = grouped.get(batchId) ?? []
    values.push(raw)
    grouped.set(batchId, values)
  }
  const evolutionIds: string[] = []
  for (const [batchId, values] of grouped) {
    values.sort((left, right) => Number(left.roundIndex ?? 0) - Number(right.roundIndex ?? 0))
    const first = values[0]!
    const evolutionId = safeBatchId(batchId)
    evolutionIds.push(evolutionId)
    const existing = await registry.readEntry(evolutionId)
    if (existing === undefined) {
      const seedTaskRef = String(first.seedTaskRef)
      const heldOutRef = String(first.heldOutRef)
      const initial: ChampionState = {
        schemaVersion: 2,
        ref: String(first.targetHarnessRef),
        manifestDigest: String(first.targetHarnessDigest),
        updatedAt: String(first.createdAt ?? new Date().toISOString()),
      }
      const accepted = [...values].reverse().find(value => value.status === 'accepted' && typeof value.candidateRef === 'string' && typeof value.candidateDigest === 'string')
      const champion: ChampionState = accepted === undefined ? initial : {
        schemaVersion: 2, ref: String(accepted.candidateRef), manifestDigest: String(accepted.candidateDigest),
        updatedAt: String(accepted.updatedAt ?? initial.updatedAt), roundId: String(accepted.roundId),
      }
      const spec: EvolutionSpec = {
        schemaVersion: 1, evolutionId, source: 'legacy-migration', createdAt: String(first.createdAt ?? new Date().toISOString()),
        initialHarnessRef: initial.ref, initialHarnessDigest: initial.manifestDigest,
        seedTaskRef, seedTaskDigest: await digestDatasetRef(seedTaskRef),
        heldOutRef, heldOutDigest: await digestDatasetRef(heldOutRef),
        metaHarnessRef: String(first.metaHarnessRef), metaModel: {},
        promotionPolicy: first.promotionPolicy as EvolutionSpec['promotionPolicy'],
        taskBudgetMs: Number(first.taskBudgetMs), toolchainRef: 'legacy:unknown',
        sandboxProfileRef: String(first.sandboxProfileRef),
      }
      await registry.createEvolution({ spec, champion, name: `legacy batch ${batchId}`, status: 'archived' })
    }
    const store = registry.stateStore(evolutionId)
    for (const raw of values) await store.writeRound(migratedRound(raw, evolutionId))
  }
  if (globalChampion !== undefined && await registry.readPublished() === undefined) {
    await registry.compareAndSwapPublished(undefined, {
      schemaVersion: 1, ref: globalChampion.ref, manifestDigest: globalChampion.manifestDigest,
      publishedAt: new Date().toISOString(), ...(globalChampion.roundId === undefined ? {} : { roundId: globalChampion.roundId }),
    })
  }
  await atomicJson(journalPath, { schemaVersion: 1, status: 'complete', migratedAt: new Date().toISOString(), evolutionIds } satisfies Journal)
  return evolutionIds
}
