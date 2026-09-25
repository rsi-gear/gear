import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, jsonDigest, type JsonValue } from '../schema.js';
import { PythonWorker, type PythonWorkerOptions } from '../hosts/python.js';
import { AUTHOR_WIRE_VERSION, AUTHOR_WIRE_VERSION_V2, type AuthorReplayReply } from './index.js';
import { authorHostIdentityDigest, authorSourceClosureDigest } from './identity.js';
import type { ReplayPort } from './adapter.js';

export type PythonAuthorReplayOptions = Omit<PythonWorkerOptions, 'mode'> & {
  signal?: AbortSignal;
  /** Transport identity is frozen before the first Campaign decision. */
  wireVersion?: typeof AUTHOR_WIRE_VERSION | typeof AUTHOR_WIRE_VERSION_V2;
  /** Maximum wait to use the admitted worker for its only replay. */
  admissionIdleMs?: number;
};
export type SealedPythonReplayPort = ReplayPort & {
  sourceDigest: string;
  hostDigest: string;
  close(): Promise<void>;
};
type Environment = { executable: string; version: string; packages: JsonValue; loadedFiles: [string, string][]; executableSha256: string };

function loadedFiles(value: unknown): [string, string][] {
  if (!Array.isArray(value)) throw new Error('Invalid Python loadedModules');
  const unique = new Map<string, string>();
  for (const row of value) {
    if (!Array.isArray(row) || row.length !== 3 || typeof row[1] !== 'string' || typeof row[2] !== 'string')
      throw new Error('Invalid Python loadedModules entry');
    const prior = unique.get(row[1]);
    if (prior && prior !== row[2]) throw new Error('Conflicting Python module digest');
    unique.set(row[1], row[2]);
  }
  return [...unique].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}
function containedModule(projectRoot: string, module: string): string {
  if (!module.endsWith('.py')) throw new Error('Python author module must be an explicit .py path inside configDir');
  const path = realpathSync(isAbsolute(module) ? module : resolve(projectRoot, module));
  const name = relative(projectRoot, path);
  if (!name || name === '..' || name.startsWith('../') || isAbsolute(name))
    throw new Error('Python author module escapes frozen configDir');
  return path;
}
function shaFile(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex'); }

/** Admission and first replay share one process; subsequent replays use fresh processes. */
export async function createPythonAuthorReplayPort(options: PythonAuthorReplayOptions): Promise<SealedPythonReplayPort> {
  const { signal, admissionIdleMs = 30_000, wireVersion = AUTHOR_WIRE_VERSION, ...workerOptions } = options;
  if (wireVersion !== AUTHOR_WIRE_VERSION && wireVersion !== AUTHOR_WIRE_VERSION_V2)
    throw new Error('Unsupported Python author replay wire version');
  if (!Number.isSafeInteger(admissionIdleMs) || admissionIdleMs < 1 || admissionIdleMs > 60_000)
    throw new Error('Python author admission idle timeout must be 1..60000 ms');
  if (signal?.aborted) throw new Error('Python author admission cancelled');
  const projectRoot = realpathSync(workerOptions.configDir);
  const modulePath = containedModule(projectRoot, workerOptions.module);
  if (!workerOptions.sdkPath) throw new Error('Python author requires an explicit frozen sdkPath');
  const sdkRoot = realpathSync(workerOptions.sdkPath);
  const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const closure = (): JsonValue => ({ project: authorSourceClosureDigest(projectRoot),
    sdk: authorSourceClosureDigest(sdkRoot), modulePath, moduleSha256: shaFile(modulePath), export: workerOptions.export });
  const before = jsonDigest(closure());
  const hostBefore = authorHostIdentityDigest(hostRoot);
  const lifetime = new AbortController();
  const abort = () => lifetime.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let warm: PythonWorker | undefined;
  const stopAdmission = () => { void warm?.close(); };
  lifetime.signal.addEventListener('abort', stopAdmission, { once: true });
  try {
    warm = await PythonWorker.start({ ...workerOptions, mode: 'author' }, lifetime.signal);
    const initial = await warm.call('environment.describe') as Record<string, JsonValue>;
    lifetime.signal.removeEventListener('abort', stopAdmission);
    if (lifetime.signal.aborted) throw new Error('Python author admission cancelled');
    if (jsonDigest(closure()) !== before || authorHostIdentityDigest(hostRoot) !== hostBefore)
      throw new Error('Python author source/host closure changed during admission');
    if (initial.sourcePath !== modulePath || initial.sourceSha256 !== shaFile(modulePath)
      || !Array.isArray(initial.packages)
      || typeof initial.interpreter !== 'string' || typeof initial.pythonVersion !== 'string')
      throw new Error('Python author admission environment drift');
    const executable = realpathSync(initial.interpreter);
    const frozen: Environment = { executable, version: initial.pythonVersion,
      packages: initial.packages ?? null, loadedFiles: loadedFiles(initial.loadedModules),
      executableSha256: shaFile(executable) };
    const source = (): JsonValue => ({ ...(closure() as Record<string, JsonValue>), environment: frozen as unknown as JsonValue });
    const sourceDigest = wireVersion === AUTHOR_WIRE_VERSION ? jsonDigest(source())
      : jsonDigest({ source: source(), wireVersion });
    const hostDigest = hostBefore;
    const checkSource = (): void => {
      if ((wireVersion === AUTHOR_WIRE_VERSION ? jsonDigest(source())
        : jsonDigest({ source: source(), wireVersion })) !== sourceDigest || authorHostIdentityDigest(hostRoot) !== hostDigest
        || shaFile(executable) !== frozen.executableSha256)
        throw new Error('Python author source/host/environment closure changed during campaign');
    };
    const checkEnvironment = (reported: Record<string, JsonValue>): void => {
      const files = loadedFiles(reported.loadedModules);
      const failed = [
        reported.sourcePath !== modulePath ? 'module-path' : null,
        reported.sourceSha256 !== shaFile(modulePath) ? 'module-bytes' : null,
        reported.interpreter !== frozen.executable ? 'interpreter' : null,
        reported.pythonVersion !== frozen.version ? 'version' : null,
        canonicalJson(reported.packages ?? null) !== canonicalJson(frozen.packages) ? 'packages' : null,
        canonicalJson(files) !== canonicalJson(frozen.loadedFiles) ? `loaded-files:${files.length}/${frozen.loadedFiles.length}` : null,
      ].filter(Boolean);
      if (failed.length) throw new Error(`Python author worker environment drift: ${failed.join(',')}`);
    };
    let reserved: PythonWorker | undefined = warm;
    warm = undefined;
    let active: PythonWorker | undefined;
    let starting: Promise<PythonWorker> | undefined;
    let idleClose: Promise<void> | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    let busy = false;
    let closed = false;
    let closePromise: Promise<void> | undefined;
    const discardReserved = (): Promise<void> => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
      const worker = reserved;
      reserved = undefined;
      return worker ? worker.close() : Promise.resolve();
    };
    idleTimer = setTimeout(() => { idleClose = discardReserved(); void idleClose.catch(() => undefined); }, admissionIdleMs);
    idleTimer.unref();
    const close = (): Promise<void> => {
      if (closePromise) return closePromise;
      closed = true;
      signal?.removeEventListener('abort', abort);
      const inFlight = starting;
      const current = active;
      closePromise = (async () => {
        await Promise.allSettled([discardReserved(), current?.close(), idleClose]);
        if (inFlight) {
          const worker = await inFlight.catch(() => undefined);
          if (worker) await worker.close();
        }
      })();
      lifetime.abort();
      return closePromise;
    };
    lifetime.signal.addEventListener('abort', () => { void close(); }, { once: true });
    if (lifetime.signal.aborted) { await close(); throw new Error('Python author admission cancelled'); }
    const replay: ReplayPort = async request => {
      if (closed) throw new Error('Python author replay port is closed');
      if (busy) throw new Error('Concurrent Python author replay is forbidden');
      busy = true;
      try {
        try { checkSource(); }
        catch (error) { await discardReserved(); throw error; }
        if (request.version !== wireVersion || Buffer.byteLength(canonicalJson(request)) > 1024 * 1024)
          throw new Error('Invalid/oversized author replay request');
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = undefined;
        let worker = reserved;
        reserved = undefined;
        if (!worker) {
          starting = PythonWorker.start({ ...workerOptions, mode: 'author' }, lifetime.signal);
          try { worker = await starting; }
          finally { starting = undefined; }
        }
        active = worker;
        try {
          if (closed) throw new Error('Python author replay port is closed');
          const reported = await worker.call('environment.describe') as Record<string, JsonValue>;
          checkEnvironment(reported);
          checkSource();
          const reply = await worker.call('author.replay', request) as AuthorReplayReply;
          if (Buffer.byteLength(canonicalJson(reply)) > 1024 * 1024 || (reply.status !== 'waiting' && reply.status !== 'completed'))
            throw new Error('Invalid/oversized Python author replay reply');
          return reply;
        } finally { active = undefined; await worker.close(); }
      } finally { busy = false; }
    };
    return Object.assign(replay, { sourceDigest, hostDigest, close });
  } catch (error) {
    lifetime.signal.removeEventListener('abort', stopAdmission);
    await warm?.close();
    signal?.removeEventListener('abort', abort);
    throw error;
  }
}
