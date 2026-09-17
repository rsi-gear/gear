#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, link, lstat, mkdir, open, readFile, readdir, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import {
  assertSkillHarnessIdentityMatches,
  parseSkillHarnessIdentity,
  requestRefineSkill,
} from 'rsi-gear/skill'
import {
  createRefineCodexTransport,
  failRefineTransportSession,
  readRefineTransportSession,
} from '../skills/refine/scripts/transport.mjs'

const execute = promisify(execFile)
const transportScript = fileURLToPath(new URL('../skills/refine/scripts/transport.mjs', import.meta.url))
const terminalStatuses = new Set(['accepted', 'rejected', 'rejected-for-substrate', 'failed'])
const pollIntervalMs = 2_000
const terminationGraceMs = 5_000
const resourcePreflightTimeoutMs = 120_000
const resourcePreflightMaxOutputBytes = 1024 * 1024
const prompt = `Use the installed refine skill to complete the current assigned candidate.
Read SKILL.md and all three required references with read_refine_resource, then call refine_request meta.claim.
The transport binds identity and private lease fields. Inspect the seed evidence and candidate, make and check one evidence-backed general harness improvement when justified, then finalize or decline.
If a finalization response is recoverable, complete every requested action and retry it. Stop after accepted finalization or decline. Do not start, continue, publish, roll back, or repair an evolution.`
const resourcePreflightPrompt = `Call the gear_refine MCP tool read_refine_resource exactly once with {"path":"SKILL.md"}, then stop.
Do not call any other tool and do not report readiness without making this tool call.`

function required(environment, name) {
  const value = environment[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required`)
  return value
}

function absolute(environment, name) {
  const value = required(environment, name)
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`)
  return resolve(value)
}

function object(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('run path must be a real directory')
  await chmod(path, 0o700)
  return path
}

async function writePrivateJson(path, value) {
  const temporary = join(resolve(path, '..'), `.${randomUUID()}.tmp`)
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(value)}\n`)
    await handle.sync()
    await handle.close()
    handle = undefined
    await chmod(temporary, 0o600)
    await link(temporary, path)
  } finally {
    if (handle !== undefined) await handle.close().catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
  }
}

async function readOptionalJson(path) {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      throw new Error('private runner state must be a 0600 regular file')
    }
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

function configuration(environment) {
  return {
    socketPath: absolute(environment, 'GEAR_REFINE_SOCKET'),
    identityFile: absolute(environment, 'GEAR_REFINE_IDENTITY_FILE'),
    codexHome: absolute(environment, 'GEAR_META_CODEX_HOME'),
    runRoot: absolute(environment, 'GEAR_META_RUN_ROOT'),
    workspace: absolute(environment, 'GEAR_META_WORKSPACE'),
    codex: environment.GEAR_CODEX_EXECUTABLE ?? 'codex',
  }
}

async function readIdentity(path) {
  const identity = parseSkillHarnessIdentity(JSON.parse(await readFile(path, 'utf8')))
  if (identity.model.provider !== 'openai-codex') {
    throw new Error('the example runner requires an openai-codex Meta identity')
  }
  return identity
}

function restrictedEnvironment(environment, codexHome) {
  const allowed = ['PATH', 'HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR']
  return Object.fromEntries([
    ...allowed.flatMap(name => environment[name] === undefined ? [] : [[name, environment[name]]]),
    ['CODEX_HOME', codexHome],
  ])
}

async function terminateChild(child, completed) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  const forced = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, terminationGraceMs)
  try {
    await Promise.allSettled([completed])
  } finally {
    clearTimeout(forced)
  }
}

async function runTransportPreflight(config, identity, environment, evolutionId) {
  const runDirectory = await privateDirectory(join(config.runRoot, `preflight-${randomUUID()}`))
  let child
  let completed
  let stop
  try {
    child = spawn(process.execPath, [
      transportScript,
      '--socket', config.socketPath,
      '--run-dir', runDirectory,
      '--identity-file', config.identityFile,
    ], {
      env: restrictedEnvironment(environment, config.codexHome),
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    let output = ''
    completed = new Promise((resolveResult, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolveResult({ code, signal }))
    })
    let termination
    stop = () => (termination ??= terminateChild(child, completed))
    let overflow = false
    child.stdin.on('error', () => {})
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      output += chunk
      if (output.length > 64 * 1024) {
        overflow = true
        void stop()
      }
    })
    child.stdin.end([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gear-runner-preflight', version: '1' },
      } }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
        name: 'refine_request', arguments: { method: 'control.identity', params: {
          ...(evolutionId === undefined ? {} : { evolutionId }),
        } },
      } }),
      '',
    ].join('\n'))
    let timeout
    let result
    try {
      result = await Promise.race([
        completed,
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            void stop().then(() => reject(new Error('transport preflight timed out')))
          }, 15_000)
        }),
      ])
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
    if (overflow || result.code !== 0 || result.signal !== null) throw new Error('transport exited unsuccessfully')
    const responses = output.trim().split('\n').map(line => JSON.parse(line))
    const initialized = responses.find(response => response?.id === 1)
    const checked = responses.find(response => response?.id === 2)
    if (initialized === undefined || checked === undefined
      || initialized.error !== undefined || initialized.result?.serverInfo?.name !== 'gear-refine-codex-transport'
      || checked.error !== undefined || checked.result === undefined) {
      throw new Error('transport did not complete its identity request')
    }
    if (checked.result.isError === true) {
      const detail = Array.isArray(checked.result.content)
        ? checked.result.content.find(item => item?.type === 'text' && typeof item.text === 'string')?.text
        : undefined
      throw new Error(detail ?? 'Gear rejected the identity request')
    }
    assertSkillHarnessIdentityMatches(
      identity,
      checked.result.structuredContent,
      'configured Meta identity does not match Gear identity',
    )
    return identity
  } catch (error) {
    if (child !== undefined && completed !== undefined) {
      await (stop?.() ?? terminateChild(child, completed))
    }
    throw new Error(`Gear Refine transport preflight failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await rm(runDirectory, { recursive: true, force: true })
  }
}

function assertResourcePreflightEvidence(output) {
  let events
  try {
    events = output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch {
    throw new Error('Codex MCP resource preflight returned invalid JSONL events')
  }
  const completed = events.find(event => event?.type === 'item.completed'
    && event.item?.type === 'mcp_tool_call'
    && event.item.server === 'gear_refine'
    && event.item.tool === 'read_refine_resource'
    && event.item.arguments?.path === 'SKILL.md')
  if (completed === undefined) throw new Error('Codex did not call read_refine_resource during MCP preflight')
  if (completed.item.status !== 'completed') {
    const detail = typeof completed.item.error?.message === 'string' ? `: ${completed.item.error.message}` : ''
    throw new Error(`Codex read_refine_resource MCP preflight did not complete${detail}`)
  }
  const resource = object(completed.item.result?.structured_content, 'Codex read_refine_resource result')
  if (resource.version !== 1 || resource.path !== 'SKILL.md'
    || typeof resource.text !== 'string' || resource.text.length === 0) {
    throw new Error('Codex read_refine_resource MCP preflight returned invalid resource evidence')
  }
}

async function runCodexResourcePreflight(config, identity, environment) {
  const runDirectory = await privateDirectory(join(config.runRoot, `codex-preflight-${randomUUID()}`))
  try {
    const execution = execute(config.codex, codexArguments(config, identity, runDirectory, true), {
      cwd: config.workspace,
      env: restrictedEnvironment(environment, config.codexHome),
      timeout: resourcePreflightTimeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: resourcePreflightMaxOutputBytes,
      encoding: 'utf8',
    })
    execution.child.stdin.end()
    const result = await execution
    assertResourcePreflightEvidence(result.stdout)
  } catch (error) {
    const detail = error instanceof Error && error.message.startsWith('Codex ') ? `: ${error.message}` : ''
    throw new Error(`Codex MCP resource preflight failed${detail}`)
  } finally {
    await rm(runDirectory, { recursive: true, force: true })
  }
}

export async function preflightCodexSkillMeta(environment = process.env, evolutionId) {
  const config = configuration(environment)
  const identity = await readIdentity(config.identityFile)
  await privateDirectory(config.runRoot)
  await privateDirectory(config.codexHome)
  const workspace = await lstat(config.workspace)
  if (!workspace.isDirectory()) throw new Error('GEAR_META_WORKSPACE must be a directory')
  try {
    const options = {
      env: restrictedEnvironment(environment, config.codexHome), timeout: 15_000, maxBuffer: 64 * 1024,
    }
    await execute(config.codex, ['--version'], options)
    await execute(config.codex, ['login', 'status'], options)
  } catch {
    throw new Error('Codex login preflight failed')
  }
  await runTransportPreflight(config, identity, environment, evolutionId)
  await runCodexResourcePreflight(config, identity, environment)
  return { config, identity }
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function roundKey(evolutionId, roundId) {
  return createHash('sha256').update(`${evolutionId}\0${roundId}`).digest('hex').slice(0, 32)
}

async function recoverPrivateSessions(config, jobRoot, roundId) {
  let recovered = false
  for (const entry of await readdir(jobRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('run-')) continue
    const runDirectory = join(jobRoot, entry.name)
    const session = await readRefineTransportSession(runDirectory, { optional: true })
    if (session === undefined) continue
    if (session.roundId !== roundId) throw new Error('private session belongs to another Meta round')
    const runner = await readOptionalJson(join(runDirectory, 'runner.json'))
    if (processAlive(runner?.pid)) {
      throw new Error('another runner already owns this Meta round')
    }
    const child = await readOptionalJson(join(runDirectory, 'child.json'))
    if (processAlive(child?.pid)) {
      throw new Error('an earlier Codex process still owns the active Meta assignment')
    }
    await failRefineTransportSession({
      runDirectory,
      socketPath: config.socketPath,
      reason: 'codex-runner-recovered-after-process-exit',
    })
    await rm(join(runDirectory, 'child.json'), { force: true })
    await rm(join(runDirectory, 'runner.json'), { force: true })
    recovered = true
  }
  return recovered
}

function codexArguments(config, identity, runDirectory, resourcePreflight = false) {
  const transportArgs = [
    transportScript,
    '--socket', config.socketPath,
    '--run-dir', runDirectory,
    '--identity-file', config.identityFile,
  ]
  const effort = identity.sampling?.reasoningEffort
  const enabledTools = resourcePreflight
    ? ['read_refine_resource']
    : ['read_refine_resource', 'refine_request']
  return [
    'exec', ...(resourcePreflight ? ['--ephemeral'] : []),
    '--ignore-user-config', '--strict-config', '--skip-git-repo-check', '--json',
    '-m', identity.model.model,
    ...(typeof effort === 'string' && effort.length > 0
      ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
    '-c', `approval_policy=${JSON.stringify('never')}`,
    '-c', `mcp_servers.gear_refine.command=${JSON.stringify(process.execPath)}`,
    '-c', `mcp_servers.gear_refine.args=${JSON.stringify(transportArgs)}`,
    '-c', 'mcp_servers.gear_refine.required=true',
    '-c', `mcp_servers.gear_refine.enabled_tools=${JSON.stringify(enabledTools)}`,
    '-c', `mcp_servers.gear_refine.tools.read_refine_resource.approval_mode=${JSON.stringify('approve')}`,
    '-c', `mcp_servers.gear_refine.tools.refine_request.approval_mode=${JSON.stringify('approve')}`,
    '-C', config.workspace,
    resourcePreflight ? resourcePreflightPrompt : prompt,
  ]
}

async function runCodex(config, identity, runDirectory, deadlineAt, environment) {
  const stdout = await open(join(runDirectory, 'events.jsonl'), 'wx', 0o600)
  const stderr = await open(join(runDirectory, 'stderr.log'), 'wx', 0o600)
  let child
  try {
    child = spawn(config.codex, codexArguments(config, identity, runDirectory), {
      cwd: config.workspace,
      env: restrictedEnvironment(environment, config.codexHome),
      stdio: ['ignore', stdout.fd, stderr.fd],
    })
    const completed = new Promise((resolveResult, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolveResult({ code, signal }))
    })
    if (!Number.isSafeInteger(child.pid)) return await completed
    try {
      await writePrivateJson(join(runDirectory, 'child.json'), {
        pid: child.pid, startedAt: new Date().toISOString(),
      })
    } catch (error) {
      await terminateChild(child, completed)
      throw error
    }
    let forced
    const terminate = signal => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill(signal)
      forced ??= setTimeout(() => child.kill('SIGKILL'), terminationGraceMs)
    }
    const interrupt = () => terminate('SIGINT')
    const stop = () => terminate('SIGTERM')
    process.once('SIGINT', interrupt)
    process.once('SIGTERM', stop)
    const budgetTimer = Number.isSafeInteger(deadlineAt)
      ? setTimeout(() => terminate('SIGTERM'), Math.max(1, deadlineAt - Date.now()))
      : undefined
    try {
      return await completed
    } finally {
      if (budgetTimer !== undefined) clearTimeout(budgetTimer)
      if (forced !== undefined) clearTimeout(forced)
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', stop)
    }
  } finally {
    await Promise.allSettled([stdout.close(), stderr.close()])
  }
}

async function runAssignment(config, identity, environment, jobRoot, evolutionId, roundId) {
  const runDirectory = await privateDirectory(join(jobRoot, `run-${Date.now()}-${randomUUID()}`))
  await writePrivateJson(join(runDirectory, 'runner.json'), { pid: process.pid, startedAt: new Date().toISOString() })
  const transport = await createRefineCodexTransport({
    socketPath: config.socketPath,
    runDirectory,
    identity,
  })
  let claim
  for (;;) {
    claim = await transport.refineRequest('meta.claim', { evolutionId, roundId })
    if (claim.pending !== false) break
    const recovered = await recoverPrivateSessions(config, jobRoot, roundId)
    const status = object(await requestRefineSkill(config.socketPath, {
      method: 'control.status', params: { evolutionId, roundId },
    }), 'Gear status')
    if (terminalStatuses.has(status.status) || recovered) {
      await rm(runDirectory, { recursive: true, force: true })
      return { terminal: status }
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, pollIntervalMs))
  }
  if (claim.roundId !== roundId) throw new Error('claimed assignment does not belong to the requested round')
  let outcome
  try {
    outcome = await runCodex(config, identity, runDirectory, claim.generationBudget?.deadlineAt, environment)
  } catch {
    await failRefineTransportSession({
      runDirectory, socketPath: config.socketPath, reason: 'codex-process-start-failed',
    })
    await rm(join(runDirectory, 'runner.json'), { force: true })
    throw new Error('Codex process could not be started')
  }
  const reason = outcome.signal === null
    ? `codex-process-exited-${outcome.code ?? 1}`
    : `codex-process-exited-${outcome.signal}`
  const settlement = await failRefineTransportSession({ runDirectory, socketPath: config.socketPath, reason })
  await rm(join(runDirectory, 'child.json'), { force: true })
  await rm(join(runDirectory, 'runner.json'), { force: true })
  return { settlement }
}

export async function runCodexSkillMetaRound(evolutionId, roundId, environment = process.env) {
  if (typeof evolutionId !== 'string' || evolutionId.length === 0
    || typeof roundId !== 'string' || roundId.length === 0) {
    throw new Error('evolutionId and roundId are required')
  }
  const { config, identity } = await preflightCodexSkillMeta(environment, evolutionId)
  const jobRoot = await privateDirectory(join(config.runRoot, `round-${roundKey(evolutionId, roundId)}`))
  const recovered = await recoverPrivateSessions(config, jobRoot, roundId)
  const status = object(await requestRefineSkill(config.socketPath, {
    method: 'control.status', params: { evolutionId, roundId },
  }), 'Gear status')
  if (terminalStatuses.has(status.status) || recovered) return status
  const assignment = await runAssignment(config, identity, environment, jobRoot, evolutionId, roundId)
  if (assignment.terminal !== undefined) return assignment.terminal
  return object(await requestRefineSkill(config.socketPath, {
    method: 'control.status', params: { evolutionId, roundId },
  }), 'Gear status')
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  if (argv.length === 1 && argv[0] === '--preflight') {
    await preflightCodexSkillMeta(environment)
    process.stdout.write(`${JSON.stringify({ ready: true })}\n`)
    return
  }
  if (argv.length === 3 && argv[0] === '--preflight' && argv[1] === '--evolution-id') {
    await preflightCodexSkillMeta(environment, argv[2])
    process.stdout.write(`${JSON.stringify({ ready: true, evolutionId: argv[2] })}\n`)
    return
  }
  if (argv.length === 4 && argv[0] === '--evolution-id' && argv[2] === '--round-id') {
    const status = await runCodexSkillMetaRound(argv[1], argv[3], environment)
    process.stdout.write(`${JSON.stringify(status)}\n`)
    if (status.status === 'failed') process.exitCode = 1
    return
  }
  throw new Error('usage: codex-skill-meta-runner.mjs --preflight [--evolution-id ID] | --evolution-id ID --round-id ID')
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    process.stderr.write(`codex-skill-meta-runner: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
