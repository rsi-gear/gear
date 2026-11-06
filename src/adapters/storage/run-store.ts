import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import type { JournalOperation, RunJournal, RunSpec } from '../../domain/run.js'
import type { Candidate } from '../../domain/algorithm-wire.js'
import { publishFile } from './atomic.js'
import { withFileLock } from './file-lock.js'
import { ResearchStore } from './research.js'

export class RunStore {
  constructor(readonly root: string) {}
  private path(id: string, name = 'journal'): string {
    if (!/^[a-zA-Z0-9_-]+$/u.test(id)) throw new GearError('invalid-run-id', 'Invalid run ID')
    return join(this.root, 'runs', id, `${name}.json`)
  }
  researchStore(id: string): ResearchStore {
    this.path(id)
    return new ResearchStore(join(this.root, 'runs', id, 'research'))
  }
  async create(id: string, spec: RunSpec, operations: JournalOperation[] = []): Promise<RunJournal> {
    const record: Omit<RunJournal, 'digest'> = {
      version: 1,
      id,
      createdAt: new Date().toISOString(),
      spec,
      specDigest: canonicalDigest(spec),
      generation: 0,
      status: 'ready',
      state: { version: 1, data: {} },
      decisions: [],
      operations: structuredClone(operations),
      candidates: [spec.anchor],
      seedEvidence: structuredClone(spec.baseline?.evidence ?? []),
      heldOutEvidence: [],
      completed: [],
      nomineeId: null,
      championId: spec.anchor.id,
      gate: { status: 'not_run', reason: 'No nominee' },
      physicalAttempts: 0,
    }
    const journal = { ...record, digest: canonicalDigest(record) }
    await this.researchStore(id).capture(journal)
    await publishFile(this.path(id), JSON.stringify(journal), { immutable: true })
    return journal
  }
  async read(id: string): Promise<RunJournal> {
    const journal = JSON.parse(await readFile(this.path(id), 'utf8')) as RunJournal
    const { digest, ...body } = journal
    if (
      journal.version !== 1 ||
      journal.id !== id ||
      canonicalDigest(body) !== digest ||
      canonicalDigest(journal.spec) !== journal.specDigest
    ) {
      throw new GearError(
        'run-identity-mismatch',
        'Run journal or frozen configuration failed verification',
        { run_id: id },
      )
    }
    return journal
  }
  async latest(): Promise<string> {
    const entries = await readdir(join(this.root, 'runs'), { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      },
    )
    const runs = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            return await this.read(entry.name)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
            throw error
          }
        }),
    )
    const latest = runs
      .filter((run): run is RunJournal => run !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0]
    if (!latest)
      throw new GearError('run-not-found', 'This project has no runs', {
        next_action: 'gear evaluate --split seed --limit 1',
      })
    return latest.id
  }
  async write(journal: RunJournal, options: { cancellationOnly?: boolean } = {}): Promise<void> {
    if (options.cancellationOnly) {
      const previous = await this.read(journal.id)
      const facts = (value: RunJournal) => {
        const {
          status: _status,
          generation: _generation,
          failure: _failure,
          digest: _digest,
          ...facts
        } = value
        return facts
      }
      if (
        !(await this.cancelled(journal.id)) ||
        !['cancelled', 'needs_recovery'].includes(journal.status) ||
        (journal.status === 'needs_recovery' && journal.failure?.code !== 'cancellation-unconfirmed') ||
        canonicalDigest(facts(journal)) !== canonicalDigest(facts(previous))
      )
        throw new GearError(
          'invalid-cancellation-write',
          'Cancellation cannot change committed experiment facts',
        )
    }
    const { digest: _ignored, ...body } = journal
    journal.digest = canonicalDigest(body)
    // The journal never references a research snapshot that has not reached durable storage.
    if (!options.cancellationOnly) await this.researchStore(journal.id).capture(journal)
    await publishFile(this.path(journal.id), JSON.stringify(journal))
  }
  async champion(): Promise<{ runId: string; candidate: Candidate; revision: string } | null> {
    let value: { runId: string; candidate: Candidate; revision: string }
    try {
      value = JSON.parse(await readFile(join(this.root, 'champion.json'), 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    const { revision, ...body } = value
    if (canonicalDigest(body) !== revision)
      throw new GearError('champion-identity-mismatch', 'Champion revision failed verification')
    const journal = await this.read(value.runId)
    if (
      journal.gate.status !== 'accepted' ||
      journal.nomineeId !== value.candidate.id ||
      !journal.candidates.some((candidate) => canonicalDigest(candidate) === canonicalDigest(value.candidate))
    )
      throw new GearError('champion-provenance-mismatch', 'Champion has no verified accepted gate')
    return value
  }
  async commitChampion(journal: RunJournal): Promise<void> {
    const candidate = journal.candidates.find((item) => item.id === journal.nomineeId)
    if (!candidate) throw new GearError('unknown-nominee', 'Final nominee is absent')
    const path = join(this.root, 'champion.json')
    await withFileLock(join(this.root, 'champion.lock'), async () => {
      const previous = await this.champion()
      if (previous?.runId === journal.id && previous.candidate?.digest === candidate.digest) return
      if ((previous?.revision ?? null) !== journal.spec.championRevision)
        throw new GearError('champion-conflict', 'Champion changed since this run was admitted')
      const body = { runId: journal.id, candidate }
      await publishFile(path, JSON.stringify({ ...body, revision: canonicalDigest(body) }))
    })
  }
  async locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    return withFileLock(this.path(id, 'owner'), action)
  }
  async cancel(id: string): Promise<void> {
    await this.read(id)
    await publishFile(this.path(id, 'cancel'), JSON.stringify({ requested: true }))
  }
  async cancelled(id: string): Promise<boolean> {
    try {
      await readFile(this.path(id, 'cancel'))
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
}
