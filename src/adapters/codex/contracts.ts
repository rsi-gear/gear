import { isAbsolute } from 'node:path'
import { GearError } from '../../domain/errors.js'
import { validateAlgorithmWire } from '../../domain/algorithm-schema.js'
import type { OperationRequest, ProviderCapabilities } from '../../ports/operations.js'
import type { ArtifactReaderDescriptor } from '../../domain/trajectory.js'

// Proxy values stay in the trusted worker; the sandbox exposes only its own
// filtered proxy endpoints to Codex. Profiles opt in by variable name.
export const codexCredentialEnvNames: readonly string[] = ['CODEX_API_KEY', 'OPENAI_API_KEY']
export const codexPassEnvNames: readonly string[] = [
  ...codexCredentialEnvNames,
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
]

export interface CodexConfiguration {
  executable: string
  model: string
  allowedDomains: string[]
  timeoutMs: number
  authHome?: string
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  linuxIsolation?: 'seccomp' | 'bubblewrap-only'
}
export interface CodexContext {
  runId: string
  directory: string
  targets: string
  targetAdapter: 'dsh' | 'pi'
  protectedPaths: string[]
  experiencePython?: string
  artifactReader?: ArtifactReaderDescriptor
  tasks: Array<{ id: string; family: string; instruction: string }>
}
export interface CodexInput {
  version: 1
  action: 'describe' | 'prepare_admission' | 'submit' | 'inspect' | 'cancel'
  configuration: CodexConfiguration
  context: CodexContext
  request: OperationRequest | null
  implementationIdentity: string | null
}
export interface CodexJob {
  version: 1
  input: CodexInput & { request: OperationRequest }
  digest: string
  identity: string
}
export const capabilities: ProviderCapabilities = {
  seeds: false,
  temperature: false,
  subsets: true,
  idempotentSubmission: true,
  inspect: true,
  cancel: true,
  physicalAttemptAccounting: true,
  evidenceProjection: false,
  hardDollarBudget: false,
  generationBudget: false,
}
export function configuration(input: unknown): CodexConfiguration {
  const value = input as CodexConfiguration
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          'executable',
          'model',
          'allowedDomains',
          'timeoutMs',
          'authHome',
          'reasoningEffort',
          'linuxIsolation',
        ].includes(key),
    ) ||
    typeof value.executable !== 'string' ||
    !isAbsolute(value.executable) ||
    typeof value.model !== 'string' ||
    !value.model.trim() ||
    !Array.isArray(value.allowedDomains) ||
    value.allowedDomains.some(
      (domain) =>
        typeof domain !== 'string' || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/u.test(domain),
    ) ||
    !Number.isSafeInteger(value.timeoutMs) ||
    value.timeoutMs < 100 ||
    value.timeoutMs > 86_400_000 ||
    (value.authHome !== undefined && (typeof value.authHome !== 'string' || !isAbsolute(value.authHome))) ||
    (value.linuxIsolation !== undefined && !['seccomp', 'bubblewrap-only'].includes(value.linuxIsolation)) ||
    (value.reasoningEffort !== undefined &&
      !['minimal', 'low', 'medium', 'high', 'xhigh'].includes(value.reasoningEffort))
  )
    throw new GearError(
      'invalid-codex-profile',
      'Codex requires an absolute executable, model, exact allowedDomains and a bounded timeoutMs',
    )
  return value
}
export function validateInput(input: unknown): CodexInput {
  const value = input as CodexInput
  if (
    !value ||
    value.version !== 1 ||
    !['describe', 'prepare_admission', 'submit', 'inspect', 'cancel'].includes(value.action)
  )
    throw new GearError('codex-protocol-invalid', 'Expected operation provider protocol version 1')
  configuration(value.configuration)
  const context = value.context
  if (
    !context ||
    !['dsh', 'pi'].includes(context.targetAdapter) ||
    ![context.directory, context.targets].every((path) => typeof path === 'string' && isAbsolute(path)) ||
    (context.experiencePython !== undefined &&
      (typeof context.experiencePython !== 'string' || !isAbsolute(context.experiencePython))) ||
    typeof context.runId !== 'string' ||
    !context.runId ||
    !Array.isArray(context.protectedPaths) ||
    context.protectedPaths.some((path) => typeof path !== 'string' || !isAbsolute(path)) ||
    !Array.isArray(context.tasks) ||
    context.tasks.some(
      (task) =>
        !task ||
        typeof task.id !== 'string' ||
        typeof task.instruction !== 'string' ||
        typeof task.family !== 'string',
    ) ||
    new Set(context.tasks.map((task) => task.id)).size !== context.tasks.length
  )
    throw new GearError(
      'codex-context-invalid',
      'Codex requires isolated operation storage and an authorized seed task projection',
    )
  if (value.action === 'describe') return value
  if (
    typeof value.implementationIdentity !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.implementationIdentity)
  )
    throw new GearError('codex-identity-required', 'Operations must bind the provider handshake identity')
  if (value.action === 'prepare_admission') return value
  const request = value.request
  if (value.action === 'submit' && request?.generationLimits !== undefined)
    throw new GearError(
      'generation-budget-unsupported',
      'Codex CLI cannot enforce aggregate token/request limits',
    )
  if (
    !request ||
    !/^sha256:[a-f0-9]{64}$/u.test(request.operationId) ||
    request.runId !== context.runId ||
    !Number.isSafeInteger(request.generation) ||
    request.generation < 0 ||
    request.partition !== 'seed' ||
    !Array.isArray(request.evidence)
  )
    throw new GearError('codex-request-invalid', 'Meta accepts only bound seed operations')
  validateAlgorithmWire('Operation', request.operation)
  const operation = request.operation
  if (
    !['diagnose_seed', 'generate_candidate'].includes(operation.kind) ||
    operation.scope === 'held_out' ||
    operation.task_ids.some((id) => !context.tasks.some((task) => task.id === id)) ||
    !operation.candidate_id ||
    !/^[a-zA-Z0-9_-]+$/u.test(operation.candidate_id) ||
    (operation.kind === 'generate_candidate' &&
      (!operation.parent_id || !/^[a-zA-Z0-9_-]+$/u.test(operation.parent_id)))
  )
    throw new GearError(
      'codex-operation-invalid',
      'Meta supports seed diagnosis and candidate generation only',
    )
  for (const cell of request.evidence) {
    validateAlgorithmWire('Evidence', cell)
    if (cell.scope === 'held_out' || !context.tasks.some((task) => task.id === cell.task_id))
      throw new GearError(
        'codex-evidence-invalid',
        'Meta evidence must belong to the authorized seed projection',
      )
  }
  return value
}
