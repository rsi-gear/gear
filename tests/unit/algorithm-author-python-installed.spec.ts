import { afterEach, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { discoverInstalledPythonAuthorSdk } from '../../src/algorithm/author/python-installed.js';
import { createPythonAuthorReplayPort } from '../../src/algorithm/author/python-port.js';
import { AUTHOR_WIRE_VERSION_V2 } from '../../src/algorithm/author/index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const candidate = process.env.GEAR_TEST_PYTHON ?? 'python3.11';
const found = spawnSync('which', [candidate], { encoding: 'utf8' });
const basePython = isAbsolute(candidate) ? candidate : found.status === 0 ? found.stdout.trim() : '';

it.skipIf(!basePython || process.platform === 'win32')('uses the selected venv symlink and its installed wheel, not SDK source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gear-author-installed-py-')); roots.push(root);
  const sdkCopy = join(root, 'sdk'); cpSync(resolve('packages/python-sdk'), sdkCopy, { recursive: true });
  execFileSync(basePython, ['-m', 'pip', 'wheel', '--no-index', '--no-deps', '--no-build-isolation',
    '--wheel-dir', root, sdkCopy], { timeout: 30_000, stdio: 'pipe' });
  const wheel = readdirSync(root).find(name => name.endsWith('.whl'));
  if (!wheel) throw new Error('Local SDK wheel build produced no wheel');
  const venv = join(root, 'venv'); execFileSync(basePython, ['-m', 'venv', venv], { timeout: 30_000 });
  const interpreter = join(venv, 'bin', 'python');
  execFileSync(interpreter, ['-m', 'pip', 'install', '--no-index', '--no-deps', join(root, wheel)],
    { timeout: 30_000, stdio: 'pipe' });
  const installed = discoverInstalledPythonAuthorSdk(interpreter);
  expect(installed.interpreter).toBe(interpreter);
  expect(installed.sdkPath).toContain(venv);
  expect(installed.packageRoot).toContain('site-packages/gear_algorithm');
  expect(installed.packageDigest).toMatch(/^[a-f0-9]{64}$/);
  const project = join(root, 'project'); mkdirSync(project);
  cpSync(resolve('packages/python-sdk/tests/fixtures/author_sample.py'), join(project, 'author_sample.py'),
    { force: true });
  const port = await createPythonAuthorReplayPort({ configDir: project, module: 'author_sample.py',
    export: 'sample', interpreter: installed.interpreter, sdkPath: installed.sdkPath,
    wireVersion: AUTHOR_WIRE_VERSION_V2 });
  try {
    expect(port.definitionDescription?.id).toBe('sample');
    expect(port.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
  } finally { await port.close(); }
}, 60_000);
