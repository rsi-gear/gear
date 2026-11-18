import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import type { JournalOperation, MetaRecovery, RunJournal, RunSpec } from '../../domain/run.js'
import type { Candidate, Json } from '../../domain/algorithm-wire.js'
import type { CapturedImports } from '../../domain/operator-run.js'
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
  async create(
    id: string,
    spec: RunSpec,
    operations: JournalOperation[] = [],
    imports?: CapturedImports,
  ): Promise<RunJournal> {
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
      candidates: [spec.anchor, ...(imports?.candidates.map((entry) => entry.candidate) ?? [])],
      seedEvidence: structuredClone(spec.baseline?.evidence ?? []),
      heldOutEvidence: [],
      completed: [],
      nomineeId: null,
      championId: spec.anchor.id,
      gate: { status: 'not_run', reason: 'No nominee' },
      physicalAttempts: 0,
      ...(spec.algorithm.protocol_version === 2
        ? {
            operators: {
              version: 2 as const,
              state: { version: Number(spec.algorithm.component?.state_schema_version), data: {} },
              decisions: [],
              calls: [],
              samples: [],
              artifacts: structuredClone(imports?.artifacts ?? []),
              history: null,
              ...(spec.operatorPolicy?.access?.task_order
                ? {
                    stream: {
                      revision: canonicalDigest([id, 'task-stream', spec.operatorPolicy.access.task_order]),
                      index: 0,
                      completed: [],
                    },
                  }
                : {}),
            },
          }
        : {}),
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
  private recoveryPath(id: string, recovery: MetaRecovery): string {
    if (!/^recovery_[a-f0-9]{64}$/u.test(recovery.id))
      throw new GearError('invalid-recovery-id', 'Invalid recovery checkpoint ID')
    return this.path(id, `recoveries/${recovery.id}/journal`)
  }
  /** Save the exact historical bytes before admitting any new attempt. Caller holds the run lock. */
  async checkpointRecovery(journal: RunJournal, recovery: MetaRecovery, cancellation?: Json): Promise<void> {
    const bytes = await readFile(this.path(journal.id))
    if (
      canonicalDigest(JSON.parse(bytes.toString('utf8'))) !== canonicalDigest(journal) ||
      journal.digest !== recovery.sourceJournalDigest
    )
      throw new GearError('recovery-checkpoint-mismatch', 'Recovery source changed before admission')
    await publishFile(this.recoveryPath(journal.id, recovery), bytes, { immutable: true })
    if (recovery.execution) {
      if (cancellation === undefined || canonicalDigest(cancellation) !== recovery.cancellationIdentity)
        throw new GearError('recovery-checkpoint-mismatch', 'Recovery cancellation connection is missing')
      await publishFile(
        this.path(journal.id, `recoveries/${recovery.id}/cancellation`),
        JSON.stringify(cancellation),
        { immutable: true },
      )
    }
  }
  async verifyRecoveryCheckpoints(journal: RunJournal): Promise<void> {
    for (const [index, recovery] of (journal.metaRecoveries ?? []).entries()) {
      const source = JSON.parse(await readFile(this.recoveryPath(journal.id, recovery), 'utf8')) as RunJournal
      if (recovery.execution) {
        const cancellation = JSON.parse(
          await readFile(this.path(journal.id, `recoveries/${recovery.id}/cancellation`), 'utf8'),
        )
        if (canonicalDigest(cancellation) !== recovery.cancellationIdentity)
          throw new GearError('recovery-checkpoint-mismatch', 'Recovery cancellation connection changed')
      }
      if (source.version !== 1 || !Array.isArray(source.operations) || !source.operators)
        throw new GearError(
          'recovery-checkpoint-mismatch',
          'Historical recovery checkpoint failed verification',
        )
      const { digest, ...body } = source
      const before = source.operations.find((op) => op.request.operationId === recovery.sourceOperationId)
      const after = journal.operations.find((op) => op.request.operationId === recovery.sourceOperationId)
      const retry = journal.operations.find((op) => op.request.operationId === recovery.operationId)
      const call = source.operators?.calls.find((entry) => entry.id === recovery.callId)
      if (
        digest !== recovery.sourceJournalDigest ||
        canonicalDigest(body) !== digest ||
        source.id !== journal.id ||
        source.specDigest !== journal.specDigest ||
        canonicalDigest(source.spec) !== journal.specDigest ||
        !before ||
        !after ||
        canonicalDigest(before) !== canonicalDigest(after) ||
        source.operations.some((operation) => {
          const current = journal.operations.find(
            (entry) => entry.request.operationId === operation.request.operationId,
          )
          return !current || canonicalDigest(current) !== canonicalDigest(operation)
        }) ||
        !call?.result ||
        canonicalDigest(call.result) !== canonicalDigest(recovery.previousResult) ||
        canonicalDigest(source.operators!.state) !== recovery.stateDigest ||
        retry?.request.generation !== source.generation + 1 ||
        canonicalDigest(source.metaRecoveries ?? []) !==
          canonicalDigest(journal.metaRecoveries!.slice(0, index))
      )
        throw new GearError(
          'recovery-checkpoint-mismatch',
          'Historical recovery checkpoint failed verification',
        )
    }
  }
  async cancellationSnapshot(journal: RunJournal): Promise<Json> {
    const recovery = journal.metaRecoveries?.findLast((item) => item.execution)
    if (recovery) this.recoveryPath(journal.id, recovery)
    const name = recovery ? `recoveries/${recovery.id}/cancellation` : 'cancellation'
    const snapshot = JSON.parse(await readFile(this.path(journal.id, name), 'utf8')) as Json
    if (canonicalDigest(snapshot) !== (recovery?.cancellationIdentity ?? journal.spec.cancellationIdentity))
      throw new GearError('cancellation-connection-unavailable', 'Frozen cancellation connection changed')
    return snapshot
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
