import { resolvePythonExecutable } from './interpreter.js'
import { Worker } from 'node:worker_threads'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** Capture trusted package files, rejecting link or oversized source substitutions. */
export function capturePolicySources(root: string, names: string[]): Record<string, string> {
  const sources: Record<string, string> = {}
  function capture(relative: string): void {
    const path = join(root, 'python', relative)
    const info = lstatSync(path)
    if (info.isSymbolicLink()) throw new Error('Packaged policy source cannot be a symlink')
    if (info.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        if (name !== '__pycache__') capture(`${relative}/${name}`)
      }
    } else if (relative.endsWith('.py')) {
      if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024)
        throw new Error('Invalid packaged Python policy source')
      sources[relative] = readFileSync(path, 'utf8')
    }
  }
  for (const name of names) capture(name)
  return sources
}

/** One independent worker and bounded cache for one immutable source snapshot. */
export function createPackagedPolicy(root: string, sourceSnapshot: Record<string, string>) {
  const sources = Object.freeze({ ...sourceSnapshot })
  const serializedSources = JSON.stringify(sources)
  const bootstrap = readFileSync(join(root, 'python/gear/refine/builtin_transport.py'), 'utf8')
  const transport = readFileSync(join(root, 'assets/python-policy-worker.cjs'), 'utf8')
  const builtinPolicyImplementationDigest = `sha256:${createHash('sha256').update(serializedSources).update(bootstrap).update(transport).digest('hex')}`
  const maxReplyBytes = 16 * 1024 * 1024
  interface PolicyRuntime {
    python: string
    worker: Worker
    pid: Int32Array
    reply: SharedArrayBuffer
    failure?: Error
  }
  let runtime: PolicyRuntime | undefined
  function disposeRuntime(): void {
    if (!runtime) return
    const current = runtime
    runtime = undefined
    const pid = Atomics.load(current.pid, 0)
    if (pid) {
      try {
        process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    void current.worker.terminate()
  }
  process.once('exit', disposeRuntime)
  function invoke(python: string, json: string): string {
    if (runtime?.python !== python || runtime?.failure) disposeRuntime()
    if (!runtime) {
      const pid = new Int32Array(new SharedArrayBuffer(4))
      const worker = new Worker(transport, {
        eval: true,
        // The internal CommonJS transport must not inherit a caller's ESM eval
        // flags, custom loaders, or preloads (including Python SDK invocations).
        execArgv: [],
        env: {},
        workerData: {
          python,
          bootstrap,
          sources,
          pid: pid.buffer,
          maxBytes: maxReplyBytes,
          env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT },
        },
      })
      const current: PolicyRuntime = { python, worker, pid, reply: new SharedArrayBuffer(maxReplyBytes + 8) }
      worker.on('error', (error) => {
        current.failure = error
      })
      worker.on('exit', (code) => {
        current.failure ??= new Error(`Python policy transport exited (${code})`)
      })
      worker.unref()
      runtime = current
    }
    const buffer = runtime.reply
    const control = new Int32Array(buffer, 0, 2)
    Atomics.store(control, 0, 0)
    runtime.worker.postMessage({ json, buffer })
    if (Atomics.wait(control, 0, 0, 30_000) === 'timed-out') {
      disposeRuntime()
      throw new Error('Python policy decision timed out')
    }
    return Buffer.from(buffer, 8, Atomics.load(control, 1)).toString('utf8')
  }

  /** Fixed, packaged Python policies. User algorithms use the isolated async worker. */
  // These packaged functions depend only on their frozen source and JSON input.
  // Keep serialized replies so callers never share mutable results. Bound both
  // entry count and bytes: large benchmark projections must not accumulate here.
  const replies = new Map<string, { json: string; bytes: number }>()
  let replyBytes = 0
  const cacheByteLimit = 16 * 1024 * 1024
  function builtinPolicy<T>(operation: string, input: unknown, configuredPython?: string): T {
    const python = configuredPython ?? resolvePythonExecutable(true)
    const request = JSON.stringify({ operation, input })
    const key = createHash('sha256').update(python).update('\0').update(request).digest('hex')
    const cached = replies.get(key)
    if (cached) {
      replies.delete(key)
      replies.set(key, cached)
      return (JSON.parse(cached.json) as { value: T }).value
    }
    const output = invoke(python, request)
    const reply = JSON.parse(output) as { value?: T; error?: string; type?: string }
    if (reply.error) {
      if (reply.type === 'TransportError') disposeRuntime()
      if (reply.type === 'TypeError' || reply.type === 'ValueError') throw new TypeError(reply.error)
      throw new Error(reply.error)
    }
    const bytes = Buffer.byteLength(output)
    if (bytes <= 1024 * 1024) {
      while (replies.size >= 1024 || replyBytes + bytes > cacheByteLimit) {
        const oldest = replies.keys().next().value!
        replyBytes -= replies.get(oldest)!.bytes
        replies.delete(oldest)
      }
      replies.set(key, { json: output, bytes })
      replyBytes += bytes
    }
    return reply.value as T
  }

  return { builtinPolicy, builtinPolicyImplementationDigest }
}
