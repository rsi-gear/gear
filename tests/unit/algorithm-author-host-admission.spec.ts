import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectAuthorHostAuthority, inspectAuthorTargetRoute } from '../../src/algorithm/author/host-admission.js';
import { authorHostScope, persistOrVerifyAuthorRunLock, readPersistedAuthorRunLock, scopedAuthorRunLock } from '../../src/algorithm/author/host-scope.js';
import { jsonDigest } from '../../src/algorithm/schema.js';
import { parseNeutralRuntimeConfig, type NeutralRuntimeConfigV1 } from '../../src/algorithm/author/neutral-runtime-config.js';
import type { AuthorStaticResolution, ResolvedAuthorRun } from '../../src/algorithm/author/run-resolver.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gear-author-host-admit-')); roots.push(root);
  const taskKeyFile = join(root, 'task.key'), evidenceKeyFile = join(root, 'evidence.key');
  writeFileSync(taskKeyFile, Buffer.alloc(32, 11)); writeFileSync(evidenceKeyFile, Buffer.alloc(32, 19));
  const routeFile = join(root, 'target-route.json'); const executable = join(root, 'hitch');
  writeFileSync(executable, '#!/bin/sh\n');
  const runtime: NeutralRuntimeConfigV1 = { schemaVersion: 1,
    builder: { dshBaseRef: 'a'.repeat(40), toolchainRef: 'node-22', sandboxProfileRef: 'sandbox', allowedImports: [] },
    compiler: { command: process.execPath },
    hitch: { executable, repositoryPath: root, harnessId: 'h', root, model: 'local-model', attempts: 1,
      maxConcurrent: 1, setupTimeoutMs: 1000, terminationGraceMs: 1000, maxOutputBytes: 1024,
      maxTrajectoryOutputBytes: 1024, sampling: {}, agentArgs: ['--profile', 'local'], passEnv: ['LOCAL_MODEL_KEY'],
      controlPlane: { mode: 'daemon', requireModelCapture: false } },
    sampling: { repetitions: 1 }, taskBudgetMs: 1000,
    authority: { issuerId: 'admin', taskKeyFile, evidenceKeyFile },
    modelDestinations: { meta: { alias: 'meta', destinationId: 'meta-id', provider: 'local', model: 'meta-model',
      registrationModule: join(root, 'meta.mjs'), spec: { runtime: { type: 'dsh', version: 'v1', integrity: 'test' },
        preset: { id: 'p', digest: 'p', resources: [] }, model: { provider: 'local', model: 'meta-model' }, sampling: {} } },
      target: { alias: 'target', destinationId: 'target-id', provider: 'local', model: 'local-model', routeFile } },
    runtimeResources: [join(root, 'meta.mjs'), routeFile] };
  writeFileSync(routeFile, JSON.stringify({ schemaVersion: 1, kind: 'hitch-daemon-model-route.v1',
    destinationId: 'target-id', provider: 'local', model: 'local-model', hitchExecutable: executable,
    hitchRoot: root, agentArgs: ['--profile', 'local'], passEnv: ['LOCAL_MODEL_KEY'], credentialEnv: 'LOCAL_MODEL_KEY' }));
  const source = { runPath: join(root, 'project', 'run.yaml'), source: { runDigest: 'a'.repeat(64) },
    profile: { models: { target: 'target' }, hitch: { executable },
    workspace: { stateRoot: join(root, 'state') } } } as AuthorStaticResolution;
  const body = { schemaVersion: 1, kind: 'author.run.lock.candidate.v1', static: source, physical: {},
    requiredKinds: [], metering: {} };
  const resolved = { ...body, lockDigest: jsonDigest(body) } as unknown as ResolvedAuthorRun;
  return { root, runtime, source, resolved, routeFile, taskKeyFile, evidenceKeyFile };
}

it('reads pre-existing distinct administrator keys and an exact frozen Hitch target route without logging a credential', () => {
  const item = fixture(); const runtime = parseNeutralRuntimeConfig(item.runtime);
  const authority = inspectAuthorHostAuthority(runtime);
  const route = inspectAuthorTargetRoute(item.source, runtime, { LOCAL_MODEL_KEY: 'private-secret' });
  expect(authority.identity.taskKey.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(authority.identity.evidenceKey.digest).not.toBe(authority.identity.taskKey.digest);
  expect(route.credentialEnv).toBe('LOCAL_MODEL_KEY');
  expect(route.verification).toBe('configuration-only');
  expect(JSON.stringify({ authority: authority.identity, route })).not.toContain('private-secret');
  expect(route.identityDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(inspectAuthorTargetRoute(item.source, runtime, { LOCAL_MODEL_KEY: 'rotated' }).identityDigest)
    .not.toBe(route.identityDigest);
  const bad = structuredClone(runtime);
  bad.hitch.agentArgs = ['--profile', 'other'];
  expect(() => inspectAuthorTargetRoute(item.source, bad, { LOCAL_MODEL_KEY: 'private-secret' }))
    .toThrow('frozen Hitch invocation');
  expect(() => inspectAuthorTargetRoute(item.source, runtime, {})).toThrow('unresolved');
});

it('keeps deterministic preview separate from a durable, exact run/resume lock', () => {
  const item = fixture(); const runtime = parseNeutralRuntimeConfig(item.runtime);
  const authority = inspectAuthorHostAuthority(runtime).identity;
  const route = inspectAuthorTargetRoute(item.source, runtime, { LOCAL_MODEL_KEY: 'private-secret' });
  const preview = authorHostScope(item.source, { kind: 'preview' });
  expect(authorHostScope(item.source, { kind: 'preview' })).toEqual(preview);
  expect(preview.lockPath).toBeNull();
  expect(existsSync(preview.stateRoot)).toBe(false);
  const previewLock = scopedAuthorRunLock(item.resolved, preview, authority, route, 64);
  expect(() => persistOrVerifyAuthorRunLock(previewLock, 'run')).toThrow('Preview lock');
  const scope = authorHostScope(item.source, { kind: 'run', runId: 'trial-1' });
  const lock = scopedAuthorRunLock(item.resolved, scope, authority, route, 64);
  persistOrVerifyAuthorRunLock(lock, 'run');
  persistOrVerifyAuthorRunLock(lock, 'resume');
  expect(readPersistedAuthorRunLock(scope.lockPath!)).toEqual(lock);
  expect(readFileSync(scope.lockPath!, 'utf8')).not.toContain('private-secret');
  expect(() => persistOrVerifyAuthorRunLock(lock, 'run')).toThrow();
  expect(() => scopedAuthorRunLock(item.resolved, scope, authority, route, 0)).toThrow('maxFrontierWaves');
  const changed = scopedAuthorRunLock(item.resolved, scope, authority,
    inspectAuthorTargetRoute(item.source, runtime, { LOCAL_MODEL_KEY: 'rotated' }), 64);
  expect(() => persistOrVerifyAuthorRunLock(changed, 'resume')).toThrow('changed');
  expect(() => authorHostScope(item.source, { kind: 'run', runId: '../outside' })).toThrow('run ID');
  expect(() => scopedAuthorRunLock({ ...item.resolved, lockDigest: 'b'.repeat(64) }, scope, authority, route, 64))
    .toThrow('candidate digest mismatch');
});

it('rejects short, replaced, or linked authority keys and altered target route bytes', () => {
  const item = fixture(); const runtime = parseNeutralRuntimeConfig(item.runtime);
  writeFileSync(item.taskKeyFile, Buffer.alloc(31));
  expect(() => inspectAuthorHostAuthority(runtime)).toThrow('at least 32');
  writeFileSync(item.taskKeyFile, Buffer.alloc(32, 11));
  const link = join(item.root, 'linked.key'); symlinkSync(item.taskKeyFile, link);
  runtime.authority!.taskKeyFile = link;
  expect(() => inspectAuthorHostAuthority(runtime)).toThrow('symlink');
  writeFileSync(item.routeFile, JSON.stringify({ schemaVersion: 1, kind: 'hitch-daemon-model-route.v1',
    destinationId: 'target-id', provider: 'other', model: 'local-model', hitchExecutable: join(item.root, 'hitch'),
    hitchRoot: item.root, agentArgs: ['--profile', 'local'], passEnv: ['LOCAL_MODEL_KEY'], credentialEnv: 'LOCAL_MODEL_KEY' }));
  expect(() => inspectAuthorTargetRoute(item.source, runtime, { LOCAL_MODEL_KEY: 'private-secret' }))
    .toThrow('frozen Hitch invocation');
});

it('ignores a prepublication temporary file and rejects a partial final lock on resume', () => {
  const item = fixture(); const runtime = parseNeutralRuntimeConfig(item.runtime);
  const authority = inspectAuthorHostAuthority(runtime).identity;
  const route = inspectAuthorTargetRoute(item.source, runtime, { LOCAL_MODEL_KEY: 'private-secret' });
  const scope = authorHostScope(item.source, { kind: 'run', runId: 'interrupted' });
  const lock = scopedAuthorRunLock(item.resolved, scope, authority, route, 3);
  mkdirSync(scope.stateRoot, { recursive: true });
  writeFileSync(`${scope.lockPath}.aborted.tmp`, '{partial');
  persistOrVerifyAuthorRunLock(lock, 'run');
  expect(readPersistedAuthorRunLock(scope.lockPath!)).toEqual(lock);
  writeFileSync(scope.lockPath!, '{partial');
  expect(() => readPersistedAuthorRunLock(scope.lockPath!)).toThrow();
  expect(() => persistOrVerifyAuthorRunLock(lock, 'resume')).toThrow();
});

it('rejects the bundled direct-only Codex wrapper before claiming daemon target admission', () => {
  const item = fixture(); const runtime = parseNeutralRuntimeConfig(item.runtime);
  const wrapper = fileURLToPath(new URL('../../assets/hitch-codex-wrapper.mjs', import.meta.url));
  runtime.hitch.executable = wrapper;
  item.source.profile.hitch.executable = wrapper;
  expect(() => inspectAuthorTargetRoute(item.source, runtime, { LOCAL_MODEL_KEY: 'private-secret' }))
    .toThrow('direct-only');
});

it('refuses a linked run directory before publishing any lock outside its state root', () => {
  const item = fixture(); const runtime = parseNeutralRuntimeConfig(item.runtime);
  const authority = inspectAuthorHostAuthority(runtime).identity;
  const route = inspectAuthorTargetRoute(item.source, runtime, { LOCAL_MODEL_KEY: 'private-secret' });
  const scope = authorHostScope(item.source, { kind: 'run', runId: 'linked' });
  const external = join(item.root, 'external'); mkdirSync(external);
  mkdirSync(join(item.source.profile.workspace.stateRoot, '.gear', 'runs'), { recursive: true });
  symlinkSync(external, scope.stateRoot);
  const lock = scopedAuthorRunLock(item.resolved, scope, authority, route, 3);
  expect(() => persistOrVerifyAuthorRunLock(lock, 'run')).toThrow('linked or invalid');
  expect(existsSync(join(external, 'run.lock.json'))).toBe(false);
});

it('does not create a child through an existing linked runs directory', () => {
  const item = fixture(); const runtime = parseNeutralRuntimeConfig(item.runtime);
  const authority = inspectAuthorHostAuthority(runtime).identity;
  const route = inspectAuthorTargetRoute(item.source, runtime, { LOCAL_MODEL_KEY: 'private-secret' });
  const scope = authorHostScope(item.source, { kind: 'run', runId: 'escape' });
  const external = join(item.root, 'outside'); mkdirSync(external);
  const gear = join(item.source.profile.workspace.stateRoot, '.gear'); mkdirSync(gear, { recursive: true });
  symlinkSync(external, join(gear, 'runs'));
  const lock = scopedAuthorRunLock(item.resolved, scope, authority, route, 3);
  expect(() => persistOrVerifyAuthorRunLock(lock, 'run')).toThrow('linked or invalid');
  expect(existsSync(join(external, 'escape'))).toBe(false);
});

it('rejects an oversized lock before creating the run directory', () => {
  const item = fixture(); const runtime = parseNeutralRuntimeConfig(item.runtime);
  const authority = inspectAuthorHostAuthority(runtime).identity;
  const route = inspectAuthorTargetRoute(item.source, runtime, { LOCAL_MODEL_KEY: 'private-secret' });
  const body = { ...item.resolved, physical: { oversized: 'x'.repeat(16 * 1024 * 1024) } };
  const { lockDigest: _old, ...withoutDigest } = body;
  const resolved = { ...withoutDigest, lockDigest: jsonDigest(withoutDigest) } as unknown as ResolvedAuthorRun;
  const scope = authorHostScope(item.source, { kind: 'run', runId: 'too-large' });
  const lock = scopedAuthorRunLock(resolved, scope, authority, route, 3);
  expect(() => persistOrVerifyAuthorRunLock(lock, 'run')).toThrow('read bound');
  expect(existsSync(scope.stateRoot)).toBe(false);
});
