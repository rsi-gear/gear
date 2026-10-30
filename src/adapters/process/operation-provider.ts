import { spawn } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import { findExecutable } from './executable.js'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import { validateAlgorithmWire } from '../../domain/algorithm-schema.js'
import type { Json } from '../../domain/algorithm-wire.js'
import type {
  OperationInspection,
  OperationProvider,
  OperationReceipt,
  OperationRequest,
  ProviderCapabilities,
  ProviderTimeouts,
  OperationCancellation,
} from '../../ports/operations.js'

export interface OperationProfile {
  command: string[]
  workingDirectory: string
  passEnv: string[]
  configuration: Record<string, unknown>
  timeoutMs: number
}
/** Trusted adapter process protocol. Target and Meta profile implementations are independent. */
export class ProcessOperationProvider implements OperationProvider {
  get cancellation(): Json {
    if (!this.capabilities.cancel) return null
    return {
      version: 1,
      kind: 'process',
      profile: this.profile as unknown as Json,
      context: this.context,
      implementationIdentity: this.implementationIdentity,
    }
  }
  static canceller(
    profile: OperationProfile,
    context: Json,
    implementationIdentity: string,
  ): OperationCancellation {
    const provider = new ProcessOperationProvider(
      profile,
      '',
      {} as ProviderCapabilities,
      context,
      implementationIdentity,
    )
    return { cancel: (request) => provider.cancel(request) }
  }
  get timeouts(): ProviderTimeouts {
    const limits = [
      { name: 'process-invocation', scope: 'provider-call' as const, milliseconds: this.profile.timeoutMs },
    ]
    return { target: limits, meta: limits, taskRuntime: 'provider-defined' }
  }
  private constructor(
    readonly profile: OperationProfile,
    readonly identity: string,
    readonly capabilities: ProviderCapabilities,
    readonly context: Json,
    readonly implementationIdentity: string | null = null,
    private readonly admission = false,
  ) {}
  static async connect(
    profile: OperationProfile,
    context: Json = null,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ProcessOperationProvider> {
    signal.throwIfAborted()
    const name = profile.command[0]
    if (!name)
      throw new GearError('provider-command-missing', 'Profile command must be a nonempty argv array')
    const executable = await findExecutable(
      name.includes('/') && !isAbsolute(name) ? resolve(profile.workingDirectory, name) : name,
    )
    profile = { ...profile, command: [executable, ...profile.command.slice(1)] }
    const provisional = new ProcessOperationProvider(profile, '', {} as ProviderCapabilities, context)
    const reply = (await provisional.invoke('describe', null, signal)) as {
      version: number
      identity: string
      capabilities: ProviderCapabilities
      admission?: boolean
    }
    if (reply.version !== 1 || !/^sha256:[0-9a-f]{64}$/u.test(reply.identity))
      throw new GearError(
        'provider-handshake-invalid',
        'Provider must describe its version and actual implementation identity',
      )
    if (reply.admission !== undefined && typeof reply.admission !== 'boolean')
      throw new GearError('provider-handshake-invalid', 'Invalid admission capability')
    for (const key of [
      'seeds',
      'temperature',
      'subsets',
      'idempotentSubmission',
      'inspect',
      'cancel',
      'physicalAttemptAccounting',
      'hardDollarBudget',
      'generationBudget',
      'evidenceProjection',
    ] as const) {
      if (typeof reply.capabilities?.[key] !== 'boolean')
        throw new GearError('provider-capability-invalid', `Provider omitted capability ${key}`)
    }
    return new ProcessOperationProvider(
      profile,
      canonicalDigest({
        implementation: reply.identity,
        capabilities: reply.capabilities,
        admission: reply.admission ?? false,
        config: profile.configuration,
        command: profile.command,
        cwd: profile.workingDirectory,
        passEnv: [...profile.passEnv].sort(),
        timeoutMs: profile.timeoutMs,
      }),
      reply.capabilities,
      context,
      reply.identity,
      reply.admission ?? false,
    )
  }
  async prepareAdmission(): Promise<void> {
    if (!this.admission) return
    const reply = await this.invoke('prepare_admission', null, new AbortController().signal)
    if (!reply || typeof reply !== 'object' || (reply as { prepared?: unknown }).prepared !== true)
      throw new GearError('provider-admission-unconfirmed', 'Provider control state was not initialized')
  }
  async submit(request: OperationRequest, signal: AbortSignal): Promise<OperationReceipt> {
    if (request.generationLimits !== undefined && !this.capabilities.generationBudget)
      throw new GearError('generation-budget-unsupported', 'Provider cannot enforce generation limits')
    if (request.projection)
      throw new GearError(
        'projection-execution-forbidden',
        'Use original-artifact projection instead of target submission',
      )
    const receipt = await this.invoke('submit', request, signal)
    validateAlgorithmWire('OperationReceipt', receipt)
    return receipt as OperationReceipt
  }
  async completeEvidence(request: OperationRequest, signal: AbortSignal): Promise<OperationReceipt> {
    if (!this.capabilities.evidenceProjection || !request.projection)
      throw new GearError(
        'evidence-projection-unsupported',
        'Provider does not support original-artifact projection',
      )
    const receipt = await this.invoke('project_evidence', request, signal)
    validateAlgorithmWire('OperationReceipt', receipt)
    return receipt as OperationReceipt
  }
  async inspect(request: OperationRequest, signal: AbortSignal): Promise<OperationInspection> {
    const result = (await this.invoke('inspect', request, signal)) as OperationInspection
    if (!result || !['complete', 'not_submitted', 'resumable', 'running', 'unknown'].includes(result.state))
      throw new GearError('provider-inspection-invalid', 'Provider returned an unknown inspection state')
    if (result.state === 'complete') validateAlgorithmWire('OperationReceipt', result.receipt)
    return result
  }
  async cancel(request: OperationRequest): Promise<void> {
    const result = await this.invoke('cancel', request, new AbortController().signal)
    if (
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      (result as { cancelled?: unknown }).cancelled !== true
    )
      throw new GearError(
        'provider-cancellation-unconfirmed',
        'Provider did not confirm stopped or fenced work',
        { retryable: true },
      )
  }
  private async invoke(
    action: string,
    request: OperationRequest | null,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted()
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: 'C.UTF-8' }
    for (const name of this.profile.passEnv)
      if (process.env[name] !== undefined) env[name] = process.env[name]
    const command = this.profile.command[0]
    if (!command)
      throw new GearError('provider-command-missing', 'Profile command must be a nonempty argv array')
    return new Promise((resolve, reject) => {
      const child = spawn(command, this.profile.command.slice(1), {
        cwd: this.profile.workingDirectory,
        env,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const stdout: Buffer[] = [],
        stderr: Buffer[] = []
      let stdoutBytes = 0,
        stderrBytes = 0
      const abort = (): void => {
        if (child.pid) {
          try {
            process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') reject(error)
          }
        }
        reject(
          new GearError(
            'provider-response-unknown',
            'Provider call was interrupted; inspect before resubmitting',
          ),
        )
      }
      const timer = setTimeout(abort, this.profile.timeoutMs)
      signal.addEventListener('abort', abort, { once: true })
      child.on('error', reject)
      child.stdin.on('error', () => {})
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length
        if (stdoutBytes > 16 * 1024 * 1024) {
          abort()
          return
        }
        stdout.push(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr.push(chunk)
        stderrBytes += chunk.length
        while (stderrBytes > 2000 && stderr.length > 1) stderrBytes -= stderr.shift()!.length
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        if (code !== 0) {
          // Pipe chunks can split a UTF-8 character; decode only after reassembling bytes.
          const text = Buffer.concat(stderr).toString('utf8').slice(-2000)
          reject(new GearError('provider-call-failed', `Provider ${action} failed: ${text}`))
          return
        }
        try {
          resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')))
        } catch {
          reject(new GearError('provider-response-invalid', 'Provider returned invalid JSON'))
        }
      })
      child.stdin.end(
        JSON.stringify({
          version: 1,
          action,
          request,
          configuration: this.profile.configuration,
          context: this.context,
          implementationIdentity: this.implementationIdentity,
        }),
      )
    })
  }
}
