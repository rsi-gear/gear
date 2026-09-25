import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { authorHostIdentityDigest, authorSourceClosureDigest } from './identity.js';
import { checkAuthorModuleSource } from './source-check.js';
import { admitInstalledAuthorProject, verifyInstalledAuthorAdmission, type InstalledAuthorAdmission } from './installed-loader.js';
import { assertJson, assertSchema, canonicalJson, jsonDigest, type JsonSchema } from '../schema.js';
import { AUTHOR_WIRE_VERSION, AUTHOR_WIRE_VERSION_V2, type AuthorReplayRequest, type AuthorReplayReply } from './index.js';

function assertNodeLoaderEnvironment(): void {
  if (process.env.NODE_OPTIONS || process.env.NODE_PATH)
    throw new AuthorWorkerError('Installed author does not support NODE_OPTIONS or NODE_PATH');
}

export class AuthorWorkerError extends Error {
  constructor(message: string) { super(message); this.name = 'AuthorWorkerError'; }
}
export type AuthorDefinitionDescription = { apiVersion: string; id: string; definitionVersion: string; configSchema?: JsonSchema };

/** Host-side process transport. The module must be part of the frozen algorithm source closure. */
export class AuthorProcessReplayPort {
  readonly sourceDigest: string;
  readonly hostDigest: string;
  /** Only installed mode: disposable compiler cache shown by check/explain. */
  readonly emittedCacheDir: string | undefined;
  readonly sourceRoot: string;
  readonly hostRoot: string;
  constructor(readonly modulePath: string, readonly exportName: string,
    readonly workerPath = fileURLToPath(new URL('./worker-entry.js', import.meta.url)), readonly timeoutMs = 10_000,
    sourceRoot = dirname(modulePath), hostRoot = dirname(dirname(workerPath)),
    readonly wireVersion: typeof AUTHOR_WIRE_VERSION | typeof AUTHOR_WIRE_VERSION_V2 = AUTHOR_WIRE_VERSION,
    private readonly installed?: InstalledAuthorAdmission) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Positive author worker timeout required');
    if (wireVersion !== AUTHOR_WIRE_VERSION && wireVersion !== AUTHOR_WIRE_VERSION_V2)
      throw new Error('Unsupported author process wire version');
    this.sourceRoot = resolve(sourceRoot); this.hostRoot = resolve(hostRoot);
    this.emittedCacheDir = this.installed?.emitRoot;
    if (this.installed) {
      assertNodeLoaderEnvironment();
      if (wireVersion !== AUTHOR_WIRE_VERSION_V2 || this.modulePath !== this.installed.emittedModule)
        throw new Error('Installed author admission requires exact v2 emitted module');
      verifyInstalledAuthorAdmission(this.installed);
      this.sourceDigest = this.installed.sourceDigest;
    } else {
      checkAuthorModuleSource(this.modulePath, this.sourceRoot, this.hostRoot);
      const closure = authorSourceClosureDigest(this.sourceRoot);
      this.sourceDigest = wireVersion === AUTHOR_WIRE_VERSION ? closure : jsonDigest({ closure, wireVersion });
    }
    this.hostDigest = authorHostIdentityDigest(this.hostRoot);
  }
  private assertFrozenIdentity(): void {
    if (this.installed) { assertNodeLoaderEnvironment(); verifyInstalledAuthorAdmission(this.installed); }
    else {
      checkAuthorModuleSource(this.modulePath, this.sourceRoot, this.hostRoot);
      const closure = authorSourceClosureDigest(this.sourceRoot);
      if ((this.wireVersion === AUTHOR_WIRE_VERSION ? closure : jsonDigest({ closure, wireVersion: this.wireVersion })) !== this.sourceDigest)
        throw new AuthorWorkerError('Author source closure changed during campaign');
    }
    if (authorHostIdentityDigest(this.hostRoot) !== this.hostDigest)
      throw new AuthorWorkerError('Author host closure changed during campaign');
  }
  async describeDefinition(): Promise<AuthorDefinitionDescription> {
    const value = await this.invoke(undefined);
    assertJson(value);
    if (!value || Array.isArray(value) || typeof value !== 'object'
      || typeof value.apiVersion !== 'string' || typeof value.id !== 'string' || !value.id
      || typeof value.definitionVersion !== 'string' || !value.definitionVersion)
      throw new AuthorWorkerError('Invalid author definition description');
    if (value.configSchema !== undefined) assertSchema(value.configSchema as JsonSchema);
    return value as AuthorDefinitionDescription;
  }
  async replay(request: AuthorReplayRequest): Promise<AuthorReplayReply> {
    if (request.version !== this.wireVersion) throw new AuthorWorkerError('Author process wire version drift');
    const reply = await this.invoke(request);
    if (!reply || Array.isArray(reply) || typeof reply !== 'object'
      || ((reply as { status?: unknown }).status !== 'waiting'
        && (reply as { status?: unknown }).status !== 'completed'))
      throw new AuthorWorkerError('Invalid author worker reply');
    return reply as AuthorReplayReply;
  }
  private async invoke(request: AuthorReplayRequest | undefined): Promise<unknown> {
    this.assertFrozenIdentity();
    const encoded = request ? canonicalJson(request) : '';
    if (Buffer.byteLength(encoded) > 1024 * 1024) throw new AuthorWorkerError('Author replay request exceeds 1 MiB');
    const workerArgs = [this.workerPath, this.modulePath, this.exportName];
    if (this.installed) workerArgs.push(this.installed.sdkEntryUrl, this.installed.sdkEntryDigest,
      this.installed.emitRoot, this.installed.emitDigest, this.installed.sdkPackageRoot, this.installed.sdkPackageDigest);
    if (!request) workerArgs.push('--describe');
    const child = spawn(process.execPath, workerArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
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
    return JSON.parse(stdout) as unknown;
  }
}

/** External five-file author project: the host chooses its own worker and sealed installed SDK entry. */
export function createInstalledAuthorReplayPort(options: { projectRoot: string; module: string; exportName: string;
  timeoutMs?: number }): AuthorProcessReplayPort {
  const admission = admitInstalledAuthorProject(options.projectRoot, options.module);
  const localWorker = fileURLToPath(new URL('./worker-entry.js', import.meta.url));
  const worker = existsSync(localWorker) ? localWorker
    : fileURLToPath(new URL('../../../lib/algorithm/author/worker-entry.js', import.meta.url));
  if (!existsSync(worker)) throw new Error('Compiled author worker is required for installed projects');
  return new AuthorProcessReplayPort(admission.emittedModule, options.exportName,
    worker, options.timeoutMs ?? 10_000,
    admission.projectRoot, undefined, AUTHOR_WIRE_VERSION_V2, admission);
}
