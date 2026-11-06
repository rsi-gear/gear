import { inspectPython } from './runtime.js'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { relative, isAbsolute } from 'node:path'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import {
  acquireAirGappedSandbox,
  assertAirGappedSandboxActive,
  createAirGappedSandboxConfig,
  sandboxSystemReadPaths,
  type AirGappedSandboxLease,
  type LinuxSandboxIsolation,
} from '../../sandbox.js'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import { validateAlgorithmWire } from '../../domain/algorithm-schema.js'
import type {
  AlgorithmState,
  Decision,
  Json,
  SearchView,
  WorkerRequest,
  WorkerResponse,
} from '../../domain/algorithm-wire.js'

// Includes the UTF-8 JSON envelope and trailing newline; keep Python protocol.py in sync.
export const MAX_ALGORITHM_MESSAGE_BYTES = 64 * 1024 * 1024

const serializedBytes = (value: Json | undefined): number =>
  value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value))

function requestSizeDetails(payload: Json): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ''
  const view = payload.view
  const fields = view && typeof view === 'object' && !Array.isArray(view) ? view : undefined
  // Evidence/completed are nested in view. These field values do not sum to the envelope size.
  return `; serialized field bytes: view=${serializedBytes(view)}, evidence=${serializedBytes(fields?.evidence)}, completed=${serializedBytes(fields?.completed)}, state=${serializedBytes(payload.state)}, algorithm=${serializedBytes(payload.algorithm)} (evidence/completed are included in view)`
}
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
import type { AlgorithmConfig } from '../../domain/run.js'
export type { AlgorithmConfig } from '../../domain/run.js'
export interface PythonWorkerOptions {
  python: string
  /** Frozen framework/algorithm source only, never a project or .gear parent directory. */
  sourceRoot: string
  scratch: string
  implementationIdentity: string
  timeoutMs?: number
  protectedPaths?: string[]
  linuxIsolation?: LinuxSandboxIsolation
}

/** No unsandboxed production fallback. The pure toy kit runs directly in Python. */
export class PythonAlgorithmWorker {
  private child: ChildProcessWithoutNullStreams | undefined
  private lease: AirGappedSandboxLease | undefined
  private stderr = ''
  private responseChunks: Buffer[] = []
  private responseBytes = 0
  private pending:
    { request: WorkerRequest; resolve(value: Json): void; reject(error: Error): void } | undefined
  private failure: Error | undefined
  private closed: Promise<void> | undefined
  constructor(readonly options: PythonWorkerOptions) {}

  async start(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    this.lease = await acquireAirGappedSandbox(this.options.linuxIsolation, 'Python algorithm worker')
    try {
      const python = await inspectPython(this.options.python)
      const sourceRoot = await realpath(this.options.sourceRoot),
        scratch = await realpath(this.options.scratch)
      const contains = (parent: string, child: string): boolean => {
        const path = relative(parent, child)
        return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('../'))
      }
      const runtimePaths = [...sandboxSystemReadPaths(), ...python.readPaths]
      if (
        contains(sourceRoot, scratch) ||
        contains(scratch, sourceRoot) ||
        runtimePaths.some((path) => contains(path, sourceRoot) || contains(path, scratch))
      ) {
        throw new GearError(
          'algorithm-sandbox-overlap',
          'Algorithm source and scratch must be isolated from each other and the interpreter roots',
        )
      }
      for (const path of this.options.protectedPaths ?? []) {
        const protectedPath = await realpath(path)
        if ([...runtimePaths, sourceRoot, scratch].some((root) => contains(root, protectedPath))) {
          throw new GearError(
            'algorithm-sandbox-overlap',
            'Private project artifacts overlap the worker read allowlist',
          )
        }
      }
      const config = await createAirGappedSandboxConfig({
        linuxIsolation: this.options.linuxIsolation,
        allowRead: [...runtimePaths, sourceRoot, scratch],
        allowWrite: [scratch],
      })
      assertAirGappedSandboxActive(config)
      const bootstrap = `import sys;sys.path.extend(${JSON.stringify(python.readPaths.filter((path) => path.endsWith('/site-packages')))});sys.path.insert(0,${JSON.stringify(sourceRoot)});from gear.refine.worker import main;raise SystemExit(main())`
      const wrapped = await SandboxManager.wrapWithSandboxArgv(
        [await realpath(python.executable), '-I', '-B', '-c', bootstrap].map(quote).join(' '),
        '/bin/bash',
        config,
      )
      this.child = spawn(wrapped.argv[0]!, wrapped.argv.slice(1), {
        cwd: scratch,
        detached: process.platform !== 'win32',
        env: {
          PATH: '/usr/bin:/bin',
          HOME: scratch,
          TMPDIR: scratch,
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONNOUSERSITE: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.closed = new Promise((resolve) => this.child!.once('close', () => resolve()))
      this.child.stdout.on('data', (chunk: Buffer) => this.onData(chunk))
      this.child.stderr.on('data', (chunk) => {
        this.stderr = (this.stderr + chunk).slice(-2000)
      })
      this.child.stdin.on('error', () => {})
      this.child.on('error', (error) => this.fail(error))
      this.child.on('close', () =>
        this.fail(
          new GearError(
            'algorithm-worker-crashed',
            `Algorithm worker exited before completion: ${this.stderr}`,
          ),
        ),
      )
      const handshake = await this.request(
        'handshake',
        'handshake',
        0,
        { implementation_identity: this.options.implementationIdentity },
        signal,
      )
      if (
        !handshake ||
        typeof handshake !== 'object' ||
        Array.isArray(handshake) ||
        handshake.protocol_version !== 1 ||
        handshake.implementation_identity !== this.options.implementationIdentity ||
        handshake.max_message_bytes !== MAX_ALGORITHM_MESSAGE_BYTES ||
        JSON.stringify(handshake.operations) !==
          JSON.stringify(['diagnose_seed', 'generate_candidate', 'evaluate_seed', 'nominate', 'stop'])
      ) {
        throw new GearError(
          'algorithm-handshake-mismatch',
          `Worker protocol, implementation or capabilities changed (worker max_message_bytes=${handshake && typeof handshake === 'object' && !Array.isArray(handshake) && typeof handshake.max_message_bytes === 'number' ? handshake.max_message_bytes : 'invalid'}; runtime max_message_bytes=${MAX_ALGORITHM_MESSAGE_BYTES}). Existing runs retain frozen Python source; use a compatible runtime or start a new run`,
        )
      }
    } catch (error) {
      await this.dispose()
      throw error
    }
  }

  async step(
    view: SearchView,
    state: AlgorithmState,
    algorithm: AlgorithmConfig,
    signal: AbortSignal,
  ): Promise<Decision> {
    validateAlgorithmWire('SearchView', view)
    validateAlgorithmWire('AlgorithmState', state)
    const result = await this.request(
      'step',
      view.run_id,
      view.step_id,
      { view, state, algorithm } as unknown as Json,
      signal,
    )
    validateAlgorithmWire('Decision', result)
    return result as unknown as Decision
  }

  private async request(
    method: WorkerRequest['method'],
    runId: string,
    stepId: number,
    payload: Json,
    signal: AbortSignal,
  ): Promise<Json> {
    if (this.failure) throw this.failure
    if (!this.child || this.pending)
      throw new GearError('algorithm-worker-busy', 'Worker is unavailable or has an outstanding request')
    signal.throwIfAborted()
    const request: WorkerRequest = {
      protocol_version: 1,
      request_id: randomUUID(),
      run_id: runId,
      step_id: stepId,
      input_digest: canonicalDigest(payload),
      method,
      payload,
    }
    const bytes = Buffer.from(`${JSON.stringify(request)}\n`)
    if (bytes.length > MAX_ALGORITHM_MESSAGE_BYTES)
      throw new GearError(
        'algorithm-message-too-large',
        `Algorithm request is ${bytes.length} bytes; protocol limit is ${MAX_ALGORITHM_MESSAGE_BYTES} bytes${requestSizeDetails(payload)}`,
      )
    const timeout = setTimeout(
      () => this.fail(new GearError('algorithm-step-timeout', 'Algorithm step timed out')),
      this.options.timeoutMs ?? 30_000,
    )
    const cancel = (): void => this.fail(new GearError('algorithm-cancelled', 'Algorithm decision cancelled'))
    signal.addEventListener('abort', cancel, { once: true })
    try {
      return await new Promise<Json>((resolve, reject) => {
        this.pending = { request, resolve, reject }
        this.child!.stdin.write(bytes)
      })
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', cancel)
    }
  }

  private onData(chunk: Buffer): void {
    if (this.failure) return
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset)
      const end = newline === -1 ? chunk.length : newline + 1
      const part = chunk.subarray(offset, end)
      const receivedBytes = this.responseBytes + part.length
      if (receivedBytes > MAX_ALGORITHM_MESSAGE_BYTES)
        return this.fail(
          new GearError(
            'algorithm-message-too-large',
            `Worker response received ${receivedBytes} bytes; protocol limit is ${MAX_ALGORITHM_MESSAGE_BYTES} bytes`,
          ),
        )
      this.responseChunks.push(part)
      this.responseBytes = receivedBytes
      if (newline === -1) return
      // Copy each complete frame once, rather than copying the accumulated response per chunk.
      const frame = Buffer.concat(this.responseChunks, this.responseBytes)
      this.responseChunks = []
      this.responseBytes = 0
      const line = frame.subarray(0, frame.length - 1)
      offset = end
      try {
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line))
        validateAlgorithmWire('WorkerResponse', value)
        const response = value as WorkerResponse,
          pending = this.pending
        if (
          !pending ||
          ['request_id', 'run_id', 'step_id', 'input_digest'].some(
            (key) => response[key as keyof WorkerResponse] !== pending.request[key as keyof WorkerRequest],
          )
        ) {
          throw new GearError('algorithm-stale-response', 'Duplicate or stale algorithm response')
        }
        if (response.error) throw new GearError(response.error.code, response.error.message)
        this.pending = undefined
        pending.resolve(response.result)
      } catch (error) {
        return this.fail(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  private fail(error: Error): void {
    this.responseChunks = []
    this.responseBytes = 0
    this.failure ??= error
    this.pending?.reject(error)
    this.pending = undefined
    if (this.child?.pid) {
      try {
        process.kill(process.platform === 'win32' ? this.child.pid : -this.child.pid, 'SIGKILL')
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== 'ESRCH') throw failure
      }
    }
  }
  async dispose(): Promise<void> {
    this.fail(new GearError('algorithm-worker-disposed', 'Worker has been disposed'))
    await this.closed
    await this.lease?.release()
    this.lease = undefined
  }
}
