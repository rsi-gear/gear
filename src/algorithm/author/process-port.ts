import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { authorHostIdentityDigest, authorSourceClosureDigest } from './identity.js';
import { checkAuthorModuleSource } from './source-check.js';
import { canonicalJson, jsonDigest } from '../schema.js';
import { AUTHOR_WIRE_VERSION, AUTHOR_WIRE_VERSION_V2, type AuthorReplayRequest, type AuthorReplayReply } from './index.js';

export class AuthorWorkerError extends Error {
  constructor(message: string) { super(message); this.name = 'AuthorWorkerError'; }
}
/** Host-side process transport. The module must be part of the frozen algorithm source closure. */
export class AuthorProcessReplayPort {
  readonly sourceDigest: string;
  readonly hostDigest: string;
  readonly sourceRoot: string;
  readonly hostRoot: string;
  constructor(readonly modulePath: string, readonly exportName: string,
    readonly workerPath = fileURLToPath(new URL('./worker-entry.js', import.meta.url)), readonly timeoutMs = 10_000,
    sourceRoot = dirname(modulePath), hostRoot = dirname(dirname(workerPath)),
    readonly wireVersion: typeof AUTHOR_WIRE_VERSION | typeof AUTHOR_WIRE_VERSION_V2 = AUTHOR_WIRE_VERSION) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Positive author worker timeout required');
    if (wireVersion !== AUTHOR_WIRE_VERSION && wireVersion !== AUTHOR_WIRE_VERSION_V2)
      throw new Error('Unsupported author process wire version');
    this.sourceRoot = resolve(sourceRoot); this.hostRoot = resolve(hostRoot);
    checkAuthorModuleSource(this.modulePath, this.sourceRoot, this.hostRoot);
    const closure = authorSourceClosureDigest(this.sourceRoot);
    this.sourceDigest = wireVersion === AUTHOR_WIRE_VERSION ? closure : jsonDigest({ closure, wireVersion });
    this.hostDigest = authorHostIdentityDigest(this.hostRoot);
  }
  async replay(request: AuthorReplayRequest): Promise<AuthorReplayReply> {
    if (request.version !== this.wireVersion) throw new AuthorWorkerError('Author process wire version drift');
    checkAuthorModuleSource(this.modulePath, this.sourceRoot, this.hostRoot);
    const closure = authorSourceClosureDigest(this.sourceRoot);
    if ((this.wireVersion === AUTHOR_WIRE_VERSION ? closure : jsonDigest({ closure, wireVersion: this.wireVersion })) !== this.sourceDigest
      || authorHostIdentityDigest(this.hostRoot) !== this.hostDigest)
      throw new AuthorWorkerError('Author source/host closure changed during campaign');
    const encoded = canonicalJson(request);
    if (Buffer.byteLength(encoded) > 1024 * 1024) throw new AuthorWorkerError('Author replay request exceeds 1 MiB');
    const child = spawn(process.execPath, [this.workerPath, this.modulePath, this.exportName], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let inputErrorMessage = ''; let timedOut = false;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; if (Buffer.byteLength(stdout) > 1024 * 1024 + 1) child.kill('SIGKILL'); });
    child.stderr.on('data', (chunk: string) => { if (Buffer.byteLength(stderr) < 64 * 1024) stderr += chunk; });
    child.stdin.on('error', error => { inputErrorMessage = error.message; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, this.timeoutMs);
    let status: { code: number | null; signal: NodeJS.Signals | null };
    try {
      child.stdin.end(encoded);
      status = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
    } finally { clearTimeout(timer); }
    if (timedOut) throw new AuthorWorkerError(`Author worker exceeded ${this.timeoutMs} ms`);
    if (status.code !== 0 || status.signal) throw new AuthorWorkerError(`Author worker exited ${status.code ?? status.signal}: ${stderr.trim()}${inputErrorMessage ? ` (${inputErrorMessage})` : ''}`);
    if (inputErrorMessage) throw new AuthorWorkerError(`Author worker input failed: ${inputErrorMessage}`);
    if (Buffer.byteLength(stdout) > 1024 * 1024 + 1) throw new AuthorWorkerError('Author replay reply exceeds 1 MiB');
    const reply = JSON.parse(stdout) as AuthorReplayReply;
    if (reply.status !== 'waiting' && reply.status !== 'completed') throw new AuthorWorkerError('Invalid author worker reply');
    return reply;
  }
}
