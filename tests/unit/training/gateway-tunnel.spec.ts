import { createServer as httpServer } from 'node:http'
import { connect, createServer, type Server } from 'node:net'
import { once } from 'node:events'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { digestJson } from '../../../src/training/digest.js'
import { ModelNodeTransport } from '../../../src/training/transport.js'
import { atomicWrite } from '../../../src/training/store.js'
import type { ModelNodeConnection, NodeIdentity } from '../../../src/training/types.js'

describe('explicit model-node SSH gateway cleanup', () => {
  let root: string, log: string
  const servers = new Set<Server>(), directories = new Set<string>()
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gear-gateway-'))
    const bin = join(root, 'bin'); await mkdir(bin)
    log = join(root, 'ssh-argv.jsonl')
    await writeFile(join(bin, 'ssh'), `#!${process.execPath}
const fs = require('node:fs'), net = require('node:net');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GEAR_GATEWAY_FIXTURE_LOG, JSON.stringify(args) + '\\n');
const operation = args.includes('-O') ? args[args.indexOf('-O') + 1] : args.includes('-M') ? 'start' : '';
if (!['start', 'exit'].includes(operation)) process.exit(2);
if (operation === 'exit' && process.env.GEAR_GATEWAY_FIXTURE_FAIL === '1') process.exit(3);
const socket = net.connect(args[args.indexOf('-S') + 1]);
socket.on('connect', () => socket.write(operation));
let reply = ''; socket.on('data', bytes => reply += bytes);
socket.on('error', () => process.exit(4));
socket.on('end', () => process.exit(reply === 'ok' ? 0 : 5));
setTimeout(() => process.exit(6), 3000).unref();
`, { mode: 0o700 })
    vi.stubEnv('PATH', bin + delimiter + process.env.PATH)
    vi.stubEnv('GEAR_GATEWAY_FIXTURE_LOG', log)
  })
  afterEach(async () => {
    vi.restoreAllMocks(); vi.unstubAllEnvs()
    for (const server of servers) if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    servers.clear()
    for (const directory of directories) await rm(directory, { recursive: true, force: true })
    directories.clear(); await rm(root, { recursive: true, force: true })
  })
  async function listening(server: Server, address: number | string): Promise<void> {
    servers.add(server)
    if (typeof address === 'number') server.listen(address, '127.0.0.1')
    else server.listen(address)
    await once(server, 'listening')
  }
  async function commands(): Promise<string[][]> {
    try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }
  async function fixture(seed = true, incarnation?: string, localPort = 0) {
    const model = httpServer((_request, response) => response.end('model-service-alive'))
    await listening(model, 0)
    const modelPort = (model.address() as { port: number }).port
    const forward = createServer(client => {
      const upstream = connect(modelPort, '127.0.0.1')
      client.pipe(upstream).pipe(client)
      client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy())
    })
    await listening(forward, localPort)
    const route = { localPort: (forward.address() as { port: number }).port, nodePort: modelPort }
    const connection: ModelNodeConnection = { transport: { type: 'ssh', host: 'gpu-fixture' }, workspace: '/workspace/frozen',
      python: ['/workspace/python-node'], configPath: '/workspace/node.json',
      gateway: incarnation ? { localPort: 31001, nodePort: 31002 } : route }
    const node: NodeIdentity = { nodeId: 'gpu-fixture', generation: 'boot-1' }
    const routeOwner = incarnation ? { node, connection: { ...connection, gateway: route }, namespace: 'evaluation', incarnation } : { node, connection }
    const controller = join(root, 'controller'), identity = digestJson(routeOwner)
    const directory = join('/tmp', `gear-node-${process.getuid?.() ?? 'user'}-${digestJson(controller).slice(-12)}`)
    directories.add(directory); await mkdir(directory, { recursive: true, mode: 0o700 })
    const socket = join(directory, identity.slice(-20) + '.sock')
    const record = join(controller, incarnation ? 'endpoint-routes' : 'node-routes', identity.slice(7) + '.json')
    const owner = { identity, ...routeOwner }
    const control = createServer(client => client.once('data', bytes => {
      if (bytes.toString() === 'start') { client.end('ok'); return }
      if (bytes.toString() !== 'exit') { client.end('bad'); return }
      // The controlled SSH executable closes only this real local forward.
      // The independently running model HTTP service is deliberately untouched.
      forward.close(() => { client.end('ok'); control.close() })
    }))
    await listening(control, socket); await chmod(socket, 0o600)
    if (seed) await atomicWrite(record, owner)
    return { connection, node, controller, directory, socket, record, owner, control, model, forward, route,
      transport: new ModelNodeTransport(connection, node) }
  }
  it('closes the exact recorded master, releases its port, and leaves the model and another master alive', async () => {
    const f = await fixture(false)
    const otherSocket = join(f.directory, 'unrelated.sock'), other = createServer(client => client.end('untouched'))
    await listening(other, otherSocket); await chmod(otherSocket, 0o600)
    const url = await f.transport.gateway(f.controller, f.connection.gateway.nodePort)
    expect(await (await fetch(url, { headers: { connection: 'close' } })).text()).toBe('model-service-alive')
    const rpc = vi.spyOn(f.transport, 'call').mockRejectedValue(new Error('cleanup must not call a model-node operation'))
    expect(await f.transport.closeGateway(f.controller, f.connection.gateway.nodePort)).toEqual({ closed: true })
    const calls = await commands()
    expect(calls[0]).toContain('-M')
    expect(calls[0]![calls[0]!.indexOf('-S') + 1]).toBe(f.socket)
    expect(calls[1]).toEqual(['-S', f.socket, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-O', 'exit', '--', 'gpu-fixture'])
    expect(calls).toHaveLength(2); expect(rpc).not.toHaveBeenCalled()
    expect(other.listening).toBe(true)
    expect(await (await fetch(`http://127.0.0.1:${f.connection.gateway.nodePort}`, { headers: { connection: 'close' } })).text()).toBe('model-service-alive')
    const replacement = createServer(); await listening(replacement, f.connection.gateway.localPort)
    await expect(lstat(f.record)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await f.transport.closeGateway(f.controller, f.connection.gateway.nodePort)).toEqual({ closed: false, reason: 'missing-record' })
    expect(await commands()).toHaveLength(2)
  })
  it('reuses the ordinary endpoint port after cleanup and fences late cleanup of an older incarnation', async () => {
    const incarnation = 'a'.repeat(32), old = await fixture(false, incarnation)
    await old.transport.endpointRoute(old.controller, { ...old.route, incarnation })
    expect(await old.transport.closeEndpointRoute(old.controller, { ...old.route, incarnation })).toEqual({ closed: true })
    const replacementId = 'b'.repeat(32), replacement = await fixture(false, replacementId, old.route.localPort)
    const url = await replacement.transport.endpointRoute(replacement.controller, { ...replacement.route, incarnation: replacementId })
    const before = await commands()
    expect(await old.transport.closeEndpointRoute(old.controller, { ...old.route, incarnation })).toEqual({ closed: false, reason: 'missing-record' })
    expect(await commands()).toEqual(before)
    expect(replacement.control.listening).toBe(true)
    expect(await (await fetch(url, { headers: { connection: 'close' } })).text()).toBe('model-service-alive')
    expect(await replacement.transport.closeEndpointRoute(replacement.controller, { ...replacement.route, incarnation: replacementId })).toEqual({ closed: true })
    expect(old.model.listening).toBe(true); expect(replacement.model.listening).toBe(true)
  })
  it.each(['identity', 'node', 'connection'] as const)('refuses a changed %s before invoking SSH', async field => {
    const f = await fixture()
    const changed = structuredClone(f.owner)
    if (field === 'identity') changed.identity = digestJson('other owner')
    else if (field === 'node') changed.node.generation = 'boot-2'
    else changed.connection.workspace = '/workspace/another'
    await atomicWrite(f.record, changed)
    await expect(f.transport.closeGateway(f.controller, f.connection.gateway.nodePort)).rejects.toMatchObject({ code: 'tunnel-owner-drift' })
    expect(await commands()).toEqual([]); expect(f.control.listening).toBe(true); expect(f.forward.listening).toBe(true)
  })
  it('does not claim another workspace or an unrecorded socket', async () => {
    const f = await fixture()
    expect(await f.transport.closeGateway(join(root, 'other-controller'), f.connection.gateway.nodePort)).toEqual({ closed: false, reason: 'missing-record' })
    await rm(f.record)
    expect(await f.transport.closeGateway(f.controller, f.connection.gateway.nodePort)).toEqual({ closed: false, reason: 'missing-record' })
    expect(await commands()).toEqual([]); expect(f.control.listening).toBe(true)
  })
  it('is idempotent when the owned socket is already absent and retains its audit record', async () => {
    const f = await fixture()
    await new Promise<void>(resolve => f.control.close(() => resolve()))
    expect(await f.transport.closeGateway(f.controller, f.connection.gateway.nodePort)).toEqual({ closed: false, reason: 'missing-socket' })
    expect(await f.transport.closeGateway(f.controller, f.connection.gateway.nodePort)).toEqual({ closed: false, reason: 'missing-socket' })
    expect(JSON.parse(await readFile(f.record, 'utf8'))).toEqual(f.owner)
    expect(await commands()).toEqual([])
  })
  it('rejects an unsafe directory and a regular file in place of the control socket', async () => {
    const f = await fixture()
    await chmod(f.directory, 0o755)
    await expect(f.transport.closeGateway(f.controller, f.connection.gateway.nodePort)).rejects.toMatchObject({ code: 'unsafe-tunnel-directory' })
    await chmod(f.directory, 0o700)
    await new Promise<void>(resolve => f.control.close(() => resolve()))
    await writeFile(f.socket, 'not a socket', { mode: 0o600 })
    await expect(f.transport.closeGateway(f.controller, f.connection.gateway.nodePort)).rejects.toMatchObject({ code: 'unsafe-tunnel-socket' })
    expect(await commands()).toEqual([])
  })
  it('rejects a symlinked owner record without contacting SSH', async () => {
    const f = await fixture(), retained = join(root, 'retained-owner.json')
    await atomicWrite(retained, f.owner); await rm(f.record); await symlink(retained, f.record)
    await expect(f.transport.closeGateway(f.controller, f.connection.gateway.nodePort)).rejects.toMatchObject({ code: 'unsafe-tunnel-record' })
    expect(await commands()).toEqual([]); expect(f.control.listening).toBe(true)
  })
  it('retains ownership on an unacknowledged close and allows an explicit retry', async () => {
    const f = await fixture()
    vi.stubEnv('GEAR_GATEWAY_FIXTURE_FAIL', '1')
    await expect(f.transport.closeGateway(f.controller, f.connection.gateway.nodePort)).rejects.toMatchObject({ code: 'node-route-close-failed' })
    expect(JSON.parse(await readFile(f.record, 'utf8'))).toEqual(f.owner)
    expect(f.control.listening).toBe(true); expect(f.forward.listening).toBe(true)
    vi.stubEnv('GEAR_GATEWAY_FIXTURE_FAIL', '0')
    expect(await f.transport.closeGateway(f.controller, f.connection.gateway.nodePort)).toEqual({ closed: true })
  })
  it('does nothing for a local route and rejects a different gateway port', async () => {
    const f = await fixture()
    const local = new ModelNodeTransport({ ...f.connection, transport: { type: 'local' } }, f.node)
    expect(await local.closeGateway(f.controller, f.connection.gateway.nodePort)).toEqual({ closed: false, reason: 'local' })
    await expect(f.transport.closeGateway(f.controller, f.connection.gateway.nodePort + 1)).rejects.toMatchObject({ code: 'gateway-port-drift' })
    expect(await commands()).toEqual([]); expect(f.control.listening).toBe(true)
  })
})
