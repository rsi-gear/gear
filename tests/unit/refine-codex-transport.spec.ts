import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

interface SkillRequest {
  method: string
  params?: unknown
}

type Request = (socketPath: string, request: SkillRequest) => Promise<unknown>

interface Transport {
  clientId: string
  tools: Array<{ name: string }>
  refineRequest(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
  invokeTool(name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>
  handleJsonRpc(message: Record<string, unknown>): Promise<Record<string, unknown> | null>
  serveStdio(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void>
}

interface Session {
  sessionKey: string
  clientId: string
  evolutionId: string
  roundId: string
  candidateId: string
  sessionId: string
  leaseId: string
  leaseToken: string
  attempt?: number
}

interface TransportModule {
  createRefineCodexTransport(options: Record<string, unknown>): Promise<Transport>
  failRefineTransportSession(options: Record<string, unknown>): Promise<Record<string, unknown>>
  readRefineTransportSession(runDirectory: string, options?: { optional?: boolean }): Promise<Session | undefined>
  refineTransportPaths(runDirectory: string): {
    runDirectory: string
    clientPath: string
    sessionPath: string
    auditPath: string
  }
}

const moduleUrl: string = new URL('../../skills/refine/scripts/transport.mjs', import.meta.url).href
const transportModule = await import(moduleUrl) as TransportModule

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function privateDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gear-refine-codex-transport-'))
  roots.push(root)
  return join(root, 'private-run')
}

function identity(model = 'gpt-6-astra') {
  return {
    runtime: { type: 'codex', version: '0.153.2', integrity: `sha256:${'1'.repeat(64)}` },
    preset: { id: 'refine', digest: `sha256:${'2'.repeat(64)}` },
    model: { provider: 'openai-codex', model, maxTokens: 8192 },
    sampling: { reasoningEffort: 'ultra' },
  }
}

const secret = 'lease-secret-that-must-never-reach-the-model-or-audit'
function assignment(sessionId = 'meta-session-1') {
  return {
    leaseId: 'lease-1',
    leaseToken: secret,
    evolutionId: 'evolution-1',
    roundId: 'round-1',
    candidateId: 'candidate-1',
    sessionId,
    workspaceId: 'workspace-1',
    parentHarnessRef: 'a'.repeat(40),
    parentHarnessDigest: `sha256:${'3'.repeat(64)}`,
    generationBudget: { attempt: 2 },
    baseline: { evalId: 'eval-1', trials: [] },
  }
}

function requestParams(call: SkillRequest): Record<string, unknown> {
  return call.params as Record<string, unknown>
}

describe('Codex MCP refine transport', () => {
  it('strictly parses configured identities and preserves maxTokens in control.identity', async () => {
    const runDirectory = await privateDirectory()
    await expect(transportModule.createRefineCodexTransport({
      socketPath: '/tmp/refine.sock', runDirectory,
      identity: { ...identity(), preset: { ...identity().preset, resources: [] } },
      request: async () => identity(),
    })).rejects.toThrow('identity.preset.resources')

    const transport = await transportModule.createRefineCodexTransport({
      socketPath: '/tmp/refine.sock', runDirectory, identity: identity(),
      request: async (_socketPath: string, call: SkillRequest) => {
        if (call.method !== 'control.identity') throw new Error(`unexpected request ${call.method}`)
        return identity()
      },
    })
    await expect(transport.refineRequest('control.identity', {})).resolves.toEqual(identity())
  })

  it('binds a stable identity and private lease without exposing credentials', async () => {
    const runDirectory = await privateDirectory()
    const calls: SkillRequest[] = []
    const request: Request = vi.fn(async (_socketPath, call) => {
      calls.push(call)
      if (call.method === 'meta.claim') return assignment()
      if (call.method === 'candidate.read') {
        return { path: 'plugins/policy.js', text: `safe text accidentally containing ${secret}`, leaseToken: secret, auth: secret }
      }
      if (call.method === 'meta.call') {
        return { accepted: false, recoverable: false, code: 'VERIFIER_EVIDENCE_UNAVAILABLE', leaseToken: secret }
      }
      throw new Error(`unexpected request ${call.method}`)
    })
    const transport = await transportModule.createRefineCodexTransport({
      socketPath: '/tmp/refine.sock', runDirectory, identity: identity(), request,
    })

    const claim = await transport.refineRequest('meta.claim', {
      evolutionId: 'evolution-1', clientId: 'spoofed', identity: {}, leaseToken: 'spoofed',
    })
    expect(requestParams(calls[0]!)).toEqual({
      evolutionId: 'evolution-1', clientId: transport.clientId, identity: identity(),
    })
    expect(JSON.stringify(claim)).not.toContain(secret)
    expect(claim).not.toHaveProperty('leaseToken')
    expect(claim.transport).toEqual({ version: 1, sessionKey: 'round-1:candidate-1:meta-session-1' })

    const session = await transportModule.readRefineTransportSession(runDirectory)
    expect(session).toMatchObject({
      clientId: transport.clientId, leaseToken: secret, attempt: 2,
      evolutionId: 'evolution-1', roundId: 'round-1', candidateId: 'candidate-1', sessionId: 'meta-session-1',
    })
    const paths = transportModule.refineTransportPaths(runDirectory)
    expect((await stat(paths.runDirectory)).mode & 0o777).toBe(0o700)
    for (const path of [paths.clientPath, paths.sessionPath, paths.auditPath]) {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    }

    const read = await transport.refineRequest('candidate.read', {
      path: 'plugins/policy.js', clientId: 'spoofed', leaseId: 'spoofed', leaseToken: 'spoofed',
    })
    expect(requestParams(calls[1]!)).toEqual({
      path: 'plugins/policy.js', clientId: transport.clientId, leaseId: 'lease-1', leaseToken: secret,
    })
    expect(JSON.stringify(read)).not.toContain(secret)
    expect(read).not.toHaveProperty('leaseToken')

    const blocked = await transport.refineRequest('meta.call', {
      capability: 'candidate.decline', arguments: { rationale: 'private rationale' },
    })
    expect(requestParams(calls[2]!)).toMatchObject({
      clientId: transport.clientId, leaseId: 'lease-1', leaseToken: secret,
      capability: 'candidate.decline', arguments: { rationale: 'private rationale' },
    })
    expect(blocked).toEqual({ accepted: false, recoverable: false, code: 'VERIFIER_EVIDENCE_UNAVAILABLE' })
    await expect(transport.refineRequest('meta.fail', { reason: 'model requested' }))
      .rejects.toThrow('supervising runner')

    const auditText = await readFile(paths.auditPath, 'utf8')
    const audit = auditText.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(audit).toHaveLength(3)
    expect(audit[0]).toMatchObject({
      version: 1,
      assignment: { evolutionId: 'evolution-1', roundId: 'round-1', candidateId: 'candidate-1', sessionId: 'meta-session-1', attempt: 2 },
      method: 'meta.claim',
    })
    expect(audit[2]).toMatchObject({
      method: 'meta.call', capability: 'candidate.decline', accepted: false, recoverable: false,
      code: 'VERIFIER_EVIDENCE_UNAVAILABLE',
    })
    expect(auditText).not.toContain(secret)
    expect(auditText).not.toContain('private rationale')
    expect(auditText).not.toMatch(/leaseToken|authorization|"auth"|"arguments"/u)

    const restarted = await transportModule.createRefineCodexTransport({
      socketPath: '/tmp/refine.sock', runDirectory, identity: identity(), request,
    })
    expect(restarted.clientId).toBe(transport.clientId)
    const repeated = await restarted.refineRequest('meta.claim', { evolutionId: 'evolution-1' })
    expect((repeated.transport as Record<string, unknown>).sessionKey)
      .toBe((claim.transport as Record<string, unknown>).sessionKey)
    expect(requestParams(calls.at(-1)!)).toMatchObject({ evolutionId: 'evolution-1', roundId: 'round-1' })
    expect((await readFile(paths.auditPath, 'utf8')).trim().split('\n')).toHaveLength(3)
    await expect(transportModule.createRefineCodexTransport({
      socketPath: '/tmp/refine.sock', runDirectory, identity: identity('different-model'), request,
    })).rejects.toThrow('identity does not match')
  })

  it('implements versioned stdio MCP tools and confines resource reads to the skill', async () => {
    const runDirectory = await privateDirectory()
    const request: Request = vi.fn(async () => ({ pending: false }))
    const transport = await transportModule.createRefineCodexTransport({
      socketPath: '/tmp/refine.sock', runDirectory, identity: identity(), request,
    })

    await expect(transport.handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
      .resolves.toMatchObject({ error: { code: -32002 } })
    await expect(transport.handleJsonRpc({
      jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2024-11-05' },
    })).resolves.toMatchObject({
      result: {
        protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'gear-refine-codex-transport', version: '1.0.0' },
      },
    })
    const listed = await transport.handleJsonRpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
    expect((listed?.result as { tools: Array<{ name: string }> }).tools.map(tool => tool.name))
      .toEqual(['read_refine_resource', 'refine_request'])

    const resource = await transport.invokeTool('read_refine_resource', { path: 'SKILL.md' })
    expect(resource).toMatchObject({ version: 1, path: 'SKILL.md', text: expect.stringContaining('name: refine') })
    await expect(transport.invokeTool('read_refine_resource', { path: '../package.json' }))
      .rejects.toThrow('escapes the packaged refine skill')

    const input = Readable.from([
      `${JSON.stringify({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: 'unknown' } })}\n`,
      `${JSON.stringify({ jsonrpc: '2.0', id: 'list', method: 'tools/list' })}\n`,
    ])
    let outputText = ''
    const output = new Writable({
      write(chunk, _encoding, callback) {
        outputText += chunk.toString()
        callback()
      },
    })
    const second = await transportModule.createRefineCodexTransport({
      socketPath: '/tmp/refine.sock', runDirectory: await privateDirectory(), identity: identity(), request,
    })
    await second.serveStdio(input, output)
    const messages = outputText.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ id: 'init', result: { protocolVersion: '2025-06-18' } })
    expect(messages[1]).toMatchObject({ id: 'list', result: { tools: expect.any(Array) } })
  })

  it('lets the supervisor fail one authenticated attempt and cleans after durable meta.fail succeeds', async () => {
    const runDirectory = await privateDirectory()
    let status = 'candidate-editing'
    const calls: SkillRequest[] = []
    const request: Request = vi.fn(async (_socketPath, call) => {
      calls.push(call)
      if (call.method === 'meta.claim') return assignment()
      if (call.method === 'meta.fail') {
        status = 'failed'
        return { failed: true, evolutionId: 'evolution-1', roundId: 'round-1', candidateId: 'candidate-1' }
      }
      if (call.method === 'control.status') {
        return {
          status,
          candidateGeneration: [{ candidateId: 'candidate-1', attempts: [{ attempt: 2, status: status === 'failed' ? 'failed' : 'running', metaSessionId: 'meta-session-1' }] }],
        }
      }
      throw new Error(`unexpected request ${call.method}`)
    })
    const transport = await transportModule.createRefineCodexTransport({
      socketPath: '/tmp/refine.sock', runDirectory, identity: identity(), request,
    })
    await transport.refineRequest('meta.claim', {})
    const session = (await transportModule.readRefineTransportSession(runDirectory))!

    const result = await transportModule.failRefineTransportSession({
      runDirectory,
      socketPath: '/tmp/refine.sock',
      reason: 'Codex exited before an accepted finalization',
      expectedSessionKey: session.sessionKey,
      request,
    })
    expect(result).toMatchObject({ submitted: true, late: false, result: { failed: true } })
    const fail = calls.find(call => call.method === 'meta.fail')
    expect(fail).toBeDefined()
    expect(requestParams(fail!)).toEqual({
      clientId: transport.clientId, leaseId: 'lease-1', leaseToken: secret,
      reason: 'Codex exited before an accepted finalization',
    })
    expect(await transportModule.readRefineTransportSession(runDirectory, { optional: true })).toBeUndefined()
    expect((await stat(transportModule.refineTransportPaths(runDirectory).clientPath)).isFile()).toBe(true)
    const auditText = await readFile(transportModule.refineTransportPaths(runDirectory).auditPath, 'utf8')
    expect(auditText).not.toContain(secret)
    expect(auditText).not.toContain('Codex exited')
    expect(auditText).toContain('"method":"meta.fail"')
  })

  it('treats a settled generation attempt as a late failure and checks status instead of sending meta.fail', async () => {
    const runDirectory = await privateDirectory()
    let statusReads = 0
    const calls: SkillRequest[] = []
    const request: Request = vi.fn(async (_socketPath, call) => {
      calls.push(call)
      if (call.method === 'meta.claim') return assignment()
      if (call.method === 'control.status') {
        statusReads += 1
        return { status: 'candidate-seed-running', candidateGeneration: [{
          candidateId: 'candidate-1', attempts: [{ attempt: 2, status: 'succeeded', metaSessionId: 'meta-session-1' }],
        }] }
      }
      throw new Error(`late failure must not call ${call.method}`)
    })
    const transport = await transportModule.createRefineCodexTransport({
      socketPath: '/tmp/refine.sock', runDirectory, identity: identity(), request,
    })
    await transport.refineRequest('meta.claim', {})

    const result = await transportModule.failRefineTransportSession({
      runDirectory, socketPath: '/tmp/refine.sock', reason: 'late process exit', request,
    })
    expect(result).toMatchObject({ submitted: true, late: true, status: { status: 'candidate-seed-running' } })
    expect(calls.some(call => call.method === 'meta.fail')).toBe(false)
    expect(statusReads).toBe(1)
    expect(await transportModule.readRefineTransportSession(runDirectory, { optional: true })).toBeUndefined()
  })

  it('deduplicates a repeated claim by the round, candidate, and Meta session', async () => {
    const runDirectory = await privateDirectory()
    const request: Request = vi.fn(async (_socketPath, call) => {
      if (call.method === 'meta.claim') return assignment()
      throw new Error(`unexpected request ${call.method}`)
    })
    const transport = await transportModule.createRefineCodexTransport({
      socketPath: '/tmp/refine.sock', runDirectory, identity: identity(), request,
    })
    const first = await transport.refineRequest('meta.claim', {})
    const second = await transport.refineRequest('meta.claim', {})
    expect((first.transport as Record<string, unknown>).sessionKey)
      .toBe((second.transport as Record<string, unknown>).sessionKey)
    const audit = await readFile(transportModule.refineTransportPaths(runDirectory).auditPath, 'utf8')
    expect(audit.trim().split('\n')).toHaveLength(1)
  })
})
