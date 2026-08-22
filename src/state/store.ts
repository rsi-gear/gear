import { constants } from 'node:fs'
import { access, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ChampionState, HitchEvaluationEvidence, MetaSessionState, RefinementRound } from '../types.js'
import { isExactGitCommit } from '../types.js'

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
  readonly workersPath: string
  readonly metaHarnessPath: string

  constructor(readonly root: string) {
    this.roundsPath = join(root, 'rounds')
    this.locksPath = join(root, 'locks')
    this.workersPath = join(root, 'workers')
    this.metaHarnessPath = join(root, 'meta-harness')
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.roundsPath, { recursive: true }),
      mkdir(this.locksPath, { recursive: true }),
      mkdir(this.workersPath, { recursive: true }),
      mkdir(this.metaHarnessPath, { recursive: true }),
    ])
  }

  async readChampion(): Promise<ChampionState | undefined> {
    const value = await this.readJson<unknown>(join(this.root, 'champion.json'))
    return value === undefined ? undefined : this.validateChampion(value)
  }

  async writeChampion(value: ChampionState): Promise<void> {
    this.validateChampion(value)
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
    const value = await this.readJson<unknown>(join(this.root, 'meta.json'))
    return value === undefined ? undefined : this.validateMeta(value)
  }

  async writeMeta(value: MetaSessionState): Promise<void> {
    this.validateMeta(value)
    await this.atomicWrite(join(this.root, 'meta.json'), value)
  }

  async readRound(roundId: string): Promise<RefinementRound | undefined> {
    const value = await this.readJson<unknown>(this.roundFile(roundId))
    return value === undefined ? undefined : this.validateRound(value)
  }

  async writeRound(value: RefinementRound): Promise<void> {
    this.validateRound(value)
    await this.atomicWrite(this.roundFile(value.roundId), value)
  }

  async listRounds(): Promise<RefinementRound[]> {
    await this.initialize()
    const names = (await readdir(this.roundsPath)).filter(name => name.endsWith('.json')).sort()
    const rounds = await Promise.all(names.map(name => this.readJson<unknown>(join(this.roundsPath, name))))
    return rounds.filter((round): round is unknown => round !== undefined).map(round => this.validateRound(round))
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

  private validateChampion(value: unknown): ChampionState {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('champion state must be an object')
    const champion = value as Partial<ChampionState>
    if (champion.schemaVersion !== 2) throw new TypeError('unsupported champion state schema; migrate the old sha256 artifact state')
    if (typeof champion.ref !== 'string' || !isExactGitCommit(champion.ref)) throw new TypeError('champion ref must be an exact Git commit')
    if (typeof champion.manifestDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(champion.manifestDigest)) {
      throw new TypeError('champion manifestDigest must be a sha256 digest')
    }
    if (typeof champion.updatedAt !== 'string' || champion.updatedAt.length === 0) throw new TypeError('champion updatedAt is required')
    if (champion.roundId !== undefined && typeof champion.roundId !== 'string') throw new TypeError('champion roundId must be a string')
    return champion as ChampionState
  }

  private validateMeta(value: unknown): MetaSessionState {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('meta state must be an object')
    const meta = value as Partial<MetaSessionState>
    if (typeof meta.sessionId !== 'string' || meta.sessionId.length === 0
      || typeof meta.metaHarnessRef !== 'string' || meta.metaHarnessRef.length === 0) {
      throw new TypeError('meta state requires sessionId and metaHarnessRef')
    }
    return meta as MetaSessionState
  }

  private validateRound(value: unknown): RefinementRound {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('refinement round must be an object')
    const round = value as Partial<RefinementRound>
    if (round.schemaVersion !== 2) throw new TypeError('unsupported refinement round schema; old artifact rounds are not compatible')
    if (typeof round.roundId !== 'string' || !/^[a-zA-Z0-9_-]+$/u.test(round.roundId)) throw new TypeError('roundId is invalid')
    const statuses = new Set([
      'queued', 'baseline-running', 'waiting-proposal', 'building-candidate', 'candidate-seed-running',
      'held-out-running', 'promoting', 'accepted', 'rejected', 'rejected-for-substrate', 'failed',
    ])
    if (typeof round.status !== 'string' || !statuses.has(round.status)) throw new TypeError('round status is invalid')
    if (round.source !== 'command' && round.source !== 'target' && round.source !== 'api') throw new TypeError('round source is invalid')
    for (const [name, field] of Object.entries({
      workspaceRoot: round.workspaceRoot,
      createdAt: round.createdAt,
      updatedAt: round.updatedAt,
      metaHarnessRef: round.metaHarnessRef,
      sandboxProfileRef: round.sandboxProfileRef,
      seedTaskRef: round.seedTaskRef,
      heldOutRef: round.heldOutRef,
      batchId: round.batchId,
    })) {
      if (typeof field !== 'string' || field.length === 0) throw new TypeError(`round ${name} is required`)
    }
    if (!Number.isSafeInteger(round.taskBudgetMs) || (round.taskBudgetMs as number) <= 0) throw new TypeError('round taskBudgetMs is invalid')
    if (!Number.isSafeInteger(round.roundIndex) || !Number.isSafeInteger(round.roundCount)
      || (round.roundIndex as number) < 1 || (round.roundCount as number) < (round.roundIndex as number)) {
      throw new TypeError('round batch index/count is invalid')
    }
    if (typeof round.targetHarnessRef !== 'string' || !isExactGitCommit(round.targetHarnessRef)) {
      throw new TypeError('round targetHarnessRef must be an exact Git commit')
    }
    if (typeof round.targetHarnessDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(round.targetHarnessDigest)) {
      throw new TypeError('round targetHarnessDigest must be a sha256 digest')
    }
    if (round.candidateRef !== undefined && !isExactGitCommit(round.candidateRef)) throw new TypeError('round candidateRef must be an exact Git commit')
    if (round.candidateDigest !== undefined && !/^sha256:[0-9a-f]{64}$/u.test(round.candidateDigest)) {
      throw new TypeError('round candidateDigest must be a sha256 digest')
    }
    if (round.baseline !== undefined) this.validateEvaluationEvidence(round.baseline, 'round baseline')
    if (round.evaluation !== undefined) {
      this.validateEvaluationEvidence(round.evaluation.seedBaseline, 'seed baseline')
      this.validateEvaluationEvidence(round.evaluation.seedCandidate, 'seed candidate')
      if (round.evaluation.heldOutBaseline !== undefined) this.validateEvaluationEvidence(round.evaluation.heldOutBaseline, 'held-out baseline')
      if (round.evaluation.heldOutCandidate !== undefined) this.validateEvaluationEvidence(round.evaluation.heldOutCandidate, 'held-out candidate')
      if (!Number.isFinite(round.evaluation.scoreDelta)
        || (round.evaluation.heldOutScoreDelta !== undefined && !Number.isFinite(round.evaluation.heldOutScoreDelta))
        || !Number.isSafeInteger(round.evaluation.requiredRegressions) || round.evaluation.requiredRegressions < 0) {
        throw new TypeError('round evaluation deltas are invalid')
      }
    }
    const terminal = round.status === 'accepted' || round.status === 'rejected'
      || round.status === 'rejected-for-substrate' || round.status === 'failed'
    if (!terminal && round.decision !== undefined) throw new TypeError('non-terminal round cannot have a decision')
    if (round.status === 'accepted') {
      if (round.decision !== 'accepted' || round.candidateRef === undefined || round.candidateDigest === undefined
        || round.evaluation?.heldOutBaseline === undefined || round.evaluation.heldOutCandidate === undefined
        || round.evaluation.seedCandidate.actualCommit !== round.candidateRef
        || round.evaluation.heldOutCandidate.actualCommit !== round.candidateRef) {
        throw new TypeError('accepted round is missing verified candidate evaluation evidence')
      }
    }
    if (round.baseline !== undefined
      && (round.baseline.requestedCommit !== round.targetHarnessRef
        || round.baseline.actualCommit !== round.targetHarnessRef
        || round.baseline.dataset !== round.seedTaskRef)) {
      throw new TypeError('round baseline does not match its pinned target/seed partition')
    }
    if (round.evaluation !== undefined) {
      const candidate = round.candidateRef
      if (candidate === undefined
        || round.evaluation.seedBaseline.requestedCommit !== round.targetHarnessRef
        || round.evaluation.seedBaseline.actualCommit !== round.targetHarnessRef
        || round.evaluation.seedBaseline.dataset !== round.seedTaskRef
        || round.evaluation.seedCandidate.requestedCommit !== candidate
        || round.evaluation.seedCandidate.actualCommit !== candidate
        || round.evaluation.seedCandidate.dataset !== round.seedTaskRef
        || round.evaluation.seedBaseline.invocationFingerprint !== round.evaluation.seedCandidate.invocationFingerprint) {
        throw new TypeError('round seed evaluation does not match its pinned commits/partition/parity')
      }
      const heldOutBaseline = round.evaluation.heldOutBaseline
      const heldOutCandidate = round.evaluation.heldOutCandidate
      if (heldOutBaseline !== undefined
        && (heldOutBaseline.requestedCommit !== round.targetHarnessRef
          || heldOutBaseline.actualCommit !== round.targetHarnessRef
          || heldOutBaseline.dataset !== round.heldOutRef)) {
        throw new TypeError('round held-out baseline does not match its pinned target/partition')
      }
      if (heldOutCandidate !== undefined
        && (heldOutBaseline === undefined
          || heldOutCandidate.requestedCommit !== candidate
          || heldOutCandidate.actualCommit !== candidate
          || heldOutCandidate.dataset !== round.heldOutRef
          || heldOutBaseline.invocationFingerprint !== heldOutCandidate.invocationFingerprint)) {
        throw new TypeError('round held-out evaluation does not match its pinned commits/partition/parity')
      }
    }
    if (round.status === 'rejected' && round.decision !== 'rejected' && round.decision !== 'no-change') {
      throw new TypeError('rejected round must record rejected or no-change decision')
    }
    if (round.status === 'rejected-for-substrate' && round.decision !== 'rejected-for-substrate') {
      throw new TypeError('substrate rejection must record rejected-for-substrate decision')
    }
    return round as RefinementRound
  }

  private validateEvaluationEvidence(value: HitchEvaluationEvidence, label: string): void {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
    if (!/^eval_[0-9a-f]{32}$/u.test(value.evalId)) throw new TypeError(`${label} evalId is invalid`)
    if (typeof value.dataset !== 'string' || value.dataset.length === 0) throw new TypeError(`${label} dataset is invalid`)
    if (!isExactGitCommit(value.requestedCommit) || !isExactGitCommit(value.actualCommit)) throw new TypeError(`${label} commit is invalid`)
    if (typeof value.revisionIdentity !== 'string' || value.revisionIdentity.length === 0
      || typeof value.invocationFingerprint !== 'string' || value.invocationFingerprint.length === 0
      || !Number.isFinite(value.primaryReward)) throw new TypeError(`${label} identity/reward is invalid`)
    if (typeof value.summary !== 'object' || value.summary === null
      || !Number.isSafeInteger(value.summary.total) || !Number.isSafeInteger(value.summary.passed)
      || !Number.isSafeInteger(value.summary.failed) || !Number.isFinite(value.summary.score)
      || value.summary.total < 0 || value.summary.passed < 0 || value.summary.failed < 0
      || value.summary.passed + value.summary.failed !== value.summary.total) {
      throw new TypeError(`${label} score summary is invalid`)
    }
    if (!Array.isArray(value.trials) || value.trials.length !== value.summary.total
      || value.trials.some(trial => typeof trial.taskName !== 'string' || trial.taskName.length === 0
      || trial.status !== 'completed'
      || (trial.runId !== undefined && !/^run_[0-9a-f]{32}$/u.test(trial.runId))
      || (trial.attempt !== undefined && (!Number.isSafeInteger(trial.attempt) || trial.attempt <= 0))
      || typeof trial.rewards !== 'object' || trial.rewards === null
      || Object.values(trial.rewards).some(reward => !Number.isFinite(reward)))) {
      throw new TypeError(`${label} trials are invalid`)
    }
    const transport = value.localSourceTransport
    if (typeof transport !== 'object' || transport === null || transport.kind !== 'local-git-commit'
      || transport.commit !== value.actualCommit || !isExactGitCommit(transport.tree)
      || transport.resolutionIdentity !== value.revisionIdentity
      || !/^sha256:[0-9a-f]{64}$/u.test(transport.payloadSha256)
      || !Number.isSafeInteger(transport.payloadBytes) || transport.payloadBytes < 0) {
      throw new TypeError(`${label} local exact commit transport evidence is invalid`)
    }
  }
}

export { exists as pathExists }
