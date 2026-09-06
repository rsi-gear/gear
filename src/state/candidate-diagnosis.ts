import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { digestJson } from './digest.js'
import type { DiagnosisReceipt, MetaFailureCard } from '../types.js'

export interface CandidateDiagnosisScope {
  evolutionId: string
  specDigest: string
  roundId: string
  candidateId: string
  parentHarnessDigest: string
  baselineDigest: string
}

export interface CandidateDiagnosisRecord {
  receipt: DiagnosisReceipt
  /** Content identity, independent of session-bound card/detail references. */
  sourceDigest: string
  evidence: { card: MetaFailureCard; verifierDetails?: string }
  source: { sessionId: string; attempt: number }
}

/** Immutable per-read records. The round lock owns writers; no shared JSON
 * read/modify/write cycle can lose concurrent diagnostic reads. */
export class CandidateDiagnosisStore {
  private readonly directory: string
  constructor(root: string, private readonly scope: CandidateDiagnosisScope) {
    this.directory = join(root, 'candidate-diagnoses', digestJson(scope).slice(7))
  }

  async read(): Promise<CandidateDiagnosisRecord[]> {
    let files: string[]
    try { files = await readdir(this.directory) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const records: CandidateDiagnosisRecord[] = []
    for (const file of files.filter(name => /^[a-f0-9]{64}\.json$/u.test(name)).sort()) {
      const saved = JSON.parse(await readFile(join(this.directory, file), 'utf8')) as {
        schemaVersion: number; scope: CandidateDiagnosisScope; record: CandidateDiagnosisRecord
      }
      if (saved.schemaVersion !== 1 || digestJson(saved.scope) !== digestJson(this.scope)
        || digestJson(saved).slice(7) !== file.slice(0, -5)
        || saved.record.receipt.runId !== saved.record.evidence.card.runId) {
        throw new Error('candidate diagnosis record integrity mismatch')
      }
      records.push(saved.record)
    }
    return records.sort((a, b) => a.receipt.inspectedAt.localeCompare(b.receipt.inspectedAt))
  }

  async write(record: CandidateDiagnosisRecord, assertOwner: () => void): Promise<void> {
    assertOwner()
    const saved = { schemaVersion: 1, scope: this.scope, record }
    const file = join(this.directory, `${digestJson(saved).slice(7)}.json`)
    try {
      const existing = JSON.parse(await readFile(file, 'utf8'))
      if (digestJson(existing) !== digestJson(saved)) throw new Error('candidate diagnosis record integrity mismatch')
      assertOwner()
      return
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await mkdir(this.directory, { recursive: true })
    const temporary = `${file}.${crypto.randomUUID()}.tmp`
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify(saved)); await handle.sync() }
      finally { await handle.close() }
      assertOwner()
      await rename(temporary, file)
      // Retry cleanup drains this write before admitting a successor. A write
      // that crossed cancellation must not become successor-visible progress.
      try { assertOwner() }
      catch (error) { await rm(file, { force: true }); throw error }
      const directory = await open(this.directory, 'r')
      try { await directory.sync() }
      finally { await directory.close() }
    } finally { await rm(temporary, { force: true }) }
  }
}
