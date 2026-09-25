import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const interpreter = [process.env.GEAR_TEST_PYTHON, process.env.GEAR_ALGORITHM_TEST_PYTHON,
  '/opt/homebrew/bin/python3.11', 'python3.12', 'python3.11'].find(candidate => {
  if (!candidate) return false;
  try { return execFileSync(candidate, ['-c', 'import sys; print(int(sys.version_info >= (3,11)))'],
    { encoding: 'utf8', timeout: 3000 }).trim() === '1'; } catch { return false; }
});
const pythonIt = interpreter ? it : it.skip;
const fixture = resolve('tests/fixtures/algorithm-author-python-kill-controller.mjs');

pythonIt('cold-resumes a real Python author Campaign after controller SIGKILL with original keys and one charge per rollout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gear-author-py-kill-')); roots.push(root);
  const before = spawn(process.execPath, [fixture, root, 'before', interpreter!],
    { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] });
  let beforeOut = ''; let beforeErr = '';
  before.stdout.setEncoding('utf8'); before.stderr.setEncoding('utf8');
  before.stderr.on('data', part => { beforeErr += part; });
  const marker = await new Promise<{ pending: { operationId: string; idempotencyKey: string; kind: string }[] }>((accept, reject) => {
    const timer = setTimeout(() => { before.kill('SIGKILL'); reject(new Error(`first controller timeout: ${beforeErr}`)); }, 30_000);
    before.stdout.on('data', (part: string) => {
      beforeOut += part;
      const line = beforeOut.split('\n').find(value => value.startsWith('SECOND_INTENT_COMMITTED '));
      if (line) { clearTimeout(timer); accept(JSON.parse(line.slice('SECOND_INTENT_COMMITTED '.length))); }
    });
    before.once('error', error => { clearTimeout(timer); reject(error); });
    before.once('exit', (code, signal) => {
      if (!beforeOut.includes('SECOND_INTENT_COMMITTED ')) {
        clearTimeout(timer); reject(new Error(`first controller exited ${code ?? signal}: ${beforeErr}`));
      }
    });
  });
  expect(marker.pending).toHaveLength(2);
  const firstClosed = new Promise<NodeJS.Signals | null>(accept => before.once('close', (_code, signal) => accept(signal)));
  before.kill('SIGKILL');
  expect(await firstClosed).toBe('SIGKILL');

  const after = spawn(process.execPath, [fixture, root, 'after', interpreter!],
    { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] });
  let afterOut = ''; let afterErr = '';
  after.stdout.setEncoding('utf8'); after.stderr.setEncoding('utf8');
  after.stdout.on('data', (part: string) => { afterOut += part; });
  after.stderr.on('data', part => { afterErr += part; });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept, reject) => {
    const timer = setTimeout(() => { after.kill('SIGKILL'); reject(new Error(`cold controller timeout: ${afterErr}`)); }, 30_000);
    after.once('error', error => { clearTimeout(timer); reject(error); });
    after.once('close', (code, signal) => { clearTimeout(timer); accept({ code, signal }); });
  });
  if (exit.code !== 0 || exit.signal !== null)
    throw new Error(`cold controller exited ${exit.code ?? exit.signal}: ${afterErr}`);
  const resultLine = afterOut.split('\n').find(value => value.startsWith('AFTER_RESULT '));
  expect(resultLine, afterErr).toBeDefined();
  const result = JSON.parse(resultLine!.slice('AFTER_RESULT '.length)) as {
    status: string; phase: string; originalPending: typeof marker.pending;
    rolesBefore: number; roleSubmitCallsAfterRestart: number; spentCalls: number;
    historyRoles: number; historyRollouts: number;
    effects: { kind: string; operationId: string; idempotencyKey: string; localKey: string }[];
  };
  expect(result.originalPending).toEqual(marker.pending);
  expect(result.status).toBe('complete');
  expect(result.phase).toBe('complete');
  expect(result.rolesBefore).toBe(2);
  expect(result.roleSubmitCallsAfterRestart).toBe(0);
  expect(result.historyRoles).toBe(2);
  expect(result.historyRollouts).toBe(20);
  expect(result.spentCalls).toBe(20);
  const effects = result.effects;
  expect(new Set(effects.map(item => item.operationId)).size).toBe(effects.length);
  expect(effects.filter(item => item.kind === 'author.role')).toHaveLength(2);
  expect(effects.filter(item => item.kind === 'author.rollout')).toHaveLength(20);
  expect(effects.filter(item => item.kind === 'author.edit').map(item => ({ operationId: item.operationId,
    idempotencyKey: item.idempotencyKey, kind: item.kind })).sort((a, b) => a.operationId.localeCompare(b.operationId)))
    .toEqual(marker.pending);
}, 60_000);
