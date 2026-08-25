import { constants } from 'node:fs'
import { access, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ChampionState, EvaluationEvidence, MetaSessionState, PairedTrial, PopulationState, RefinementRound } from '../types.js'
import { isExactGitCommit } from '../types.js'
import { digestJson } from './digest.js'

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

  constructor(
    readonly root: string,
    readonly evolutionId?: string,
    private readonly onRoundChange?: () => Promise<void>,
  ) {
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
    for (const member of population.members) {
      if (typeof member.candidateId !== 'string' || member.candidateId.length === 0
        || !isExactGitCommit(member.harnessRef) || !/^sha256:[0-9a-f]{64}$/u.test(member.harnessDigest)
        || !Array.isArray(member.parentCandidateIds) || member.lineageRootId.length === 0
        || !validMetricSet(member.metrics)
        || member.selectedAt.length === 0) throw new TypeError('population member is invalid')
      if (member.metaCheckpoint !== undefined
        && (member.metaCheckpoint.sourceSessionId !== member.metaSessionId
          || !Number.isSafeInteger(member.metaCheckpoint.eventCount) || member.metaCheckpoint.eventCount < 0
          || !/^sha256:[0-9a-f]{64}$/u.test(member.metaCheckpoint.prefixDigest))) {
        throw new TypeError('population member Meta checkpoint is invalid')
      }
    }
    const identity = { evolutionId: population.evolutionId, generation: population.generation, members: population.members }
    if (digestJson(identity) !== population.digest) throw new TypeError('population digest mismatch')
    return population as PopulationState
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
    if (round.advisoryFocus !== undefined && (!Array.isArray(round.advisoryFocus)
      || new Set(round.advisoryFocus).size !== round.advisoryFocus.length)) {
      throw new TypeError('round advisoryFocus must be a deduplicated array')
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
    if (!Array.isArray(round.candidatePool) || round.candidatePool.length === 0
      || new Set(round.candidatePool.map(candidate => candidate.candidateId)).size !== round.candidatePool.length) {
      throw new TypeError('round candidatePool is invalid')
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
        if (typeof candidate.seedComparison.parentBaselineEvalId !== 'string'
          || !Number.isFinite(candidate.seedComparison.scoreDelta)
          || !Number.isSafeInteger(candidate.seedComparison.requiredRegressions)
          || candidate.seedComparison.requiredRegressions < 0) {
          throw new TypeError('candidate seed comparison is invalid')
        }
        this.validatePairedTrials(
          candidate.seedComparison.pairedTrials,
          round.plan.seed.conditionId,
          candidate.seedEvaluation?.trials.length ?? -1,
          'candidate seed',
        )
      }
      if (candidate.heldOutEvaluation !== undefined) this.validateEvaluationEvidence(candidate.heldOutEvaluation, 'candidate held-out evaluation')
      if (candidate.metrics !== undefined && !validMetricSet(candidate.metrics)) throw new TypeError('candidate metrics are invalid')
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
    if (round.parentBaselines !== undefined) {
      for (const baseline of round.parentBaselines) {
        this.validateEvaluationEvidence(baseline.evidence, 'parent seed baseline')
        if (baseline.evidence.actualCommit !== baseline.parentHarnessRef
          || baseline.evidence.conditionId !== round.plan.seed.conditionId) throw new TypeError('parent seed baseline identity is invalid')
      }
    }
    if (round.selection !== undefined) {
      const selected = new Set(round.selection.selectedCandidateIds)
      if (selected.size !== round.selection.selectedCandidateIds.length || selected.size === 0
        || !selected.has(round.selection.promotionCandidateId)
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
    if (round.evaluation !== undefined) {
      this.validateEvaluationEvidence(round.evaluation.seedBaseline, 'seed baseline')
      this.validateEvaluationEvidence(round.evaluation.seedCandidate, 'seed candidate')
      if (round.evaluation.heldOutBaseline !== undefined) this.validateEvaluationEvidence(round.evaluation.heldOutBaseline, 'held-out baseline')
      if (round.evaluation.heldOutCandidate !== undefined) this.validateEvaluationEvidence(round.evaluation.heldOutCandidate, 'held-out candidate')
      this.validatePairedTrials(
        round.evaluation.seedPairedTrials,
        round.plan.seed.conditionId,
        round.evaluation.seedCandidate.trials.length,
        'seed',
      )
      if (round.evaluation.heldOutPairedTrials !== undefined) {
        if (round.evaluation.heldOutCandidate === undefined) throw new TypeError('held-out pairs require candidate evidence')
        this.validatePairedTrials(
          round.evaluation.heldOutPairedTrials,
          round.plan.heldOut.conditionId,
          round.evaluation.heldOutCandidate.trials.length,
          'held-out',
        )
      } else if (round.evaluation.heldOutCandidate !== undefined) {
        throw new TypeError('held-out candidate evidence requires paired trials')
      }
      if (round.evaluation.promotionMetrics !== undefined && !validMetricSet(round.evaluation.promotionMetrics)) {
        throw new TypeError('round promotion metrics are invalid')
      }
      if (!Number.isFinite(round.evaluation.scoreDelta)
        || (round.evaluation.heldOutScoreDelta !== undefined && !Number.isFinite(round.evaluation.heldOutScoreDelta))
        || !Number.isSafeInteger(round.evaluation.requiredRegressions) || round.evaluation.requiredRegressions < 0) {
        throw new TypeError('round evaluation deltas are invalid')
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
    if (round.status === 'accepted') {
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
        || round.evaluation.seedBaseline.effectiveConfigDigest !== round.evaluation.seedCandidate.effectiveConfigDigest
        || ((round.evaluation.seedBaseline.invocationFingerprint !== undefined
            || round.evaluation.seedCandidate.invocationFingerprint !== undefined)
          && round.evaluation.seedBaseline.invocationFingerprint !== round.evaluation.seedCandidate.invocationFingerprint)) {
        throw new TypeError('round seed evaluation does not match its pinned commits/partition/parity')
      }
      const heldOutBaseline = round.evaluation.heldOutBaseline
      const heldOutCandidate = round.evaluation.heldOutCandidate
      if (heldOutBaseline !== undefined
        && (heldOutBaseline.requestedCommit !== round.targetHarnessRef
          || heldOutBaseline.actualCommit !== round.targetHarnessRef
          || heldOutBaseline.dataset !== round.heldOutRef
          || heldOutBaseline.conditionId !== round.plan.heldOut.conditionId)) {
        throw new TypeError('round held-out baseline does not match its pinned target/partition')
      }
      if (heldOutCandidate !== undefined
        && (heldOutBaseline === undefined
          || heldOutCandidate.requestedCommit !== candidate
          || heldOutCandidate.actualCommit !== candidate
          || heldOutCandidate.dataset !== round.heldOutRef
          || heldOutCandidate.conditionId !== round.plan.heldOut.conditionId
          || heldOutBaseline.provider !== heldOutCandidate.provider
          || heldOutBaseline.effectiveConfigDigest !== heldOutCandidate.effectiveConfigDigest
          || ((heldOutBaseline.invocationFingerprint !== undefined || heldOutCandidate.invocationFingerprint !== undefined)
            && heldOutBaseline.invocationFingerprint !== heldOutCandidate.invocationFingerprint))) {
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

  private validateEvaluationEvidence(value: EvaluationEvidence, label: string): void {
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
      || (trial.runId !== undefined && (typeof trial.runId !== 'string' || trial.runId.length === 0))
      || (trial.attempt !== undefined && (!Number.isSafeInteger(trial.attempt) || trial.attempt <= 0))
      || typeof trial.rewards !== 'object' || trial.rewards === null
      || Object.values(trial.rewards).some(reward => !Number.isFinite(reward)))) {
      throw new TypeError(`${label} trials are invalid`)
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

  private validatePairedTrials(value: PairedTrial[], conditionId: string, expectedCount: number, label: string): void {
    if (!Array.isArray(value) || value.length !== expectedCount
      || new Set(value.map(trial => trial.trialKey)).size !== value.length
      || value.some(trial => trial.conditionId !== conditionId || trial.trialKey.length === 0 || trial.taskName.length === 0
        || !Number.isFinite(trial.baselineReward) || !Number.isFinite(trial.candidateReward)
        || !Number.isFinite(trial.rewardDelta)
        || trial.rewardDelta !== trial.candidateReward - trial.baselineReward)) {
      throw new TypeError(`round ${label} paired trials are invalid`)
    }
  }
}

export { exists as pathExists }
