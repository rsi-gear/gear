#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  assertSkillHarnessIdentityMatches,
  parseSkillHarnessIdentity,
  requestRefineSkill as packageRequestRefineSkill,
} from 'rsi-gear/skill'
export const TRANSPORT_VERSION = 1
export const MCP_PROTOCOL_VERSION = '2025-06-18'
const CLIENT_FILE_NAME = 'client.json'
const SESSION_FILE_NAME = 'session.json'
const AUDIT_FILE_NAME = 'transport-audit.jsonl'
const SKILL_DIRECTORY = fileURLToPath(new URL('../', import.meta.url))
const MAX_RESOURCE_BYTES = 1024 * 1024
const TERMINAL_ROUND_STATUSES = new Set(['accepted', 'rejected', 'rejected-for-substrate', 'failed'])
const SENSITIVE_KEY = /(?:token|auth|credential|secret|password)/iu
const SUPPORTED_MCP_VERSIONS = new Set(['2024-11-05', '2025-03-26', MCP_PROTOCOL_VERSION])
function object(value, label = 'value') {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
  return value
}
function requiredString(value, key, label = 'value') {
  if (typeof value[key] !== 'string' || value[key].length === 0) throw new TypeError(`${label}.${key} is required`)
  return value[key]
}
function message(error) { return error instanceof Error ? error.message : String(error) }
function missing(error) { return typeof error === 'object' && error !== null && error.code === 'ENOENT' }
function rawMetric(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && /^sha256:[a-f0-9]{64}$/u.test(value.contractDigest ?? '') && typeof value.unit === 'string'
    && ['available', 'missing', 'invalid', 'unsupported'].includes(value.status)
    && (value.status !== 'available' || Number.isFinite(value.value))
    && Array.isArray(value.evidenceRefs) && value.evidenceRefs.every(ref => /^sha256:[a-f0-9]{64}$/u.test(ref))
    && Object.keys(value).every(key => ['contractDigest', 'unit', 'status', 'value', 'reason', 'evidenceRefs', 'observationTotal', 'observationTotalExact'].includes(key))
}
function safe(value, secrets = [], context) {
  if (typeof value === 'string') {
    return secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), value)
  }
  if (Array.isArray(value)) return value.map(item => safe(item, secrets))
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) =>
    SENSITIVE_KEY.test(key) && !(context === 'rawMetrics' && rawMetric(item)) ? [] : [[key, safe(item, secrets, key)]],
  ))
}
export function refineTransportPaths(runDirectory) {
  const directory = resolve(runDirectory)
  return { runDirectory: directory, clientPath: join(directory, CLIENT_FILE_NAME),
    sessionPath: join(directory, SESSION_FILE_NAME), auditPath: join(directory, AUDIT_FILE_NAME) }
}
async function privateDirectory(runDirectory) {
  const directory = resolve(runDirectory)
  let created = false
  try {
    await lstat(directory)
  } catch (error) {
    if (!missing(error)) throw error
    await mkdir(directory, { recursive: true, mode: 0o700 })
    created = true
  }
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('refine run directory must be a real directory')
  if (!created && (info.mode & 0o077) !== 0) throw new Error('refine run directory permissions must be 0700')
  await chmod(directory, 0o700)
  return directory
}
async function readPrivateJson(path, optional = false) {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (optional && missing(error)) return undefined
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`private state is not a regular file: ${path}`)
  if ((info.mode & 0o077) !== 0) throw new Error(`private state permissions are broader than 0600: ${path}`)
  return JSON.parse(await readFile(path, 'utf8'))
}
async function createPrivateJson(path, value) {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(path, 0o600)
}
async function writePrivateJson(path, value) {
  const temporary = join(resolve(path, '..'), `.${randomUUID()}.tmp`)
  try {
    await createPrivateJson(temporary, value)
    await rename(temporary, path)
    await chmod(path, 0o600)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}
async function appendAudit(runDirectory, entry) {
  const { auditPath } = refineTransportPaths(runDirectory)
  try {
    const info = await lstat(auditPath)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('transport audit must be a regular file')
  } catch (error) { if (!missing(error)) throw error }
  const handle = await open(auditPath, 'a', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(entry)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(auditPath, 0o600)
}
async function loadClient(runDirectory, identity) {
  const { clientPath } = refineTransportPaths(runDirectory)
  const existing = await readPrivateJson(clientPath, true)
  if (existing !== undefined) {
    const value = object(existing, 'client state')
    if (value.version !== TRANSPORT_VERSION) {
      throw new Error('configured identity does not match the private run directory')
    }
    assertSkillHarnessIdentityMatches(
      identity,
      value.identity,
      'configured identity does not match the private run directory',
    )
    return { version: TRANSPORT_VERSION, clientId: requiredString(value, 'clientId', 'client state'), identity }
  }
  const client = { version: TRANSPORT_VERSION, clientId: `codex:${randomUUID()}`, identity }
  try {
    await createPrivateJson(clientPath, client)
    return client
  } catch (error) {
    if (typeof error !== 'object' || error === null || error.code !== 'EEXIST') throw error
    return loadClient(runDirectory, identity)
  }
}
function sessionFromClaim(claim, clientId, claimedAt) {
  const generationBudget = typeof claim.generationBudget === 'object' && claim.generationBudget !== null
    ? claim.generationBudget : undefined
  const attempt = Number.isSafeInteger(generationBudget?.attempt) ? generationBudget.attempt : undefined
  const roundId = requiredString(claim, 'roundId', 'assignment')
  const candidateId = requiredString(claim, 'candidateId', 'assignment')
  const sessionId = requiredString(claim, 'sessionId', 'assignment')
  return {
    version: TRANSPORT_VERSION,
    sessionKey: `${roundId}:${candidateId}:${sessionId}`,
    clientId,
    evolutionId: requiredString(claim, 'evolutionId', 'assignment'),
    roundId,
    candidateId,
    sessionId,
    ...(attempt === undefined ? {} : { attempt }),
    leaseId: requiredString(claim, 'leaseId', 'assignment'),
    leaseToken: requiredString(claim, 'leaseToken', 'assignment'),
    claimedAt: claimedAt ?? new Date().toISOString(),
  }
}
function validateSession(input) {
  const session = object(input, 'session state')
  if (session.version !== TRANSPORT_VERSION) throw new Error('unsupported refine session version')
  for (const key of ['sessionKey', 'clientId', 'evolutionId', 'roundId', 'candidateId', 'sessionId', 'leaseId', 'leaseToken']) {
    requiredString(session, key, 'session state')
  }
  if (session.attempt !== undefined && !Number.isSafeInteger(session.attempt)) throw new Error('refine session attempt is invalid')
  if (session.sessionKey !== `${session.roundId}:${session.candidateId}:${session.sessionId}`) {
    throw new Error('refine session association mismatch')
  }
  return structuredClone(session)
}
export async function readRefineTransportSession(runDirectory, options = {}) {
  await privateDirectory(runDirectory)
  const stored = await readPrivateJson(refineTransportPaths(runDirectory).sessionPath, options.optional === true)
  return stored === undefined ? undefined : validateSession(stored)
}
function assignment(session) {
  return { evolutionId: session.evolutionId, roundId: session.roundId, candidateId: session.candidateId,
    sessionId: session.sessionId, ...(session.attempt === undefined ? {} : { attempt: session.attempt }) }
}
function audit(session, method, capability, result) {
  return {
    version: TRANSPORT_VERSION,
    assignment: assignment(session),
    method,
    ...(capability === undefined ? {} : { capability }),
    ...(typeof result?.accepted === 'boolean' ? { accepted: result.accepted } : {}),
    ...(typeof result?.recoverable === 'boolean' ? { recoverable: result.recoverable } : {}),
    ...(typeof result?.code === 'string' ? { code: result.code } : {}),
  }
}
function envelope(session) {
  return { clientId: session.clientId, leaseId: session.leaseId, leaseToken: session.leaseToken }
}
function terminalRound(status) {
  return typeof status === 'object' && status !== null && TERMINAL_ROUND_STATUSES.has(status.status)
}
function settledAttempt(status, session) {
  if (terminalRound(status)) return true
  if (typeof status !== 'object' || status === null || !Array.isArray(status.candidateGeneration)) return false
  const candidate = status.candidateGeneration.find(item => typeof item === 'object' && item !== null
    && item.candidateId === session.candidateId)
  if (candidate === undefined || !Array.isArray(candidate.attempts)) return false
  const attempt = candidate.attempts.find(item => typeof item === 'object' && item !== null
    && item.metaSessionId === session.sessionId)
  return attempt !== undefined && attempt.status !== 'running'
}
async function status(request, socketPath, session) {
  return request(socketPath, { method: 'control.status',
    params: { evolutionId: session.evolutionId, roundId: session.roundId } })
}
async function removeSession(runDirectory, sessionKey) {
  const current = await readRefineTransportSession(runDirectory, { optional: true })
  if (current === undefined) return
  if (current.sessionKey !== sessionKey) throw new Error('refine session changed before cleanup')
  await rm(refineTransportPaths(runDirectory).sessionPath)
}
/** Called by the supervising runner after the external Codex process exits. */
export async function failRefineTransportSession(options) {
  const values = object(options, 'failure options')
  const runDirectory = requiredString(values, 'runDirectory', 'failure options')
  const socketPath = requiredString(values, 'socketPath', 'failure options')
  const reason = requiredString(values, 'reason', 'failure options')
  const request = values.request ?? packageRequestRefineSkill
  if (typeof request !== 'function') throw new TypeError('failure options.request must be a function')
  const session = await readRefineTransportSession(runDirectory, { optional: true })
  if (session === undefined) return { submitted: false, missing: true }
  if (values.expectedSessionKey !== undefined && values.expectedSessionKey !== session.sessionKey) {
    throw new Error('refine session does not match the expected attempt/session key')
  }
  let observed = await status(request, socketPath, session)
  if (settledAttempt(observed, session)) {
    await removeSession(runDirectory, session.sessionKey)
    return { submitted: true, late: true, status: safe(observed, [session.leaseToken]), assignment: assignment(session) }
  }
  let result
  try {
    result = await request(socketPath, { method: 'meta.fail', params: { ...envelope(session), reason } })
  } catch (error) {
    observed = await status(request, socketPath, session)
    if (!settledAttempt(observed, session)) throw new Error(safe(message(error), [session.leaseToken]))
    await removeSession(runDirectory, session.sessionKey)
    return { submitted: true, late: true, status: safe(observed, [session.leaseToken]), assignment: assignment(session) }
  }
  await appendAudit(runDirectory, audit(session, 'meta.fail', undefined, result))
  await removeSession(runDirectory, session.sessionKey)
  return { submitted: true, late: false, result: safe(result, [session.leaseToken]), assignment: assignment(session) }
}
async function readResource(pathInput) {
  const root = await realpath(SKILL_DIRECTORY)
  const logicalPath = pathInput ?? 'SKILL.md'
  if (typeof logicalPath !== 'string' || logicalPath.length === 0 || isAbsolute(logicalPath)) {
    throw new TypeError('resource path must be a non-empty relative path')
  }
  const path = resolve(root, logicalPath)
  const logical = relative(root, path)
  if (logical === '' || logical === '..' || logical.startsWith('../') || isAbsolute(logical)) {
    throw new Error('resource path escapes the packaged refine skill')
  }
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('refine resource must be a regular file')
  if (info.size > MAX_RESOURCE_BYTES) throw new Error('refine resource exceeds the transport limit')
  const canonical = await realpath(path)
  if (relative(root, canonical).startsWith('..')) throw new Error('resource path escapes the packaged refine skill')
  return { version: TRANSPORT_VERSION, path: logical.split('\\').join('/'), text: await readFile(canonical, 'utf8') }
}
function toolResult(value) {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    ...(typeof value === 'object' && value !== null && !Array.isArray(value) ? { structuredContent: value } : {}),
  }
}
export async function createRefineCodexTransport(options) {
  const values = object(options, 'transport options')
  const socketPath = requiredString(values, 'socketPath', 'transport options')
  const runDirectory = await privateDirectory(requiredString(values, 'runDirectory', 'transport options'))
  const identity = parseSkillHarnessIdentity(values.identity)
  const request = values.request ?? packageRequestRefineSkill
  if (typeof request !== 'function') throw new TypeError('transport options.request must be a function')
  const client = await loadClient(runDirectory, identity)
  let initialized = false
  let tail = Promise.resolve()
  const serialize = operation => {
    const result = tail.then(operation, operation)
    tail = result.catch(() => {})
    return result
  }
  const currentSession = () => readRefineTransportSession(runDirectory, { optional: true })
  const refineRequest = (method, paramsInput = {}) => serialize(async () => {
    if (typeof method !== 'string' || method.length === 0) throw new TypeError('method is required')
    if (method === 'meta.fail') throw new Error('meta.fail is reserved for the supervising runner')
    const params = { ...object(paramsInput, 'params') }
    for (const key of Object.keys(params)) {
      if (key === 'clientId' || key === 'identity' || key === 'leaseId' || SENSITIVE_KEY.test(key)) delete params[key]
    }
    if (method === 'meta.claim') {
      const previous = await currentSession()
      if (previous !== undefined) {
        params.evolutionId = previous.evolutionId
        params.roundId = previous.roundId
      }
      const claim = object(await request(socketPath, {
        method, params: { ...params, clientId: client.clientId, identity: structuredClone(identity) },
      }), 'meta.claim result')
      if (typeof claim.leaseToken !== 'string' || claim.leaseToken.length === 0) return safe(claim)
      const session = sessionFromClaim(claim, client.clientId, previous?.claimedAt)
      if (previous !== undefined && previous.sessionKey !== session.sessionKey) {
        const oldStatus = await status(request, socketPath, previous)
        if (!settledAttempt(oldStatus, previous)) throw new Error('private run directory already owns another active assignment')
        await removeSession(runDirectory, previous.sessionKey)
      }
      await writePrivateJson(refineTransportPaths(runDirectory).sessionPath, session)
      if (previous?.sessionKey !== session.sessionKey) {
        await appendAudit(runDirectory, audit(session, 'meta.claim', undefined, claim))
      }
      const publicClaim = safe(claim, [session.leaseToken])
      publicClaim.transport = { version: TRANSPORT_VERSION, sessionKey: session.sessionKey }
      return publicClaim
    }
    const needsLease = method === 'meta.call' || method.startsWith('candidate.')
    const session = needsLease ? await currentSession() : undefined
    if (needsLease && session === undefined) throw new Error('claim a Meta assignment before using candidate or meta.call methods')
    const result = await request(socketPath, {
      method, params: session === undefined ? params : { ...params, ...envelope(session) },
    })
    if (session !== undefined) {
      const capability = method === 'meta.call' && typeof params.capability === 'string' ? params.capability : undefined
      await appendAudit(runDirectory, audit(session, method, capability, result))
    }
    if (method === 'control.identity') return parseSkillHarnessIdentity(result)
    return safe(result, session === undefined ? [] : [session.leaseToken])
  })
  const tools = [
    {
      name: 'read_refine_resource',
      description: 'Read a UTF-8 resource from the versioned packaged refine skill.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false },
    },
    {
      name: 'refine_request',
      description: 'Call Gear Refine with automatically bound identity and private lease fields.',
      inputSchema: { type: 'object',
        properties: { method: { type: 'string' }, params: { type: 'object', additionalProperties: true } },
        required: ['method'], additionalProperties: false },
    },
  ]
  const invokeTool = async (name, argsInput = {}) => {
    const args = object(argsInput, `${name} arguments`)
    if (name === 'read_refine_resource') return readResource(args.path)
    if (name === 'refine_request') return refineRequest(
      requiredString(args, 'method', 'refine_request arguments'), args.params ?? {})
    throw new Error(`unknown tool: ${name}`)
  }
  const handleJsonRpc = async input => {
    let requestMessage
    try {
      requestMessage = object(input, 'JSON-RPC message')
    } catch (error) {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: message(error) } }
    }
    const hasId = Object.hasOwn(requestMessage, 'id')
    const id = hasId ? requestMessage.id : null
    const result = value => hasId ? { jsonrpc: '2.0', id, result: value } : null
    const error = (code, text) => hasId ? { jsonrpc: '2.0', id, error: { code, message: text } } : null
    if (requestMessage.jsonrpc !== '2.0' || typeof requestMessage.method !== 'string') {
      return error(-32600, 'invalid JSON-RPC request')
    }
    try {
      if (requestMessage.method === 'initialize') {
        const params = object(requestMessage.params ?? {}, 'initialize params')
        initialized = true
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined
        return result({
          protocolVersion: requested !== undefined && SUPPORTED_MCP_VERSIONS.has(requested) ? requested : MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'gear-refine-codex-transport', version: `${TRANSPORT_VERSION}.0.0` },
        })
      }
      if (requestMessage.method === 'notifications/initialized') {
        initialized = true
        return null
      }
      if (requestMessage.method === 'ping') return result({})
      if (!initialized) return error(-32002, 'MCP transport is not initialized')
      if (requestMessage.method === 'tools/list') return result({ tools })
      if (requestMessage.method !== 'tools/call') return error(-32601, `method not found: ${requestMessage.method}`)
      const params = object(requestMessage.params ?? {}, 'tools/call params')
      const name = requiredString(params, 'name', 'tools/call params')
      if (!tools.some(tool => tool.name === name)) return error(-32602, `unknown tool: ${name}`)
      try { return result(toolResult(await invokeTool(name, params.arguments ?? {}))) } catch (toolFailure) {
        const session = await currentSession().catch(() => undefined)
        return result({
          content: [{ type: 'text', text: safe(message(toolFailure), session === undefined ? [] : [session.leaseToken]) }],
          isError: true,
        })
      }
    } catch (requestFailure) {
      return error(-32602, message(requestFailure))
    }
  }
  const serveStdio = async (input = process.stdin, output = process.stdout) => {
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      if (line.trim().length === 0) continue
      let response
      try {
        response = await handleJsonRpc(JSON.parse(line))
      } catch (parseFailure) {
        response = { jsonrpc: '2.0', id: null, error: { code: -32700, message: message(parseFailure) } }
      }
      if (response !== null) output.write(`${JSON.stringify(response)}\n`)
    }
  }
  return {
    version: TRANSPORT_VERSION,
    clientId: client.clientId,
    tools: structuredClone(tools),
    refineRequest,
    invokeTool,
    handleJsonRpc,
    serveStdio,
  }
}
function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!['--socket', '--run-dir', '--identity-file'].includes(key) || value === undefined) {
      throw new Error('usage: transport.mjs --socket PATH --run-dir PATH --identity-file PATH')
    }
    options[key.slice(2)] = value
  }
  for (const key of ['socket', 'run-dir', 'identity-file']) requiredString(options, key, 'arguments')
  return options
}
export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv)
  const transport = await createRefineCodexTransport({ socketPath: args.socket, runDirectory: args['run-dir'],
    identity: JSON.parse(await readFile(args['identity-file'], 'utf8')) })
  await transport.serveStdio()
}
const executedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href
if (executedPath === import.meta.url) {
  main().catch(error => {
    process.stderr.write(`${message(error)}\n`)
    process.exitCode = 1
  })
}
