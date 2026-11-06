import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import { GearError } from '../../domain/errors.js'

const execute = promisify(execFile)
export interface ProbeCase {
  index: number
  workspace: string
  logs: string
  expected_score: number
}
export interface BenchmarkProbePlan {
  task_id: string
  benchmark_digest: string
  compiler_digest: string
  probe_digest: string
  scorer_digest: string
  scorer_metadata?: Record<string, unknown>
  usage_required?: boolean
  credential_env?: string[]
  verifier_timeout_ms?: number
  environment: string
  dockerfile?: string
  compose?: { file: string; services: string[] }
  tests: string
  cases: ProbeCase[]
  scorer_requested: boolean
  scorer_not_run_reason: string | null
}

/** Explicit authoring probe, isolated from Target execution and the experiment ledger. */
export class DockerBenchmarkProbe {
  readonly tag = `gear-benchmark-probe:${randomUUID()}`
  private readonly containers = new Set<string>()
  private buildStarted = false
  private compose: { file: string; project: string } | undefined
  private readonly composeImages = new Set<string>()
  private async command(args: string[], signal?: AbortSignal, timeout = 60_000): Promise<string> {
    const result = await execute('docker', args, {
      ...(signal ? { signal } : {}),
      timeout,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
    })
    return result.stdout.trim()
  }
  async build(plan: BenchmarkProbePlan, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    try {
      if (plan.compose) {
        const project = `gear-probe-${randomUUID()}`
        const composition = JSON.parse(await readFile(plan.compose.file, 'utf8')) as {
          services: Record<string, { build?: unknown; image?: string; pull_policy?: string }>
        }
        for (const [name, service] of Object.entries(composition.services)) {
          if (service.build) {
            const tag = name === 'main' ? this.tag : `${this.tag}-${name}`
            service.image = tag
            service.pull_policy = 'build'
            this.composeImages.add(tag)
          }
        }
        const file = plan.compose.file + '.run.json'
        await writeFile(file, JSON.stringify(composition))
        this.compose = { file, project }
        const args = ['compose', '--project-name', project, '--file', file]
        await this.command([...args, 'build'], signal, 600_000)
        await this.command(
          [...args, 'up', '--detach', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '60'],
          signal,
          90_000,
        )
        const identity = await this.command(['image', 'inspect', this.tag, '--format', '{{.Id}}'], signal)
        if (!/^sha256:[a-f0-9]{64}$/u.test(identity)) throw new Error('Invalid Docker image identity')
        return identity
      }
      this.buildStarted = true
      await this.command(
        [
          'build',
          '--pull=false',
          '--tag',
          this.tag,
          ...(plan.dockerfile ? ['--file', plan.dockerfile] : []),
          plan.environment,
        ],
        signal,
        600_000,
      )
      const identity = await this.command(['image', 'inspect', this.tag, '--format', '{{.Id}}'], signal)
      if (!/^sha256:[a-f0-9]{64}$/u.test(identity)) throw new Error('Invalid Docker image identity')
      await this.run(identity, [], ['-c', 'exit 0'], signal)
      return identity
    } catch {
      signal.throwIfAborted()
      throw new GearError('benchmark-environment-failed', 'Docker build or container startup failed', {
        next_action: 'Check Docker and the task environment/Dockerfile; no Target or model was run',
      })
    }
  }
  private async run(
    image: string,
    mounts: string[],
    command: string[],
    signal: AbortSignal,
    credentials: string[] = [],
    timeout = 60_000,
  ): Promise<void> {
    const name = `gear-benchmark-probe-${randomUUID()}`
    this.containers.add(name)
    try {
      await this.command(
        [
          'run',
          '--name',
          name,
          credentials.length ? '--network=bridge' : '--network=none',
          ...credentials.flatMap((name) => ['--env', name]),
          '--cap-drop=ALL',
          '--security-opt=no-new-privileges',
          '--pids-limit=128',
          '--cpus=1',
          '--memory=1g',
          '--entrypoint=/bin/sh',
          ...mounts,
          image,
          ...command,
        ],
        signal,
        timeout,
      )
    } finally {
      // Killing the Docker client alone does not stop its container. Cleanup ignores caller cancellation.
      await this.command(['rm', '--force', name], undefined, 15_000).then(
        () => this.containers.delete(name),
        () => {},
      )
    }
  }
  async verify(
    plan: BenchmarkProbePlan,
    fixture: ProbeCase,
    image: string,
    signal: AbortSignal,
  ): Promise<void> {
    const credentials = plan.credential_env ?? []
    if (
      credentials.some((name) => !/^GEAR_SCORER_[A-Z0-9_]+_API_KEY$/u.test(name)) ||
      credentials.length > 1 ||
      Boolean(plan.usage_required) !== (credentials.length === 1)
    )
      throw new GearError('benchmark-scorer-credentials', 'Invalid verifier credential scope')
    const timeout = plan.verifier_timeout_ms ?? 60_000
    if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 135_000)
      throw new GearError('benchmark-verifier-timeout', 'Invalid verifier deadline')
    try {
      await this.run(
        image,
        [
          '--mount',
          `type=bind,src=${fixture.workspace},dst=/app,readonly`,
          '--mount',
          `type=bind,src=${plan.tests},dst=/tests,readonly`,
          '--mount',
          `type=bind,src=${fixture.logs},dst=/logs/verifier`,
        ],
        ['/tests/test.sh'],
        signal,
        credentials,
        timeout,
      )
    } catch {
      signal.throwIfAborted()
      throw new GearError('benchmark-verifier-failed', 'The verifier exited unsuccessfully or timed out')
    }
  }
  async dispose(): Promise<string[]> {
    const failures: string[] = []
    if (this.compose) {
      const { file, project } = this.compose
      await this.command(
        ['compose', '--project-name', project, '--file', file, 'down', '--volumes', '--remove-orphans'],
        undefined,
        30_000,
      ).then(
        () => {
          this.compose = undefined
        },
        () => failures.push(project),
      )
    }
    for (const name of this.containers) {
      await this.command(['rm', '--force', name], undefined, 15_000).then(
        () => this.containers.delete(name),
        () => {},
      )
    }
    const remaining = [...failures, ...this.containers]
    for (const tag of this.composeImages) {
      await this.command(['image', 'rm', tag], undefined, 15_000).then(
        () => this.composeImages.delete(tag),
        (error: unknown) => {
          if (!String((error as { stderr?: string }).stderr).includes('No such image:')) remaining.push(tag)
        },
      )
    }
    if (this.buildStarted) {
      await this.command(['image', 'rm', this.tag], undefined, 15_000).catch((error: unknown) => {
        const stderr = (error as { stderr?: string }).stderr ?? ''
        if (!stderr.includes('No such image:')) remaining.push(this.tag)
      })
    }
    return remaining
  }
}
