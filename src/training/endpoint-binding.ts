import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { digestJson } from './digest.js'
import { requireContract } from './schema.js'
import type * as T from './types.js'

type Json = Record<string, unknown>
const object = (value: unknown, required: string[], optional: string[] = []): Json => {
  requireContract(!!value && typeof value === 'object' && !Array.isArray(value), 'invalid-endpoint-binding', 'endpoint binding must be structured')
  const input = value as Json
  requireContract(required.every(key => key in input) && Object.keys(input).every(key => [...required, ...optional].includes(key)),
    'invalid-endpoint-binding', 'endpoint binding has missing or unknown fields')
  return input
}
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f]/.test(value)
const hash = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export function parseEndpointBinding(value: unknown, privateConnection = false): T.EvaluationEndpointBinding | T.ReadyEvaluationEndpointBinding {
  const copy = structuredClone(value)
  const binding = object(copy, ['schema_version', 'kind', 'endpoint_ref', 'endpoint_revision', 'api', 'wire_model', 'capabilities', 'generation', 'deployment_receipt',
    ...(privateConnection ? ['connection'] : [])])
  requireContract(binding.schema_version === '1' && binding.kind === 'external-endpoint' && text(binding.endpoint_ref)
    && /^endpoint\/[a-z0-9][a-z0-9_.-]{0,63}(?:@sha256:[a-f0-9]{64})?$/.test(binding.endpoint_ref) && hash(binding.endpoint_revision)
    && ['responses', 'chat-completions'].includes(String(binding.api)) && text(binding.wire_model), 'invalid-endpoint-binding', 'endpoint identity or protocol is invalid')
  if (String(binding.endpoint_ref).includes('@')) requireContract(String(binding.endpoint_ref).split('@')[1] === binding.endpoint_revision, 'endpoint-revision-drift', 'versioned endpoint reference differs from the binding revision')
  const caps = object(binding.capabilities, ['streaming', 'tool_calls', 'parallel_tool_calls', 'input_modalities'])
  requireContract(['streaming', 'tool_calls', 'parallel_tool_calls'].every(key => typeof caps[key] === 'boolean')
    && digestJson(caps.input_modalities) === digestJson(['text']), 'invalid-endpoint-capabilities', 'evaluation supports explicitly declared text endpoint capabilities')
  requireContract(caps.parallel_tool_calls === false, 'unsupported-parallel-tool-calls', 'parallel function calls are not verified by this release; declare parallel_tool_calls=false')
  const generation = object(binding.generation, ['max_output_tokens'], ['temperature', 'top_p', 'top_k', 'repetition_penalty', 'min_p', 'seed'])
  requireContract(Number.isSafeInteger(generation.max_output_tokens) && Number(generation.max_output_tokens) > 0
    && Object.values(generation).every(finite),
  'invalid-endpoint-generation', 'endpoint generation parameters must be explicit and finite')
  if ('temperature' in generation) requireContract(Number(generation.temperature) >= 0, 'invalid-endpoint-generation', 'temperature must be nonnegative')
  if ('top_p' in generation) requireContract(Number(generation.top_p) > 0 && Number(generation.top_p) <= 1, 'invalid-endpoint-generation', 'top_p must be in (0,1]')
  if ('top_k' in generation) requireContract(Number.isSafeInteger(generation.top_k) && Number(generation.top_k) >= -1, 'invalid-endpoint-generation', 'top_k must be an integer >= -1')
  if ('min_p' in generation) requireContract(Number(generation.min_p) >= 0 && Number(generation.min_p) <= 1, 'invalid-endpoint-generation', 'min_p must be in [0,1]')
  if ('seed' in generation) requireContract(Number.isSafeInteger(generation.seed), 'invalid-endpoint-generation', 'seed must be an integer')
  if ('repetition_penalty' in generation) requireContract(Number(generation.repetition_penalty) > 0, 'invalid-endpoint-generation', 'repetition_penalty must be positive')
  const receipt = object(binding.deployment_receipt, ['schema_version', 'model_digest', 'wire_model', 'deployment_ref', 'source', 'service_config'])
  requireContract(receipt.schema_version === '1' && hash(receipt.model_digest) && receipt.wire_model === binding.wire_model
    && text(receipt.deployment_ref) && text(receipt.source) && !!receipt.service_config && typeof receipt.service_config === 'object'
    && !Array.isArray(receipt.service_config) && Object.keys(receipt.service_config).length > 0,
  'invalid-deployment-receipt', 'strict evaluation requires an immutable model deployment receipt')
  const service = receipt.service_config as Json
  const allowedServiceKeys = new Set(['engine', 'engine_version', 'engine_digest', 'quantization', 'tool_parser', 'reasoning_parser',
    'tokenizer_digest', 'chat_template_digest', 'cache_policy', 'isolation', 'parsing'])
  requireContract(text(service.engine) && Object.keys(service).every(key => allowedServiceKeys.has(key)),
    'invalid-service-config', 'deployment receipt contains unsupported public runtime fields')
  const sensitive = /^(connection|base_url|url|auth|credentials?|secrets?|token|api_key|password|env|model_digest|wire_model|deployment_ref|endpoint_revision)$/i
  const verifyPublic = (entry: unknown): void => {
    if (typeof entry === 'string') requireContract(!/(?:https?|ssh|file):\/\//i.test(entry), 'private-service-config', 'private service URLs cannot enter evaluation evidence')
    else if (Array.isArray(entry)) entry.forEach(verifyPublic)
    else if (entry && typeof entry === 'object') for (const [key, item] of Object.entries(entry)) {
      requireContract(!sensitive.test(key), 'private-service-config', 'private credentials or connection fields cannot enter evaluation evidence')
      verifyPublic(item)
    }
  }
  verifyPublic(service)
  digestJson(receipt.service_config)
  if (privateConnection) {
    const connection = object(binding.connection, ['base_url', 'auth'])
    requireContract(text(connection.base_url), 'invalid-endpoint-url', 'endpoint API root is required')
    const url = new URL(connection.base_url)
    requireContract(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash,
      'invalid-endpoint-url', 'endpoint root must be HTTP(S), without credentials, query or fragment')
    const auth = object(connection.auth, ['kind'], (connection.auth as Json)?.kind === 'env' ? ['name'] : [])
    requireContract(auth.kind === 'none' || auth.kind === 'env' && typeof auth.name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(auth.name),
      'invalid-endpoint-auth', 'endpoint credentials must use an environment reference')
    const normalized = url.toString().replace(/\/+$/, '')
    requireContract(binding.endpoint_revision === digestJson({ schema_version: '1', base_url: normalized, wire_model: binding.wire_model,
      api: binding.api, auth, capabilities: caps }), 'endpoint-revision-drift', 'endpoint connection does not match its frozen revision')
    connection.base_url = normalized
  }
  return copy as T.EvaluationEndpointBinding | T.ReadyEvaluationEndpointBinding
}

export function publicEndpointBinding(binding: T.ReadyEvaluationEndpointBinding): T.EvaluationEndpointBinding {
  const { connection: _, ...publicBinding } = binding
  return parseEndpointBinding(publicBinding) as T.EvaluationEndpointBinding
}

/** Deployment ownership attests the mounted snapshot; Gear checks every frozen comparison input. */
export function validateReadyEndpointBinding(value: unknown, model: T.ModelVersion,
  common: T.ModelTrainingSpec['evaluation']['common'], trustedSources: string[]): T.ReadyEvaluationEndpointBinding {
  const binding = parseEndpointBinding(value, true) as T.ReadyEvaluationEndpointBinding
  const receipt = binding.deployment_receipt
  requireContract(trustedSources.includes(receipt.source), 'untrusted-deployment-receipt', 'deployment receipt source is not trusted by this controller')
  requireContract(receipt.model_digest === model.hfSnapshotRef.digest, 'deployment-model-mismatch', 'deployment receipt identifies another immutable HF snapshot')
  requireContract(digestJson(receipt.service_config) === common.runtimeDigest, 'evaluation-runtime-drift', 'deployment engine, parsing, quantization and cache configuration differ from common conditions')
  requireContract(digestJson(binding.generation) === common.samplingDigest, 'evaluation-sampling-drift', 'endpoint generation differs from frozen evaluation parameters')
  requireContract(digestJson({ api: binding.api }) === common.protocolDigest, 'evaluation-protocol-drift', 'endpoint protocol differs from common conditions')
  return binding
}

export interface ExternalEndpointPreparationConfig {
  /** JSON {schemaVersion:1, bindings:{[immutableHfSnapshotDigest]: absoluteBindingFile}}. */
  bindingsFile: string
  trustedReceiptSources: string[]
}
export class ExternalFileEndpointPreparer implements T.ModelEndpointPreparer {
  readonly configurationDigest: string
  readonly trustedReceiptSources: string[]
  constructor(readonly config: ExternalEndpointPreparationConfig) {
    requireContract(!!config && typeof config === 'object' && typeof config.bindingsFile === 'string' && isAbsolute(config.bindingsFile) && Array.isArray(config.trustedReceiptSources) && config.trustedReceiptSources.length > 0
      && config.trustedReceiptSources.every(text) && new Set(config.trustedReceiptSources).size === config.trustedReceiptSources.length,
    'invalid-endpoint-preparation', 'external endpoint preparation requires an absolute bindings map and trusted deployment receipt sources')
    this.configurationDigest = digestJson(config)
    this.trustedReceiptSources = [...config.trustedReceiptSources]
  }
  async prepare(model: T.ModelVersion): Promise<T.ReadyEvaluationEndpointBinding | undefined> {
    let value: unknown
    try { value = JSON.parse(await readFile(this.config.bindingsFile, 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    const map = object(value, ['schemaVersion', 'bindings'])
    requireContract(map.schemaVersion === 1 && !!map.bindings && typeof map.bindings === 'object' && !Array.isArray(map.bindings),
      'invalid-endpoint-preparation', 'endpoint binding map must use schemaVersion 1')
    const bindings = map.bindings as Json
    requireContract(Object.entries(bindings).every(([digest, path]) => hash(digest) && typeof path === 'string' && isAbsolute(path)),
      'invalid-endpoint-preparation', 'endpoint bindings must be indexed by immutable HF snapshot digests')
    const file = bindings[model.hfSnapshotRef.digest]
    if (!file) return undefined
    try { return parseEndpointBinding(JSON.parse(await readFile(file as string, 'utf8')), true) as T.ReadyEvaluationEndpointBinding }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
}
