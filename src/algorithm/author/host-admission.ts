import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBoundedFile } from './identity.js';
import { assertJson, jsonDigest } from '../schema.js';
import type { AuthorStaticResolution } from './run-resolver.js';
import type { NeutralRuntimeConfigV1 } from './neutral-runtime-config.js';
import type { AuthorHostAuthorityIdentity, AuthorTargetRouteIdentity } from './host-scope.js';

export type AuthorHostAuthority = { identity: AuthorHostAuthorityIdentity;
  taskKey: Buffer; evidenceKey: Buffer };
type TargetRouteDeclaration = { schemaVersion: 1; kind: 'hitch-daemon-model-route.v1';
  destinationId: string; provider: string; model: string; hitchExecutable: string;
  hitchRoot: string; agentArgs: string[]; passEnv: string[]; credentialEnv: string | null };
const HEX = /^[a-f0-9]{64}$/;
const ENV = /^[A-Z_][A-Z0-9_]*$/;
const sha256 = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');
function exact(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  if (Object.keys(value).sort().join(',') !== [...fields].sort().join(','))
    throw new Error(`${label} fields differ from contract`);
}
/** Administrator-provisioned HMAC keys are read, never created, by check/explain. */
export function inspectAuthorHostAuthority(runtime: NeutralRuntimeConfigV1): AuthorHostAuthority {
  const authority = runtime.authority;
  if (!authority) throw new Error('A1 host needs administrator-provisioned authority key files');
  const readKey = (named: string, label: string): { path: string; digest: string; bytes: Buffer } => {
    if (lstatSync(named).isSymbolicLink()) throw new Error(`${label} symlink is not a stable authority source`);
    const path = realpathSync(named);
    const bytes = readBoundedFile(path, 4096);
    if (bytes.length < 32) throw new Error(`${label} requires at least 32 bytes`);
    return { path, digest: sha256(bytes), bytes };
  };
  const task = readKey(authority.taskKeyFile, 'Task authority key');
  const evidence = readKey(authority.evidenceKeyFile, 'Evidence authority key');
  if (task.path === evidence.path || task.digest === evidence.digest)
    throw new Error('Task and evidence authorities need distinct keys');
  if (sha256(readBoundedFile(task.path, 4096)) !== task.digest
    || sha256(readBoundedFile(evidence.path, 4096)) !== evidence.digest)
    throw new Error('Administrator authority key changed during inspection');
  const body = { schemaVersion: 1 as const, issuerId: authority.issuerId,
    taskKey: { path: task.path, digest: task.digest },
    evidenceKey: { path: evidence.path, digest: evidence.digest } };
  return { identity: { ...body, identityDigest: jsonDigest(body) },
    taskKey: task.bytes, evidenceKey: evidence.bytes };
}

/** Reads the administrator's actual frozen target route declaration; it never contacts a model. */
export function inspectAuthorTargetRoute(source: AuthorStaticResolution,
  runtime: NeutralRuntimeConfigV1, environment: NodeJS.ProcessEnv = process.env): AuthorTargetRouteIdentity {
  const target = runtime.modelDestinations.target;
  if (!target.routeFile) throw new Error('A1 host needs a target route declaration');
  if (lstatSync(target.routeFile).isSymbolicLink()) throw new Error('Target route symlink is unsupported');
  const declarationPath = realpathSync(target.routeFile);
  if (!runtime.runtimeResources.some(path => resolve(path) === resolve(target.routeFile!)))
    throw new Error('Target route must be in the frozen runtime resource closure');
  const bundledCodexWrapper = fileURLToPath(new URL('../../../assets/hitch-codex-wrapper.mjs', import.meta.url));
  if (sha256(readBoundedFile(realpathSync(runtime.hitch.executable), 64 * 1024 * 1024))
    === sha256(readBoundedFile(bundledCodexWrapper, 4 * 1024 * 1024)))
    throw new Error('Bundled Codex Hitch wrapper is direct-only and cannot submit daemon evaluations');
  const bytes = readBoundedFile(declarationPath, 64 * 1024);
  const parsed: unknown = JSON.parse(bytes.toString('utf8'));
  assertJson(parsed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Target route must be an object');
  const route = parsed as unknown as TargetRouteDeclaration;
  exact(route as unknown as Record<string, unknown>, ['schemaVersion', 'kind', 'destinationId', 'provider', 'model',
    'hitchExecutable', 'hitchRoot', 'agentArgs', 'passEnv', 'credentialEnv'], 'Target route');
  if (route.schemaVersion !== 1 || route.kind !== 'hitch-daemon-model-route.v1'
    || route.destinationId !== target.destinationId || route.provider !== target.provider
    || route.model !== target.model || route.model !== runtime.hitch.model
    || target.alias !== source.profile.models.target
    || route.hitchExecutable !== runtime.hitch.executable
    || route.hitchExecutable !== source.profile.hitch.executable
    || route.hitchRoot !== runtime.hitch.root
    || jsonDigest(route.agentArgs) !== jsonDigest(runtime.hitch.agentArgs)
    || jsonDigest(route.passEnv) !== jsonDigest(runtime.hitch.passEnv)
    || runtime.hitch.controlPlane?.mode !== 'daemon')
    throw new Error('Target route does not match the actual frozen Hitch invocation');
  if (route.credentialEnv !== null && (!ENV.test(route.credentialEnv)
    || !runtime.hitch.passEnv.includes(route.credentialEnv)))
    throw new Error('Target credential reference is not on Hitch passEnv allowlist');
  const value = route.credentialEnv === null ? null : environment[route.credentialEnv];
  if (route.credentialEnv !== null && (!value || value.includes('\0')))
    throw new Error('Target credential reference is unresolved');
  const body = { schemaVersion: 1 as const, kind: 'hitch-daemon-model-route.v1' as const,
    verification: 'configuration-only' as const, declarationPath, declarationDigest: sha256(bytes), credentialEnv: route.credentialEnv,
    credentialDigest: value === null ? null : sha256(value!) };
  if (!HEX.test(body.declarationDigest) || (body.credentialDigest !== null && !HEX.test(body.credentialDigest)))
    throw new Error('Target route digest invalid');
  if (sha256(readBoundedFile(declarationPath, 64 * 1024)) !== body.declarationDigest)
    throw new Error('Target route changed during inspection');
  return { ...body, identityDigest: jsonDigest(body) };
}
