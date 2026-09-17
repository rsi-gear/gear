import { validateSearchSchema } from '../search/schema.js'
import { searchProjectionAggregates } from '../search/legacy.js'
import { constants } from 'node:fs'
import { access, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  CandidateAssessment, ChampionState, ComponentKind, ComponentRef, EvaluationEvidence, MetaSessionState,
  PairedTrial, PairingAudit, PopulationMember, PopulationState, RefinementRound, RoundEvaluationAttempt, EvaluationSubmissionIntent,
  SeedExperienceRecord,
} from '../types.js'
import { isExactGitCommit } from '../types.js'
import { digestJson } from './digest.js'
import { validateSeedExperienceRecord } from '../experience/memory.js'
import { validateBaselineSourceSnapshot } from '../refine/baseline-source.js'

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

function validMetricSet(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const metrics = value as Record<string, unknown>
  if (!Number.isFinite(metrics.quality) || !Number.isFinite(metrics.taskSuccessRate)) return false
  for (const key of ['cost', 'latency', 'safety', 'trajectoryDiversity']) {
    if (metrics[key] !== undefined && !Number.isFinite(metrics[key])) return false
  }
  if (metrics.descriptors !== undefined) {
    if (typeof metrics.descriptors !== 'object' || metrics.descriptors === null || Array.isArray(metrics.descriptors)) return false
    if (Object.values(metrics.descriptors).some(item => typeof item !== 'string' && !Number.isFinite(item))) return false
  }
  return true
}

function validMetaPrerequisiteFailure(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const blocker = value as Record<string, unknown>
  if (blocker.schemaVersion !== 1
    || blocker.code !== 'VERIFIER_EVIDENCE_UNAVAILABLE' && blocker.code !== 'TRAJECTORY_EVIDENCE_UNAVAILABLE'
    || blocker.failedOperation !== 'candidate.finalize' && blocker.failedOperation !== 'candidate.decline'
      && blocker.failedOperation !== 'trajectory.query'
    || !Array.isArray(blocker.blockedRuns) || blocker.blockedRuns.length === 0) return false
  return blocker.blockedRuns.every(item => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return false
    const run = item as Record<string, unknown>
    return typeof run.runId === 'string' && /^run_[0-9a-f]{32}$/u.test(run.runId)
      && typeof run.code === 'string' && /^[a-z0-9_]{1,128}$/u.test(run.code)
      && (run.cause === undefined || typeof run.cause === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(run.cause))
      && (run.resolution === undefined || run.resolution === 'upgrade-hitch' || run.resolution === 'repair-evidence')
  })
}

function trialKey(trial: { taskName: string; attempt?: number }): string {
  return JSON.stringify([trial.taskName, trial.attempt ?? null])
}

function trialReward(trial: EvaluationEvidence['trials'][number]): number {
  const reward = trial.rewards.reward ?? Object.values(trial.rewards)[0]
  if (reward === undefined) throw new TypeError('paired evaluation trial has no reward')
  return reward
}

function expectedPairedTrials(baseline: EvaluationEvidence, candidate: EvaluationEvidence): PairedTrial[] {
  const baselineTrials = new Map(baseline.trials.map(trial => [trialKey(trial), trial]))
  return candidate.trials.flatMap(trial => {
    const key = trialKey(trial)
    const before = baselineTrials.get(key)
    if (before === undefined) return []
    const baselineReward = trialReward(before)
    const candidateReward = trialReward(trial)
    const baselineProcessScore = before.scores?.processScore
    const candidateProcessScore = trial.scores?.processScore
    return [{
      conditionId: baseline.conditionId,
      trialKey: key,
      taskName: trial.taskName,
      ...(before.trialName === undefined ? {} : { baselineTrialName: before.trialName }),
      ...(trial.trialName === undefined ? {} : { candidateTrialName: trial.trialName }),
      ...(trial.attempt === undefined ? {} : { attempt: trial.attempt }),
      ...(before.runId === undefined ? {} : { baselineRunId: before.runId }),
      ...(trial.runId === undefined ? {} : { candidateRunId: trial.runId }),
      baselineReward,
      candidateReward,
      rewardDelta: candidateReward - baselineReward,
      ...(baselineProcessScore === undefined ? {} : { baselineProcessScore }),
      ...(candidateProcessScore === undefined ? {} : { candidateProcessScore }),
      ...(baselineProcessScore === undefined || candidateProcessScore === undefined
        ? {}
        : { processScoreDelta: candidateProcessScore - baselineProcessScore }),
    }]
  }).sort((left, right) => left.trialKey.localeCompare(right.trialKey))
}

function pairedScoreDelta(pairs: readonly PairedTrial[]): number {
  if (pairs.length === 0) return 0
  return pairs.reduce((sum, pair) => sum + pair.candidateReward - pair.baselineReward, 0) / pairs.length
}

function pairedProcessScoreDelta(pairs: readonly PairedTrial[]): number | undefined {
  if (pairs.length === 0 || pairs.some(pair => pair.baselineProcessScore === undefined || pair.candidateProcessScore === undefined)) return undefined
  return pairs.reduce((sum, pair) => sum + pair.candidateProcessScore! - pair.baselineProcessScore!, 0) / pairs.length
}

function requiredRegressionCount(requiredTaskIds: readonly string[], pairs: readonly PairedTrial[]): number {
  if (pairs.length === 0) return 0
  const grouped = new Map<string, PairedTrial[]>()
  for (const pair of pairs) grouped.set(pair.taskName, [...(grouped.get(pair.taskName) ?? []), pair])
  let regressions = 0
  for (const task of requiredTaskIds) {
    const taskPairs = grouped.get(task)
    if (taskPairs === undefined || taskPairs.length === 0) {
      throw new TypeError(`required task has no valid paired rollout cell: ${task}`)
    }
    const baseline = taskPairs.reduce((sum, pair) => sum + pair.baselineReward, 0) / taskPairs.length
    const candidate = taskPairs.reduce((sum, pair) => sum + pair.candidateReward, 0) / taskPairs.length
    if (candidate < baseline) regressions += 1
  }
  return regressions
}

function validComponentRef(value: ComponentRef<unknown>, kind: ComponentKind): boolean {
  return value.kind === kind && value.apiVersion === 1 && value.id.length > 0
    && value.implementation.package.length > 0 && value.implementation.version.length > 0
    && value.implementation.integrity.length > 0 && digestJson(value.config) === value.configDigest
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
  readonly experienceRecordsPath: string

  constructor(
    readonly root: string,
    readonly evolutionId?: string,
    private readonly onRoundChange?: () => Promise<void>,
  ) {
    this.roundsPath = join(root, 'rounds')
    this.locksPath = join(root, 'locks')
    this.workersPath = join(root, 'workers')
    this.metaHarnessPath = join(root, 'meta-harness')
    this.experienceRecordsPath = join(root, 'experience', 'records')
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.roundsPath, { recursive: true }),
      mkdir(this.locksPath, { recursive: true }),
      mkdir(this.workersPath, { recursive: true }),
      mkdir(this.metaHarnessPath, { recursive: true }),
      mkdir(this.experienceRecordsPath, { recursive: true }),
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

  async readPopulation(): Promise<PopulationState | undefined> {
    const value = await this.readJson<unknown>(join(this.root, 'population.json'))
    return value === undefined ? undefined : this.validatePopulation(value)
  }

  async writePopulation(value: PopulationState): Promise<void> {
    this.validatePopulation(value)
    await this.atomicWrite(join(this.root, 'population.json'), value)
  }

  async compareAndSwapPopulation(expectedDigest: string, value: PopulationState): Promise<void> {
    const current = await this.readPopulation()
    if (current?.digest !== expectedDigest) {
      throw new Error(`population CAS failed: expected ${expectedDigest}, found ${current?.digest ?? '<missing>'}`)
    }
    await this.writePopulation(value)
  }

  async readRound(roundId: string): Promise<RefinementRound | undefined> {
    const value = await this.readJson<unknown>(this.roundFile(roundId))
    return value === undefined ? undefined : this.validateRound(value)
  }

  async writeRound(value: RefinementRound): Promise<void> {
    this.validateRound(value)
    await this.atomicWrite(this.roundFile(value.roundId), value)
    await this.onRoundChange?.()
  }

  async listRounds(): Promise<RefinementRound[]> {
    await this.initialize()
    const names = (await readdir(this.roundsPath)).filter(name => name.endsWith('.json')).sort()
    const rounds = await Promise.all(names.map(name => this.readJson<unknown>(join(this.roundsPath, name))))
    return rounds.filter((round): round is unknown => round !== undefined).map(round => this.validateRound(round))
  }

  async readExperienceRecord(recordDigest: string): Promise<SeedExperienceRecord | undefined> {
    const value = await this.readJson<SeedExperienceRecord>(this.experienceRecordFile(recordDigest))
    if (value === undefined) return undefined
    const record = validateSeedExperienceRecord(value)
    if (record.recordDigest !== recordDigest) throw new TypeError('seed experience record filename/digest mismatch')
    return record
  }

  async writeExperienceRecord(value: SeedExperienceRecord): Promise<void> {
    const record = validateSeedExperienceRecord(value)
    const path = this.experienceRecordFile(record.recordDigest)
    const existing = await this.readJson<SeedExperienceRecord>(path)
    if (existing !== undefined) {
      const validated = validateSeedExperienceRecord(existing)
      if (digestJson(validated) !== digestJson(record)) {
        throw new Error(`immutable seed experience record collision: ${record.recordDigest}`)
      }
      return
    }
    await this.atomicWrite(path, record)
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

  private experienceRecordFile(recordDigest: string): string {
    if (!/^sha256:[0-9a-f]{64}$/u.test(recordDigest)) throw new TypeError('invalid seed experience record digest')
    return join(this.experienceRecordsPath, `${recordDigest.slice('sha256:'.length)}.json`)
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
    if (typeof meta.evolutionId !== 'string' || !/^[a-zA-Z0-9_-]+$/u.test(meta.evolutionId)
      || (this.evolutionId !== undefined && meta.evolutionId !== this.evolutionId)
      || typeof meta.sessionId !== 'string' || meta.sessionId.length === 0
      || typeof meta.metaHarnessRef !== 'string' || meta.metaHarnessRef.length === 0
      || typeof meta.specDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(meta.specDigest)) {
      throw new TypeError('meta state requires matching evolutionId, sessionId, metaHarnessRef, and specDigest')
    }
    if (meta.checkpoint !== undefined
      && (typeof meta.checkpoint.sourceSessionId !== 'string' || meta.checkpoint.sourceSessionId !== meta.sessionId
        || !Number.isSafeInteger(meta.checkpoint.eventCount) || meta.checkpoint.eventCount < 0
        || !/^sha256:[0-9a-f]{64}$/u.test(meta.checkpoint.prefixDigest))) {
      throw new TypeError('meta checkpoint identity is invalid')
    }
    return meta as MetaSessionState
  }

  private validatePopulation(value: unknown): PopulationState {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('population state must be an object')
    const population = value as Partial<PopulationState>
    if (typeof population.evolutionId !== 'string' || !/^[a-zA-Z0-9_-]+$/u.test(population.evolutionId)
      || (this.evolutionId !== undefined && population.evolutionId !== this.evolutionId)
      || !Number.isSafeInteger(population.generation) || (population.generation as number) < 0
      || !Array.isArray(population.members) || population.members.length === 0
      || typeof population.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(population.digest)) {
      throw new TypeError('population identity is invalid')
    }
    for (const member of population.members) this.validatePopulationMember(member)
    const identity = { evolutionId: population.evolutionId, generation: population.generation, members: population.members }
    if (digestJson(identity) !== population.digest) throw new TypeError('population digest mismatch')
    return population as PopulationState
  }

  private validatePopulationMember(value: unknown): PopulationMember {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('population member is invalid')
    const member = value as Partial<PopulationMember>
    if (typeof member.candidateId !== 'string' || member.candidateId.length === 0
      || typeof member.harnessRef !== 'string' || !isExactGitCommit(member.harnessRef)
      || typeof member.harnessDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(member.harnessDigest)
      || !Array.isArray(member.parentCandidateIds)
      || member.parentCandidateIds.some(id => typeof id !== 'string' || id.length === 0)
      || typeof member.lineageRootId !== 'string' || member.lineageRootId.length === 0
      || !validMetricSet(member.metrics)
      || typeof member.selectedAt !== 'string' || member.selectedAt.length === 0
      || member.metaSessionId !== undefined && (typeof member.metaSessionId !== 'string' || member.metaSessionId.length === 0)) {
      throw new TypeError('population member is invalid')
    }
    if (member.metaCheckpoint !== undefined
      && (typeof member.metaCheckpoint !== 'object' || member.metaCheckpoint === null
        || member.metaCheckpoint.sourceSessionId !== member.metaSessionId || member.metaSessionId === undefined
        || !Number.isSafeInteger(member.metaCheckpoint.eventCount) || member.metaCheckpoint.eventCount < 0
        || !/^sha256:[0-9a-f]{64}$/u.test(member.metaCheckpoint.prefixDigest))) {
      throw new TypeError('population member Meta checkpoint is invalid')
    }
    return member as PopulationMember
  }

  private validateRound(value: unknown): RefinementRound {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('refinement round must be an object')
    const round = value as Partial<RefinementRound>
    if (typeof round.evolutionId !== 'string' || !/^[a-zA-Z0-9_-]+$/u.test(round.evolutionId)
      || (this.evolutionId !== undefined && round.evolutionId !== this.evolutionId)) {
      throw new TypeError('round evolutionId is invalid or does not match its store')
    }
    if (typeof round.roundId !== 'string' || !/^[a-zA-Z0-9_-]+$/u.test(round.roundId)) throw new TypeError('roundId is invalid')
    const statuses = new Set([
      'queued', 'baseline-running', 'preparing-candidate', 'candidate-editing', 'building-candidate', 'candidate-seed-running',
      'selection-running', 'held-out-running', 'repairing-evaluation', 'promoting', 'accepted', 'rejected',
      'rejected-for-substrate', 'failed',
    ])
    if (typeof round.status !== 'string' || !statuses.has(round.status)) throw new TypeError('round status is invalid')
    if (round.baselineReuseBlocker !== undefined) {
      const blocker = round.baselineReuseBlocker
      if (typeof blocker !== 'object' || blocker === null
        || !['BASELINE_IDENTITY_UNRESOLVED', 'BASELINE_CONDITION_MISMATCH', 'BASELINE_EVIDENCE_UNAVAILABLE'].includes(blocker.code)
        || typeof blocker.reason !== 'string' || blocker.reason.length === 0
        || typeof blocker.requiredAction !== 'string' || blocker.requiredAction.length === 0
        || round.status !== 'failed') {
        throw new TypeError('round baselineReuseBlocker is invalid')
      }
    }
    if (round.source !== 'command' && round.source !== 'target' && round.source !== 'api' && round.source !== 'skill') {
      throw new TypeError('round source is invalid')
    }
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
    const promotionPolicy = round.promotionPolicy
    if (promotionPolicy === undefined
      || !Number.isFinite(promotionPolicy.minimumCandidateScore)
      || !Number.isFinite(promotionPolicy.minimumAbsoluteGain)
      || typeof promotionPolicy.requireNoRegression !== 'boolean'
      || !Number.isFinite(promotionPolicy.maxHeldOutRegression)
      || !Number.isSafeInteger(promotionPolicy.maxRequiredRegressions)
      || promotionPolicy.maxRequiredRegressions < 0
      || (promotionPolicy.requiredTaskIds !== undefined
        && (!Array.isArray(promotionPolicy.requiredTaskIds)
          || promotionPolicy.requiredTaskIds.some(task => typeof task !== 'string' || task.length === 0)
          || new Set(promotionPolicy.requiredTaskIds).size !== promotionPolicy.requiredTaskIds.length))) {
      throw new TypeError('round promotion policy is invalid')
    }
    if (round.plan === undefined || round.plan.planId.length === 0 || !/^sha256:[0-9a-f]{64}$/u.test(round.plan.digest)) {
      throw new TypeError('round resolved plan is invalid')
    }
    if (round.plan.taskSampler.kind !== 'task-sampler'
      || digestJson({ roundId: round.roundId, taskSampler: round.plan.taskSampler, seed: round.plan.seed, heldOut: round.plan.heldOut }) !== round.plan.digest) {
      throw new TypeError('round resolved plan digest mismatch')
    }
    for (const [label, condition] of [['seed', round.plan.seed], ['held-out', round.plan.heldOut]] as const) {
      if (!/^sha256:[0-9a-f]{64}$/u.test(condition.conditionId) || condition.partition !== label
        || condition.dataset.ref !== (label === 'seed' ? round.seedTaskRef : round.heldOutRef)
        || !/^sha256:[0-9a-f]{64}$/u.test(condition.dataset.digest)
        || !Number.isSafeInteger(condition.repetitions) || condition.repetitions <= 0
        || !Number.isSafeInteger(condition.timeoutMs) || condition.timeoutMs !== round.taskBudgetMs
        || typeof condition.model !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(condition.rolloutProviderDigest)) {
        throw new TypeError(`round ${label} evaluation condition is invalid`)
      }
      const conditionIdentity = {
        partition: condition.partition,
        dataset: condition.dataset,
        repetitions: condition.repetitions,
        ...(condition.seeds === undefined ? {} : { seeds: condition.seeds }),
        model: condition.model,
        sampling: condition.sampling,
        timeoutMs: condition.timeoutMs,
        rolloutProviderDigest: condition.rolloutProviderDigest,
      }
      if (digestJson(conditionIdentity) !== condition.conditionId) {
        throw new TypeError(`round ${label} evaluation condition digest mismatch`)
      }
    }
    if (round.baselineSource !== undefined) {
      const snapshot = validateBaselineSourceSnapshot(round.baselineSource)
      const seed = snapshot.partitions.seed
      const seedAttempt = round.evaluationAttempts?.find(attempt => (
        attempt.provider === seed.evidence.provider && attempt.evalId === seed.evidence.evalId
      ))
      const parentBaseline = round.parentBaselines?.find(parent => (
        parent.parentHarnessRef === round.targetHarnessRef
          && digestJson(parent.evidence) === seed.evidenceDigest
      ))
      if (snapshot.source.evolutionId === round.evolutionId
        || snapshot.target.harnessRef !== round.targetHarnessRef
        || snapshot.target.manifestDigest !== round.targetHarnessDigest
        || digestJson(seed.condition) !== digestJson(round.plan.seed)
        || round.baseline === undefined || digestJson(round.baseline) !== seed.evidenceDigest
        || parentBaseline === undefined
        || seedAttempt?.status !== 'settled' || seedAttempt.phase !== 'seed-baseline'
        || seedAttempt.owner.role !== 'baseline' || seedAttempt.owner.harnessRef !== round.targetHarnessRef
        || seedAttempt.reusedFromEvolutionId !== snapshot.source.evolutionId
        || seedAttempt.reusedFromRoundId !== snapshot.source.roundId) {
        throw new TypeError('round baseline source snapshot is not durably imported')
      }
      const heldOut = snapshot.partitions.heldOut
      if (heldOut !== undefined && round.evaluation?.heldOutBaseline !== undefined) {
        const heldOutAttempt = round.evaluationAttempts?.find(attempt => (
          attempt.provider === heldOut.evidence.provider && attempt.evalId === heldOut.evidence.evalId
        ))
        if (digestJson(round.evaluation.heldOutBaseline) !== heldOut.evidenceDigest
          || heldOutAttempt?.status !== 'settled' || heldOutAttempt.phase !== 'held-out-baseline'
          || heldOutAttempt.owner.role !== 'baseline' || heldOutAttempt.owner.harnessRef !== round.targetHarnessRef
          || heldOutAttempt.reusedFromEvolutionId !== snapshot.source.evolutionId
          || heldOutAttempt.reusedFromRoundId !== snapshot.source.roundId) {
          throw new TypeError('round held-out baseline differs from its source snapshot')
        }
      }
    }
    if (round.advisoryFocus !== undefined && (!Array.isArray(round.advisoryFocus)
      || new Set(round.advisoryFocus).size !== round.advisoryFocus.length)) {
      throw new TypeError('round advisoryFocus must be a deduplicated array')
    }
    if (round.experienceSnapshot !== undefined) {
      const snapshot = round.experienceSnapshot
      if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.members)
        || snapshot.members.length > 4_096 || !/^sha256:[0-9a-f]{64}$/u.test(snapshot.digest)
        || new Set(snapshot.members.map(member => member.recordId)).size !== snapshot.members.length
        || new Set(snapshot.members.map(member => member.recordDigest)).size !== snapshot.members.length) {
        throw new TypeError('round seed experience snapshot is invalid')
      }
      for (const member of snapshot.members) {
        if (typeof member.recordId !== 'string' || member.recordId.length === 0
          || !/^sha256:[0-9a-f]{64}$/u.test(member.recordDigest)
          || typeof member.sourceRoundId !== 'string' || member.sourceRoundId.length === 0
          || typeof member.candidateId !== 'string' || member.candidateId.length === 0
          || !isExactGitCommit(member.candidateHarnessRef)
          || member.sourceRoundId === round.roundId) {
          throw new TypeError('round seed experience snapshot member is invalid')
        }
      }
      if (snapshot.digest !== digestJson({ schemaVersion: 1, members: snapshot.members })) {
        throw new TypeError('round seed experience snapshot digest mismatch')
      }
    }
    if (round.finalization !== undefined && round.finalization !== null) {
      if (typeof round.finalization.rationale !== 'string' || round.finalization.rationale.length === 0
        || typeof round.finalization.expectedOutcome !== 'string' || round.finalization.expectedOutcome.length === 0
        || !Array.isArray(round.finalization.evidenceRefs)
        || round.finalization.evidenceRefs.some(ref => typeof ref !== 'string' || ref.length === 0)) {
        throw new TypeError('round finalization is invalid')
      }
    }
    if (round.decline !== undefined && (typeof round.decline.rationale !== 'string'
      || round.decline.rationale.length === 0 || !Array.isArray(round.decline.evidenceRefs)
      || round.decline.evidenceRefs.some(ref => typeof ref !== 'string' || ref.length === 0))) {
      throw new TypeError('round decline is invalid')
    }
    if (round.searchMode !== undefined) {
      if (round.searchMode !== 'failure-cluster-gepa-v1' || !round.searchAnchor) throw new TypeError('invalid search round admission')
      const { digest: anchorDigest, ...snapshot } = round.searchAnchor.snapshot
      if (digestJson(snapshot) !== anchorDigest || snapshot.commit !== round.targetHarnessRef || snapshot.manifestDigest !== round.targetHarnessDigest
        || !/^sha256:[a-f0-9]{64}$/u.test(round.searchAnchor.championRevisionDigest)) throw new TypeError('search champion anchor identity mismatch')
      if (round.searchOutcome) {
        validateSearchSchema('SearchRoundOutcome', round.searchOutcome)
        const { digest: outcomeDigest, ...outcome } = round.searchOutcome
        if (digestJson(outcome) !== outcomeDigest || outcome.roundId !== round.roundId || outcome.schemaVersion !== 2
          || outcome.championAnchorDigest !== anchorDigest || outcome.championChanged !== (round.status === 'accepted')) throw new TypeError('search terminal decision mismatch')
        if (outcome.championChanged && (outcome.advisory || outcome.promotion?.outcome !== 'accepted'
          || !round.candidatePool?.some(c => c.candidateId === outcome.nomineeId && c.sealedVersion))) throw new TypeError('search champion requires complete promotion')
      } else if (round.status === 'accepted') throw new TypeError('search accepted round missing v2 outcome')
    }
    if (!Array.isArray(round.candidatePool) || round.candidatePool.length === 0 && round.searchMode === undefined
      || new Set(round.candidatePool.map(candidate => candidate.candidateId)).size !== round.candidatePool.length) {
      throw new TypeError('round candidatePool is invalid')
    }
    if (round.candidateGenerationDeadlineAt !== undefined
      && (!Number.isSafeInteger(round.candidateGenerationDeadlineAt) || round.candidateGenerationDeadlineAt <= 0)) {
      throw new TypeError('round candidate generation deadline is invalid')
    }
    for (const candidate of round.candidatePool) {
      if (candidate.roundId !== round.roundId || candidate.candidateId.length === 0
        || !isExactGitCommit(candidate.parentHarnessRef) || candidate.parentCandidateIds.length !== 1) {
        throw new TypeError('round candidate identity is invalid')
      }
      for (const checkpoint of [candidate.parentCheckpoint, candidate.resultCheckpoint]) {
        if (checkpoint !== undefined && (typeof checkpoint.sourceSessionId !== 'string'
          || !Number.isSafeInteger(checkpoint.eventCount) || checkpoint.eventCount < 0
          || !/^sha256:[0-9a-f]{64}$/u.test(checkpoint.prefixDigest))) {
          throw new TypeError('round candidate Meta checkpoint is invalid')
        }
      }
      if (candidate.generationAttempts !== undefined) {
        if (!Array.isArray(candidate.generationAttempts) || candidate.generationAttempts.length === 0) {
          throw new TypeError('round candidate generation attempts are invalid')
        }
        for (const [index, attempt] of candidate.generationAttempts.entries()) {
          const hasValidFailure = attempt.failure !== undefined
            && typeof attempt.failure.phase === 'string' && attempt.failure.phase.length > 0
            && typeof attempt.failure.message === 'string' && attempt.failure.message.length > 0
            && (attempt.failure.prerequisite === undefined
              || validMetaPrerequisiteFailure(attempt.failure.prerequisite))
          const turnUsage = attempt.metaTurn?.usage
          const hasValidMetaTurn = attempt.metaTurn === undefined || (
            typeof attempt.metaTurn.reason === 'string' && attempt.metaTurn.reason.length > 0
            && (attempt.metaTurn.turn === undefined || Number.isSafeInteger(attempt.metaTurn.turn))
            && (attempt.metaTurn.durationMs === undefined
              || Number.isSafeInteger(attempt.metaTurn.durationMs) && attempt.metaTurn.durationMs >= 0)
            && (attempt.metaTurn.effectiveMaxTokens === undefined
              || Number.isSafeInteger(attempt.metaTurn.effectiveMaxTokens) && attempt.metaTurn.effectiveMaxTokens > 0)
            && (turnUsage === undefined || [
              turnUsage.inputTokens, turnUsage.outputTokens, turnUsage.cacheReadTokens,
              turnUsage.cacheWriteTokens, turnUsage.reasoningTokens,
            ].every(value => value === undefined || Number.isSafeInteger(value) && value >= 0))
          )
          if (attempt.attempt !== index + 1
            || attempt.deadlineAt !== undefined && (!Number.isSafeInteger(attempt.deadlineAt) || attempt.deadlineAt <= 0)
            || [attempt.preparationCompletedAt, attempt.proposalCompletedAt].some(value => value !== undefined && !Number.isFinite(Date.parse(value)))
            || typeof attempt.startedAt !== 'string' || attempt.startedAt.length === 0
            || attempt.workspaceId !== undefined && (typeof attempt.workspaceId !== 'string' || attempt.workspaceId.length === 0)
            || attempt.metaSessionId !== undefined && (typeof attempt.metaSessionId !== 'string' || attempt.metaSessionId.length === 0)
            || attempt.prerequisiteBlocker !== undefined && !validMetaPrerequisiteFailure(attempt.prerequisiteBlocker)
            || attempt.status === 'running' && (attempt.completedAt !== undefined || attempt.failure !== undefined)
            || attempt.status === 'succeeded' && (typeof attempt.completedAt !== 'string' || attempt.completedAt.length === 0 || attempt.failure !== undefined)
            || attempt.status === 'failed' && (typeof attempt.completedAt !== 'string' || attempt.completedAt.length === 0 || !hasValidFailure)
            || !hasValidMetaTurn
            || !['running', 'succeeded', 'failed'].includes(attempt.status)) {
            throw new TypeError('round candidate generation attempt is invalid')
          }
        }
      }
      if (candidate.diff !== undefined && (candidate.diff.parentRef !== candidate.parentHarnessRef
        || !/^sha256:[0-9a-f]{64}$/u.test(candidate.diff.patchDigest)
        || !Number.isSafeInteger(candidate.diff.totalBytes) || candidate.diff.totalBytes < 0
        || !Array.isArray(candidate.diff.files))) {
        throw new TypeError('round candidate diff is invalid')
      }
      if (candidate.sealedVersion !== undefined) {
        if (!isExactGitCommit(candidate.sealedVersion.commitOid) || !isExactGitCommit(candidate.sealedVersion.treeOid)
          || !/^sha256:[0-9a-f]{64}$/u.test(candidate.sealedVersion.manifestDigest)
          || !/^sha256:[0-9a-f]{64}$/u.test(candidate.sealedVersion.patchDigest)
          || !candidate.sealedVersion.immutableRef.startsWith('refs/dsh-refine/evolutions/')) {
          throw new TypeError('round sealed candidate identity is invalid')
        }
        if (candidate.diff !== undefined && candidate.sealedVersion.patchDigest !== candidate.diff.patchDigest) {
          throw new TypeError('round sealed candidate patch digest mismatch')
        }
      }
      if (candidate.seedEvaluation !== undefined) this.validateEvaluationEvidence(candidate.seedEvaluation, 'candidate seed evaluation')
      if (candidate.seedComparison !== undefined) {
        if (candidate.seedEvaluation === undefined
          || typeof candidate.seedComparison.parentBaselineEvalId !== 'string'
          || !Number.isFinite(candidate.seedComparison.scoreDelta)
          || (candidate.seedComparison.processScoreDelta !== undefined && !Number.isFinite(candidate.seedComparison.processScoreDelta))
          || !Number.isSafeInteger(candidate.seedComparison.requiredRegressions)
          || candidate.seedComparison.requiredRegressions < 0) {
          throw new TypeError('candidate seed comparison is invalid')
        }
        this.validatePairedTrials(
          candidate.seedComparison.pairedTrials,
          round.plan.seed.conditionId,
          candidate.seedComparison.pairing.paired,
          'candidate seed',
        )
        const parentBaselineRecord = round.parentBaselines?.find(value => (
          value.evidence.evalId === candidate.seedComparison!.parentBaselineEvalId
        ))
        if (parentBaselineRecord === undefined
          || parentBaselineRecord.parentCandidateId !== candidate.parentCandidateIds[0]) {
          throw new TypeError('candidate seed comparison baseline is unavailable')
        }
        const parentBaseline = parentBaselineRecord.evidence
        this.validatePairingAudit(
          candidate.seedComparison.pairing,
          parentBaseline,
          candidate.seedEvaluation,
          candidate.seedComparison.pairedTrials,
          'candidate seed',
        )
        if (Math.abs(candidate.seedComparison.scoreDelta - pairedScoreDelta(candidate.seedComparison.pairedTrials)) > 1e-12) {
          throw new TypeError('candidate seed comparison score delta is invalid')
        }
        const expectedProcessScoreDelta = pairedProcessScoreDelta(candidate.seedComparison.pairedTrials)
        if ((candidate.seedComparison.processScoreDelta === undefined) !== (expectedProcessScoreDelta === undefined)
          || candidate.seedComparison.processScoreDelta !== undefined
            && Math.abs(candidate.seedComparison.processScoreDelta - expectedProcessScoreDelta!) > 1e-12) {
          throw new TypeError('candidate seed comparison process score delta is invalid')
        }
        if (candidate.seedComparison.requiredRegressions !== requiredRegressionCount(
          promotionPolicy.requiredTaskIds ?? [],
          candidate.seedComparison.pairedTrials,
        )) {
          throw new TypeError('candidate seed comparison required regressions are invalid')
        }
      }
      if (candidate.heldOutEvaluation !== undefined) this.validateEvaluationEvidence(candidate.heldOutEvaluation, 'candidate held-out evaluation')
      if (candidate.metrics !== undefined && !validMetricSet(candidate.metrics)) throw new TypeError('candidate metrics are invalid')
    }
    if (['accepted', 'rejected', 'rejected-for-substrate', 'failed'].includes(round.status)
      && round.candidatePool.some(candidate => candidate.generationAttempts?.some(attempt => attempt.status === 'running'))) {
      throw new TypeError('terminal round cannot contain a running candidate generation attempt')
    }
    if (round.championParent !== undefined) {
      const parent = this.validatePopulationMember(round.championParent)
      if (parent.harnessRef !== round.targetHarnessRef || parent.harnessDigest !== round.targetHarnessDigest) {
        throw new TypeError('round champion parent does not match its admitted champion')
      }
      if (!Array.isArray(round.parentAllocations)
        || new Set(round.parentAllocations.map(allocation => allocation.candidateId)).size !== round.candidatePool.length
        || round.parentAllocations.some(allocation => allocation.parentCandidateId !== parent.candidateId
          || allocation.parentHarnessRef !== parent.harnessRef || allocation.parentHarnessDigest !== parent.harnessDigest)
        || round.candidatePool.some(candidate => candidate.parentCandidateIds[0] !== parent.candidateId
          || candidate.parentHarnessRef !== parent.harnessRef)) {
        throw new TypeError('round champion parent allocation is invalid')
      }
    }
    if (round.parentAllocations !== undefined) {
      if (round.parentAllocations.length !== round.candidatePool.length) throw new TypeError('round parent allocation is incomplete')
      for (const allocation of round.parentAllocations) {
        const candidate = round.candidatePool.find(item => item.candidateId === allocation.candidateId)
        if (candidate === undefined || candidate.parentCandidateIds[0] !== allocation.parentCandidateId
          || candidate.parentHarnessRef !== allocation.parentHarnessRef || !isExactGitCommit(allocation.parentHarnessRef)
          || !/^sha256:[0-9a-f]{64}$/u.test(allocation.parentHarnessDigest)) {
          throw new TypeError('round parent allocation is invalid')
        }
      }
    }
    if (round.evaluationStarts !== undefined) {
      if (!Array.isArray(round.evaluationStarts)) throw new TypeError('round evaluationStarts must be an array')
      for (const start of round.evaluationStarts) {
        if (typeof start !== 'object' || start === null
          || !['seed-baseline', 'seed-candidate', 'held-out-baseline', 'held-out-candidate'].includes(start.phase)
          || !isExactGitCommit(start.harnessRef)
          || start.conditionId !== (start.phase.startsWith('seed-') ? round.plan!.seed : round.plan!.heldOut).conditionId
          || typeof start.startedAt !== 'string' || start.startedAt.length === 0) {
          throw new TypeError('round evaluation start is invalid')
        }
      }
    }
    if (round.evaluationRepairResume !== undefined && round.evaluationAttempts === undefined) {
      throw new TypeError('round evaluation repair resume intent requires evaluation attempts')
    }
    if (round.evaluationAttempts !== undefined) {
      if (!Array.isArray(round.evaluationAttempts)) throw new TypeError('round evaluationAttempts must be an array')
      const identities = new Set<string>()
      for (const attempt of round.evaluationAttempts) {
        this.validateEvaluationAttempt(round as RefinementRound, attempt, identities)
      }
    }
    if (round.pendingEvaluationRerun !== undefined) {
      const pending = round.pendingEvaluationRerun
      if (typeof pending !== 'object' || pending === null || typeof pending.reservation !== 'object' || pending.reservation === null) {
        throw new TypeError('pending evaluation rerun is invalid')
      }
      const reservation = pending.reservation
      this.validateSubmissionIntent({ provider: reservation.provider, idempotencyKey: reservation.rerunId, parameters: reservation.parameters })
      const attempt = round.evaluationAttempts?.find(value => value.provider === reservation.provider && value.evalId === reservation.evalId)
      if (attempt === undefined || (attempt.status !== 'rerunning' && attempt.status !== 'failed')
        || (round.status !== 'repairing-evaluation' && round.status !== 'failed')
        || (reservation.provider === 'hitch-cli' && !/^rerun_[0-9a-f]{32}$/u.test(reservation.rerunId))) {
        throw new TypeError('pending evaluation rerun does not match its owned attempt')
      }
    }
    if (round.pendingEvaluationSubmissions !== undefined) {
      if (!Array.isArray(round.pendingEvaluationSubmissions)) throw new TypeError('pending evaluation submissions must be an array')
      const identities = new Set<string>()
      for (const pending of round.pendingEvaluationSubmissions) {
        if (typeof pending !== 'object' || pending === null || typeof pending.request !== 'object'
          || pending.request === null || typeof pending.request.phase !== 'string') {
          throw new TypeError('pending evaluation submission is invalid')
        }
        this.validateSubmissionIntent(pending.intent)
        const identity = `${pending.intent.provider}\0${pending.intent.idempotencyKey}`
        if (identities.has(identity)) throw new TypeError('pending evaluation submission is duplicated')
        identities.add(identity)
        const request = pending.request
        const condition = request.phase.startsWith('seed-') ? round.plan!.seed : round.plan!.heldOut
        if (digestJson(request.condition) !== digestJson(condition)
          || (pending.reservation !== undefined && pending.reservation.provider !== pending.intent.provider)) {
          throw new TypeError('pending evaluation submission condition/provider is invalid')
        }
        this.validateEvaluationAttempt(round as RefinementRound, {
          provider: pending.intent.provider,
          evalId: pending.reservation?.evalId ?? `eval_${'0'.repeat(32)}`,
          phase: request.phase, owner: pending.owner,
          conditionId: request.condition.conditionId, dataset: request.dataset,
          requestedModelId: request.condition.model, requestedCommit: request.harnessRef,
          status: 'running', startedAt: pending.startedAt,
        }, new Set())
      }
    }
    if (round.parentBaselines !== undefined) {
      for (const baseline of round.parentBaselines) {
        this.validateEvaluationEvidence(baseline.evidence, 'parent seed baseline', round.searchMode === 'failure-cluster-gepa-v1')
        if (baseline.evidence.actualCommit !== baseline.parentHarnessRef
          || baseline.evidence.conditionId !== round.plan.seed.conditionId) throw new TypeError('parent seed baseline identity is invalid')
      }
    }
    if (round.failedEvaluations !== undefined) {
      if (!Array.isArray(round.failedEvaluations)) throw new TypeError('round failed evaluations must be an array')
      const keys = round.failedEvaluations.map(value => `${value.phase}\u0000${value.owner.candidateId}\u0000${value.evidence.evalId}`)
      if (new Set(keys).size !== keys.length) throw new TypeError('round failed evaluations are duplicated')
      for (const failed of round.failedEvaluations) this.validateFailedEvaluation(failed, round as RefinementRound)
    }
    if (round.selectionAssessment !== undefined) {
      const assessableCandidates = round.candidatePool
        .filter(candidate => candidate.seedEvaluation !== undefined && candidate.seedComparison !== undefined && candidate.metrics !== undefined)
      const assessable = assessableCandidates.map(candidate => candidate.candidateId)
      this.validateCandidateAssessment(round.selectionAssessment, assessable)
      if (assessableCandidates.some(candidate => digestJson(candidate.metrics) !== digestJson(
        round.selectionAssessment!.candidateMetrics[candidate.candidateId],
      ))) {
        throw new TypeError('round candidate assessment metrics do not match candidate records')
      }
    }
    if (round.selection !== undefined) {
      const selected = new Set(round.selection.selectedCandidateIds)
      const assessedIds = Object.keys(round.selectionAssessment?.candidateMetrics ?? {}).sort()
      const metricIds = Object.keys(round.selection.metrics).sort()
      if (selected.size !== round.selection.selectedCandidateIds.length || selected.size === 0
        || !selected.has(round.selection.promotionCandidateId)
        || round.selectionAssessment === undefined
        || round.selection.assessmentDigest !== round.selectionAssessment.digest
        || !validComponentRef(round.selection.component, 'candidate-selector')
        || JSON.stringify(metricIds) !== JSON.stringify(assessedIds)
        || Object.values(round.selection.metrics).some(metric => !Number.isFinite(metric))
        || round.promotionCandidateId !== undefined && round.promotionCandidateId !== round.selection.promotionCandidateId
        || [...selected].some(id => !round.candidatePool!.some(candidate => candidate.candidateId === id))) {
        throw new TypeError('round selection decision is invalid')
      }
    }
    if (round.meta !== undefined && round.meta.evolutionId !== round.evolutionId) {
      throw new TypeError('round meta attribution evolution mismatch')
    }
    if (round.proposalEvidence !== undefined && round.proposalEvidence.evolutionId !== round.evolutionId) {
      throw new TypeError('round proposal evidence evolution mismatch')
    }
    if (round.baseline !== undefined) this.validateEvaluationEvidence(round.baseline, 'round baseline')
    if (round.evaluationMode !== undefined && round.evaluationMode !== 'reuse-seed') {
      throw new TypeError('round evaluation mode is invalid')
    }
    if (round.evaluation?.heldOutReusedFromSeed !== undefined) {
      const { conditionId: _seedId, partition: _seedPartition, ...seed } = round.plan.seed
      const { conditionId: _heldOutId, partition: _heldOutPartition, ...heldOut } = round.plan.heldOut
      if (round.evaluationMode !== 'reuse-seed' || round.evaluation.heldOutReusedFromSeed !== true
        || digestJson(seed) !== digestJson(heldOut)
        || digestJson(round.evaluation.seedBaseline) !== digestJson(round.evaluation.heldOutBaseline)
        || digestJson(round.evaluation.seedCandidate) !== digestJson(round.evaluation.heldOutCandidate)
        || digestJson(round.evaluation.seedPairedTrials) !== digestJson(round.evaluation.heldOutPairedTrials)) {
        throw new TypeError('reused held-out evidence must exactly match seed evidence and conditions')
      }
    }
    const heldOutConditionId = round.evaluation?.heldOutReusedFromSeed === true
      ? round.plan.seed.conditionId : round.plan.heldOut.conditionId
    if (round.evaluation !== undefined) {
      this.validateEvaluationEvidence(round.evaluation.seedBaseline, 'seed baseline')
      this.validateEvaluationEvidence(round.evaluation.seedCandidate, 'seed candidate')
      if (round.evaluation.heldOutBaseline !== undefined) this.validateEvaluationEvidence(round.evaluation.heldOutBaseline, 'held-out baseline')
      if (round.evaluation.heldOutCandidate !== undefined) this.validateEvaluationEvidence(round.evaluation.heldOutCandidate, 'held-out candidate')
      this.validatePairedTrials(
        round.evaluation.seedPairedTrials,
        round.plan.seed.conditionId,
        round.evaluation.seedPairing.paired,
        'seed',
      )
      this.validatePairingAudit(
        round.evaluation.seedPairing,
        round.evaluation.seedBaseline,
        round.evaluation.seedCandidate,
        round.evaluation.seedPairedTrials,
        'seed',
      )
      if (Math.abs(round.evaluation.scoreDelta - pairedScoreDelta(round.evaluation.seedPairedTrials)) > 1e-12) {
        throw new TypeError('round seed score delta does not match paired evidence')
      }
      const seedProcessScoreDelta = pairedProcessScoreDelta(round.evaluation.seedPairedTrials)
      if ((round.evaluation.processScoreDelta === undefined) !== (seedProcessScoreDelta === undefined)
        || round.evaluation.processScoreDelta !== undefined
          && Math.abs(round.evaluation.processScoreDelta - seedProcessScoreDelta!) > 1e-12) {
        throw new TypeError('round seed process score delta does not match paired evidence')
      }
      if (round.evaluation.heldOutPairedTrials !== undefined) {
        if (round.evaluation.heldOutBaseline === undefined || round.evaluation.heldOutCandidate === undefined
          || round.evaluation.heldOutPairing === undefined) throw new TypeError('held-out pairs require paired evidence and audit')
        this.validatePairedTrials(
          round.evaluation.heldOutPairedTrials,
          heldOutConditionId,
          round.evaluation.heldOutPairing.paired,
          'held-out',
        )
        this.validatePairingAudit(
          round.evaluation.heldOutPairing,
          round.evaluation.heldOutBaseline,
          round.evaluation.heldOutCandidate,
          round.evaluation.heldOutPairedTrials,
          'held-out',
        )
        if (round.evaluation.heldOutScoreDelta === undefined
          || Math.abs(round.evaluation.heldOutScoreDelta - pairedScoreDelta(round.evaluation.heldOutPairedTrials)) > 1e-12) {
          throw new TypeError('round held-out score delta does not match paired evidence')
        }
        const heldOutProcessScoreDelta = pairedProcessScoreDelta(round.evaluation.heldOutPairedTrials)
        if ((round.evaluation.heldOutProcessScoreDelta === undefined) !== (heldOutProcessScoreDelta === undefined)
          || round.evaluation.heldOutProcessScoreDelta !== undefined
            && Math.abs(round.evaluation.heldOutProcessScoreDelta - heldOutProcessScoreDelta!) > 1e-12) {
          throw new TypeError('round held-out process score delta does not match paired evidence')
        }
      } else if (round.evaluation.heldOutCandidate !== undefined) {
        throw new TypeError('held-out candidate evidence requires paired trials')
      } else if (round.evaluation.heldOutPairing !== undefined) {
        throw new TypeError('held-out pairing audit requires paired trials')
      }
      if (round.evaluation.promotionMetrics !== undefined && !validMetricSet(round.evaluation.promotionMetrics)) {
        throw new TypeError('round promotion metrics are invalid')
      }
      if (!Number.isFinite(round.evaluation.scoreDelta)
        || (round.evaluation.processScoreDelta !== undefined && !Number.isFinite(round.evaluation.processScoreDelta))
        || (round.evaluation.heldOutScoreDelta !== undefined && !Number.isFinite(round.evaluation.heldOutScoreDelta))
        || (round.evaluation.heldOutProcessScoreDelta !== undefined && !Number.isFinite(round.evaluation.heldOutProcessScoreDelta))
        || !Number.isSafeInteger(round.evaluation.requiredRegressions) || round.evaluation.requiredRegressions < 0) {
        throw new TypeError('round evaluation deltas are invalid')
      }
      const expectedRequiredRegressions = requiredRegressionCount(
        promotionPolicy.requiredTaskIds ?? [],
        round.evaluation.seedPairedTrials,
      ) + (round.evaluation.heldOutReusedFromSeed === true ? 0 : requiredRegressionCount(
        promotionPolicy.requiredTaskIds ?? [],
        round.evaluation.heldOutPairedTrials ?? [],
      ))
      if (round.evaluation.requiredRegressions !== expectedRequiredRegressions) {
        throw new TypeError('round required regressions do not match paired evidence')
      }
      if (round.status === 'accepted' && (round.evaluation.seedPairedTrials.length === 0
        || (round.evaluation.heldOutPairedTrials?.length ?? 0) === 0)) {
        throw new TypeError('accepted round requires valid seed and held-out pairs')
      }
    }
    if (round.evaluationAttempts !== undefined) {
      const evidence = [
        round.baseline,
        ...(round.parentBaselines ?? []).map(value => value.evidence),
        ...round.candidatePool.flatMap(candidate => [candidate.seedEvaluation, candidate.heldOutEvaluation]),
        round.evaluation?.seedBaseline,
        round.evaluation?.seedCandidate,
        round.evaluation?.heldOutBaseline,
        round.evaluation?.heldOutCandidate,
      ].filter((value): value is EvaluationEvidence => value !== undefined)
      for (const value of evidence) {
        const attempt = round.evaluationAttempts.find(candidate => candidate.provider === value.provider && candidate.evalId === value.evalId)
        const durableRepairEvidence = attempt?.status === 'repair-completed'
          && round.evaluationRepairResume?.provider === attempt.provider
          && round.evaluationRepairResume.evalId === attempt.evalId
        const legacyRepairEvidence = round.evaluationRepairResume === undefined
          && round.status === 'repairing-evaluation'
          && (attempt?.status === 'rerunning' || attempt?.status === 'repair-completed')
        if (attempt === undefined || (attempt.status !== 'settled' && !durableRepairEvidence && !legacyRepairEvidence)
          || attempt.conditionId !== value.conditionId || attempt.dataset !== value.dataset
          || attempt.requestedCommit !== value.requestedCommit || attempt.owner.harnessRef !== value.actualCommit) {
          throw new TypeError('round evaluation evidence does not match its durable attempt ownership')
        }
      }
      const resume = round.evaluationRepairResume
      if (resume !== undefined) {
        if (typeof resume !== 'object' || resume === null
          || typeof resume.provider !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(resume.provider)
          || typeof resume.evalId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(resume.evalId)
          || typeof resume.completedAt !== 'string' || resume.completedAt.length === 0) {
          throw new TypeError('round evaluation repair resume intent is invalid')
        }
        const terminal = round.status === 'accepted' || round.status === 'rejected'
          || round.status === 'rejected-for-substrate' || round.status === 'failed'
        const attempt = round.evaluationAttempts.find(candidate => candidate.provider === resume.provider && candidate.evalId === resume.evalId)
        if (terminal || round.decision !== undefined || round.commitIntent !== undefined
          || attempt?.status !== 'repair-completed' || attempt.completedAt !== resume.completedAt
          || !evidence.some(value => value.provider === resume.provider && value.evalId === resume.evalId)) {
          throw new TypeError('round evaluation repair resume intent is invalid')
        }
      }
      for (const attempt of round.evaluationAttempts) {
        const ownsResume = round.evaluationRepairResume?.provider === attempt.provider
          && round.evaluationRepairResume.evalId === attempt.evalId
        const legacyPendingResume = round.evaluationRepairResume === undefined && round.status === 'repairing-evaluation'
        if (attempt.status === 'repair-completed' && ((!ownsResume && !legacyPendingResume)
          || !evidence.some(value => value.provider === attempt.provider && value.evalId === attempt.evalId))) {
          throw new TypeError('completed evaluation repair requires durable evidence and pending resume state')
        }
      }
    }
    if (round.parentPopulationDigest !== undefined && !/^sha256:[0-9a-f]{64}$/u.test(round.parentPopulationDigest)) {
      throw new TypeError('round parent population digest is invalid')
    }
    if (round.commitIntent !== undefined) {
      const intent = round.commitIntent
      if (intent.expectedPopulationDigest !== round.parentPopulationDigest
        || intent.expectedChampionRef !== round.targetHarnessRef
        || intent.promotionCandidateId !== round.promotionCandidateId
        || !['prepared', 'population-committed', 'champion-committed'].includes(intent.phase)
        || !['accepted', 'rejected'].includes(intent.decision)) {
        throw new TypeError('round commit intent identity is invalid')
      }
      this.validatePopulation(intent.nextPopulation)
      const selectedIds = new Set(round.selection?.selectedCandidateIds ?? [])
      if (intent.nextPopulation.evolutionId !== round.evolutionId
        || intent.nextPopulation.members.length !== selectedIds.size
        || intent.nextPopulation.members.some(member => {
          const candidate = round.candidatePool!.find(value => value.candidateId === member.candidateId)
          return !selectedIds.has(member.candidateId) || candidate?.metrics === undefined || candidate.resultCheckpoint === undefined
            || candidate.metaSessionId === undefined || candidate.sealedVersion?.commitOid !== member.harnessRef
            || candidate.sealedVersion.manifestDigest !== member.harnessDigest
            || candidate.metaSessionId !== member.metaSessionId
            || digestJson(candidate.metrics) !== digestJson(member.metrics)
            || digestJson(candidate.resultCheckpoint) !== digestJson(member.metaCheckpoint)
        })) {
        throw new TypeError('round commit intent population does not match seed-selected candidates')
      }
      if ((intent.decision === 'accepted') !== (intent.nextChampion !== undefined)) {
        throw new TypeError('round commit intent champion decision is incomplete')
      }
      if (intent.nextChampion !== undefined
        && (this.validateChampion(intent.nextChampion).ref
          !== round.candidatePool.find(candidate => candidate.candidateId === intent.promotionCandidateId)?.sealedVersion?.commitOid)) {
        throw new TypeError('round commit intent champion is invalid')
      }
    }
    const terminal = round.status === 'accepted' || round.status === 'rejected'
      || round.status === 'rejected-for-substrate' || round.status === 'failed'
    if (!terminal && round.decision !== undefined) throw new TypeError('non-terminal round cannot have a decision')
    if (round.status === 'accepted' && round.searchMode === undefined) {
      const promoted = round.candidatePool.find(candidate => candidate.candidateId === round.promotedCandidateId)
      if (round.decision !== 'accepted' || promoted?.sealedVersion === undefined
        || round.evaluation?.heldOutBaseline === undefined || round.evaluation.heldOutCandidate === undefined
        || round.evaluation.seedCandidate.actualCommit !== promoted.sealedVersion.commitOid
        || round.evaluation.heldOutCandidate.actualCommit !== promoted.sealedVersion.commitOid) {
        throw new TypeError('accepted round is missing verified candidate evaluation evidence')
      }
    }
    if (round.baseline !== undefined
      && (round.baseline.requestedCommit !== round.targetHarnessRef
        || round.baseline.actualCommit !== round.targetHarnessRef
        || round.baseline.dataset !== round.seedTaskRef
        || round.baseline.conditionId !== round.plan.seed.conditionId)) {
      throw new TypeError('round baseline does not match its pinned target/seed partition')
    }
    if (round.evaluation !== undefined) {
      const candidate = round.candidatePool.find(value => value.sealedVersion?.commitOid === round.evaluation?.seedCandidate.actualCommit)
        ?.sealedVersion?.commitOid
      if (candidate === undefined
        || round.evaluation.seedBaseline.requestedCommit !== round.targetHarnessRef
        || round.evaluation.seedBaseline.actualCommit !== round.targetHarnessRef
        || round.evaluation.seedBaseline.dataset !== round.seedTaskRef
        || round.evaluation.seedCandidate.requestedCommit !== candidate
        || round.evaluation.seedCandidate.actualCommit !== candidate
        || round.evaluation.seedCandidate.dataset !== round.seedTaskRef
        || round.evaluation.seedBaseline.conditionId !== round.plan.seed.conditionId
        || round.evaluation.seedCandidate.conditionId !== round.plan.seed.conditionId
        || round.evaluation.seedBaseline.provider !== round.evaluation.seedCandidate.provider
        || round.evaluation.seedBaseline.effectiveConfigDigest !== round.evaluation.seedCandidate.effectiveConfigDigest) {
        throw new TypeError('round seed evaluation does not match its pinned commits/partition/parity')
      }
      const heldOutBaseline = round.evaluation.heldOutBaseline
      const heldOutCandidate = round.evaluation.heldOutCandidate
      if (heldOutBaseline !== undefined
        && (heldOutBaseline.requestedCommit !== round.targetHarnessRef
          || heldOutBaseline.actualCommit !== round.targetHarnessRef
          || heldOutBaseline.dataset !== round.heldOutRef
          || heldOutBaseline.conditionId !== heldOutConditionId)) {
        throw new TypeError('round held-out baseline does not match its pinned target/partition')
      }
      if (heldOutCandidate !== undefined
        && (heldOutBaseline === undefined
          || heldOutCandidate.requestedCommit !== candidate
          || heldOutCandidate.actualCommit !== candidate
          || heldOutCandidate.dataset !== round.heldOutRef
          || heldOutCandidate.conditionId !== heldOutConditionId
          || heldOutBaseline.provider !== heldOutCandidate.provider
          || heldOutBaseline.effectiveConfigDigest !== heldOutCandidate.effectiveConfigDigest)) {
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

  private validateEvaluationAttempt(
    round: RefinementRound,
    attempt: RoundEvaluationAttempt,
    identities: Set<string>,
  ): void {
    if (typeof attempt !== 'object' || attempt === null || Array.isArray(attempt)
      || typeof attempt.provider !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(attempt.provider)
      || typeof attempt.evalId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(attempt.evalId)
      || (attempt.provider === 'hitch-cli' && !/^eval_[0-9a-f]{32}$/u.test(attempt.evalId))) {
      throw new TypeError('round evaluation attempt identity is invalid')
    }
    if (attempt.submissionIntent !== undefined) {
      this.validateSubmissionIntent(attempt.submissionIntent)
      if (attempt.submissionIntent.provider !== attempt.provider) throw new TypeError('evaluation submission provider differs from attempt')
    }
    const identity = `${attempt.provider}\0${attempt.evalId}`
    if (identities.has(identity)) throw new TypeError('round evaluation attempt identity is duplicated')
    identities.add(identity)
    if (!['seed-baseline', 'seed-candidate', 'held-out-baseline', 'held-out-candidate'].includes(attempt.phase)
      || !['running', 'rerunning', 'repair-completed', 'settled', 'failed', 'cancelled'].includes(attempt.status)
      || typeof attempt.startedAt !== 'string' || attempt.startedAt.length === 0
      || typeof attempt.owner !== 'object' || attempt.owner === null
      || typeof attempt.owner.candidateId !== 'string' || attempt.owner.candidateId.length === 0
      || (attempt.owner.role !== 'baseline' && attempt.owner.role !== 'candidate')
      || !isExactGitCommit(attempt.owner.harnessRef)
      || attempt.requestedCommit !== attempt.owner.harnessRef) {
      throw new TypeError('round evaluation attempt lifecycle/owner is invalid')
    }
    const terminal = attempt.status !== 'running' && attempt.status !== 'rerunning'
    if (terminal !== (typeof attempt.completedAt === 'string' && attempt.completedAt.length > 0)
      || ((attempt.status === 'running' || attempt.status === 'rerunning') && attempt.failure !== undefined)
      || ((attempt.status === 'failed' || attempt.status === 'cancelled')
        && (typeof attempt.failure?.code !== 'string' || attempt.failure.code.length === 0
          || typeof attempt.failure.message !== 'string' || attempt.failure.message.length === 0))
      || ((attempt.status === 'settled' || attempt.status === 'repair-completed') && attempt.failure !== undefined)
      || (attempt.reusedFromRoundId !== undefined
        && (typeof attempt.reusedFromRoundId !== 'string' || attempt.reusedFromRoundId.length === 0
          || (attempt.reusedFromEvolutionId === undefined && attempt.reusedFromRoundId === round.roundId)
          || !attempt.phase.endsWith('baseline')
          || attempt.status !== 'settled'))
      || (attempt.reusedFromEvolutionId !== undefined
        && (typeof attempt.reusedFromEvolutionId !== 'string'
          || !/^[a-zA-Z0-9_-]+$/u.test(attempt.reusedFromEvolutionId)
          || attempt.reusedFromEvolutionId === round.evolutionId
          || attempt.reusedFromRoundId === undefined))
      || (attempt.reuseAudit !== undefined
        && (attempt.reusedFromRoundId === undefined
          || typeof attempt.reuseAudit !== 'object' || attempt.reuseAudit === null
          || typeof attempt.reuseAudit.sourceInvocationFingerprint !== 'string'
          || attempt.reuseAudit.sourceInvocationFingerprint.length === 0
          || typeof attempt.reuseAudit.currentInvocationFingerprint !== 'string'
          || attempt.reuseAudit.currentInvocationFingerprint.length === 0
          || typeof attempt.reuseAudit.invocationFingerprintChanged !== 'boolean'
          || attempt.reuseAudit.invocationFingerprintChanged
            !== (attempt.reuseAudit.sourceInvocationFingerprint !== attempt.reuseAudit.currentInvocationFingerprint)))) {
      throw new TypeError('round evaluation attempt terminal state is invalid')
    }
    const condition = attempt.phase.startsWith('seed-') ? round.plan.seed : round.plan.heldOut
    const expectedDataset = attempt.phase.startsWith('seed-') ? round.seedTaskRef : round.heldOutRef
    if (attempt.conditionId !== condition.conditionId || attempt.dataset !== expectedDataset
      || attempt.requestedModelId !== condition.model) {
      throw new TypeError('round evaluation attempt condition is invalid')
    }
    if (attempt.owner.role === 'candidate') {
      const candidate = round.candidatePool.find(value => value.candidateId === attempt.owner.candidateId)
      if (!attempt.phase.endsWith('candidate') || candidate?.sealedVersion?.commitOid !== attempt.owner.harnessRef) {
        throw new TypeError('round candidate evaluation attempt owner is invalid')
      }
      return
    }
    const allocation = round.parentAllocations?.find(value => value.parentCandidateId === attempt.owner.candidateId
      && value.parentHarnessRef === attempt.owner.harnessRef)
    const deterministicChampion = attempt.owner.harnessRef === round.targetHarnessRef
      && attempt.owner.candidateId === `champion-${round.targetHarnessRef}`
    if (!attempt.phase.endsWith('baseline') || (allocation === undefined && !deterministicChampion)) {
      throw new TypeError('round baseline evaluation attempt owner is invalid')
    }
  }

  private validateSubmissionIntent(intent: EvaluationSubmissionIntent): void {
    if (typeof intent !== 'object' || intent === null
      || typeof intent.provider !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(intent.provider)
      || typeof intent.idempotencyKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(intent.idempotencyKey)
      || intent.parameters === undefined) {
      throw new TypeError('evaluation submission intent is invalid')
    }
  }

  private validateCandidateAssessment(value: CandidateAssessment, candidateIds: string[]): void {
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || value.component.kind !== 'candidate-assessor'
      || !validComponentRef(value.component, 'candidate-assessor')
      || typeof value.reason !== 'string' || value.reason.length === 0
      || typeof value.candidateMetrics !== 'object' || value.candidateMetrics === null
      || Array.isArray(value.candidateMetrics)) {
      throw new TypeError('round candidate assessment is invalid')
    }
    const expected = [...candidateIds].sort()
    const actual = Object.keys(value.candidateMetrics).sort()
    if (JSON.stringify(expected) !== JSON.stringify(actual)
      || Object.values(value.candidateMetrics).some(metrics => !validMetricSet(metrics))) {
      throw new TypeError('round candidate assessment metrics are invalid')
    }
    if (value.rankingCandidateIds !== undefined
      && JSON.stringify([...value.rankingCandidateIds].sort()) !== JSON.stringify(expected)) {
      throw new TypeError('round candidate assessment ranking is invalid')
    }
    if (value.usage !== undefined) {
      const usage = [value.usage.modelRequests, value.usage.inputTokens, value.usage.outputTokens,
        value.usage.cachedInputTokens, value.usage.reasoningTokens]
      if (usage.some(item => item !== undefined && (!Number.isSafeInteger(item) || item < 0))) {
        throw new TypeError('round candidate assessment usage is invalid')
      }
    }
    const { digest, ...identity } = value
    if (!/^sha256:[0-9a-f]{64}$/u.test(digest) || digestJson(identity) !== digest) {
      throw new TypeError('round candidate assessment digest mismatch')
    }
  }

  private validateEvaluationEvidence(value: EvaluationEvidence, label: string, searchMode = false): void {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
    if (typeof value.provider !== 'string' || value.provider.length === 0
      || !/^sha256:[0-9a-f]{64}$/u.test(value.conditionId)
      || !/^sha256:[0-9a-f]{64}$/u.test(value.effectiveConfigDigest)
      || typeof value.evalId !== 'string' || value.evalId.length === 0) throw new TypeError(`${label} identity is invalid`)
    if (typeof value.dataset !== 'string' || value.dataset.length === 0) throw new TypeError(`${label} dataset is invalid`)
    if (!isExactGitCommit(value.requestedCommit) || !isExactGitCommit(value.actualCommit)) throw new TypeError(`${label} commit is invalid`)
    if (typeof value.revisionIdentity !== 'string' || value.revisionIdentity.length === 0
      || (value.invocationFingerprint !== undefined
        && (typeof value.invocationFingerprint !== 'string' || value.invocationFingerprint.length === 0))
      || (value.benchmark !== undefined && (
        typeof value.benchmark !== 'object' || value.benchmark === null
        || typeof value.benchmark.id !== 'string' || value.benchmark.id.length === 0
        || typeof value.benchmark.revision !== 'string' || value.benchmark.revision.length === 0
      ))
      || !Number.isFinite(value.primaryReward)
      || (value.processScore !== undefined && !Number.isFinite(value.processScore))
      || (value.completeness !== 'complete' && value.completeness !== 'partial')
      || !Number.isSafeInteger(value.plannedTrialCount) || value.plannedTrialCount <= 0) {
      throw new TypeError(`${label} identity/reward is invalid`)
    }
    if (typeof value.summary !== 'object' || value.summary === null
      || !Number.isSafeInteger(value.summary.total) || !Number.isSafeInteger(value.summary.passed)
      || !Number.isSafeInteger(value.summary.failed) || !Number.isFinite(value.summary.score)
      || value.summary.total < 0 || value.summary.passed < 0 || value.summary.failed < 0
      || value.summary.passed + value.summary.failed !== value.summary.total) {
      throw new TypeError(`${label} score summary is invalid`)
    }
    if ((value.processScore === undefined) !== (value.summary.process === undefined)
      || value.processScore !== undefined && value.summary.process?.score !== value.processScore) {
      throw new TypeError(`${label} process score summary is invalid`)
    }
    const scopedProjection = searchMode && value.provider === 'search-v2-seed-projection'
    if (!Array.isArray(value.trials) || (!scopedProjection && value.trials.length !== value.summary.total)
      || value.trials.some(trial => typeof trial.taskName !== 'string' || trial.taskName.length === 0
      || trial.status !== 'completed'
      || (trial.runId !== undefined && (typeof trial.runId !== 'string' || trial.runId.length === 0))
      || (trial.attempt !== undefined && (!Number.isSafeInteger(trial.attempt) || trial.attempt <= 0))
      || typeof trial.rewards !== 'object' || trial.rewards === null
      || Object.values(trial.rewards).some(reward => !Number.isFinite(reward))
      || (trial.scores !== undefined && (
        !Number.isFinite(trial.scores.totalScore)
        || (trial.scores.processScore !== undefined && !Number.isFinite(trial.scores.processScore))
        || (trial.scores.normalization !== 'standard' && trial.scores.normalization !== 'legacy-reward')
        || (trial.scores.normalization === 'legacy-reward' && trial.scores.processScore !== undefined)
        || trial.scores.totalScore !== (trial.rewards.total_score ?? trial.rewards.reward ?? Object.values(trial.rewards)[0])
      )))) {
      throw new TypeError(`${label} trials are invalid`)
    }
    const scoped = scopedProjection ? searchProjectionAggregates(value) : undefined
    if (scoped && (value.summary.total !== scoped.taskCount || Math.abs(value.primaryReward - scoped.outcome) > 1e-12 || Math.abs(value.summary.score - scoped.outcome) > 1e-12)) throw new TypeError(`${label} search task aggregate is invalid`)
    const processScores = value.trials.flatMap(trial => trial.scores?.processScore === undefined ? [] : [trial.scores.processScore])
    const expectedProcess = scopedProjection ? scoped?.process : processScores.length === value.trials.length && processScores.length > 0
      ? processScores.reduce((sum, score) => sum + score, 0) / processScores.length
      : undefined
    if ((value.processScore === undefined) !== (expectedProcess === undefined)
      || value.processScore !== undefined && Math.abs(value.processScore - expectedProcess!) > 1e-12) {
      throw new TypeError(`${label} process score does not match trials`)
    }
    if (!Array.isArray(value.invalidTrials)
      || value.plannedTrialCount !== value.trials.length + value.invalidTrials.length
      || (value.completeness === 'complete' ? value.invalidTrials.length !== 0 : value.invalidTrials.length === 0)
      || value.invalidTrials.some(trial => typeof trial.taskName !== 'string' || trial.taskName.length === 0
        || typeof trial.trialName !== 'string' || trial.trialName.length === 0
        || typeof trial.runId !== 'string' || trial.runId.length === 0
        || !Number.isSafeInteger(trial.attempt) || trial.attempt <= 0
        || trial.status !== 'errored'
        || typeof trial.invalidReason !== 'string' || trial.invalidReason.length === 0)) {
      throw new TypeError(`${label} invalid trials are invalid`)
    }
    const plannedKeys = [...value.trials, ...value.invalidTrials]
      .map(trial => JSON.stringify([trial.taskName, trial.attempt ?? null]))
    const runIds = [...value.trials.flatMap(trial => trial.runId === undefined ? [] : [trial.runId]),
      ...value.invalidTrials.map(trial => trial.runId)]
    if (new Set(plannedKeys).size !== plannedKeys.length || new Set(runIds).size !== runIds.length) {
      throw new TypeError(`${label} trial identities are ambiguous`)
    }
    const transport = value.localSourceTransport
    if (transport !== undefined) {
      if (typeof transport !== 'object' || transport === null || transport.kind !== 'local-git-commit'
        || transport.commit !== value.actualCommit || !isExactGitCommit(transport.tree)
        || transport.resolutionIdentity !== value.revisionIdentity
        || !/^sha256:[0-9a-f]{64}$/u.test(transport.payloadSha256)
        || !Number.isSafeInteger(transport.payloadBytes) || transport.payloadBytes < 0) {
        throw new TypeError(`${label} local exact commit transport evidence is invalid`)
      }
    }
  }

  private validateFailedEvaluation(
    value: NonNullable<RefinementRound['failedEvaluations']>[number],
    round: RefinementRound,
  ): void {
    const phases = new Set(['seed-baseline', 'seed-candidate', 'held-out-baseline', 'held-out-candidate'])
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || !phases.has(value.phase)
      || typeof value.owner !== 'object' || value.owner === null
      || typeof value.owner.candidateId !== 'string' || value.owner.candidateId.length === 0
      || !isExactGitCommit(value.owner.harnessRef)
      || (value.owner.role !== 'baseline' && value.owner.role !== 'candidate')
      || (value.phase.endsWith('baseline') ? value.owner.role !== 'baseline' : value.owner.role !== 'candidate')
      || typeof value.failure !== 'object' || value.failure === null
      || typeof value.failure.code !== 'string' || value.failure.code.length === 0
      || typeof value.failure.message !== 'string' || value.failure.message.length === 0) {
      throw new TypeError('round failed evaluation record is invalid')
    }
    const evidence = value.evidence
    if (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence)
      || typeof evidence.provider !== 'string' || evidence.provider.length === 0
      || !/^sha256:[0-9a-f]{64}$/u.test(evidence.conditionId)
      || !/^sha256:[0-9a-f]{64}$/u.test(evidence.effectiveConfigDigest)
      || typeof evidence.evalId !== 'string' || evidence.evalId.length === 0
      || typeof evidence.dataset !== 'string' || evidence.dataset.length === 0
      || !isExactGitCommit(evidence.requestedCommit) || !isExactGitCommit(evidence.actualCommit)
      || typeof evidence.revisionIdentity !== 'string' || evidence.revisionIdentity.length === 0
      || (evidence.invocationFingerprint !== undefined
        && (typeof evidence.invocationFingerprint !== 'string' || evidence.invocationFingerprint.length === 0))
      || evidence.runSetComplete !== true
      || !Array.isArray(evidence.trials) || evidence.trials.length === 0) {
      throw new TypeError('round failed evaluation evidence is invalid')
    }
    const runIds = evidence.trials.map(trial => trial.runId)
    if (new Set(runIds).size !== runIds.length || evidence.trials.some(trial => (
      typeof trial.taskName !== 'string' || trial.taskName.length === 0
      || typeof trial.trialName !== 'string' || trial.trialName.length === 0
      || typeof trial.runId !== 'string' || trial.runId.length === 0
      || !Number.isSafeInteger(trial.attempt) || trial.attempt <= 0
      || (trial.status !== 'completed' && trial.status !== 'errored')
      || (trial.status === 'errored'
        && (typeof trial.invalidReason !== 'string' || trial.invalidReason.length === 0))
      || (trial.invalidReason !== undefined && (typeof trial.invalidReason !== 'string' || trial.invalidReason.length === 0))
    ))) {
      throw new TypeError('round failed evaluation trials are invalid')
    }
    const partition = value.phase.startsWith('seed-') ? round.plan.seed : round.plan.heldOut
    if (evidence.conditionId !== partition.conditionId || evidence.dataset !== partition.dataset.ref
      || evidence.requestedCommit !== value.owner.harnessRef || evidence.actualCommit !== value.owner.harnessRef) {
      throw new TypeError('round failed evaluation does not match its owner or partition')
    }
    if (value.owner.role === 'candidate') {
      const candidate = round.candidatePool.find(item => item.candidateId === value.owner.candidateId)
      if (candidate?.sealedVersion?.commitOid !== value.owner.harnessRef) {
        throw new TypeError('round failed candidate evaluation owner is invalid')
      }
    } else {
      const parentHarnesses = new Set([
        round.targetHarnessRef,
        ...(round.parentAllocations ?? []).map(allocation => allocation.parentHarnessRef),
      ])
      if (!parentHarnesses.has(value.owner.harnessRef)) throw new TypeError('round failed baseline evaluation owner is invalid')
    }
    const transport = evidence.localSourceTransport
    if (transport !== undefined && (typeof transport !== 'object' || transport === null
      || transport.kind !== 'local-git-commit' || transport.commit !== evidence.actualCommit
      || !isExactGitCommit(transport.tree) || transport.resolutionIdentity !== evidence.revisionIdentity
      || !/^sha256:[0-9a-f]{64}$/u.test(transport.payloadSha256)
      || !Number.isSafeInteger(transport.payloadBytes) || transport.payloadBytes < 0)) {
      throw new TypeError('round failed evaluation transport is invalid')
    }
  }

  private validatePairedTrials(value: PairedTrial[], conditionId: string, expectedCount: number, label: string): void {
    if (!Array.isArray(value) || value.length !== expectedCount
      || new Set(value.map(trial => trial.trialKey)).size !== value.length
      || value.some(trial => trial.conditionId !== conditionId || trial.trialKey.length === 0 || trial.taskName.length === 0
        || !Number.isFinite(trial.baselineReward) || !Number.isFinite(trial.candidateReward)
        || !Number.isFinite(trial.rewardDelta)
        || trial.rewardDelta !== trial.candidateReward - trial.baselineReward
        || (trial.baselineProcessScore !== undefined && !Number.isFinite(trial.baselineProcessScore))
        || (trial.candidateProcessScore !== undefined && !Number.isFinite(trial.candidateProcessScore))
        || (trial.processScoreDelta !== undefined && !Number.isFinite(trial.processScoreDelta))
        || (trial.processScoreDelta === undefined) !== (trial.baselineProcessScore === undefined || trial.candidateProcessScore === undefined)
        || trial.processScoreDelta !== undefined
          && trial.processScoreDelta !== trial.candidateProcessScore! - trial.baselineProcessScore!)) {
      throw new TypeError(`round ${label} paired trials are invalid`)
    }
  }

  private validatePairingAudit(
    value: PairingAudit,
    baseline: EvaluationEvidence,
    candidate: EvaluationEvidence,
    pairs: readonly PairedTrial[],
    label: string,
  ): void {
    const baselinePlanned = [...baseline.trials, ...baseline.invalidTrials].map(trialKey).sort()
    const candidatePlanned = [...candidate.trials, ...candidate.invalidTrials].map(trialKey).sort()
    const expectedPairs = expectedPairedTrials(baseline, candidate)
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || !Number.isSafeInteger(value.planned) || value.planned <= 0
      || !Number.isSafeInteger(value.paired) || value.paired < 0
      || !Number.isSafeInteger(value.excluded) || value.excluded < 0
      || !Number.isSafeInteger(value.baselineInvalid) || value.baselineInvalid < 0
      || !Number.isSafeInteger(value.candidateInvalid) || value.candidateInvalid < 0
      || value.planned !== baseline.plannedTrialCount || value.planned !== candidate.plannedTrialCount
      || value.paired !== pairs.length || value.excluded !== value.planned - value.paired
      || value.baselineInvalid !== baseline.invalidTrials.length
      || value.candidateInvalid !== candidate.invalidTrials.length
      || baseline.conditionId !== candidate.conditionId
      || baseline.provider !== candidate.provider
      || baseline.effectiveConfigDigest !== candidate.effectiveConfigDigest
      || baseline.benchmark?.id !== candidate.benchmark?.id
      || baseline.benchmark?.revision !== candidate.benchmark?.revision
      || baseline.dataset !== candidate.dataset
      || JSON.stringify(baselinePlanned) !== JSON.stringify(candidatePlanned)
      || digestJson(pairs) !== digestJson(expectedPairs)) {
      throw new TypeError(`round ${label} pairing audit is invalid`)
    }
  }
}

export { exists as pathExists }
