import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runAuthorCommand, type AuthorCliBackend, type AuthorCliSession } from '../../src/algorithm/author/cli.js';
import { initAuthorProject } from '../../src/algorithm/author/project.js';

const roots: string[] = [];
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'gear-author-cli-')); roots.push(root);
  const path = join(root, 'demo');
  initAuthorProject({ directory: path, language: 'python', template: 'search', profile: 'lab' });
  return path;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const digest = 'a'.repeat(64);

it('checks a v2 run without writing run state and resolves the explicit profile file', async () => {
  const root = project(); const lines: string[] = [];
  const visited: unknown[] = [];
  const backend: AuthorCliBackend = {
    inspect: async value => { visited.push(value); return { lock: { lockDigest: digest,
      scope: { runId: 'preview', lockPath: null } }, explanation: 'frozen physical profile' }; },
    open: async () => { throw new Error('check must not open run'); },
    resume: async () => { throw new Error('check must not resume run'); },
  };
  await runAuthorCommand(['check', 'run.yaml', '--python', '/opt/homebrew/bin/python3.11',
    '--profile-file', './admin.yaml', '--max-frontier-waves', '37'],
  { backend, cwd: root, emit: line => lines.push(line) });
  expect(visited).toEqual([{ runPath: join(root, 'run.yaml'), profilePath: join(root, 'admin.yaml'),
    maxFrontierWaves: 37, python: '/opt/homebrew/bin/python3.11', scope: { kind: 'preview' } }]);
  expect(JSON.parse(lines[0]!) as { status: string }).toMatchObject({ status: 'checked', lockDigest: digest });
  expect(existsSync(join(root, '.gear', 'run'))).toBe(false);
  await expect(runAuthorCommand(['check', 'run.yaml', '--python', '/opt/homebrew/bin/python3.11'],
    { backend, cwd: root })).rejects.toThrow('Explicit positive max-frontier-waves');
});

it('rejects a v1 Campaign spec at the public author command before host admission', async () => {
  const root = project();
  writeFileSync(join(root, 'old.json'), JSON.stringify({ schemaVersion: 1,
    kind: 'algorithm-campaign', campaignId: 'old', stateDir: './.gear/old' }));
  const backend: AuthorCliBackend = {
    inspect: async () => { throw new Error('host must not inspect v1'); },
    open: async () => { throw new Error('host must not run v1'); },
    resume: async () => { throw new Error('host must not resume v1'); },
  };
  await expect(runAuthorCommand(['check', 'old.json', '--max-frontier-waves', '10'], { backend, cwd: root }))
    .rejects.toThrow('Legacy RunSpec schemaVersion 1 is unsupported');
});

it('drives waiting work to completion and resumes only from the saved lock index', async () => {
  const root = project(); const lines: string[] = []; const calls: string[] = [];
  const lockPath = join(root, 'saved-run.lock.json');
  let closed = 0;
  const session = (runId: string): AuthorCliSession => {
    const statuses: ('advanced' | 'waiting' | 'complete')[] = ['advanced', 'waiting', 'waiting', 'complete'];
    return { lock: { lockDigest: digest, scope: { runId, lockPath } },
      runtime: { tick: async () => { calls.push('tick'); return statuses.shift() ?? 'complete'; },
        snapshot: () => ({ state: { sealed: true } }) },
      adapter: { readResult: () => ({ selected: { kind: 'harness-agent' } }) },
      inspectAttention: () => null,
      close: async () => { closed++; } };
  };
  let savedRunId = '';
  const backend: AuthorCliBackend = {
    inspect: async () => { throw new Error('run/resume must not inspect preview'); },
    open: async value => {
      if (value.scope.kind !== 'run') throw new Error('run scope required');
      savedRunId = value.scope.runId;
      return session(savedRunId);
    },
    resume: async value => {
      expect(value.lockPath).toBe(lockPath);
      return session(savedRunId);
    },
  };
  const command = { backend, cwd: root, emit: (line: string) => lines.push(line),
    wait: async () => { calls.push('wait'); } };
  await runAuthorCommand(['run', 'run.yaml', '--python', '/opt/homebrew/bin/python3.11',
    '--max-frontier-waves', '25'], command);
  expect(calls).toEqual(['tick', 'tick', 'wait', 'tick', 'wait', 'tick']);
  expect(closed).toBe(1);
  const index = JSON.parse(readFileSync(join(root, '.gear', 'run', `${savedRunId}.json`), 'utf8')) as
    { runId: string; lockPath: string; lockDigest: string };
  expect(index).toMatchObject({ runId: savedRunId, lockPath, lockDigest: digest });
  expect(lines.map(line => (JSON.parse(line) as { status: string }).status))
    .toEqual(['started', 'waiting', 'complete']);
  writeFileSync(join(root, 'run.yaml'), 'not a valid RunSpec\n');
  calls.length = 0;
  await runAuthorCommand(['resume', savedRunId, '--python', '/opt/homebrew/bin/python3.11'], command);
  expect(closed).toBe(2);
  expect(calls).toEqual(['tick', 'tick', 'wait', 'tick', 'wait', 'tick']);
  writeFileSync(join(root, '.gear', 'run', `${savedRunId}.json`),
    JSON.stringify({ ...index, lockDigest: 'b'.repeat(64) }));
  calls.length = 0;
  await expect(runAuthorCommand(['resume', savedRunId, '--python', '/opt/homebrew/bin/python3.11'], command))
    .rejects.toThrow('Resume lock identity differs');
  expect(calls).toEqual([]);
  expect(closed).toBe(3);
});

it('returns a nonzero failure for host-declared attention and closes the session', async () => {
  const root = project(); const lines: string[] = [];
  let closed = false;
  const backend: AuthorCliBackend = {
    inspect: async () => { throw new Error('unexpected inspect'); },
    open: async value => ({ lock: { lockDigest: digest,
      scope: { runId: value.scope.kind === 'run' ? value.scope.runId : 'bad', lockPath: join(root, 'lock.json') } },
    runtime: { tick: async () => 'waiting', snapshot: () => null },
    adapter: { readResult: () => null }, inspectAttention: () => 'operator reconciliation required',
    close: async () => { closed = true; } }),
    resume: async () => { throw new Error('unexpected resume'); },
  };
  await expect(runAuthorCommand(['run', 'run.yaml', '--python', '/opt/homebrew/bin/python3.11',
    '--max-frontier-waves', '10'], { backend, cwd: root, emit: line => lines.push(line) }))
    .rejects.toThrow('needs attention');
  expect(closed).toBe(true);
  expect(lines.map(line => (JSON.parse(line) as { status: string }).status)).toEqual(['started', 'needs-attention']);
});

it('rejects an ambiguous resume ID and lock before opening a backend', async () => {
  const root = project();
  const backend: AuthorCliBackend = {
    inspect: async () => { throw new Error('backend must not inspect'); },
    open: async () => { throw new Error('backend must not open'); },
    resume: async () => { throw new Error('backend must not resume'); },
  };
  await expect(runAuthorCommand(['resume', 'run-1', '--lock', join(root, 'other.lock')],
    { backend, cwd: root })).rejects.toThrow('Choose a run ID or --lock, not both');
});

it('stops observing without cancelling a waiting Campaign and always closes the host', async () => {
  const root = project(); const lines: string[] = []; const controller = new AbortController();
  let closed = false;
  const backend: AuthorCliBackend = {
    inspect: async () => { throw new Error('unexpected inspect'); },
    open: async value => ({ lock: { lockDigest: digest,
      scope: { runId: value.scope.kind === 'run' ? value.scope.runId : 'bad', lockPath: join(root, 'lock.json') } },
    runtime: { tick: async () => 'waiting', snapshot: () => null },
    adapter: { readResult: () => null }, inspectAttention: () => null,
    close: async () => { closed = true; } }),
    resume: async () => { throw new Error('unexpected resume'); },
  };
  await runAuthorCommand(['run', 'run.yaml', '--python', '/opt/homebrew/bin/python3.11',
    '--max-frontier-waves', '10'], { backend, cwd: root, signal: controller.signal,
    emit: line => lines.push(line), wait: async () => { controller.abort(); } });
  expect(closed).toBe(true);
  expect(lines.map(line => (JSON.parse(line) as { status: string }).status))
    .toEqual(['started', 'waiting', 'observer-stopped']);
});
