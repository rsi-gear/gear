import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import { resolve, isAbsolute } from 'node:path';
import { assertJson, type JsonValue } from '../schema.js';
import type { ArtifactRef } from '../contracts.js';

const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_LOG_BYTES = 64 * 1024;

export class PythonHostError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'PythonHostError'; }
}

/** A framed exception from Python author code, distinct from timeout or lost connection. */
export class PythonRemoteError extends PythonHostError {
  constructor(code: string, message: string) { super(code, message); this.name = 'PythonRemoteError'; }
}

export type PythonWorkerOptions = {
  configDir: string;
  module: string;
  export: string;
  interpreter: string;
  mode: 'algorithm' | 'component' | 'provider' | 'author';
  sdkPath?: string;
  timeoutMs?: number;
  recordDir?: string;
  artifactBridge?: { putBytes(bytes: Uint8Array, mediaType: string, schemaId?: string): ArtifactRef; getBytes(ref: ArtifactRef): Uint8Array };
};

type Pending = { resolve(value: JsonValue): void; reject(error: Error): void; timer: NodeJS.Timeout };

async function waitForChildExit(exit: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([exit, new Promise<void>(resolveDelay => { timer = setTimeout(resolveDelay, timeoutMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}



export class PythonWorker {
  readonly #options: PythonWorkerOptions;
  readonly #token = randomBytes(32).toString('hex');
  readonly #workerId = randomBytes(16).toString('hex');
  readonly #pending = new Map<string, Pending>();
  #server: Server | undefined;
  #socket: Socket | undefined;
  #child: ChildProcessWithoutNullStreams | undefined;
  #childExit: Promise<void> | undefined;
  #buffer = Buffer.alloc(0);
  #nextId = 0;
  #callQueue: Promise<unknown> = Promise.resolve();
  #ready = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #logs = '';

  private constructor(options: PythonWorkerOptions) { this.#options = options; }

  static async start(options: PythonWorkerOptions, signal?: AbortSignal): Promise<PythonWorker> {
    if (signal?.aborted) throw new PythonHostError('CANCELLED', 'Python worker startup cancelled');
    const worker = new PythonWorker(options);
    let cancel: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      cancel = () => {
        reject(new PythonHostError('CANCELLED', 'Python worker startup cancelled'));
        void worker.close();
      };
    });
    let deadline: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => reject(new PythonHostError('TIMEOUT', 'Python worker startup timed out')),
        options.timeoutMs ?? 10_000);
    });
    if (cancel) signal?.addEventListener('abort', cancel, { once: true });
    try {
      await Promise.race(signal ? [worker.#start(), aborted, timeout] : [worker.#start(), timeout]);
      if (signal?.aborted) throw new PythonHostError('CANCELLED', 'Python worker startup cancelled');
      return worker;
    } catch (error) {
      await worker.close();
      throw error;
    } finally {
      if (deadline) clearTimeout(deadline);
      if (cancel) signal?.removeEventListener('abort', cancel);
    }
  }

  get logs(): string { return this.#logs; }
  get closed(): boolean { return this.#closed; }

  async #start(): Promise<void> {
    const options = this.#options;
    if (!options.module || !options.export || !options.interpreter) throw new PythonHostError('CONFIG', 'Python module, export and interpreter are required');
    const configDir = resolve(options.configDir);
    const interpreter = options.interpreter.includes('/') || options.interpreter.includes('\\')
      ? (isAbsolute(options.interpreter) ? options.interpreter : resolve(configDir, options.interpreter))
      : options.interpreter;
    const server = createServer();
    this.#server = server;
    await new Promise<void>((resolveReady, rejectReady) => {
      server.once('error', rejectReady);
      server.listen(0, '127.0.0.1', () => { server.off('error', rejectReady); resolveReady(); });
    });
    if (this.#closed) throw new PythonHostError('CANCELLED', 'Python worker startup cancelled');
    const address = server.address();
    if (!address || typeof address === 'string') throw new PythonHostError('LISTEN', 'loopback listener has no TCP port');
    const environment: NodeJS.ProcessEnv = { ...process.env, GEAR_ALGORITHM_TOKEN: this.#token, GEAR_ALGORITHM_WORKER_ID: this.#workerId, PYTHONDONTWRITEBYTECODE: '1' };
    if (options.recordDir) environment.GEAR_ALGORITHM_PROVIDER_RECORD_DIR = resolve(options.recordDir);
    if (options.sdkPath) environment.PYTHONPATH = [resolve(options.sdkPath), environment.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':');
    const child = spawn(interpreter, ['-m', 'gear_algorithm.worker', '--port', String(address.port), '--module', options.module,
      '--export', options.export, '--config-dir', configDir, '--mode', options.mode], { cwd: configDir, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    this.#child = child;
    this.#childExit = new Promise(resolveExit => child.once('exit', () => resolveExit()));
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk: Buffer) => { this.#logs = (this.#logs + chunk.toString('utf8')).slice(-MAX_LOG_BYTES); });
    }
    const timeoutMs = options.timeoutMs ?? 10_000;
    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        const timer = setTimeout(() => rejectReady(new PythonHostError('TIMEOUT', 'Python worker handshake timed out')), timeoutMs);
        const fail = (error: Error) => { clearTimeout(timer); rejectReady(error); };
        child.once('error', error => fail(new PythonHostError('SPAWN', error.message)));
        child.once('exit', (code, signal) => {
          if (!this.#ready) fail(new PythonHostError('EXIT', `Python worker exited before handshake (${code ?? signal})`));
          this.#failAll(new PythonHostError('EXIT', `Python worker exited (${code ?? signal})`));
        });
        server.on('connection', socket => {
          if (this.#socket) { socket.destroy(); return; }
          this.#socket = socket;
          socket.on('data', chunk => {
            try {
              this.#buffer = Buffer.concat([this.#buffer, chunk]);
              this.#drain(frame => {
                if (!this.#ready) {
                  if (frame.type !== 'hello' || frame.version !== 1 || frame.token !== this.#token || frame.workerId !== this.#workerId) {
                    throw new PythonHostError('AUTH', 'Python worker handshake rejected');
                  }
                  this.#ready = true;
                  this.#send({ type: 'hello-ack', version: 1, workerId: this.#workerId });
                  clearTimeout(timer);
                  resolveReady();
                } else this.#handleFrame(frame);
              });
            } catch (error) {
              const failure = error instanceof Error ? error : new PythonHostError('PROTOCOL', String(error));
              fail(failure);
              this.#failAll(failure);
              void this.close();
            }
          });
          socket.once('close', () => {
            const error = new PythonHostError('DISCONNECT', 'Python worker connection closed');
            if (!this.#ready) fail(error);
            this.#failAll(error);
          });
        });
      });
    } catch (error) {
      await this.close();
      throw error;
    }
    if (this.#closed) throw new PythonHostError('CANCELLED', 'Python worker startup cancelled');
  }

  #drain(onFrame: (frame: Record<string, JsonValue>) => void): void {
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32BE(0);
      if (length === 0 || length > MAX_FRAME_BYTES) throw new PythonHostError('FRAME', 'invalid or oversized Python frame');
      if (this.#buffer.length < length + 4) return;
      const bytes = this.#buffer.subarray(4, length + 4);
      this.#buffer = this.#buffer.subarray(length + 4);
      let parsed: unknown;
      try { parsed = JSON.parse(bytes.toString('utf8')); }
      catch { throw new PythonHostError('FRAME', 'invalid Python JSON frame'); }
      assertJson(parsed);
      if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') throw new PythonHostError('FRAME', 'Python frame must be object');
      onFrame(parsed);
    }
  }

  #send(frame: Record<string, JsonValue>): void {
    assertJson(frame);
    const data = Buffer.from(JSON.stringify(frame), 'utf8');
    if (data.length === 0 || data.length > MAX_FRAME_BYTES) throw new PythonHostError('FRAME', 'outgoing Python frame too large');
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(data.length);
    if (!this.#socket?.writable) throw new PythonHostError('DISCONNECT', 'Python worker is disconnected');
    this.#socket.write(Buffer.concat([prefix, data]));
  }

  #handleFrame(frame: Record<string, JsonValue>): void {
    if (frame.type === 'request') { void this.#handleWorkerRequest(frame); return; }
    if (frame.type !== 'response' || typeof frame.id !== 'string') throw new PythonHostError('PROTOCOL', 'unexpected Python frame');
    const pending = this.#pending.get(frame.id);
    if (!pending) return; // Late response from a timed out request cannot affect its successor.
    this.#pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.error !== undefined) {
      const error = frame.error;
      if (error === null || Array.isArray(error) || typeof error !== 'object' || typeof error.code !== 'string' || typeof error.message !== 'string') {
        pending.reject(new PythonHostError('PROTOCOL', 'invalid Python error envelope'));
      } else pending.reject(new PythonRemoteError(error.code, error.message));
    } else if (Object.hasOwn(frame, 'result')) pending.resolve(frame.result!);
    else pending.reject(new PythonHostError('PROTOCOL', 'Python response has no result'));
  }

  async #handleWorkerRequest(frame: Record<string, JsonValue>): Promise<void> {
    const id = frame.id;
    if (typeof id !== 'string' || !id.startsWith(`artifact:${this.#workerId}:`)) {
      void this.close(); return;
    }
    try {
      const bridge = this.#options.artifactBridge;
      if (!bridge) throw new PythonHostError('ARTIFACT', 'artifact bridge is unavailable');
      const params = frame.params;
      if (params === null || Array.isArray(params) || typeof params !== 'object') throw new PythonHostError('ARTIFACT', 'invalid artifact request');
      let result: JsonValue;
      if (frame.method === 'artifact.put') {
        if (typeof params.contentBase64 !== 'string' || typeof params.mediaType !== 'string' ||
            (params.schemaId !== undefined && typeof params.schemaId !== 'string')) throw new PythonHostError('ARTIFACT', 'invalid artifact put');
        const bytes = Buffer.from(params.contentBase64, 'base64');
        if (bytes.toString('base64') !== params.contentBase64) throw new PythonHostError('ARTIFACT', 'invalid artifact base64');
        result = bridge.putBytes(bytes, params.mediaType, params.schemaId as string | undefined);
      } else if (frame.method === 'artifact.get') {
        const ref = params.ref as ArtifactRef;
        if (!ref || ref.kind !== 'artifact') throw new PythonHostError('ARTIFACT', 'invalid artifact ref');
        result = { contentBase64: Buffer.from(bridge.getBytes(ref)).toString('base64') };
      } else throw new PythonHostError('ARTIFACT', 'unsupported artifact method');
      this.#send({ type: 'response', id, result });
    } catch (error) {
      this.#send({ type: 'response', id, error: { code: 'ARTIFACT', message: error instanceof Error ? error.message : String(error) } });
    }
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
  }

  async call(method: string, params: JsonValue = null, timeoutMs = this.#options.timeoutMs ?? 10_000): Promise<JsonValue> {
    const active = this.#callQueue.then(() => this.#callNow(method, params, timeoutMs));
    this.#callQueue = active.catch(() => undefined);
    return active;
  }

  async #callNow(method: string, params: JsonValue, timeoutMs: number): Promise<JsonValue> {
    if (!this.#ready || this.#closed) throw new PythonHostError('DISCONNECT', 'Python worker is unavailable');
    assertJson(params);
    const id = `${this.#workerId}:${++this.#nextId}`;
    return new Promise<JsonValue>((resolveReady, rejectReady) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rejectReady(new PythonHostError('TIMEOUT', `Python ${method} timed out`));
        void this.close();
      }, timeoutMs);
      this.#pending.set(id, { resolve: resolveReady, reject: rejectReady, timer });
      try { this.#send({ type: 'request', id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        rejectReady(error);
      }
    });
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.#closeNow();
    return this.#closePromise;
  }

  async #closeNow(): Promise<void> {
    this.#failAll(new PythonHostError('CLOSED', 'Python worker closed'));
    this.#socket?.destroy();
    this.#child?.kill('SIGTERM');
    if (this.#childExit) {
      await waitForChildExit(this.#childExit, 1000);
      if (this.#child?.exitCode === null && this.#child.signalCode === null) {
        this.#child.kill('SIGKILL');
        await waitForChildExit(this.#childExit, 1000);
      }
    }
    await new Promise<void>(resolveReady => { if (!this.#server) return resolveReady(); this.#server.close(() => resolveReady()); });
  }
}
