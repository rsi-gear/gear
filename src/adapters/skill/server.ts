import { chmod, lstat, mkdir, rm } from 'node:fs/promises'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { GearError } from '../../domain/errors.js'
import { withFileLock } from '../storage/file-lock.js'

export interface SkillGateway {
  readonly maxRequestBytes: number
  call(method: string, params: unknown, requestId?: string): Promise<unknown>
}
interface RequestEnvelope {
  id: string
  method: string
  params: unknown
}
function envelope(value: unknown): RequestEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('request must be an object')
  const request = value as Record<string, unknown>
  if (typeof request.id !== 'string' || !request.id || request.id.length > 1024)
    throw new TypeError('request id is required (at most 1024 characters)')
  if (typeof request.method !== 'string' || !request.method || request.method.length > 128)
    throw new TypeError('request method is required (at most 128 characters)')
  return { id: request.id, method: request.method, params: request.params ?? {} }
}
function write(socket: Socket, value: unknown): void {
  if (!socket.destroyed && !socket.writableEnded) socket.write(`${JSON.stringify(value)}\n`)
}
async function assertStale(path: string): Promise<void> {
  const socket = connect(path)
  try {
    await new Promise<void>((resolve, reject) => {
      socket.setTimeout(1000, () =>
        reject(new GearError('socket-busy', 'Existing socket did not respond; refusing to replace it')),
      )
      socket.once('connect', () =>
        reject(new GearError('socket-busy', 'Another controller is using this socket')),
      )
      socket.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve()
        else reject(error)
      })
    })
  } finally {
    socket.destroy()
  }
}

export class RefineSkillServer {
  private server: Server | undefined
  private readonly sockets = new Set<Socket>()
  private readonly pending = new Set<Promise<void>>()
  private starting: Promise<void> | undefined
  private ownership: Promise<void> | undefined
  private release: (() => void) | undefined
  constructor(
    readonly socketPath: string,
    private readonly gateway: SkillGateway,
  ) {}

  start(): Promise<void> {
    if (this.starting) return this.starting
    const ready = Promise.withResolvers<void>(),
      hold = Promise.withResolvers<void>()
    this.release = hold.resolve
    this.starting = ready.promise
    // The lock lives beside the socket, never on the replaceable socket inode.
    this.ownership = withFileLock(`${this.socketPath}.lock`, async () => {
      try {
        await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 })
        if (process.platform !== 'win32') {
          try {
            const existing = await lstat(this.socketPath)
            if (!existing.isSocket())
              throw new Error(`refusing to replace non-socket path: ${this.socketPath}`)
            await assertStale(this.socketPath)
            await rm(this.socketPath, { force: true })
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
        const server = createServer((socket) => this.accept(socket))
        this.server = server
        let owns = false
        try {
          await new Promise<void>((resolve, reject) => {
            server.once('error', reject)
            server.listen(this.socketPath, () => {
              server.off('error', reject)
              owns = true
              resolve()
            })
          })
          if (process.platform !== 'win32') await chmod(this.socketPath, 0o600)
          ready.resolve()
          await hold.promise
        } finally {
          for (const socket of this.sockets) socket.destroy()
          this.sockets.clear()
          if (server.listening)
            await new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            )
          await Promise.all(this.pending)
          if (owns && process.platform !== 'win32') await rm(this.socketPath, { force: true })
          this.server = undefined
        }
      } catch (error) {
        ready.reject(error)
        throw error
      }
    })
    void this.ownership.catch((error) => ready.reject(error))
    return this.starting
  }
  async dispose(): Promise<void> {
    this.release?.()
    try {
      await this.ownership
    } finally {
      this.starting = undefined
      this.ownership = undefined
      this.release = undefined
    }
  }
  private accept(socket: Socket): void {
    socket.setEncoding('utf8')
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))
    let buffer = '',
      closed = false
    const fail = (message: string): void => {
      if (closed) return
      closed = true
      write(socket, { id: null, error: { code: 'invalid-request', message } })
      socket.end()
    }
    socket.on('data', (chunk) => {
      if (closed) return
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (Buffer.byteLength(line) > this.gateway.maxRequestBytes) {
          fail(`request exceeds ${this.gateway.maxRequestBytes} bytes`)
          return
        }
        if (line.trim()) {
          const pending = this.handle(socket, line).finally(() => this.pending.delete(pending))
          this.pending.add(pending)
        }
        newline = buffer.indexOf('\n')
      }
      if (Buffer.byteLength(buffer) > this.gateway.maxRequestBytes)
        fail(`request exceeds ${this.gateway.maxRequestBytes} bytes`)
    })
    socket.on('error', () => {})
  }
  private async handle(socket: Socket, line: string): Promise<void> {
    let id: string | null = null
    try {
      const request = envelope(JSON.parse(line))
      id = request.id
      const result = await this.gateway.call(request.method, request.params, request.id)
      write(socket, { id, result })
    } catch (error) {
      write(socket, {
        id,
        error:
          error instanceof GearError
            ? error.toJSON()
            : { code: 'request-failed', message: error instanceof Error ? error.message : String(error) },
      })
    }
  }
}
