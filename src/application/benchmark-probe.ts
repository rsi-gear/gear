import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { GearError } from '../domain/errors.js'
import { canonicalDigest } from '../domain/canonical.js'
import { publishFile } from '../adapters/storage/atomic.js'
import { DockerBenchmarkProbe, type BenchmarkProbePlan } from '../adapters/hitch/benchmark-probe.js'
import { resolveProject } from './project-config.js'
import { checkBenchmark } from './benchmark.js'
import { profile } from './profile-store.js'
import { pinImage } from './profile-service.js'
import { pythonJson } from './python.js'

export interface BenchmarkProbeOptions {
  task_id?: string
  scorer?: boolean
  image?: string
}
export async function probeBenchmark(
  root: string,
  options: BenchmarkProbeOptions = {},
  signal: AbortSignal = new AbortController().signal,
) {
  const { config } = await resolveProject(root),
    benchmark = await checkBenchmark(root, config)
  const taskId = options.task_id ?? benchmark.splits.seed[0]!
  if (!benchmark.splits.seed.includes(taskId))
    throw new GearError('probe-seed-required', 'Authoring probes require a seed task')
  let image = options.image
  if (!image) {
    const selected = await profile(config.target.profile)
    if (!('kind' in selected) || selected.kind !== 'hitch')
      throw new GearError('probe-image-required', 'Choose --image IMAGE or a Hitch Target profile')
    image = selected.baseImage
  }
  const baseImage = await pinImage(image)
  signal.throwIfAborted()
  const scratch = await mkdtemp(join(tmpdir(), 'gear-benchmark-probe-')),
    runner = new DockerBenchmarkProbe()
  const id = `probe_${randomUUID()}`,
    path = join(root, '.gear', 'probes', `${id}.json`)
  const result: Record<string, unknown> = {
    version: 1,
    probe_id: id,
    kind: 'authoring_probe',
    split: 'seed',
    task_id: taskId,
    benchmark_digest: benchmark.digest,
    base_image: baseImage,
    model_requests: 0,
    model_cost_usd: 0,
    target_executed: false,
    baseline: false,
    environment: 'not_run',
    scorer: 'not_run',
    status: 'not_run',
    fixtures: [],
    report: relative(root, path),
  }
  try {
    const plan = (await pythonJson(['benchmark', 'probe-plan'], {
      benchmark,
      destination: join(scratch, 'compiled'),
      task_id: taskId,
      base_image: baseImage,
      scorer: options.scorer ?? false,
    })) as BenchmarkProbePlan
    Object.assign(result, {
      compiler_digest: plan.compiler_digest,
      scorer_digest: plan.scorer_digest,
      ...(plan.scorer_metadata ? { scorer_metadata: plan.scorer_metadata } : {}),
      probe_digest: plan.probe_digest,
    })
    if (plan.usage_required) {
      result.planned_model_requests = plan.cases.length
      result.estimated_model_cost_usd = 0
      if ((plan.credential_env ?? []).some((name) => !process.env[name]))
        throw new GearError('benchmark-scorer-credentials', 'The dedicated scorer API key is unavailable')
    }
    result.image_identity = await runner.build(plan, signal)
    result.environment = 'passed'
    const fixtures: Array<Record<string, unknown>> = []
    for (const fixture of plan.cases) {
      signal.throwIfAborted()
      let verificationError: unknown
      if (plan.usage_required)
        Object.assign(result, { model_requests: null, model_cost_usd: null, estimated_model_cost_usd: null })
      try {
        await runner.verify(plan, fixture, String(result.image_identity), signal)
      } catch (error) {
        verificationError = error
      }
      let observed: Record<string, unknown> = {}
      if (!verificationError || plan.usage_required) {
        try {
          observed = (await pythonJson(['benchmark', 'probe-result'], {
            directory: fixture.logs,
            expected_score: fixture.expected_score,
            usage_required: plan.usage_required ?? false,
          })) as Record<string, unknown>
        } catch (error) {
          verificationError ??= error
        }
      }
      fixtures.push({
        index: fixture.index,
        ...observed,
        ...(verificationError
          ? {
              status: 'scoring_failed',
              reason: verificationError instanceof GearError ? verificationError.code : 'verifier-failed',
            }
          : {}),
      })
      result.fixtures = fixtures
      if (plan.usage_required) {
        const sum = (field: string): number | null => {
          const values = fixtures.map((item) => (item.usage as Record<string, unknown> | undefined)?.[field])
          return values.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
            ? (values as number[]).reduce((total, value) => total + value, 0)
            : null
        }
        Object.assign(result, {
          request_attempts: sum('request_attempts'),
          model_requests: sum('model_requests'),
          model_tokens: sum('tokens'),
          model_cost_usd: sum('dollars'),
          estimated_model_cost_usd: sum('estimated_dollars'),
        })
      }
      signal.throwIfAborted()
    }
    result.scorer = plan.cases.length
      ? fixtures.every((item) => item.status === 'passed')
        ? 'passed'
        : 'failed'
      : 'not_run'
    result.status =
      result.scorer === 'failed'
        ? 'scoring_failed'
        : options.scorer && !plan.cases.length
          ? 'not_run'
          : 'passed'
    if (plan.scorer_not_run_reason) result.scorer_reason = plan.scorer_not_run_reason
  } catch (error) {
    result.status = signal.aborted
      ? 'cancelled'
      : result.environment === 'passed' ||
          (error instanceof GearError && error.code === 'benchmark-scorer-credentials')
        ? 'scoring_failed'
        : 'environment_failed'
    if (result.status === 'environment_failed') result.environment = 'failed'
    result.error =
      error instanceof GearError
        ? error.toJSON()
        : { code: signal.aborted ? 'probe-cancelled' : 'probe-failed' }
  } finally {
    const remaining = await runner.dispose()
    await rm(scratch, { recursive: true, force: true }).catch(() => remaining.push(scratch))
    result.cleanup_required = remaining
  }
  if ((result.cleanup_required as string[]).length) result.status = 'cleanup_required'
  const report = { ...result, digest: canonicalDigest(result) }
  await mkdir(join(root, '.gear', 'probes'), { recursive: true, mode: 0o700 })
  await publishFile(path, JSON.stringify(report, null, 2) + '\n', { immutable: true })
  return report
}
