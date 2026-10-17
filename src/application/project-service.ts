import { generationBudget, requireGenerationCapability } from '../domain/generation-budget.js'
import { evaluationRepairPolicy, requireEvaluationCapabilities } from '../domain/evaluation.js'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { CompiledBenchmark, ProjectConfig } from '../domain/project.js'
import type { AlgorithmConfig, AlgorithmDriver, RunSpec } from '../domain/run.js'
import type { OperationProvider, OperationCancellation } from '../ports/operations.js'
import { canonicalDigest } from '../domain/canonical.js'
import { GearError } from '../domain/errors.js'
import { resolveProjectObjective } from './objective.js'
import { pythonObjective } from '../adapters/python/objective.js'
import { RunStore } from '../adapters/storage/run-store.js'
import { withFileLock } from '../adapters/storage/file-lock.js'
import { publishFile } from '../adapters/storage/atomic.js'
import { freezeAlgorithmSource } from '../adapters/python/source.js'
import { PythonAlgorithmWorker } from '../adapters/python/worker.js'
import { DurableRunner } from '../runtime/runner.js'
import { finishCancellation } from '../runtime/cancellation.js'
import { checkBenchmark } from './benchmark.js'
import { resolveProject } from './project-config.js'
import { pythonExecutable } from './python.js'
import { harnessAdapter } from './harness-adapters.js'
import { projectReport } from './project-report.js'
import { projectResearch } from './research.js'
import { ProjectExperience } from './experience.js'
import { ExperienceStore } from '../adapters/storage/experience.js'
import { readSeedTrajectory } from '../adapters/artifacts/access.js'
import { snapshotTarget, targetResources, targetManifest, TargetStore } from '../adapters/storage/targets.js'
import { sealedProvider } from './sealed-provider.js'
import { exportRun } from './export.js'
import type { Json } from '../domain/algorithm-wire.js'
import { selectBaseline, verifyBaseline } from './baseline.js'
import { runPlan, requireAffordableBaseline } from './run-plan.js'

export interface ProjectRuntimeContext {
  kind: 'evaluate' | 'refine'
  root: string
  runId: string
  stateRoot: string
  config: ProjectConfig
  benchmark: CompiledBenchmark
}
export interface ProjectBindings {
  provider(context: ProjectRuntimeContext, signal?: AbortSignal): Promise<OperationProvider>
  /** Reconstruct only the stop protocol from the private admission snapshot. */
  cancellation?(snapshot: Json): Promise<OperationCancellation>
  driver?(
    context: ProjectRuntimeContext,
    identity: string,
    source: string,
    scratch: string,
  ): Promise<AlgorithmDriver & { dispose?(): Promise<void> }>
}
export interface RefineOptions {
  rounds?: number
  algorithm?: AlgorithmConfig
  sources?: Array<{ path: string; source: string }>
  dependencies?: Json[]
}
export interface EvaluateOptions {
  split: 'seed' | 'held_out'
  limit?: number
}

export class ProjectApplication {
  readonly root: string
  readonly store: RunStore
  constructor(
    root: string,
    readonly bindings: ProjectBindings,
  ) {
    this.root = resolve(root)
    this.store = new RunStore(join(this.root, '.gear'))
  }
  async check() {
    const { config } = await resolveProject(this.root)
    return checkBenchmark(this.root, config)
  }
  async refine(options: RefineOptions = {}, signal: AbortSignal = new AbortController().signal) {
    signal.throwIfAborted()
    const { runId } = await this.admitRefine(options)
    return this.resume(runId, signal)
  }
  async admitRefine(options: RefineOptions = {}, runId = `run_${randomUUID().replaceAll('-', '')}`) {
    return this.admit(runId, 'refine', options, () => this.prepareRefine(options, runId))
  }
  async previewRefine(options: RefineOptions = {}) {
    const { spec } = await this.refineInputs(options, `preview_${randomUUID().replaceAll('-', '')}`)
    return runPlan(spec)
  }
  private async prepareRefine(options: RefineOptions, runId: string) {
    const { spec, context, provider, target, baseline } = await this.refineInputs(options, runId)
    requireAffordableBaseline(spec)
    const runRoot = join(context.stateRoot, 'runs', runId)
    await mkdir(runRoot, { recursive: true, mode: 0o700 })
    spec.implementationIdentity = await freezeAlgorithmSource(
      join(runRoot, 'algorithm'),
      options.sources,
      options.dependencies,
    )
    await mkdir(join(runRoot, 'scratch'), { mode: 0o700 })
    await publishFile(join(runRoot, 'benchmark.json'), JSON.stringify(context.benchmark), { immutable: true })
    await publishFile(join(runRoot, 'project.json'), JSON.stringify(context.config), { immutable: true })
    if (baseline)
      await publishFile(join(runRoot, 'baseline-source.json'), JSON.stringify(baseline.proof), {
        immutable: true,
      })
    await this.freezeTarget(context, provider, target)
    spec.cancellationIdentity = await this.freezeCancellation(runRoot, provider)
    await this.store.create(runId, spec)
    return { runId }
  }
  private async refineInputs(options: RefineOptions, runId: string) {
    const { config } = await resolveProject(
      this.root,
      options.rounds === undefined ? {} : { rounds: options.rounds },
    )
    const benchmark = await checkBenchmark(this.root, config)
    const stateRoot = join(this.root, '.gear')
    const context = { kind: 'refine' as const, root: this.root, runId, stateRoot, config, benchmark },
      provider = await this.bindings.provider(context)
    const algorithm =
      options.algorithm ??
      (typeof config.algorithm === 'string' ? { name: config.algorithm, options: {} } : config.algorithm)
    const generation = generationBudget(config.generation)
    requireEvaluationCapabilities(provider.capabilities)
    requireGenerationCapability(generation, provider.capabilities.generationBudget)
    const target = await this.selectTarget(context, provider)
    const objective = resolveProjectObjective(config)
    for (const rule of [...objective.protection, ...(objective.assertion_protection ?? [])]) {
      if (!benchmark.splits[rule.partition].includes(rule.task_id))
        throw new GearError(
          'protected-task-unavailable',
          'Protected task does not belong to its declared partition',
        )
    }
    const spec: RunSpec = {
      objective,
      objectiveIdentity: pythonObjective.identity,
      version: 1,
      kind: 'refine',
      generationBudget: generation,
      benchmarkDigest: benchmark.digest,
      configDigest: canonicalDigest(config),
      implementationIdentity: 'preview-not-frozen',
      providerIdentity: provider.identity,
      evaluationIdentity: provider.evaluationIdentity ?? provider.identity,
      providerCapabilities: structuredClone(provider.capabilities),
      ...(provider.artifactReader ? { artifactReader: structuredClone(provider.artifactReader) } : {}),
      ...(provider.timeouts ? { providerTimeouts: structuredClone(provider.timeouts) } : {}),
      ...(benchmark.execution_timeouts
        ? { taskTimeouts: structuredClone(benchmark.execution_timeouts) }
        : {}),
      championRevision: target.championRevision,
      targetSourceDigest: target.sourceDigest,
      lineage: target.lineage,
      algorithm,
      validationMode: config.validation.mode,
      seed: '0',
      seedTasks: benchmark.tasks
        .filter((task) => benchmark.splits.seed.includes(task.id))
        .map((task) => ({ id: task.id, family: task.family, estimated_cost: 1 })),
      heldOutTaskIds: benchmark.splits.held_out,
      anchor: {
        id: 'anchor',
        digest: target.manifest.digest,
        parent_id: null,
      },
      budget: {
        rounds: config.budget.rounds,
        maxEvaluations: config.budget.max_evaluations,
        maxCandidates: config.budget.max_candidates,
        repetitions: config.budget.repetitions,
      },
      acceptance: { minimumGain: 0, maxHeldOutRegression: 0 },
      evaluationRepair: evaluationRepairPolicy(
        config.evaluation
          ? {
              maxRetries: config.evaluation.repair.max_retries,
              maxProjections: config.evaluation.repair.max_projections,
              backoffMs: config.evaluation.repair.backoff_ms,
            }
          : undefined,
      ),
    }
    const baseline = await selectBaseline(this.root, config, spec)
    if (baseline) spec.baseline = baseline.reuse
    return { spec, context, provider, target, baseline }
  }
  async evaluate(options: EvaluateOptions, signal: AbortSignal = new AbortController().signal) {
    signal.throwIfAborted()
    const { runId } = await this.admitEvaluate(options)
    return this.resume(runId, signal)
  }
  async admitEvaluate(options: EvaluateOptions, runId = `run_${randomUUID().replaceAll('-', '')}`) {
    return this.admit(runId, 'evaluate', options, () => this.prepareEvaluate(options, runId))
  }
  private async prepareEvaluate(options: EvaluateOptions, runId: string) {
    const { config } = await resolveProject(this.root),
      benchmark = await checkBenchmark(this.root, config)
    if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1))
      throw new GearError('invalid-task-limit', 'Task limit must be a positive integer')
    const taskIds = benchmark.splits[options.split].slice(0, options.limit)
    if (!taskIds.length)
      throw new GearError('empty-evaluation-split', 'Selected evaluation split has no tasks')
    const stateRoot = join(this.root, '.gear'),
      runRoot = join(stateRoot, 'runs', runId)
    await mkdir(runRoot, { recursive: true, mode: 0o700 })
    await publishFile(join(runRoot, 'benchmark.json'), JSON.stringify(benchmark), { immutable: true })
    await publishFile(join(runRoot, 'project.json'), JSON.stringify(config), { immutable: true })
    const context = { kind: 'evaluate' as const, root: this.root, runId, stateRoot, config, benchmark },
      provider = await this.bindings.provider(context)
    const target = await this.prepareTarget(context, provider)
    const objective = resolveProjectObjective(config)
    for (const rule of [...objective.protection, ...(objective.assertion_protection ?? [])]) {
      if (!benchmark.splits[rule.partition].includes(rule.task_id))
        throw new GearError(
          'protected-task-unavailable',
          'Protected task does not belong to its declared partition',
        )
    }
    const spec: RunSpec = {
      objective,
      objectiveIdentity: pythonObjective.identity,
      version: 1,
      kind: 'evaluate',
      generationBudget: generationBudget(config.generation),
      benchmarkDigest: benchmark.digest,
      configDigest: canonicalDigest(config),
      implementationIdentity: canonicalDigest('operator-evaluate-v1'),
      providerIdentity: provider.identity,
      evaluationIdentity: provider.evaluationIdentity ?? provider.identity,
      providerCapabilities: structuredClone(provider.capabilities),
      ...(provider.artifactReader ? { artifactReader: structuredClone(provider.artifactReader) } : {}),
      championRevision: target.championRevision,
      targetSourceDigest: target.sourceDigest,
      lineage: target.lineage,
      algorithm: { name: 'operator-evaluate', options: {} },
      validationMode: config.validation.mode,
      seed: '0',
      seedTasks: benchmark.tasks
        .filter((task) => benchmark.splits.seed.includes(task.id))
        .map((task) => ({ id: task.id, family: task.family, estimated_cost: 1 })),
      heldOutTaskIds: benchmark.splits.held_out,
      anchor: {
        id: 'anchor',
        digest: target.manifest.digest,
        parent_id: null,
      },
      budget: {
        rounds: 1,
        maxEvaluations: config.budget.max_evaluations,
        maxCandidates: 1,
        repetitions: config.budget.repetitions,
      },
      acceptance: { minimumGain: 0, maxHeldOutRegression: 0 },
      evaluationRepair: evaluationRepairPolicy(
        config.evaluation
          ? {
              maxRetries: config.evaluation.repair.max_retries,
              maxProjections: config.evaluation.repair.max_projections,
              backoffMs: config.evaluation.repair.backoff_ms,
            }
          : undefined,
      ),
    }
    const slots = taskIds.flatMap((taskId) =>
      Array.from({ length: spec.budget.repetitions }, (_, repetition) => ({ taskId, repetition })),
    )
    if (slots.length > spec.budget.maxEvaluations)
      throw new GearError('budget-exhausted', 'Requested smoke evaluation exceeds the run budget')
    spec.cancellationIdentity = await this.freezeCancellation(runRoot, provider)
    await this.store.create(runId, spec, [
      {
        request: {
          operationId: canonicalDigest([runId, 'operator-evaluation', slots]),
          runId,
          generation: 1,
          operation: {
            kind: 'evaluate_seed',
            candidate_id: 'anchor',
            parent_id: null,
            task_ids: taskIds,
            scope: options.split,
            rationale: 'Explicit operator evaluation',
            payload: null,
          },
          partition: options.split,
          repetitions: spec.budget.repetitions,
          slots,
          evidence: [],
          metrics: objective.metrics,
          ...(objective.assertions?.length ? { assertions: objective.assertions } : {}),
        },
        status: 'reserved',
        reservedAttempts: slots.length,
      },
    ])
    return { runId }
  }
  async resume(runId: string, signal: AbortSignal = new AbortController().signal) {
    const journal = await this.store.read(runId),
      stateRoot = join(this.root, '.gear'),
      runRoot = join(stateRoot, 'runs', runId)
    if (journal.status === 'completed' || journal.status === 'cancelled')
      return projectReport(this.root, journal)
    if (await this.store.cancelled(runId)) {
      await this.completeCancellation(runId)
      throw new GearError('run-cancelled', 'Cancellation requested', { run_id: runId })
    }
    await this.store.researchStore(runId).load(journal)
    try {
      const benchmark = JSON.parse(
        await readFile(join(runRoot, 'benchmark.json'), 'utf8'),
      ) as CompiledBenchmark
      const config = JSON.parse(await readFile(join(runRoot, 'project.json'), 'utf8')) as ProjectConfig
      if (canonicalDigest(config) !== journal.spec.configDigest)
        throw new GearError('project-identity-mismatch', 'Frozen project configuration changed')
      const { digest: savedBenchmarkDigest, ...benchmarkBody } = benchmark
      if (
        canonicalDigest(benchmarkBody) !== savedBenchmarkDigest ||
        benchmark.digest !== journal.spec.benchmarkDigest
      )
        throw new GearError('benchmark-identity-mismatch', 'Frozen benchmark changed')
      await verifyBaseline(this.root, runId, journal.spec)
      const context = { kind: journal.spec.kind, root: this.root, runId, stateRoot, config, benchmark },
        provider = await this.bindings.provider(context, signal)
      signal.throwIfAborted()
      return await this.execute(
        context,
        provider,
        journal.spec.implementationIdentity,
        join(runRoot, 'algorithm'),
        join(runRoot, 'scratch'),
        signal,
      )
    } catch (error) {
      const failure =
        error instanceof GearError
          ? error
          : new GearError('run-execution-failed', error instanceof Error ? error.message : String(error))
      failure.details.run_id ??= runId
      // Startup can fail before the durable runner takes ownership. Record only
      // that unchanged generation; never overwrite a later worker's result.
      await this.store
        .locked(runId, async () => {
          const current = await this.store.read(runId)
          if (
            current.generation === journal.generation &&
            !['completed', 'cancelled'].includes(current.status)
          ) {
            current.status = 'needs_recovery'
            current.failure = {
              code: failure.code,
              message: failure.message,
              retryable: failure.details.retryable === true,
            }
            await this.store.write(current)
          }
        })
        .catch(() => {})
      throw failure
    }
  }

  async cancel(id: string) {
    await this.store.cancel(id)
    return { run_id: id, cancellation: 'requested' }
  }
  private async freezeCancellation(directory: string, provider: OperationProvider): Promise<string> {
    await provider.prepareAdmission?.()
    const snapshot = provider.cancellation ?? null
    const identity = canonicalDigest(snapshot)
    await publishFile(join(directory, 'cancellation.json'), JSON.stringify(snapshot), { immutable: true })
    return identity
  }
  async completeCancellation(id: string): Promise<void> {
    await this.store.locked(id, async () => {
      const journal = await this.store.read(id)
      if (['completed', 'cancelled'].includes(journal.status)) return
      if (!(await this.store.cancelled(id)))
        throw new GearError('cancellation-not-requested', 'Persist cancellation before stopping work')
      let connection: Promise<OperationCancellation> | undefined
      await finishCancellation(this.store, journal, async (request) => {
        connection ??= (async () => {
          const snapshot = JSON.parse(
            await readFile(join(this.store.root, 'runs', id, 'cancellation.json'), 'utf8'),
          ) as Json
          if (canonicalDigest(snapshot) !== journal.spec.cancellationIdentity || !this.bindings.cancellation)
            throw new GearError(
              'cancellation-connection-unavailable',
              'Frozen cancellation connection is unavailable',
            )
          return this.bindings.cancellation(snapshot)
        })()
        await (await connection).cancel(request)
      })
    })
  }
  async report(id: string) {
    return projectReport(this.root, await this.store.read(id))
  }
  async archive(id: string) {
    return projectResearch(this.root, await this.store.read(id))
  }
  async experience(id: string, params: Record<string, unknown>) {
    const journal = await this.store.read(id)
    const runRoot = join(this.root, '.gear/runs', id)
    const config = JSON.parse(
      await readFile(join(runRoot, 'project.json'), 'utf8'),
    ) as ProjectRuntimeContext['config']
    if (canonicalDigest(config) !== journal.spec.configDigest)
      throw new GearError('project-identity-mismatch', 'Frozen project configuration changed')
    const targets = new TargetStore(
      runRoot,
      harnessAdapter(config.target.adapter),
      journal.spec.evaluationIdentity ?? journal.spec.providerIdentity,
    )
    return new ProjectExperience(runRoot, targets).access(journal, params)
  }
  async trajectory(id: string, snapshotDigest: string, params: Record<string, unknown>, signal: AbortSignal) {
    const journal = await this.store.read(id),
      runRoot = join(this.root, '.gear/runs', id)
    const snapshot = await new ExperienceStore(join(runRoot, 'experience')).read(snapshotDigest)
    if (
      snapshot.run_id !== id ||
      snapshot.records.some((record) =>
        record.scope.task_ids.some((task) => !journal.spec.seedTasks.some((seed) => seed.id === task)),
      )
    )
      throw new GearError('trajectory-outside-snapshot', 'Snapshot belongs to another run or seed scope')
    return readSeedTrajectory(runRoot, snapshot, journal.spec.artifactReader, params, signal)
  }
  async export(id: string) {
    return exportRun(this.root, await this.store.read(id))
  }
  private async admit(
    runId: string,
    kind: 'refine' | 'evaluate',
    options: RefineOptions | EvaluateOptions,
    prepare: () => Promise<{ runId: string }>,
  ) {
    if (!/^run_[a-f0-9]{32}$/u.test(runId)) throw new GearError('invalid-run-id', 'Invalid admission run ID')
    const intent = { kind, optionsDigest: canonicalDigest(JSON.parse(JSON.stringify(options))) }
    const path = join(this.store.root, 'admissions', `${runId}.json`)
    return withFileLock(`${path}.lock`, async () => {
      let previous: typeof intent | null = null
      try {
        previous = JSON.parse(await readFile(path, 'utf8')) as typeof intent
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (previous && canonicalDigest(previous) !== canonicalDigest(intent))
        throw new GearError(
          'admission-conflict',
          'This request ID already belongs to different run options',
          { run_id: runId },
        )
      const runRoot = join(this.store.root, 'runs', runId)
      let existing
      try {
        existing = await this.store.read(runId)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (existing) {
        if (!previous || existing.spec.kind !== kind)
          throw new GearError('admission-conflict', 'Run ID belongs to another admission', { run_id: runId })
        return { runId }
      }
      const partial = await lstat(runRoot).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (partial && !previous)
        throw new GearError('admission-conflict', 'Unowned partial run directory', { run_id: runId })
      await publishFile(path, JSON.stringify(intent), { immutable: true })
      // No operation can be submitted without a committed journal. Under this
      // admission lock, only our own interrupted preparation may be replaced.
      if (partial) await rm(runRoot, { recursive: true, force: true })
      return prepare()
    })
  }
  private async execute(
    context: ProjectRuntimeContext,
    provider: OperationProvider,
    identity: string,
    source: string,
    scratch: string,
    signal: AbortSignal,
  ) {
    let driver: AlgorithmDriver & { dispose?(): Promise<void> }
    if ((await this.store.read(context.runId)).spec.kind === 'evaluate')
      driver = {
        async step() {
          throw new Error('Evaluation does not invoke an algorithm')
        },
      }
    else if (this.bindings.driver) driver = await this.bindings.driver(context, identity, source, scratch)
    else {
      const worker = new PythonAlgorithmWorker({
        python: await pythonExecutable(),
        sourceRoot: source,
        scratch,
        implementationIdentity: identity,
        ...(context.config.sandbox ? { linuxIsolation: context.config.sandbox.linux_isolation } : {}),
        protectedPaths: [
          join(context.stateRoot, 'runs', context.runId, 'benchmark.json'),
          join(this.root, 'gear.yaml'),
        ],
      })
      await worker.start(signal)
      driver = worker
    }
    try {
      const targets = new TargetStore(
        join(context.stateRoot, 'runs', context.runId),
        harnessAdapter(context.config.target.adapter),
        provider.evaluationIdentity ?? provider.identity,
      )
      const journal = await this.store.read(context.runId)
      for (const candidate of journal.candidates) {
        if ((await targets.verify(candidate.id)).digest !== candidate.digest)
          throw new GearError('target-identity-mismatch', `Candidate ${candidate.id} changed since admission`)
      }
      const experience = new ProjectExperience(join(context.stateRoot, 'runs', context.runId), targets)
      return projectReport(
        this.root,
        await new DurableRunner(
          this.store,
          driver,
          sealedProvider(provider, targets, experience),
          pythonObjective,
          experience,
        ).run(context.runId, signal),
      )
    } finally {
      await driver.dispose?.()
    }
  }
  private async prepareTarget(context: ProjectRuntimeContext, provider: OperationProvider) {
    const target = await this.selectTarget(context, provider)
    await this.freezeTarget(context, provider, target)
    return target
  }
  private async selectTarget(context: ProjectRuntimeContext, provider: OperationProvider) {
    const adapter = harnessAdapter(context.config.target.adapter)
    const source = resolve(this.root, context.config.target.path)
    await adapter.check(source)
    const sourceDigest = canonicalDigest(await targetResources(source))
    const previous = await this.store.champion()
    let selectedSource = source,
      baseRef = sourceDigest
    let lineage: RunSpec['lineage'] = null
    if (previous) {
      const previousRun = await this.store.read(previous.runId)
      const previousConfig = JSON.parse(
        await readFile(join(context.stateRoot, 'runs', previous.runId, 'project.json'), 'utf8'),
      ) as ProjectConfig
      if (canonicalDigest(previousConfig) !== previousRun.spec.configDigest)
        throw new GearError('champion-identity-mismatch', 'Retained Target configuration changed')
      if (
        previousRun.spec.targetSourceDigest === sourceDigest &&
        previousConfig.target.adapter === context.config.target.adapter
      ) {
        const store = new TargetStore(
          join(context.stateRoot, 'runs', previous.runId),
          adapter,
          previousRun.spec.evaluationIdentity ?? previousRun.spec.providerIdentity,
        )
        const retained = await store.verify(previous.candidate.id)
        if (retained.digest !== previous.candidate.digest)
          throw new GearError(
            'champion-identity-mismatch',
            'Retained target content no longer matches its accepted gate',
          )
        selectedSource = store.path(previous.candidate.id)
        baseRef = retained.baseRef
        lineage = { runId: previous.runId, candidateId: previous.candidate.id }
      }
    }
    const manifest = targetManifest(
      adapter,
      provider.evaluationIdentity ?? provider.identity,
      baseRef,
      await targetResources(selectedSource),
    )
    return {
      manifest,
      sourceDigest,
      lineage,
      championRevision: previous?.revision ?? null,
      selectedSource,
      baseRef,
    }
  }
  private async freezeTarget(
    context: ProjectRuntimeContext,
    provider: OperationProvider,
    selected: Awaited<ReturnType<ProjectApplication['selectTarget']>>,
  ) {
    const targets = new TargetStore(
      join(context.stateRoot, 'runs', context.runId),
      harnessAdapter(context.config.target.adapter),
      provider.evaluationIdentity ?? provider.identity,
    )
    await snapshotTarget(selected.selectedSource, targets.path('anchor'))
    const manifest = await targets.seal('anchor', selected.baseRef)
    if (manifest.digest !== selected.manifest.digest)
      throw new GearError(
        'target-changed-before-admission',
        'Target changed while the run was being prepared; create a fresh plan',
      )
  }
}
