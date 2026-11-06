import { randomUUID } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { digestJson } from './digest.js'
import { jsonProcess, ProcessResponseError } from './process.js'
import { requireContract, TrainingContractError } from './schema.js'
import { TrainingContentStore, atomicWrite, withTrainingFileLock } from './store.js'
import type { ContentRef, ModelNodeConnection, NodeIdentity } from './types.js'

export interface NodeEnvelope {
  schemaVersion: 2; requestId: string; node: NodeIdentity | null; operation: string; inputDigest: string; payload: unknown
}
interface NodeResponse { schemaVersion: 2; requestId: string; node: NodeIdentity; inputDigest: string; result: unknown }
const quote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`

/** SSH invokes a remote shell even when the local process uses argv. Quote every remote argument. */
export function nodeCommand(connection: ModelNodeConnection, action: 'rpc' | 'cas-import' | 'cas-export'): string[] {
  requireContract(connection.python.length > 0 && connection.python.every(x => typeof x === 'string' && !!x && !x.includes('\0')),
    'invalid-node-command', 'Python must be an explicit argv array')
  const command = [...connection.python, '-m', 'gear.training.cli.node', action, '--config', connection.configPath]
  if (connection.transport.type === 'local') return command
  requireContract(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(connection.transport.host), 'invalid-ssh-host', 'SSH host must be a configured Host alias')
  return ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '--', connection.transport.host, command.map(quote).join(' ')]
}

export function nodeEnvelope(node: NodeIdentity | null, operation: string, payload: unknown, requestId: string = randomUUID()): NodeEnvelope {
  return { schemaVersion: 2, requestId, node, operation, inputDigest: digestJson(payload), payload }
}

export function validateNodeResponse(value: unknown, envelope: NodeEnvelope): NodeResponse {
  const r = value as Partial<NodeResponse> | null
  requireContract(!!r && r.schemaVersion === 2 && r.requestId === envelope.requestId && r.inputDigest === envelope.inputDigest
    && !!r.node && typeof r.node.nodeId === 'string' && typeof r.node.generation === 'string'
    && (envelope.node === null || digestJson(r.node) === digestJson(envelope.node)) && 'result' in r,
  'node-response-drift', 'model-node response differs from the requested identity, generation or input')
  return r as NodeResponse
}

export class ModelNodeTransport {
  constructor(readonly connection: ModelNodeConnection, readonly identity: NodeIdentity | null, readonly timeoutMs = 60_000, readonly transferTimeoutMs = 3_600_000) {}
  async call(operation: string, payload: unknown, requestId?: string, remainingMs?: number): Promise<unknown> {
    requireContract(this.identity !== null || operation === 'probe', 'node-not-resolved', 'probe and pin a node generation before performing work')
    const envelope = nodeEnvelope(this.identity, operation, payload, requestId)
    let value: unknown
    const readOnly = ['probe', 'training.inspect', 'scripts.inspect', 'cas.stat', 'training.episodes.receipts', 'deployment.observe'].includes(operation)
    const verifiesFiles = ['cas.retain', 'cas.hfManifest', 'cas.sealHf', 'deployment.ensure'].includes(operation)
    requireContract(remainingMs === undefined || Number.isFinite(remainingMs) && remainingMs > 0, 'node-deadline-expired', 'node operation needs remaining time in its original deadline')
    const deadline = Date.now() + Math.min(verifiesFiles ? this.transferTimeoutMs : this.timeoutMs, remainingMs ?? Infinity)
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          value = await jsonProcess(nodeCommand(this.connection, 'rpc'), [], envelope, Math.max(1, deadline - Date.now()))
          break
        } catch (error) {
          const delay = attempt === 0 ? 150 : 500
          // SSH 255 carries no acknowledged RPC response. Retry only reads,
          // retaining the original envelope, identity and total timeout.
          if (!(error instanceof ProcessResponseError) || error.exitCode !== 255 || !readOnly
            || this.connection.transport.type !== 'ssh' || attempt >= 2 || Date.now() + delay >= deadline) throw error
          await new Promise(resolve => setTimeout(resolve, delay))
        }
      }
    }
    catch (error) {
      if (error instanceof TrainingContractError) error.message = `model-node ${operation}: ${error.message}`
      throw error
    }
    return validateNodeResponse(value, envelope).result
  }
  async gateway(controllerDirectory: string, nodePort: number): Promise<string> {
    const { gateway } = this.connection
    requireContract(this.identity && nodePort === gateway.nodePort, 'gateway-port-drift', 'node gateway differs from its explicit stable route')
    return this.openRoute(controllerDirectory, gateway, 'training')
  }
  /** Ordinary model connections have their own route and incarnation ownership. */
  async endpointRoute(controllerDirectory: string, route: { localPort: number; nodePort: number; incarnation: string }): Promise<string> {
    requireContract(this.identity && /^[a-f0-9]{32}$/.test(route.incarnation), 'endpoint-route-drift', 'ordinary model route requires a pinned instance')
    requireContract([route.localPort, route.nodePort].every(p => Number.isSafeInteger(p) && p > 0 && p <= 65535)
      && route.localPort !== this.connection.gateway.localPort && route.nodePort !== this.connection.gateway.nodePort,
    'endpoint-route-conflict', 'ordinary evaluation and training routes require distinct ports')
    return this.openRoute(controllerDirectory, { localPort: route.localPort, nodePort: route.nodePort }, 'evaluation', route.incarnation)
  }
  private async openRoute(controllerDirectory: string, gateway: { localPort: number; nodePort: number }, namespace: 'training' | 'evaluation', incarnation?: string): Promise<string> {
    const { transport } = this.connection
    const routeConnection = namespace === 'training' ? this.connection : { ...this.connection, gateway }
    const routeRecord = namespace === 'training' ? { node: this.identity, connection: this.connection } : { node: this.identity, connection: routeConnection, namespace, incarnation }
    const routeDirectory = namespace === 'training' ? 'node-routes' : 'endpoint-routes'
    if (transport.type === 'local') {
      requireContract(gateway.localPort === gateway.nodePort, 'gateway-port-drift', 'local model gateway ports must match')
    } else {
      const identity = digestJson(routeRecord)
      const directory = join('/tmp', `gear-node-${process.getuid?.() ?? 'user'}-${digestJson(controllerDirectory).slice(-12)}`)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const permissions = await lstat(directory)
      requireContract(permissions.isDirectory() && !permissions.isSymbolicLink() && (permissions.mode & 0o077) === 0
        && (!process.getuid || permissions.uid === process.getuid()), 'unsafe-tunnel-directory', 'SSH socket directory must be private to its owner')
      const socket = join(directory, identity.slice(-20) + '.sock')
      const record = join(controllerDirectory, routeDirectory, identity.slice(7) + '.json')
      const invoke = (args: string[]) => promisify(execFile)('ssh', args, { timeout: 30_000 })
      await withTrainingFileLock(record + '.lock', async () => {
        let previous: { identity: string } | undefined
        try { previous = JSON.parse(await readFile(record, 'utf8')) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
        requireContract(!previous || previous.identity === identity, 'tunnel-owner-drift', 'SSH route identity changed')
        const common = ['-S', socket, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15']
        if (previous) { try { await invoke([...common, '-O', 'check', '--', transport.host]); return } catch {} }
        await atomicWrite(record, { identity, ...routeRecord })
        try {
          await invoke([...common, '-M', '-fNT', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
            '-L', `127.0.0.1:${gateway.localPort}:127.0.0.1:${gateway.nodePort}`, '--', transport.host])
        } catch { throw new TrainingContractError('node-route-unavailable', 'SSH gateway could not be established; retain the original policy and job identity') }
      })
    }
    return `http://127.0.0.1:${gateway.localPort}`
  }
  /** Explicit owner cleanup only. Closing a forward never stops the model service. */
  async closeGateway(controllerDirectory: string, nodePort: number): Promise<{ closed: boolean; reason?: 'local' | 'missing-record' | 'missing-socket' }> {
    const { gateway } = this.connection
    requireContract(this.identity && nodePort === gateway.nodePort, 'gateway-port-drift', 'node gateway differs from its explicit stable route')
    return this.closeRoute(controllerDirectory, gateway, 'training')
  }
  async closeEndpointRoute(controllerDirectory: string, route: { localPort: number; nodePort: number; incarnation: string }): Promise<{ closed: boolean; reason?: 'local' | 'missing-record' | 'missing-socket' }> {
    requireContract(this.identity && /^[a-f0-9]{32}$/.test(route.incarnation), 'endpoint-route-drift', 'ordinary route cleanup requires its original instance')
    return this.closeRoute(controllerDirectory, { localPort: route.localPort, nodePort: route.nodePort }, 'evaluation', route.incarnation)
  }
  private async closeRoute(controllerDirectory: string, gateway: { localPort: number; nodePort: number }, namespace: 'training' | 'evaluation', incarnation?: string): Promise<{ closed: boolean; reason?: 'local' | 'missing-record' | 'missing-socket' }> {
    const { transport } = this.connection
    if (transport.type === 'local') return { closed: false, reason: 'local' }
    requireContract(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(transport.host), 'invalid-ssh-host', 'SSH host must be a configured Host alias')
    const routeRecord = namespace === 'training' ? { node: this.identity, connection: this.connection }
      : { node: this.identity, connection: { ...this.connection, gateway }, namespace, incarnation }
    const identity = digestJson(routeRecord)
    const directory = join('/tmp', `gear-node-${process.getuid?.() ?? 'user'}-${digestJson(controllerDirectory).slice(-12)}`)
    const socket = join(directory, identity.slice(-20) + '.sock')
    const record = join(controllerDirectory, namespace === 'training' ? 'node-routes' : 'endpoint-routes', identity.slice(7) + '.json')
    const expected = { identity, ...routeRecord }
    return withTrainingFileLock(record + '.lock', async () => {
      const permissions = await lstat(record).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
      if (!permissions) return { closed: false, reason: 'missing-record' }
      requireContract(permissions.isFile() && !permissions.isSymbolicLink() && (permissions.mode & 0o077) === 0
        && permissions.size <= 64 * 1024 && (!process.getuid || permissions.uid === process.getuid()),
      'unsafe-tunnel-record', 'SSH route record must be a private regular file owned by this user')
      requireContract(digestJson(JSON.parse(await readFile(record, 'utf8'))) === digestJson(expected),
        'tunnel-owner-drift', 'SSH route record differs from this node, connection or identity')
      const folder = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
      if (!folder) return { closed: false, reason: 'missing-socket' }
      requireContract(folder.isDirectory() && !folder.isSymbolicLink() && (folder.mode & 0o077) === 0
        && (!process.getuid || folder.uid === process.getuid()), 'unsafe-tunnel-directory', 'SSH socket directory must be private to its owner')
      const endpoint = await lstat(socket).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
      if (!endpoint) return { closed: false, reason: 'missing-socket' }
      requireContract(endpoint.isSocket() && !endpoint.isSymbolicLink() && (endpoint.mode & 0o077) === 0
        && (!process.getuid || endpoint.uid === process.getuid()), 'unsafe-tunnel-socket', 'SSH control socket must be private to its owner')
      try {
        await promisify(execFile)('ssh', ['-S', socket, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-O', 'exit', '--', transport.host], { timeout: 30_000 })
      } catch {
        const remaining = await lstat(socket).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
        if (!remaining) return { closed: false, reason: 'missing-socket' }
        throw new TrainingContractError('node-route-close-failed', 'SSH gateway close was not acknowledged; retain its owner record for retry')
      }
      // Never unlink a control socket ourselves or remove a changed owner record.
      requireContract(digestJson(JSON.parse(await readFile(record, 'utf8'))) === digestJson(expected),
        'tunnel-owner-drift', 'SSH route owner changed during close')
      await rm(record)
      return { closed: true }
    })
  }
  private binary(action: 'cas-import' | 'cas-export') {
    requireContract(this.identity, 'node-not-resolved', 'pin a model-node generation before transferring artifacts')
    const command = nodeCommand(this.connection, action)
    const child = spawn(command[0]!, command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
    child.stderr.resume(); child.stdin.on('error', () => {})
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, this.transferTimeoutMs)
    const ended = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => {
        clearTimeout(timer)
        if (timedOut) reject(new TrainingContractError('content-transfer-timeout', 'transfer timed out; retry the same digest'))
        else if (code !== 0) reject(new TrainingContractError('content-transfer-failed', 'node transfer failed; partial objects were not published'))
        else resolve()
      })
    })
    void ended.catch(() => {}) // May reject before the stream consumer reaches its final await.
    return { child, ended, dispose: () => { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGKILL') } }
  }
  async upload(store: TrainingContentStore, ref: ContentRef, expectedSize?: number): Promise<void> {
    const state = await this.call('cas.stat', { digest: ref.digest }) as { present: boolean; size?: number }
    if (state.present) {
      requireContract(Number.isSafeInteger(state.size) && state.size! >= 0 && (expectedSize === undefined || state.size === expectedSize),
        'content-size-drift', 'node object has another size')
      return
    }
    const file = await store.verifyFile(ref)
    requireContract(expectedSize === undefined || file.size === expectedSize, 'content-size-drift', 'source object differs from its snapshot size')
    const envelope = nodeEnvelope(this.identity, 'cas.import', { digest: ref.digest, size: file.size })
    const transfer = this.binary('cas-import'); let response = ''; let length = 0
    const readReply = async () => {
      for await (const chunk of transfer.child.stdout) {
        length += (chunk as Buffer).length
        requireContract(length <= 1024 * 1024, 'node-output-limit', 'CAS acknowledgement exceeded its limit')
        response += chunk.toString()
      }
    }
    async function* content() { yield Buffer.from(JSON.stringify(envelope) + '\n'); yield* createReadStream(file.path) }
    try {
      await Promise.all([pipeline(Readable.from(content()), transfer.child.stdin), readReply(), transfer.ended])
      const result = validateNodeResponse(JSON.parse(response), envelope).result as { present: boolean; size: number }
      requireContract(result.present && result.size === file.size, 'content-import-unacknowledged', 'node did not confirm durable CAS import')
    } finally { transfer.dispose() }
  }
  async download(store: TrainingContentStore, ref: ContentRef): Promise<void> {
    try { await store.verifyFile(ref); return } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    const envelope = nodeEnvelope(this.identity, 'cas.export', { digest: ref.digest })
    const transfer = this.binary('cas-export')
    transfer.child.stdin.end(JSON.stringify(envelope) + '\n')
    const source = transfer.child.stdout[Symbol.asyncIterator]()
    let header = Buffer.alloc(0); let tail: Buffer = Buffer.alloc(0)
    try {
      while (true) {
        const item = await source.next()
        requireContract(!item.done, 'missing-node-header', 'node returned no CAS response header')
        header = Buffer.concat([header, item.value as Buffer])
        const end = header.indexOf(10)
        if (end >= 0) { tail = header.subarray(end + 1); header = header.subarray(0, end); break }
        requireContract(header.length <= 1024 * 1024, 'node-output-limit', 'CAS response header exceeded its limit')
      }
      requireContract(header.length <= 1024 * 1024, 'node-output-limit', 'CAS response header exceeded its limit')
      const result = validateNodeResponse(JSON.parse(header.toString('utf8')), envelope).result as { present: boolean; size: number }
      requireContract(result.present && Number.isSafeInteger(result.size), 'missing-node-content', 'node has no durable object to export')
      async function* content() {
        if (tail.length) yield tail
        while (true) { const next = await source.next(); if (next.done) break; yield next.value as Buffer }
        await transfer.ended // No CAS publication until both bytes and successful process exit are acknowledged.
      }
      await store.importStream(ref, result.size, content())
    } finally { transfer.dispose() }
  }
}

export function contentDependencies(value: unknown): ContentRef[] {
  const refs = new Map<string, ContentRef>()
  const walk = (item: unknown): void => {
    if (Array.isArray(item)) { item.forEach(walk); return }
    if (!item || typeof item !== 'object') return
    const r = item as Record<string, unknown>
    if (Object.keys(r).sort().join(',') === 'digest,mediaType,uri') {
      requireContract(typeof r.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(r.digest) && r.uri === `cas:${r.digest}` && typeof r.mediaType === 'string',
        'nonportable-content-ref', 'distributed artifacts require portable CAS references')
      refs.set(r.digest, r as unknown as ContentRef)
    } else Object.values(r).forEach(walk)
  }
  walk(value); return [...refs.values()]
}

/** Walk only explicit roots. Callers decide which train-only inputs may leave the controller. */
export async function syncContentGraph(transport: ModelNodeTransport, store: TrainingContentStore, roots: ContentRef[], direction: 'upload' | 'download'): Promise<void> {
  const queue = [...roots], seen = new Set<string>()
  let cursor = 0
  while (cursor < queue.length) {
    // Independent immutable objects can share four transfers. Keep traversal
    // bounded, deduplicate before dispatch, and settle every transfer on errors.
    const batch: ContentRef[] = []
    while (cursor < queue.length && batch.length < 4) {
      const ref = queue[cursor++]!
      if (seen.has(ref.digest)) continue
      seen.add(ref.digest); batch.push(ref)
    }
    const results = await Promise.allSettled(batch.map(async ref => {
      if (direction === 'download') await transport.download(store, ref)
      const children = ref.mediaType === 'application/json' ? contentDependencies(await store.readJson(ref)) : []
      if (direction === 'upload') await transport.upload(store, ref)
      return children
    }))
    for (const result of results) if (result.status === 'rejected') throw result.reason
    for (const result of results) if (result.status === 'fulfilled') queue.push(...result.value)
  }
}

/** Snapshot files are opaque bytes. JSON configs are not CAS traversal roots. */
export function snapshotFileEntries(value: unknown): Array<{ contentRef: ContentRef; size: number }> | null {
    const manifest = value as Record<string, unknown> | null
    if (!manifest || manifest.schemaVersion !== 1 || !['hf-safetensors', 'trainer-files'].includes(String(manifest.format))) return null
    requireContract(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 4096,
      'invalid-model-input-snapshot', 'training input must be an explicit bounded model or trainer snapshot')
    const files: Array<{ contentRef: ContentRef; size: number }> = [], names = new Set<string>()
    for (const entry of manifest.files as Record<string, unknown>[]) {
      const file = entry.contentRef as ContentRef
      requireContract(typeof entry.path === 'string' && !entry.path.includes('\\') && !entry.path.startsWith('/')
        && !entry.path.includes('\0') && entry.path.split('/').every(part => part !== '' && part !== '.' && part !== '..') && !names.has(entry.path)
        && Number.isSafeInteger(entry.size) && (entry.size as number) >= 0
        && file && /^sha256:[a-f0-9]{64}$/.test(file.digest) && file.uri === `cas:${file.digest}` && entry.sha256 === file.digest,
      'invalid-model-input-snapshot', 'snapshot file identity or path is invalid')
      names.add(entry.path); files.push({ contentRef: file, size: entry.size as number })
    }
    const allowed = new Set(files.map(file => file.contentRef.digest))
    requireContract(contentDependencies(manifest).every(child => allowed.has(child.digest)),
      'model-input-reference-leak', 'snapshot metadata cannot request controller-only objects')
    return files
}

export async function uploadSnapshotFiles(transport: ModelNodeTransport, store: TrainingContentStore, roots: ContentRef[]): Promise<void> {
  const snapshots: { ref: ContentRef; files: Array<{ contentRef: ContentRef; size: number }> }[] = []
  for (const ref of roots) {
    const files = snapshotFileEntries(await store.readJson(ref))
    requireContract(files, 'invalid-model-input-snapshot', 'training input must be a model or trainer snapshot')
    snapshots.push({ ref, files })
  }
  // Validate every manifest before sending any of its files. Deliberately do
  // not inspect JSON file contents for additional refs, even when they look valid.
  const sent = new Set<string>()
  for (const { ref, files } of snapshots) for (const item of [{ contentRef: ref, size: undefined }, ...files]) {
    if (sent.has(item.contentRef.digest)) continue
    await transport.upload(store, item.contentRef, item.size); sent.add(item.contentRef.digest)
  }
}
