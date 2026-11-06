import { canonicalDigest } from '../domain/canonical.js'
import { GearError } from '../domain/errors.js'
import type { ProjectApplication, EvaluateOptions, RefineOptions } from './project-service.js'
import { resolveProject } from './project-config.js'
import {
  prepareBenchmarkImport,
  applyBenchmarkImport,
  type BenchmarkImportOptions,
} from './benchmark-import.js'
import { doctor } from './doctor.js'
import { probeBenchmark } from './benchmark-probe.js'
import { setup, type SetupOptions } from './setup.js'
import { initProject } from './init.js'
import { createProfile, selectProjectProfile, type CreateProfileOptions } from './profile-service.js'
import { defaultProfiles, listProfiles, saveProfile, selectDefaultProfile } from './profile-store.js'
import { pythonJson } from './python.js'
import { runPlan, type RunPlan } from './run-plan.js'

interface Invocation {
  requestId?: string
  background?: boolean
  signal?: AbortSignal
  onPlan?: (plan: RunPlan) => void | Promise<void>
}
function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new GearError('invalid-command-params', 'Command parameters must be an object')
  const params = value as Record<string, unknown>
  const unknown = Object.keys(params).filter((key) => !allowed.includes(key))
  if (unknown.length)
    throw new GearError('unknown-command-params', `Unknown parameters: ${unknown.join(', ')}`)
  return params
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 1024)
    throw new GearError(
      'invalid-command-params',
      `${label} must be a nonempty string (at most 1024 characters)`,
    )
  return value
}
function positive(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new GearError('invalid-command-params', `${label} must be a positive safe integer`)
  return value as number
}

function refineOptions(input: unknown): RefineOptions {
  const params = object(input, ['rounds', 'algorithm', 'sources', 'dependencies'])
  positive(params.rounds, 'rounds')
  if (params.algorithm !== undefined) {
    const algorithm = object(params.algorithm, ['name', 'options'])
    string(algorithm.name, 'algorithm.name')
    if (!algorithm.options || typeof algorithm.options !== 'object' || Array.isArray(algorithm.options))
      throw new GearError('invalid-command-params', 'algorithm.options must be an object')
  }
  if (
    params.sources !== undefined &&
    (!Array.isArray(params.sources) ||
      params.sources.some((value) => {
        const source = object(value, ['path', 'source'])
        return typeof source.path !== 'string' || typeof source.source !== 'string'
      }))
  )
    throw new GearError('invalid-command-params', 'sources must contain path/source pairs')
  if (params.dependencies !== undefined && !Array.isArray(params.dependencies))
    throw new GearError('invalid-command-params', 'dependencies must be an array')
  canonicalDigest(params) // Reject non-JSON or non-finite values before durable admission.
  return params as RefineOptions
}

/** One command surface for CLI, the Python SDK's CLI transport, and Skill. */
export class ProjectController {
  readonly maxRequestBytes = 4 * 1024 * 1024
  private readonly jobs = new Map<string, { abort: AbortController; completion: Promise<void> }>()
  private readonly cancellations = new Map<string, Promise<void>>()
  private closed = false
  constructor(readonly application: ProjectApplication) {}

  call(method: string, params: unknown = {}, requestId?: string): Promise<unknown> {
    return this.invoke(method, params, {
      background: true,
      ...(requestId === undefined ? {} : { requestId }),
    })
  }
  async invoke(method: string, input: unknown = {}, context: Invocation = {}): Promise<unknown> {
    if (this.closed) throw new GearError('controller-stopped', 'Project controller is stopping')
    context.signal?.throwIfAborted()
    if (method === 'environment.doctor') {
      object(input, [])
      return doctor(this.application.root)
    }
    if (method === 'environment.setup') {
      const params = object(input, [
        'python',
        'hitch',
        'adapter',
        'hitchExecutable',
        'hitchRoot',
        'image',
        'targetProfile',
        'metaProfile',
      ])
      for (const [key, value] of Object.entries(params)) {
        if (key === 'hitch') {
          if (typeof value !== 'boolean')
            throw new GearError('invalid-command-params', 'hitch must be boolean')
        } else string(value, key)
      }
      return setup(params as SetupOptions)
    }
    if (method === 'project.init') {
      const params = object(input, ['directory', 'adapter', 'template', 'targetProfile', 'metaProfile'])
      string(params.directory, 'directory')
      if (params.adapter !== undefined && !['dsh', 'pi'].includes(String(params.adapter)))
        throw new GearError('invalid-command-params', 'adapter must be dsh|pi')
      if (params.template !== undefined && !['text', 'files'].includes(String(params.template)))
        throw new GearError('invalid-command-params', 'template must be text|files')
      for (const key of ['targetProfile', 'metaProfile'])
        if (params[key] !== undefined) string(params[key], key)
      const { directory, ...options } = params
      return initProject(string(directory, 'directory'), options as Parameters<typeof initProject>[1])
    }
    if (method === 'profile.list') {
      object(input, [])
      return { profiles: await listProfiles(), defaults: await defaultProfiles() }
    }
    if (method === 'profile.create') {
      const params = object(input, ['name', 'options'])
      const options = object(params.options, [
        'kind',
        'model',
        'executable',
        'adapter',
        'root',
        'harnessRef',
        'baseImage',
        'passEnv',
        'agentArgs',
        'timeoutMs',
        'maxConcurrent',
        'preparationTimeoutMs',
        'setupTimeoutMs',
        'authHome',
        'allowedDomains',
      ])
      return createProfile(string(params.name, 'name'), options as unknown as CreateProfileOptions)
    }
    if (method === 'profile.import') {
      const params = object(input, ['name', 'profile'])
      return saveProfile(string(params.name, 'name'), params.profile)
    }
    if (method === 'profile.select') {
      const params = object(input, ['name', 'role', 'scope'])
      const name = string(params.name, 'name')
      if (params.role !== 'target' && params.role !== 'meta')
        throw new GearError('invalid-command-params', 'role must be target|meta')
      if (params.scope === 'default') return selectDefaultProfile(name, params.role)
      if (params.scope !== undefined && params.scope !== 'project')
        throw new GearError('invalid-command-params', 'scope must be project|default')
      return selectProjectProfile(this.application.root, name, params.role)
    }
    if (method === 'benchmark.import') {
      const params = object(input, ['source', 'template', 'mode', 'resource_root'])
      string(params.source, 'source')
      if (
        params.template !== undefined &&
        !['text', 'json', 'files', 'harbor'].includes(String(params.template))
      )
        throw new GearError('invalid-command-params', 'template must be text|json|files|harbor')
      if (params.mode !== undefined && !['holdout', 'research'].includes(String(params.mode)))
        throw new GearError('invalid-command-params', 'mode must be holdout|research')
      if (params.resource_root !== undefined) string(params.resource_root, 'resource_root')
      return prepareBenchmarkImport(this.application.root, params as unknown as BenchmarkImportOptions)
    }
    if (method === 'benchmark.apply') {
      const params = object(input, ['plan_id'])
      return applyBenchmarkImport(this.application.root, string(params.plan_id, 'plan_id'))
    }
    if (method === 'benchmark.probe') {
      const params = object(input, ['task_id', 'scorer', 'image'])
      if (params.task_id !== undefined) string(params.task_id, 'task_id')
      if (params.image !== undefined) string(params.image, 'image')
      if (params.scorer !== undefined && typeof params.scorer !== 'boolean')
        throw new GearError('invalid-command-params', 'scorer must be boolean')
      return probeBenchmark(this.application.root, params, context.signal)
    }
    if (method === 'benchmark.check' || method === 'benchmark.preview') {
      const params = object(input, method === 'benchmark.preview' ? ['task_id'] : [])
      const benchmark = await this.application.check()
      if (method === 'benchmark.check')
        return {
          digest: benchmark.digest,
          tasks: benchmark.tasks.length,
          splits: benchmark.splits,
          checks: benchmark.checks,
          ...(benchmark.scorer_metadata ? { scorer: benchmark.scorer_metadata } : {}),
        }
      const id = string(params.task_id, 'task_id'),
        task = benchmark.tasks.find((value) => value.id === id)
      if (!task) throw new GearError('unknown-task', 'Task does not exist')
      return { task, scorer: benchmark.verifiers[id] }
    }
    if (method === 'config.explain') {
      object(input, [])
      return resolveProject(this.application.root)
    }
    if (method === 'algorithm.test') {
      const params = object(input, ['entrypoint'])
      return pythonJson(
        [
          'algorithm',
          'test',
          params.entrypoint === undefined ? 'gepa' : string(params.entrypoint, 'entrypoint'),
        ],
        null,
      )
    }
    if (method === 'run.plan') return this.application.previewRefine(refineOptions(input))
    if (method === 'run.refine' || method === 'run.evaluate') {
      const id =
        context.requestId === undefined
          ? undefined
          : `run_${canonicalDigest(['project-command-v1', this.application.root, string(context.requestId, 'request ID')]).slice(7, 39)}`
      let admitted: { runId: string }
      if (method === 'run.evaluate') {
        const params = object(input, ['split', 'limit'])
        if (params.split !== 'seed' && params.split !== 'held_out')
          throw new GearError('explicit-split-required', 'Choose split: seed or held_out')
        const limit = positive(params.limit, 'limit')
        const options: EvaluateOptions = { split: params.split, ...(limit === undefined ? {} : { limit }) }
        admitted = await this.application.admitEvaluate(options, id)
      } else {
        const params = refineOptions(input)
        admitted = await this.application.admitRefine(params as RefineOptions, id)
      }
      return this.execute(admitted.runId, context, false)
    }
    if (method === 'experience.trajectory') {
      const params = object(input, ['run_id', 'snapshot_digest', 'ref', 'source_ref', 'query'])
      return this.application.trajectory(
        string(params.run_id, 'run_id'),
        string(params.snapshot_digest, 'snapshot_digest'),
        {
          ref: string(params.ref, 'ref'),
          source_ref: string(params.source_ref, 'source_ref'),
          query: params.query ?? {},
        },
        context.signal ?? new AbortController().signal,
      )
    }
    if (method === 'experience.query' || method === 'experience.read') {
      const params = object(
        input,
        method === 'experience.query'
          ? ['run_id', 'snapshot_digest', 'query', 'parent_id', 'limit', 'cursor']
          : ['run_id', 'snapshot_digest', 'ref', 'view', 'limit', 'cursor'],
      )
      const { run_id, ...options } = params
      if (method === 'experience.read') string(params.ref, 'ref')
      if (params.snapshot_digest !== undefined) string(params.snapshot_digest, 'snapshot_digest')
      return this.application.experience(string(run_id, 'run_id'), options)
    }
    if (['run.resume', 'run.cancel', 'run.report', 'run.export', 'run.archive'].includes(method)) {
      const params = object(input, ['run_id'])
      const id =
        params.run_id === undefined && method === 'run.report'
          ? await this.application.store.latest()
          : string(params.run_id, 'run_id')
      if (method === 'run.resume') return this.execute(id, context, true)
      if (method === 'run.cancel') {
        const requested = await this.application.cancel(id)
        this.jobs
          .get(id)
          ?.abort.abort(new GearError('run-cancelled', 'Cancellation requested', { run_id: id }))
        if (!context.background) {
          try {
            await this.application.completeCancellation(id)
            return { run_id: id, cancellation: 'confirmed' }
          } catch (error) {
            if (error instanceof GearError && error.code === 'state-busy') return requested
            throw error
          }
        }
        // This may stop old work while a separate recovery is still preparing its runtime.
        if (!this.cancellations.has(id)) {
          const completion = this.application
            .completeCancellation(id)
            .then(
              () => {},
              () => {},
            )
            .finally(() => {
              this.cancellations.delete(id)
            })
          this.cancellations.set(id, completion)
        }
        return requested
      }
      if (method === 'run.export') return this.application.export(id)
      if (method === 'run.archive') return this.application.archive(id)
      return this.report(id)
    }
    throw new GearError('unknown-command', `Unknown project command: ${method}`)
  }
  private async execute(id: string, context: Invocation, resume: boolean): Promise<unknown> {
    const journal = await this.application.store.read(id)
    const plan = journal.spec.kind === 'refine' ? runPlan(journal.spec, id) : null
    if (plan) await context.onPlan?.(plan)
    context.signal?.throwIfAborted()
    if (
      ['completed', 'cancelled'].includes(journal.status) ||
      (!resume && journal.status === 'needs_recovery')
    )
      return this.report(id)
    if (!context.background) return this.application.resume(id, context.signal)
    if (this.closed)
      throw new GearError('controller-stopped', 'Run admitted; resume it with a new controller', {
        run_id: id,
      })
    if (!this.jobs.has(id)) {
      const abort = new AbortController()
      const completion = this.application
        .resume(id, abort.signal)
        // ProjectApplication/runner persist the failure before this settles.
        .then(
          () => {},
          () => {},
        )
        .finally(() => {
          this.jobs.delete(id)
        })
      this.jobs.set(id, { abort, completion })
    }
    return { run_id: id, status: journal.status, execution: 'active', ...(plan ? { plan } : {}) }
  }
  private async report(id: string) {
    return this.application.report(id)
  }
  async dispose(): Promise<void> {
    this.closed = true
    const jobs = [...this.jobs.values()]
    for (const job of jobs)
      job.abort.abort(new GearError('controller-stopped', 'Controller stopped; resume the saved run'))
    await Promise.all(jobs.map((job) => job.completion))
    await Promise.all(this.cancellations.values())
  }
}
