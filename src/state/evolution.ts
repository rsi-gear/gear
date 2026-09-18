import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  ChampionState,
  EvolutionId,
  EvolutionRegistryEntry,
  EvolutionRegistryState,
  EvolutionSpec,
  PopulationState,
  PublishedHarnessState,
} from '../types.js'
import { isExactGitCommit } from '../types.js'
import { RefineStateStore } from './store.js'
import { digestJson } from './digest.js'
import { serializeExperimentsTsv } from './experiments.js'
import { validateMetaSampling } from '../meta/sampling.js'
import { validateOffloadingPolicy } from '../meta/offloading-policy.js'
import { validateSearchSchema } from '../search/schema.js'
import { validateBaselineConditionSource } from '../refine/baseline-source.js'

export { digestJson } from './digest.js'

const SHA256 = /^sha256:[0-9a-f]{64}$/u
const SAFE_ID = /^[a-zA-Z0-9_-]+$/u

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
  if (value.searchSettings) validateSearchSchema('SearchSettings', value.searchSettings)
  assertSafeId(value.evolutionId, 'evolutionId')
  if (!isExactGitCommit(value.initialHarness.ref) || !SHA256.test(value.initialHarness.digest)) {
    throw new TypeError('evolution initial harness identity is invalid')
  }
  if (!SHA256.test(value.datasets.seed.digest) || !SHA256.test(value.datasets.heldOut.digest)
    || value.datasets.seed.ref.length === 0 || value.datasets.heldOut.ref.length === 0) {
    throw new TypeError('evolution dataset identities are invalid')
  }
  for (const [name, field] of Object.entries({
    createdAt: value.createdAt,
    metaPreset: value.metaAgent.preset.id,
    metaProvider: value.metaAgent.model.provider,
    metaModel: value.metaAgent.model.model,
    toolchainRef: value.toolchainRef,
    sandboxProfileRef: value.sandboxProfileRef,
  })) {
    if (typeof field !== 'string' || field.length === 0) throw new TypeError(`evolution ${name} is required`)
  }
  if (value.metaAgent.runtime.type.length === 0 || value.metaAgent.runtime.version.length === 0
    || !SHA256.test(value.metaAgent.runtime.integrity) || !SHA256.test(value.metaAgent.preset.digest)
    || value.metaAgent.preset.resources.some(resource => resource.logicalPath.length === 0
      || resource.kind.length === 0 || !SHA256.test(resource.digest))) {
    throw new TypeError('evolution Meta Agent identity is invalid')
  }
  validateMetaSampling(value.metaAgent.sampling, 'evolution Meta sampling')
  if (value.metaAgent.contextOffloading !== undefined) {
    if (value.metaAgent.runtime.type !== 'dsh') throw new TypeError('context offloading requires native DSH Meta')
    validateOffloadingPolicy(value.metaAgent.contextOffloading)
  }
  if (value.metaAgent.model.maxTokens !== undefined
    && (!Number.isSafeInteger(value.metaAgent.model.maxTokens) || value.metaAgent.model.maxTokens <= 0)) {
    throw new TypeError('evolution Meta maxTokens is invalid')
  }
  const generationBudget = value.candidateGeneration.budget
  if (generationBudget.finalizationReserveMs !== undefined
    && (!Number.isSafeInteger(generationBudget.finalizationReserveMs) || generationBudget.finalizationReserveMs < 0
      || generationBudget.finalizationReserveMs > (generationBudget.attemptTimeoutMs ?? generationBudget.timeoutMs ?? 0))) {
    throw new TypeError('candidate finalization reserve must be between zero and the attempt timeout')
  }
  const legacyGenerationBudget = generationBudget.timeoutMs !== undefined
    && generationBudget.attemptTimeoutMs === undefined
    && generationBudget.maxAttemptsPerCandidate === undefined
    && generationBudget.roundTimeoutMs === undefined
  const retryingGenerationBudget = generationBudget.timeoutMs === undefined
    && Number.isSafeInteger(generationBudget.attemptTimeoutMs) && generationBudget.attemptTimeoutMs! > 0
    && Number.isSafeInteger(generationBudget.maxAttemptsPerCandidate) && generationBudget.maxAttemptsPerCandidate! > 0
    && Number.isSafeInteger(generationBudget.roundTimeoutMs) && generationBudget.roundTimeoutMs! > 0
  if (!Number.isSafeInteger(value.candidateGeneration.maxCandidates) || value.candidateGeneration.maxCandidates <= 0
    || !(legacyGenerationBudget && Number.isSafeInteger(generationBudget.timeoutMs) && generationBudget.timeoutMs! > 0)
      && !retryingGenerationBudget) {
    throw new TypeError('evolution candidate generation budget is invalid')
  }
  for (const budget of [value.candidateGeneration.budget.maxModelRequests, value.candidateGeneration.budget.maxTokens]) {
    if (budget !== undefined && (!Number.isSafeInteger(budget) || budget <= 0)) {
      throw new TypeError('evolution candidate generation optional budget is invalid')
    }
  }
  if (!Number.isSafeInteger(value.rollout.repetitions) || value.rollout.repetitions <= 0
    || value.rollout.model.length === 0 || !Number.isSafeInteger(value.selection.survivors)
    || value.selection.survivors <= 0 || value.selection.survivors > value.candidateGeneration.maxCandidates
    || !Number.isSafeInteger(value.selection.timeoutMs) || value.selection.timeoutMs <= 0) {
    throw new TypeError('evolution rollout/selection configuration is invalid')
  }
  if (value.rollout.seeds !== undefined && (value.rollout.seeds.length === 0
    || value.rollout.seeds.length !== value.rollout.repetitions
    || value.rollout.seeds.some(seed => !Number.isSafeInteger(seed)))) {
    throw new TypeError('evolution rollout seeds are invalid')
  }
  if (value.rollout.providerSemanticDigest !== undefined
    && !/^sha256:[0-9a-f]{64}$/u.test(value.rollout.providerSemanticDigest)) {
    throw new TypeError('evolution rollout provider semantic digest is invalid')
  }
  if (value.baselineConditionSource !== undefined) {
    const source = validateBaselineConditionSource(value.baselineConditionSource)
    const providerIdentity = {
      kind: value.rollout.provider.kind,
      id: value.rollout.provider.id,
      apiVersion: value.rollout.provider.apiVersion,
      implementation: value.rollout.provider.implementation,
    }
    if (source.inheritedRolloutProviderDigest !== value.rollout.providerSemanticDigest
      || digestJson(source.destinationProvider) !== digestJson(providerIdentity)) {
      throw new TypeError('evolution baseline condition source does not match its rollout provider')
    }
  }
  const rolloutTemperature = value.rollout.sampling.temperature
  if (rolloutTemperature !== undefined
    && (!Number.isFinite(rolloutTemperature) || rolloutTemperature < 0 || rolloutTemperature > 2)) {
    throw new TypeError('evolution rollout temperature is invalid')
  }
  if (!Array.isArray(value.evaluation.judges) || value.evaluation.judges.length === 0
    || typeof value.evaluation.primaryMetric !== 'string' || value.evaluation.primaryMetric.length === 0) {
    throw new TypeError('evolution evaluation configuration is invalid')
  }
  if (value.evaluation.mode !== undefined && value.evaluation.mode !== 'reuse-seed') {
    throw new TypeError('unknown evaluation mode')
  }
  if (value.evaluation.mode === 'reuse-seed'
    && (value.datasets.seed.ref !== value.datasets.heldOut.ref
      || value.datasets.seed.digest !== value.datasets.heldOut.digest)) {
    throw new TypeError('reuse-seed requires identical seed and held-out datasets')
  }
  const components = [
    ['candidate-generator', value.candidateGeneration.strategy],
    ['rollout-provider', value.rollout.provider],
    ['task-sampler', value.rollout.taskSampler],
    ...value.evaluation.judges.map(component => ['judge', component] as const),
    ['candidate-assessor', value.selection.assessor],
    ['candidate-selector', value.selection.strategy],
    ['promotion-policy', value.promotion.policy],
  ] as const
  for (const [kind, component] of components) {
    if (component.kind !== kind || component.apiVersion !== 1 || component.id.length === 0 || component.implementation.package.length === 0
      || component.implementation.version.length === 0 || component.implementation.integrity.length === 0
      || digestJson(component.config) !== component.configDigest) {
      throw new TypeError(`evolution component identity is invalid: ${component.id}`)
    }
  }
  if (!Number.isSafeInteger(value.taskBudgetMs) || value.taskBudgetMs <= 0) {
    throw new TypeError('evolution taskBudgetMs is invalid')
  }
  if (value.experienceMemory !== undefined
    && (value.experienceMemory.schemaVersion !== 1 || typeof value.experienceMemory.enabled !== 'boolean')) {
    throw new TypeError('evolution seed experience memory policy is invalid')
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
  readonly experimentsPath: string
  private registryQueue: Promise<void> = Promise.resolve()
  private experimentsQueue: Promise<void> = Promise.resolve()

  constructor(readonly root: string) {
    this.evolutionsRoot = join(root, 'evolutions')
    this.registryPath = join(root, 'registry.json')
    this.publishedPath = join(root, 'published.json')
    this.experimentsPath = join(root, 'experiments.tsv')
  }

  async initialize(): Promise<void> {
    await mkdir(this.evolutionsRoot, { recursive: true })
    const existing = await this.readJson<unknown>(this.registryPath)
    if (existing === undefined) {
      await this.atomicWrite(this.registryPath, { schemaVersion: 1, evolutions: [] } satisfies EvolutionRegistryState)
    } else {
      this.validateRegistry(existing)
    }
    await this.refreshExperimentsIndex()
  }

  evolutionRoot(evolutionId: EvolutionId): string {
    assertSafeId(evolutionId, 'evolutionId')
    return join(this.evolutionsRoot, evolutionId)
  }

  stateStore(evolutionId: EvolutionId): RefineStateStore {
    return new RefineStateStore(
      this.evolutionRoot(evolutionId),
      evolutionId,
      async () => this.refreshExperimentsIndex(),
    )
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
      const populationIdentity = {
        evolutionId: spec.evolutionId,
        generation: 0,
        members: [{
          candidateId: `initial-${champion.ref}`,
          harnessRef: champion.ref,
          harnessDigest: champion.manifestDigest,
          parentCandidateIds: [],
          lineageRootId: `initial-${champion.ref}`,
          metrics: { quality: 0, taskSuccessRate: 0 },
          selectedAt: spec.createdAt,
        }],
      }
      const population: PopulationState = { ...populationIdentity, digest: digestJson(populationIdentity) }
      await Promise.all([
        this.atomicWrite(join(root, 'spec.json'), spec),
        store.writeChampion(champion),
        store.writePopulation(population),
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

  async refreshExperimentsIndex(): Promise<void> {
    const operation = this.experimentsQueue.then(async () => {
      await this.withFileLock('experiments', async () => {
        const registry = await this.readJson<unknown>(this.registryPath)
        if (registry === undefined) return
        const state = this.validateRegistry(registry)
        const evolutions = await Promise.all(state.evolutions.map(async entry => ({
          entry,
          rounds: await new RefineStateStore(this.evolutionRoot(entry.evolutionId), entry.evolutionId).listRounds(),
        })))
        await this.atomicWriteText(this.experimentsPath, serializeExperimentsTsv(evolutions))
      })
    })
    this.experimentsQueue = operation.catch(() => {})
    await operation
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
      await this.refreshExperimentsIndex()
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
    await this.atomicWriteText(path, json(value))
  }

  private async atomicWriteText(path: string, value: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(value, 'utf8')
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
