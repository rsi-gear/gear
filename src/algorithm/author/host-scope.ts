import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { readBoundedFile } from './identity.js';
import { assertJson, canonicalJson, jsonDigest } from '../schema.js';
import type { AuthorStaticResolution, ResolvedAuthorRun } from './run-resolver.js';

export type AuthorHostScope = { schemaVersion: 1; kind: 'preview' | 'run'; runId: string;
  campaignId: string; stateRoot: string; lockPath: string | null; scopeDigest: string };
export type AuthorHostAuthorityIdentity = { schemaVersion: 1; issuerId: string;
  taskKey: { path: string; digest: string }; evidenceKey: { path: string; digest: string };
  identityDigest: string };
export type AuthorTargetRouteIdentity = { schemaVersion: 1; kind: 'hitch-daemon-model-route.v1';
  verification: 'configuration-only'; declarationPath: string; declarationDigest: string; credentialEnv: string | null;
  credentialDigest: string | null; identityDigest: string };
export type ScopedAuthorRunLock = { schemaVersion: 1; kind: 'author.run.lock.v1';
  scope: AuthorHostScope; authority: AuthorHostAuthorityIdentity; targetRoute: AuthorTargetRouteIdentity;
  capacity: { maxFrontierWaves: number }; resolved: ResolvedAuthorRun; lockDigest: string };

function runId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) || value === '.' || value === '..')
    throw new Error('Author run ID must be a safe, nonempty component');
  return value;
}
/** Preview is a stable, read-only identity. It is never a resumable Campaign. */
export function authorHostScope(source: AuthorStaticResolution,
  request: { kind: 'preview'; runId?: string } | { kind: 'run'; runId: string }): AuthorHostScope {
  const base = resolve(source.profile.workspace.stateRoot);
  const id = request.runId === undefined
    ? `preview-${jsonDigest({ runPath: source.runPath, sources: source.source }).slice(0, 24)}`
    : runId(request.runId);
  const stateRoot = join(base, '.gear', 'runs', id);
  const body = { schemaVersion: 1 as const, kind: request.kind, runId: id,
    campaignId: `author.${id}`, stateRoot,
    lockPath: request.kind === 'run' ? join(stateRoot, 'run.lock.json') : null };
  return { ...body, scopeDigest: jsonDigest(body) };
}
/** Full lock includes the actual physical provider catalog, after its one-way identity DAG is resolved. */
export function scopedAuthorRunLock(resolved: ResolvedAuthorRun, scope: AuthorHostScope,
  authority: AuthorHostAuthorityIdentity, targetRoute: AuthorTargetRouteIdentity,
  maxFrontierWaves: number): ScopedAuthorRunLock {
  if (!Number.isSafeInteger(maxFrontierWaves) || maxFrontierWaves < 1)
    throw new Error('Explicit positive maxFrontierWaves required');
  const { lockDigest: candidateDigest, ...candidateBody } = resolved;
  if (jsonDigest(candidateBody) !== candidateDigest) throw new Error('Author resolver candidate digest mismatch');
  if (scope.scopeDigest !== jsonDigest({ schemaVersion: scope.schemaVersion, kind: scope.kind,
    runId: scope.runId, campaignId: scope.campaignId, stateRoot: scope.stateRoot, lockPath: scope.lockPath }))
    throw new Error('Author run scope identity drift');
  if (scope.stateRoot !== join(resolve(resolved.static.profile.workspace.stateRoot), '.gear', 'runs', scope.runId))
    throw new Error('Author run scope outside frozen profile state root');
  if (authority.identityDigest !== jsonDigest({ schemaVersion: authority.schemaVersion, issuerId: authority.issuerId,
    taskKey: authority.taskKey, evidenceKey: authority.evidenceKey })
    || targetRoute.identityDigest !== jsonDigest({ schemaVersion: targetRoute.schemaVersion,
      kind: targetRoute.kind, verification: targetRoute.verification, declarationPath: targetRoute.declarationPath,
      declarationDigest: targetRoute.declarationDigest, credentialEnv: targetRoute.credentialEnv,
      credentialDigest: targetRoute.credentialDigest }))
    throw new Error('Author host authority or target route identity drift');
  const body = { schemaVersion: 1 as const, kind: 'author.run.lock.v1' as const,
    scope, authority, targetRoute, capacity: { maxFrontierWaves }, resolved };
  assertJson(body);
  return { ...body, lockDigest: jsonDigest(body) };
}

/** Resume starts from the saved lock, not from a moving branch or a new profile resolution. */
export function readPersistedAuthorRunLock(path: string): ScopedAuthorRunLock {
  const saved: unknown = JSON.parse(readBoundedFile(path, 16 * 1024 * 1024).toString('utf8'));
  assertJson(saved);
  const lock = saved as ScopedAuthorRunLock;
  if (lock.schemaVersion !== 1 || lock.kind !== 'author.run.lock.v1'
    || lock.scope?.kind !== 'run' || lock.scope.lockPath === null
    || realpathSync(lock.scope.lockPath) !== realpathSync(path))
    throw new Error('Saved author run lock scope invalid');
  const expected = scopedAuthorRunLock(lock.resolved, lock.scope, lock.authority, lock.targetRoute,
    lock.capacity?.maxFrontierWaves);
  if (canonicalJson(expected) !== canonicalJson(lock)) throw new Error('Saved author run lock identity mismatch');
  return lock;
}

/** Only the run path writes a lock. A matching resume never replaces it. */
export function persistOrVerifyAuthorRunLock(lock: ScopedAuthorRunLock, mode: 'run' | 'resume'): void {
  if (lock.scope.kind !== 'run' || lock.scope.lockPath === null) throw new Error('Preview lock cannot run or resume');
  const { lockDigest, ...body } = lock;
  if (jsonDigest(body) !== lockDigest) throw new Error('Author run lock digest mismatch');
  const path = lock.scope.lockPath;
  if (mode === 'resume') {
    const saved = readPersistedAuthorRunLock(path);
    if (canonicalJson(saved) !== canonicalJson(lock)) throw new Error('Author run lock changed; resume refused');
    return;
  }
  const bytes = canonicalJson(lock);
  if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) throw new Error('Author run lock exceeds read bound');
  const profileStateRoot = lock.resolved.static.profile.workspace.stateRoot;
  mkdirSync(profileStateRoot, { recursive: true, mode: 0o700 });
  if (!lstatSync(profileStateRoot).isDirectory() || lstatSync(profileStateRoot).isSymbolicLink())
    throw new Error('Author run state directory is linked or invalid');
  // Validate each existing component before creating the next; a linked .gear/runs cannot redirect a write.
  for (const directory of [dirname(dirname(dirname(path))), dirname(dirname(path)), dirname(path)]) {
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Author run state directory is linked or invalid');
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  let published = false;
  try {
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    // Hard-link publication is exclusive and atomic: a crashed partial temp never occupies the final lock path.
    linkSync(temporary, path);
    published = true;
    const directory = openSync(dirname(path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
    if (published) {
      const directory = openSync(dirname(path), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  }
}
