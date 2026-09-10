import { createHash } from 'node:crypto'
import { readdirSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

interface RunnerModule {
  preflightCodexSkillMeta(environment: NodeJS.ProcessEnv, evolutionId?: string): Promise<unknown>
  runCodexSkillMetaRound(evolutionId: string, roundId: string, environment: NodeJS.ProcessEnv): Promise<Record<string, unknown>>
  main(argv: string[], environment: NodeJS.ProcessEnv): Promise<void>
}

interface TransportModule {
  createRefineCodexTransport(options: Record<string, unknown>): Promise<{
    refineRequest(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
  }>
  readRefineTransportSession(runDirectory: string, options?: { optional?: boolean }): Promise<unknown>
}

const runnerModule = await import(new URL('../../examples/codex-skill-meta-runner.mjs', import.meta.url).href) as RunnerModule
const transportModule = await import(new URL('../../skills/refine/scripts/transport.mjs', import.meta.url).href) as TransportModule
const evolutionId = 'evolution-runner-1'
const roundId = 'round-runner-1'
const leaseToken = 'runner-lease-secret-never-log-this'
const roots: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolvePromise => server.close(() => resolvePromise()))))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function identity() {
  return {
    runtime: { type: 'codex', version: '0.153.2', integrity: `sha256:${'1'.repeat(64)}` },
    preset: { id: 'refine', digest: `sha256:${'2'.repeat(64)}` },
    model: { provider: 'openai-codex', model: 'gpt-6-astra', maxTokens: 8192 },
    sampling: { reasoningEffort: 'ultra' },
  }
}

type CodexMode = 'blocked' | 'success' | 'hold' | 'collision' | 'vanish'
  | 'preflight-text' | 'preflight-failed' | 'preflight-wrong-path' | 'preflight-invalid-resource'

async function fakeCodex(root: string, mode: CodexMode) {
  const executable = join(root, 'fake-codex.mjs')
  const logPath = join(root, 'codex-invocations.jsonl')
  const releasePath = join(root, 'release-codex')
  const script = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, unlinkSync, watch } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
const mode = ${JSON.stringify(mode)}
const logPath = ${JSON.stringify(logPath)}
const args = process.argv.slice(2)
appendFileSync(logPath, JSON.stringify({ args, codexHome: process.env.CODEX_HOME, pid: process.pid }) + '\\n')
if (args[0] === '--version') { process.stdout.write('codex fixture 1\\n'); process.exit(0) }
if (args[0] === 'login' && args[1] === 'status') {
  let auth
  try { auth = JSON.parse(readFileSync(process.env.CODEX_HOME + '/auth.json', 'utf8')) } catch { auth = undefined }
  if (typeof auth?.accessToken !== 'string' || auth.accessToken.length === 0) {
    process.stderr.write('login failed with should-not-escape-auth-marker\\n')
    process.exit(1)
  }
  process.stdout.write('logged in\\n')
  process.exit(0)
}
if (args[0] !== 'exec') process.exit(2)
const encoded = args.find(value => value.startsWith('mcp_servers.gear_refine.args='))
const enabled = args.find(value => value.startsWith('mcp_servers.gear_refine.enabled_tools='))
if (encoded === undefined || enabled === undefined) process.exit(3)
const transportArgs = JSON.parse(encoded.slice(encoded.indexOf('=') + 1))
const enabledTools = JSON.parse(enabled.slice(enabled.indexOf('=') + 1))
const resourcePreflight = enabledTools.length === 1 && enabledTools[0] === 'read_refine_resource'
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    process.stdin.destroy()
    reject(new Error('exec stdin did not close'))
  }, 1_000)
  process.stdin.once('end', () => {
    clearTimeout(timeout)
    resolve()
  })
  process.stdin.resume()
})
const writeEvent = item => process.stdout.write(JSON.stringify({ type: 'item.completed', item }) + '\\n')
const resourceItem = (path, structuredContent) => ({
  id: 'item-resource', type: 'mcp_tool_call', server: 'gear_refine', tool: 'read_refine_resource',
  arguments: { path },
  result: { content: [{ type: 'text', text: 'fixture resource' }], structured_content: structuredContent },
  error: null, status: 'completed',
})
if (resourcePreflight && mode === 'preflight-text') {
  writeEvent({ id: 'item-message', type: 'agent_message', text: 'ready' })
} else if (resourcePreflight && mode === 'preflight-failed') {
  writeEvent({
    id: 'item-resource', type: 'mcp_tool_call', server: 'gear_refine', tool: 'read_refine_resource',
    arguments: { path: 'SKILL.md' }, result: null,
    error: { message: 'MCP tool call requires approval, but approval policy is never' }, status: 'failed',
  })
} else if (resourcePreflight && mode === 'preflight-wrong-path') {
  writeEvent(resourceItem('references/protocol.md', {
    version: 1, path: 'references/protocol.md', text: 'fixture resource',
  }))
} else if (resourcePreflight && mode === 'preflight-invalid-resource') {
  writeEvent(resourceItem('SKILL.md', { version: 1, path: 'SKILL.md', text: '' }))
} else {
  const transport = spawn(process.execPath, transportArgs, { stdio: ['pipe', 'pipe', 'inherit'] })
  const ended = new Promise((resolve, reject) => {
    transport.once('error', reject)
    transport.once('exit', (code, signal) => code === 0 && signal === null ? resolve() : reject(new Error('transport failed')))
  })
  let buffer = ''
  const pending = new Map()
  transport.stdout.setEncoding('utf8')
  transport.stdout.on('data', chunk => {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf('\\n')
      if (newline < 0) break
      const response = JSON.parse(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      pending.get(response.id)?.(response)
      pending.delete(response.id)
    }
  })
  let nextId = 1
  const rpc = (method, params) => new Promise(resolve => {
    const id = nextId++
    pending.set(id, resolve)
    transport.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n')
  })
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } })
  if (resourcePreflight) {
    const response = await rpc('tools/call', { name: 'read_refine_resource', arguments: { path: 'SKILL.md' } })
    writeEvent({
      ...resourceItem('SKILL.md', response.result?.structuredContent),
      result: { content: response.result?.content, structured_content: response.result?.structuredContent },
    })
    transport.stdin.end()
    await ended
    if (mode === 'vanish') unlinkSync(fileURLToPath(import.meta.url))
  } else if (mode === 'hold') {
    const releasePath = ${JSON.stringify(releasePath)}
    await new Promise((resolve, reject) => {
      if (existsSync(releasePath)) { resolve(); return }
      const watcher = watch(${JSON.stringify(root)}, (_event, filename) => {
        if (filename === 'release-codex' && existsSync(releasePath)) {
          watcher.close()
          resolve()
        }
      })
      watcher.once('error', error => { watcher.close(); reject(error) })
      if (existsSync(releasePath)) { watcher.close(); resolve() }
    })
    transport.stdin.end()
    await ended
  } else {
    await rpc('tools/call', { name: 'refine_request', arguments: { method: 'meta.claim', params: {} } })
    await rpc('tools/call', { name: 'refine_request', arguments: {
      method: 'meta.call', params: { capability: 'candidate.decline', arguments: { reason: 'fixture result' } },
    } })
    transport.stdin.end()
    await ended
  }
}
`
  await writeFile(executable, script)
  await chmod(executable, 0o755)
  return { executable, logPath, releasePath }
}

interface GearFixture {
  server: Server
  socketPath: string
  calls: Array<{ method: string, params: Record<string, unknown> }>
  failCount(): number
  claimCount(): number
}

async function fakeGear(
  root: string,
  mode: 'blocked' | 'collision' | 'delayed' | 'success' = 'blocked',
): Promise<GearFixture> {
  const socketPath = join(root, 'gear.sock')
  const calls: Array<{ method: string, params: Record<string, unknown> }> = []
  let failures = 0
  let claims = 0
  let claimRequests = 0
  let ownerClientId: string | undefined
  let status = 'candidate-editing'
  let attemptStatus = 'running'
  const server = createServer(socket => {
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const request = JSON.parse(buffer.slice(0, newline)) as {
          id: string, method: string, params?: Record<string, unknown>
        }
        buffer = buffer.slice(newline + 1)
        const params = request.params ?? {}
        calls.push({ method: request.method, params })
        let result: unknown
        if (request.method === 'control.identity') {
          result = identity()
        } else if (request.method === 'control.status') {
          result = params.evolutionId === undefined ? [] : {
            evolutionId, roundId, status,
            candidateGeneration: [{ candidateId: 'candidate-1', attempts: [{
              metaSessionId: 'session-1', status: attemptStatus,
            }] }],
          }
        } else if (request.method === 'meta.claim') {
          claimRequests += 1
          if (params.evolutionId !== undefined && (params.evolutionId !== evolutionId || params.roundId !== roundId)) {
            result = { pending: false }
          } else if (mode === 'delayed' && claimRequests === 1) {
            result = { pending: false }
          } else if (ownerClientId !== undefined && params.clientId !== ownerClientId) {
            result = { pending: false }
          } else {
            ownerClientId = String(params.clientId)
            claims += 1
            if (mode === 'collision' && claims === 1) {
              const roundDirectory = readdirSync(join(root, 'runs')).find(name => name.startsWith('round-'))
              const runDirectory = roundDirectory === undefined ? undefined
                : readdirSync(join(root, 'runs', roundDirectory)).find(name => name.startsWith('run-'))
              if (roundDirectory === undefined || runDirectory === undefined) throw new Error('runner directory is missing')
              writeFileSync(join(root, 'runs', roundDirectory, runDirectory, 'child.json'), '{}', { mode: 0o600 })
            }
            result = {
              evolutionId, roundId, candidateId: 'candidate-1', sessionId: 'session-1',
              leaseId: 'lease-1', leaseToken,
              generationBudget: { attempt: 1, deadlineAt: Date.now() + 30_000 },
              baseline: { evalId: 'eval-1', trials: [] },
            }
          }
        } else if (request.method === 'meta.call') {
          if (params.leaseToken !== leaseToken) throw new Error('transport did not bind the lease')
          if (mode === 'success') {
            attemptStatus = 'succeeded'
            status = 'candidate-seed-running'
            result = { accepted: true }
          } else {
            result = { accepted: false, recoverable: false, code: 'operator_auth_missing' }
          }
        } else if (request.method === 'meta.fail') {
          if (params.leaseToken !== leaseToken) throw new Error('runner did not bind the lease')
          failures += 1
          attemptStatus = 'failed'
          status = 'failed'
          result = { failed: true, evolutionId, roundId, candidateId: 'candidate-1' }
        } else {
          throw new Error(`unexpected Gear request: ${request.method}`)
        }
        socket.write(`${JSON.stringify({ id: request.id, result })}\n`)
      }
    })
  })
  servers.push(server)
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolvePromise)
  })
  return { server, socketPath, calls, failCount: () => failures, claimCount: () => claims }
}

async function fixture(mode: CodexMode | 'delayed' = 'blocked') {
  const root = await mkdtemp(join(tmpdir(), 'gear-codex-meta-runner-'))
  roots.push(root)
  const runRoot = join(root, 'runs')
  const codexHome = join(root, 'meta-codex-home')
  const workspace = join(root, 'workspace')
  await Promise.all([mkdir(runRoot, { mode: 0o700 }), mkdir(codexHome, { mode: 0o700 }), mkdir(workspace)])
  const identityFile = join(root, 'identity.json')
  await writeFile(identityFile, JSON.stringify(identity()))
  await chmod(identityFile, 0o600)
  const codex = await fakeCodex(root, mode === 'delayed' ? 'blocked' : mode)
  const gear = await fakeGear(root,
    mode === 'success' ? 'success' : mode === 'delayed' ? 'delayed'
      : mode === 'collision' ? 'collision' : 'blocked')
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    GEAR_REFINE_SOCKET: gear.socketPath,
    GEAR_REFINE_IDENTITY_FILE: identityFile,
    GEAR_META_CODEX_HOME: codexHome,
    GEAR_META_RUN_ROOT: runRoot,
    GEAR_META_WORKSPACE: workspace,
    GEAR_CODEX_EXECUTABLE: codex.executable,
  }
  return { root, runRoot, codexHome, identityFile, environment, gear, ...codex }
}

async function loggedInvocations(path: string): Promise<Array<{ args: string[], codexHome: string, pid: number }>> {
  try {
    return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function filesBelow(root: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...await filesBelow(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

async function eventually(predicate: () => boolean) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
  }
  throw new Error('condition was not reached')
}

describe('Codex Skill Meta runner example', () => {
  it('checks login, identity, and a real resource call before admission', async () => {
    const value = await fixture()
    await writeFile(join(value.codexHome, 'auth.json'), '{}')
    await expect(runnerModule.preflightCodexSkillMeta(value.environment)).rejects.toThrow('Codex login preflight failed')
    expect(value.gear.calls).toEqual([])

    await writeFile(join(value.codexHome, 'auth.json'), JSON.stringify({ accessToken: 'fixture-access' }))
    await runnerModule.preflightCodexSkillMeta(value.environment)
    expect(value.gear.calls).toContainEqual({ method: 'control.identity', params: {} })
    await runnerModule.preflightCodexSkillMeta(value.environment, evolutionId)
    expect(value.gear.calls).toContainEqual({ method: 'control.identity', params: { evolutionId } })
    const invocations = await loggedInvocations(value.logPath)
    expect(invocations.map(value => value.args)).toContainEqual(['login', 'status'])
    expect(invocations.every(invocation => invocation.codexHome === value.codexHome)).toBe(true)
    const executions = invocations.filter(invocation => invocation.args[0] === 'exec')
    expect(executions).toHaveLength(2)
    for (const execution of executions) {
      expect(execution.args).toContain('--ephemeral')
      expect(execution.args).toContain('--ignore-user-config')
      expect(execution.args).toContain('--strict-config')
      expect(execution.args).toContain('approval_policy="never"')
      expect(execution.args).toContain('mcp_servers.gear_refine.required=true')
      expect(execution.args).toContain('mcp_servers.gear_refine.enabled_tools=["read_refine_resource"]')
      expect(execution.args).toContain('mcp_servers.gear_refine.tools.read_refine_resource.approval_mode="approve"')
      expect(execution.args).toContain('mcp_servers.gear_refine.tools.refine_request.approval_mode="approve"')
      expect(execution.args.at(-1)).toContain('read_refine_resource exactly once')
    }
    expect(value.gear.calls).toEqual([
      { method: 'control.identity', params: {} },
      { method: 'control.identity', params: { evolutionId } },
    ])
    expect(value.gear.claimCount()).toBe(0)
    expect(await readdir(value.runRoot)).toEqual([])
  })

  it.each([
    ['text-only readiness', 'preflight-text', 'did not call read_refine_resource'],
    ['approval denial', 'preflight-failed', 'approval policy is never'],
    ['the wrong resource path', 'preflight-wrong-path', 'did not call read_refine_resource'],
    ['invalid resource evidence', 'preflight-invalid-resource', 'invalid resource evidence'],
  ] as const)('rejects %s even when Codex exits successfully', async (_case, mode, expected) => {
    const value = await fixture(mode)
    await writeFile(join(value.codexHome, 'auth.json'), JSON.stringify({ accessToken: 'fixture-access' }))
    await expect(runnerModule.preflightCodexSkillMeta(value.environment)).rejects.toThrow(expected)
    expect(value.gear.calls).toEqual([{ method: 'control.identity', params: {} }])
    expect(value.gear.claimCount()).toBe(0)
    expect(value.gear.failCount()).toBe(0)
    expect(await readdir(value.runRoot)).toEqual([])
  })

  it('rejects a malformed identity before running Codex or contacting Gear', async () => {
    const value = await fixture()
    await writeFile(join(value.codexHome, 'auth.json'), JSON.stringify({ accessToken: 'fixture-access' }))
    await writeFile(value.identityFile, JSON.stringify({ ...identity(), contextOffloading: {} }))
    await expect(runnerModule.preflightCodexSkillMeta(value.environment)).rejects.toThrow('identity.contextOffloading')
    expect(await loggedInvocations(value.logPath)).toEqual([])
    expect(value.gear.calls).toEqual([])
  })

  it.each([
    ['model', { ...identity(), model: { ...identity().model, model: 'gpt-6-terra' } }, 'identity.model.model'],
    ['digest', { ...identity(), preset: { ...identity().preset, digest: `sha256:${'3'.repeat(64)}` } }, 'identity.preset.digest'],
    ['effort', { ...identity(), sampling: { reasoningEffort: 'high' } }, 'identity.sampling.reasoningEffort'],
  ])('rejects a well-formed identity with a different %s before claim', async (_field, configured, path) => {
    const value = await fixture()
    await writeFile(join(value.codexHome, 'auth.json'), JSON.stringify({ accessToken: 'fixture-access' }))
    await writeFile(value.identityFile, JSON.stringify(configured))
    await expect(runnerModule.preflightCodexSkillMeta(value.environment, evolutionId))
      .rejects.toThrow(path)
    expect(value.gear.calls).toContainEqual({ method: 'control.identity', params: { evolutionId } })
    expect(value.gear.calls.some(call => call.method === 'meta.claim')).toBe(false)
  })

  it('durably fails an unrecoverable decline and keeps credentials out of private logs', async () => {
    const value = await fixture('blocked')
    await writeFile(join(value.codexHome, 'auth.json'), JSON.stringify({ accessToken: 'fixture-access' }))
    const result = await runnerModule.runCodexSkillMetaRound(evolutionId, roundId, value.environment)
    expect(result.status).toBe('failed')
    expect(value.gear.failCount()).toBe(1)
    expect(value.gear.calls.filter(call => call.method === 'meta.claim').every(call => call.params.roundId === roundId)).toBe(true)
    expect(value.gear.server.listening).toBe(true)
    const contents = await Promise.all((await filesBelow(value.runRoot)).map(path => readFile(path, 'utf8')))
    const combined = contents.join('\n')
    expect(combined).toContain('operator_auth_missing')
    expect(combined).toContain('"accepted":false')
    expect(combined).not.toContain(leaseToken)
    const previousExitCode = process.exitCode
    process.exitCode = undefined
    try {
      await runnerModule.main(['--evolution-id', evolutionId, '--round-id', roundId], value.environment)
      expect(process.exitCode).toBe(1)
    } finally {
      process.exitCode = previousExitCode
    }
  })

  it('returns after an accepted submission without waiting for candidate evaluation', async () => {
    const value = await fixture('success')
    await writeFile(join(value.codexHome, 'auth.json'), JSON.stringify({ accessToken: 'fixture-access' }))
    const result = await runnerModule.runCodexSkillMetaRound(evolutionId, roundId, value.environment)
    expect(result.status).toBe('candidate-seed-running')
    expect(value.gear.failCount()).toBe(0)
    const invocations = await loggedInvocations(value.logPath)
    const execution = invocations.find(invocation => invocation.args[0] === 'exec'
      && !invocation.args.includes('--ephemeral'))
    expect(execution?.args).toContain('--ignore-user-config')
    expect(execution?.args).toContain('--strict-config')
    expect(execution?.args).toContain('approval_policy="never"')
    expect(execution?.args).toContain('mcp_servers.gear_refine.required=true')
    expect(execution?.args).toContain('mcp_servers.gear_refine.enabled_tools=["read_refine_resource","refine_request"]')
    expect(execution?.args).toContain('mcp_servers.gear_refine.tools.read_refine_resource.approval_mode="approve"')
    expect(execution?.args).toContain('mcp_servers.gear_refine.tools.refine_request.approval_mode="approve"')
    expect(execution?.args).not.toContain('--ephemeral')
    expect(execution?.codexHome).toBe(value.codexHome)
  })

  it('recovers a dead private session once without starting another Codex process', async () => {
    const value = await fixture()
    await writeFile(join(value.codexHome, 'auth.json'), JSON.stringify({ accessToken: 'fixture-access' }))
    const key = createHash('sha256').update(`${evolutionId}\0${roundId}`).digest('hex').slice(0, 32)
    const runDirectory = join(value.runRoot, `round-${key}`, 'run-crashed')
    await mkdir(runDirectory, { recursive: true, mode: 0o700 })
    const transport = await transportModule.createRefineCodexTransport({
      socketPath: value.gear.socketPath, runDirectory, identity: identity(),
    })
    await transport.refineRequest('meta.claim', { evolutionId, roundId })
    await writeFile(join(runDirectory, 'runner.json'), JSON.stringify({ pid: 2_147_483_647 }), { mode: 0o600 })
    await writeFile(join(runDirectory, 'child.json'), JSON.stringify({ pid: 2_147_483_647 }), { mode: 0o600 })

    const result = await runnerModule.runCodexSkillMetaRound(evolutionId, roundId, value.environment)
    expect(result.status).toBe('failed')
    expect(value.gear.failCount()).toBe(1)
    expect(await transportModule.readRefineTransportSession(runDirectory, { optional: true })).toBeUndefined()
    const executions = (await loggedInvocations(value.logPath))
      .filter(invocation => invocation.args[0] === 'exec')
    expect(executions).toHaveLength(1)
    expect(executions.every(invocation => invocation.args.includes('--ephemeral'))).toBe(true)
  })

  it('excludes a second runner for the same round', async () => {
    const value = await fixture('hold')
    await writeFile(join(value.codexHome, 'auth.json'), JSON.stringify({ accessToken: 'fixture-access' }))
    const first = runnerModule.runCodexSkillMetaRound(evolutionId, roundId, value.environment)
    await eventually(() => value.gear.claimCount() > 0)
    let firstResult: Record<string, unknown> | undefined
    try {
      await expect(runnerModule.runCodexSkillMetaRound(evolutionId, roundId, value.environment))
        .rejects.toThrow('another runner already owns this Meta round')
    } finally {
      await writeFile(value.releasePath, 'release\n')
      firstResult = await first
    }
    expect(firstResult?.status).toBe('failed')
    expect(value.gear.failCount()).toBe(1)
  })

  it('waits when the generation attempt exists before its assignment is published', async () => {
    const value = await fixture('delayed')
    await writeFile(join(value.codexHome, 'auth.json'), JSON.stringify({ accessToken: 'fixture-access' }))
    const result = await runnerModule.runCodexSkillMetaRound(evolutionId, roundId, value.environment)
    expect(result.status).toBe('failed')
    expect(value.gear.claimCount()).toBeGreaterThan(0)
    expect(value.gear.failCount()).toBe(1)
  })

  it('settles a claimed attempt when the executable disappears after preflight', async () => {
    const value = await fixture('vanish')
    await writeFile(join(value.codexHome, 'auth.json'), JSON.stringify({ accessToken: 'fixture-access' }))
    await expect(runnerModule.runCodexSkillMetaRound(evolutionId, roundId, value.environment))
      .rejects.toThrow('Codex process could not be started')
    expect(value.gear.failCount()).toBe(1)
  })

  it('terminates the child when its private process record cannot be created', async () => {
    const value = await fixture('collision')
    await writeFile(join(value.codexHome, 'auth.json'), JSON.stringify({ accessToken: 'fixture-access' }))
    await expect(runnerModule.runCodexSkillMetaRound(evolutionId, roundId, value.environment))
      .rejects.toThrow('Codex process could not be started')
    expect(value.gear.failCount()).toBe(1)
    const execution = (await loggedInvocations(value.logPath)).find(invocation => invocation.args[0] === 'exec'
      && !invocation.args.includes('--ephemeral'))
    if (execution !== undefined) expect(() => process.kill(execution.pid, 0)).toThrow()
    const roundDirectory = (await readdir(value.runRoot)).find(name => name.startsWith('round-'))
    const runDirectory = (await readdir(join(value.runRoot, roundDirectory!))).find(name => name.startsWith('run-'))
    expect(await readFile(join(value.runRoot, roundDirectory!, runDirectory!, 'child.json'), 'utf8')).toBe('{}')
    expect((await readdir(join(value.runRoot, roundDirectory!, runDirectory!)))
      .filter(name => name.startsWith('.') && name.endsWith('.tmp'))).toEqual([])
  })
})
