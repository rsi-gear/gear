import { randomUUID } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile } from 'node:fs/promises'
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
  const command = [...connection.python, '-m', 'gear_training.node', action, '--config', connection.configPath]
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
  async call(operation: string, payload: unknown, requestId?: string): Promise<unknown> {
    requireContract(this.identity !== null || operation === 'probe', 'node-not-resolved', 'probe and pin a node generation before performing work')
    const envelope = nodeEnvelope(this.identity, operation, payload, requestId)
    let value: unknown
    const readOnly = ['probe', 'training.inspect', 'cas.stat', 'training.episodes.receipts'].includes(operation)
    const verifiesFiles = ['cas.retain', 'cas.hfManifest', 'cas.sealHf'].includes(operation)
    const deadline = Date.now() + (verifiesFiles ? this.transferTimeoutMs : this.timeoutMs)
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
    const { gateway, transport } = this.connection
    requireContract(this.identity && nodePort === gateway.nodePort, 'gateway-port-drift', 'node gateway differs from its explicit stable route')
    if (transport.type === 'local') {
      requireContract(gateway.localPort === gateway.nodePort, 'gateway-port-drift', 'local model gateway ports must match')
    } else {
      const identity = digestJson({ node: this.identity, connection: this.connection })
      const directory = join('/tmp', `gear-node-${process.getuid?.() ?? 'user'}-${digestJson(controllerDirectory).slice(-12)}`)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const permissions = await lstat(directory)
      requireContract(permissions.isDirectory() && !permissions.isSymbolicLink() && (permissions.mode & 0o077) === 0
        && (!process.getuid || permissions.uid === process.getuid()), 'unsafe-tunnel-directory', 'SSH socket directory must be private to its owner')
      const socket = join(directory, identity.slice(-20) + '.sock')
      const record = join(controllerDirectory, 'node-routes', identity.slice(7) + '.json')
      const invoke = (args: string[]) => promisify(execFile)('ssh', args, { timeout: 30_000 })
      await withTrainingFileLock(record + '.lock', async () => {
        let previous: { identity: string } | undefined
        try { previous = JSON.parse(await readFile(record, 'utf8')) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
        requireContract(!previous || previous.identity === identity, 'tunnel-owner-drift', 'SSH route identity changed')
        const common = ['-S', socket, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15']
        if (previous) { try { await invoke([...common, '-O', 'check', '--', transport.host]); return } catch {} }
        await atomicWrite(record, { identity, node: this.identity, connection: this.connection })
        try {
          await invoke([...common, '-M', '-fNT', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
            '-L', `127.0.0.1:${gateway.localPort}:127.0.0.1:${gateway.nodePort}`, '--', transport.host])
        } catch { throw new TrainingContractError('node-route-unavailable', 'SSH gateway could not be established; retain the original policy and job identity') }
      })
    }
    return `http://127.0.0.1:${gateway.localPort}`
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
  const queue = [...roots]; const seen = new Set<string>()
  for (let i = 0; i < queue.length; i++) {
    const ref = queue[i]!
    if (seen.has(ref.digest)) continue
    seen.add(ref.digest)
    if (direction === 'download') await transport.download(store, ref)
    if (ref.mediaType === 'application/json') queue.push(...contentDependencies(await store.readJson(ref)))
    if (direction === 'upload') await transport.upload(store, ref)
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
