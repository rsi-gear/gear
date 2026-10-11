/** Install the actual npm tarball and wheel outside the repository, then exercise the default CLI. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), 'gear-step-consumer-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const buildPython = process.env.GEAR_ALGORITHM_TEST_PYTHON ?? 'python3';
function run(command, args, cwd, extra = {}) {
  try { return execFileSync(command, args, { cwd, env: { ...process.env, ...extra }, encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024, timeout: 180_000 }); }
  catch (error) { process.stderr.write(error.stdout ?? ''); process.stderr.write(error.stderr ?? ''); throw error; }
}
try {
  const packed = JSON.parse(run(npm, ['pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', temporary], root))[0];
  const consumer = join(temporary, 'consumer'); await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'external-algorithm-author', private: true, type: 'module' }));
  run(npm, ['install', '--ignore-scripts', '--offline', '--legacy-peer-deps', '--no-audit', '--no-fund', join(temporary, packed.filename)], consumer);
  const cli = join(consumer, 'node_modules/rsi-gear/lib/cli.js');
  const command = (action, path, language) => {
    const output = run(process.execPath, ['--no-experimental-strip-types', cli, 'algorithm', action, path, ...(language ? [language] : [])], consumer);
    return action === 'init' ? output : JSON.parse(output.trim().split('\n').at(-1));
  };
  const sdk = join(temporary, 'python-sdk'), wheels = join(temporary, 'wheels');
  await cp(join(root, 'packages/python-sdk'), sdk, { recursive: true });
  run(buildPython, ['-m', 'pip', 'wheel', '--no-build-isolation', '--no-deps', '--wheel-dir', wheels, sdk], consumer);
  const wheel = (await readdir(wheels)).find(name => name.endsWith('.whl'));
  assert.ok(wheel);
  const venv = join(temporary, 'venv'); run(buildPython, ['-m', 'venv', venv], consumer);
  const python = join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  run(python, ['-m', 'pip', 'install', '--no-index', '--no-deps', join(wheels, wheel)], consumer);
  run(python, ['-c', 'from gear_algorithm import algorithm, Archive; import importlib.util; assert callable(algorithm); assert importlib.util.find_spec("torch") is None'], consumer);
  const completed = [];
  for (const language of ['typescript', 'python']) {
    const project = join(consumer, language);
    command('init', project, language);
    const path = join(project, 'gear.algorithm.json');
    const config = JSON.parse(await readFile(path, 'utf8'));
    if (language === 'python') config.algorithm.interpreter = python;
    await writeFile(path, JSON.stringify(config));
    if (language === 'typescript') run(process.execPath, [join(consumer, 'node_modules/typescript/bin/tsc'),
      '--strict', '--noUncheckedIndexedAccess', '--exactOptionalPropertyTypes', '--skipLibCheck', '--noEmit',
      '--module', 'NodeNext', '--target', 'ES2024', 'algorithm.ts'], project);
    assert.equal(command('check', path).ok, true);
    const result = command('run', path);
    assert.equal(result.status, 'complete');
    assert.equal(result.result.outputs.evaluation.metrics.pass_rate, 0.8);
    const headPath = join(project, config.stateDir, 'campaign/HEAD');
    const head = await readFile(headPath, 'utf8');
    assert.equal(command('resume', path).status, 'complete');
    assert.equal(await readFile(headPath, 'utf8'), head);
    completed.push(language);
  }
  for (const name of ['gepa_style', 'rho_style', 'dgm_style']) {
    const project = join(consumer, name); command('init', project, 'python');
    await cp(join(root, 'examples/algorithms/step-search', `${name}.py`), join(project, 'algorithm.py'));
    const path = join(project, 'gear.algorithm.json');
    const config = JSON.parse(await readFile(path, 'utf8')); config.algorithm.interpreter = python;
    await writeFile(path, JSON.stringify(config));
    assert.equal(command('check', path).ok, true);
    assert.equal(command('run', path).status, 'complete');
    assert.equal(command('resume', path).status, 'complete');
    completed.push(name);
  }
  console.log(JSON.stringify({ npmTarball: packed.filename, pythonWheel: wheel, completed,
    typecheckedTypeScript: true, nativeTypeStrippingRequired: false, resumedWithoutNewJournalCommit: true, host: 'recorded (no model or Hitch)' }));
} finally { await rm(temporary, { recursive: true, force: true }); }
