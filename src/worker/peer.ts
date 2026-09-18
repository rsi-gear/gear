import { createInterface, type Interface as ReadlineInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

interface JsonRpcFrame {
  jsonrpc?: string
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
}

export type JsonRpcHandler = (params: Record<string, unknown>) => Promise<unknown> | unknown

function paramsRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export class JsonRpcPeer {
  private readonly lines: ReadlineInterface
  private readonly pending = new Map<number, Pending>()
  private readonly handlers = new Map<string, JsonRpcHandler>()
  private serial = 0
  private closed = false

  constructor(private readonly input: Readable, private readonly output: Writable) {
    this.lines = createInterface({ input })
    this.lines.on('line', line => { void this.onLine(line) })
    this.lines.once('close', () => this.close(new Error('JSON-RPC transport closed')))
  }

  handle(method: string, handler: JsonRpcHandler): () => void {
    if (this.handlers.has(method)) throw new Error(`JSON-RPC method already registered: ${method}`)
    this.handlers.set(method, handler)
    return () => { this.handlers.delete(method) }
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('JSON-RPC transport is closed'))
    const id = ++this.serial
    const promise = new Promise<unknown>((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject })
    })
    this.write({ jsonrpc: '2.0', id, method, params })
    return promise
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (!this.closed) this.write({ jsonrpc: '2.0', method, params })
  }

  close(error = new Error('JSON-RPC transport closed')): void {
    if (this.closed) return
    this.closed = true
    this.lines.close()
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  private async onLine(line: string): Promise<void> {
    let frame: JsonRpcFrame
    try {
      frame = JSON.parse(line) as JsonRpcFrame
    } catch {
      return
    }
    if (frame.id !== undefined && frame.method === undefined) {
      const pending = this.pending.get(frame.id)
      if (pending === undefined) return
      this.pending.delete(frame.id)
      if (frame.error !== undefined) pending.reject(new Error(frame.error.message ?? 'JSON-RPC request failed'))
      else pending.resolve(frame.result)
      return
    }
    if (frame.method === undefined) return
    const handler = this.handlers.get(frame.method)
    if (frame.id === undefined) {
      if (handler !== undefined) await Promise.resolve(handler(paramsRecord(frame.params))).catch(() => {})
      return
    }
    if (handler === undefined) {
      this.write({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: `unknown method: ${frame.method}` } })
      return
    }
    try {
      const result = await handler(paramsRecord(frame.params))
      this.write({ jsonrpc: '2.0', id: frame.id, result })
    } catch (error) {
      this.write({
        jsonrpc: '2.0', id: frame.id,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  private write(frame: JsonRpcFrame): void {
    this.output.write(`${JSON.stringify(frame)}\n`)
  }
}
