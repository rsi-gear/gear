import Ajv from 'ajv'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import type { Json, Operation } from '../../domain/algorithm-wire.js'
import type {
  OperationProvider,
  OperationRequest,
  OperationReceipt,
  OperationInspection,
  OperationCancellation,
} from '../../ports/operations.js'
import { publishFile } from '../storage/atomic.js'
import { withFileLock } from '../storage/file-lock.js'
import { builtinPolicy, builtinPolicyImplementationDigest } from '../python/builtin-policy.js'

export interface ModelProfile {
  kind: 'model'
  endpoint: string
  model: string
  apiKeyEnv: string
  maxCompletionTokens: number
  timeoutMs: number
  passEnv: string[]
}
export interface ModelContext {
  directory: string
  tasks: Array<{ id: string; family: string; instruction: string }>
}
const active = new Map<string, AbortController>()
const capabilities = {
  seeds: false,
  temperature: false,
  subsets: true,
  idempotentSubmission: false,
  inspect: true,
  cancel: true,
  physicalAttemptAccounting: true,
  hardDollarBudget: false,
  generationBudget: false,
  evidenceProjection: false,
}
async function read<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
async function responseText(response: Response): Promise<string> {
  const reader = response.body!.getReader(),
    chunks: Uint8Array[] = []
  let bytes = 0
  for (;;) {
    const part = await reader.read()
    if (part.done) break
    bytes += part.value.byteLength
    if (bytes > 1024 * 1024) {
      await reader.cancel()
      throw new GearError('model-response-limit', 'Model response exceeds 1 MiB')
    }
    chunks.push(part.value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** One Chat Completions POST; an interrupted unknown request is never automatically repeated. */
export class ModelOperationProvider implements OperationProvider {
  readonly capabilities = capabilities
  private constructor(
    readonly profile: ModelProfile,
    readonly context: ModelContext,
    readonly identity: string,
  ) {}
  static async connect(profile: ModelProfile, context: ModelContext): Promise<ModelOperationProvider> {
    const implementation = await readFile(new URL(import.meta.url), 'utf8')
    return new ModelOperationProvider(
      profile,
      context,
      canonicalDigest({ implementation, policy: builtinPolicyImplementationDigest, profile }),
    )
  }
  get cancellation(): Json {
    return {
      version: 1,
      kind: 'model',
      profile: this.profile as unknown as Json,
      context: this.context as unknown as Json,
      identity: this.identity,
    }
  }
  static canceller(profile: ModelProfile, context: ModelContext, identity: string): OperationCancellation {
    const provider = new ModelOperationProvider(profile, context, identity)
    return { cancel: (request) => provider.cancel(request) }
  }
  get timeouts() {
    return {
      target: null,
      meta: [
        { name: 'model-request', scope: 'meta-operation' as const, milliseconds: this.profile.timeoutMs },
      ],
    }
  }
  validateOperation(operation: Operation): void {
    const meta =
      operation.payload && typeof operation.payload === 'object' && !Array.isArray(operation.payload)
        ? operation.payload.meta
        : null
    if (operation.kind !== 'diagnose_seed' || !meta || typeof meta !== 'object' || Array.isArray(meta))
      throw new GearError(
        'model-operation-unsupported',
        'Single-request model profiles require a read-only role with a prompt and response schema',
      )
  }
  private directory(request: OperationRequest) {
    return join(this.context.directory, request.operationId.slice(7))
  }
  private async state(request: OperationRequest) {
    const directory = this.directory(request)
    const started = await read<{ digest: string }>(join(directory, 'started.json'))
    if (started && started.digest !== canonicalDigest(request))
      throw new GearError('model-operation-conflict', 'Operation inputs changed')
    return { directory, started, receipt: await read<OperationReceipt>(join(directory, 'receipt.json')) }
  }
  async inspect(request: OperationRequest): Promise<OperationInspection> {
    const { started, receipt } = await this.state(request)
    return receipt
      ? { state: 'complete', receipt }
      : started
        ? { state: 'unknown' }
        : { state: 'not_submitted' }
  }
  async submit(request: OperationRequest, signal: AbortSignal): Promise<OperationReceipt> {
    this.validateOperation(request.operation)
    if (request.generationLimits)
      throw new GearError(
        'generation-budget-unsupported',
        'Single-request model profiles report usage but do not enforce hard total token budgets',
      )
    const directory = this.directory(request)
    return withFileLock(join(directory, 'operation.lock'), async () => {
      const prior = await this.state(request)
      if (prior.receipt) return prior.receipt
      if (prior.started)
        throw new GearError(
          'model-result-unknown',
          'Inspect and reconcile the original model request before retrying',
        )
      if (await read(join(directory, 'cancel.json')))
        throw new GearError('model-cancelled', 'Model operation was cancelled')
      const apiKey = process.env[this.profile.apiKeyEnv]
      if (!apiKey)
        throw new GearError(
          'model-credentials-missing',
          `Set ${this.profile.apiKeyEnv} for this model profile`,
        )
      const taskIds = new Set(request.operation.task_ids)
      const tasks = this.context.tasks.filter((task) => taskIds.has(task.id))
      const prepared = builtinPolicy('meta_prepare', {
        operation: request.operation,
        tasks,
        evidence: request.evidence,
        harness: {},
        mutationPolicy: {},
      } as unknown as Json) as { schema: Json }
      const valid = new Ajv({ allErrors: false, unknownFormats: 'ignore' }).compile(prepared.schema as object)
      const payload = request.operation.payload as Record<string, Json>
      const meta = payload.meta as Record<string, Json>
      const body = JSON.stringify({
        model: this.profile.model,
        stream: false,
        n: 1,
        max_completion_tokens: this.profile.maxCompletionTokens,
        messages: [
          { role: 'system', content: meta.prompt },
          {
            role: 'user',
            content: JSON.stringify({ inputs: payload.inputs ?? null, tasks, evidence: request.evidence }),
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'gear_role', strict: true, schema: prepared.schema },
        },
      })
      if (Buffer.byteLength(body) > 1024 * 1024)
        throw new GearError('model-request-limit', 'Model request exceeds 1 MiB')
      signal.throwIfAborted()
      const controller = new AbortController()
      const receipt: OperationReceipt = {
        result: {
          operation_id: request.operationId,
          kind: request.operation.kind,
          candidate_id: request.operation.candidate_id,
          status: 'failed',
          data: null,
        },
        candidate: null,
        evidence: [],
        physicalAttempts: 0,
        usage: { model_requests: 1 },
        provenance: { provider: this.identity },
      }
      await publishFile(
        join(directory, 'started.json'),
        JSON.stringify({ digest: canonicalDigest(request) }),
        { immutable: true },
      )
      active.set(directory, controller)
      let observedResponse = false
      try {
        const response = await fetch(this.profile.endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body,
          signal: AbortSignal.any([signal, controller.signal, AbortSignal.timeout(this.profile.timeoutMs)]),
        })
        if (!response.ok) {
          observedResponse = true
          throw new GearError('model-http-failed', `Model endpoint returned HTTP ${response.status}`)
        }
        const text = await responseText(response)
        observedResponse = true
        const value = JSON.parse(text) as {
          choices: Array<{ finish_reason: string; message: { content: string } }>
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
        }
        const usage = value.usage
        if (usage)
          for (const [source, target] of [
            ['prompt_tokens', 'input_tokens'],
            ['completion_tokens', 'output_tokens'],
            ['total_tokens', 'tokens'],
          ] as const) {
            const count = usage[source]
            if (Number.isSafeInteger(count) && count! >= 0) receipt.usage[target] = count!
          }
        if (value.choices?.length !== 1 || value.choices[0]!.finish_reason !== 'stop')
          throw new GearError('model-output-invalid', 'Model did not complete one structured reply')
        const raw = JSON.parse(value.choices[0]!.message.content)
        if (!valid(raw))
          throw new GearError('model-output-invalid', 'Model reply does not satisfy the declared role schema')
        const data = builtinPolicy('meta_result', {
          operation: request.operation,
          result: raw,
        } as unknown as Json) as Record<string, Json>
        receipt.result.data = data
        receipt.result.status = data.declined ? 'failed' : 'complete'
      } catch (error) {
        if (!observedResponse)
          throw new GearError(
            'model-result-unknown',
            'The model POST may have executed; inspect and reconcile before retrying',
          )
        receipt.result.data = { error: error instanceof GearError ? error.code : 'model-request-failed' }
      } finally {
        active.delete(directory)
      }
      await publishFile(join(directory, 'receipt.json'), JSON.stringify(receipt), { immutable: true })
      return receipt
    })
  }
  async cancel(request: OperationRequest): Promise<void> {
    const directory = this.directory(request)
    active.get(directory)?.abort()
    await withFileLock(join(directory, 'operation.lock'), async () => {
      const { started, receipt } = await this.state(request)
      if (started && !receipt)
        throw new GearError('model-cancellation-unknown', 'Remote model completion remains unconfirmed')
      await publishFile(join(directory, 'cancel.json'), '{}', { immutable: true })
    })
  }
}
