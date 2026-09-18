import { chmod, lstat, mkdir, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import type { RefineSkillGateway } from './gateway.js'

interface RequestEnvelope { id: string; method: string; params: unknown }

function envelope(value: unknown): RequestEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('request must be an object')
  const request = value as Record<string, unknown>
  if (typeof request.id !== 'string' || request.id.length === 0) throw new TypeError('request id is required')
  if (typeof request.method !== 'string' || request.method.length === 0) throw new TypeError('request method is required')
  return { id: request.id, method: request.method, params: request.params ?? {} }
}

function write(socket: Socket, value: unknown): void {
  socket.write(`${JSON.stringify(value)}\n`)
}

export class RefineSkillServer {
  private server: Server | undefined
  private ownsSocketPath = false
  private readonly sockets = new Set<Socket>()

  constructor(readonly socketPath: string, private readonly gateway: RefineSkillGateway) {}

  async start(): Promise<void> {
    if (this.server !== undefined) return
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') {
      try {
        const existing = await lstat(this.socketPath)
        if (!existing.isSocket()) throw new Error(`refusing to replace non-socket path: ${this.socketPath}`)
        await rm(this.socketPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const server = createServer(socket => this.accept(socket))
    this.server = server
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(this.socketPath, () => {
          server.off('error', reject)
          this.ownsSocketPath = true
          resolve()
        })
      })
      if (process.platform !== 'win32') await chmod(this.socketPath, 0o600)
    } catch (error) {
      this.server = undefined
      server.close()
      if (this.ownsSocketPath && process.platform !== 'win32') await rm(this.socketPath, { force: true })
      this.ownsSocketPath = false
      throw error
    }
  }

  async dispose(): Promise<void> {
    const server = this.server
    const ownsSocketPath = this.ownsSocketPath
    this.server = undefined
    this.ownsSocketPath = false
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    if (server !== undefined) await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
    if (ownsSocketPath && process.platform !== 'win32') await rm(this.socketPath, { force: true })
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))
    socket.setEncoding('utf8')
    let buffer = ''
    let closed = false
    const fail = (message: string): void => {
      if (closed) return
      closed = true
      write(socket, { id: null, error: { message } })
      socket.end()
    }
    socket.on('data', chunk => {
      if (closed) return
      buffer += chunk
      if (Buffer.byteLength(buffer) > this.gateway.maxRequestBytes) {
        fail(`request exceeds ${this.gateway.maxRequestBytes} bytes`)
        return
      }
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (line.trim().length === 0) continue
        void this.handle(socket, line)
      }
    })
    socket.on('error', () => {})
  }

  private async handle(socket: Socket, line: string): Promise<void> {
    let id: string | null = null
    try {
      const request = envelope(JSON.parse(line))
      id = request.id
      const result = await this.gateway.call(request.method, request.params)
      write(socket, { id, result })
    } catch (error) {
      write(socket, { id, error: { message: error instanceof Error ? error.message : String(error) } })
    }
  }
}
