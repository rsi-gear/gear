import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInstalledAuthorReplayPort } from '../../src/algorithm/author/process-port.js';
import { AUTHOR_WIRE_VERSION_V2 } from '../../src/algorithm/author/index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const controller = resolve('tests/fixtures/algorithm-author-installed-controller.mjs');
function runController(project: string, state: string, phase: 'before' | 'after') {
  const output = execFileSync(process.execPath, [controller, project, state, phase],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(output) as { phase: string; decisionIndex: number; sourceDigest: string; hostDigest: string;
    submitCalls: number; keys: string[]; history: string[]; historyIds: string[]; result?: { selected: unknown; outputs: Record<string, unknown> } };
}
function makeInstalledProject(): { root: string; project: string; state: string; tarball: string } {
  const root = mkdtempSync(join(tmpdir(), 'gear-installed-author-')); roots.push(root);
  const project = join(root, 'project'); const state = join(root, 'campaign');
  mkdirSync(project); mkdirSync(join(project, 'prompts'));
  const cache = process.env.npm_config_cache ?? join(homedir(), '.npm');
  const npmEnv = { ...process.env, npm_config_cache: cache };
  const packed = execFileSync('npm', ['pack', '--ignore-scripts', '--offline', '--silent', '--pack-destination', project],
    { cwd: resolve('.'), env: npmEnv, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n').at(-1)!;
  const tarball = join(project, packed);
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'external-gear-author', version: '1.0.0',
    private: true, type: 'module', dependencies: { 'rsi-gear': `file:./${packed}` } }));
  execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: project, env: npmEnv, encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] });
  writeFileSync(join(project, 'algorithm.ts'), `import { algorithm } from 'rsi-gear/algorithm/author';\nimport { fromHelper } from './helper.js';\nexport const sample = algorithm<{ goal: string }>(async ctx => {\n  const one = await ctx.operation('proof.step', { n: fromHelper(1) });\n  const two = await ctx.operation('proof.step', { n: fromHelper(2), previous: one });\n  const three = await ctx.operation('proof.step', { n: fromHelper(3), previous: two });\n  return ctx.result({ selected: ctx.initialAgent, outputs: { one, two, three } });\n}, { configSchema: { type: 'object', required: ['goal'], properties: { goal: { type: 'string' } }, additionalProperties: false } });\n`);
  writeFileSync(join(project, 'helper.ts'), 'export function fromHelper(value: number): number { return value; }\n');
  writeFileSync(join(project, 'prompts', 'editor.md'), 'Frozen editor prompt.\n');
  return { root, project, state, tarball };
}
function replayRequest() {
  const digest = (c: string) => c.repeat(64);
  return { version: AUTHOR_WIRE_VERSION_V2, input: { initialAgent: { schemaVersion: 1,
    kind: 'harness-agent', bindingSetRef: { kind: 'binding-set', digest: digest('a'), schemaId: 'test' },
    executionProfileDigest: digest('b') }, data: {}, config: { goal: 'external' },
    capabilities: { version: 'gear.author.capabilities.v1', lockDigest: digest('c'), roles: {}, operationLimits: {}, execution: {} } },
    history: [] } as never;
}

it('runs a packed, installed TypeScript author through three Campaign frontiers and cold process resume', () => {
  const { project, state } = makeInstalledProject();
  const before = runController(project, state, 'before');
  expect(before.decisionIndex).toBe(2);
  expect(before.history).toEqual(['proof.step', 'proof.step']);
  const prompt = join(project, 'prompts', 'editor.md');
  const oldPrompt = readFileSync(prompt);
  writeFileSync(prompt, 'Changed editor prompt.\n');
  expect(() => runController(project, state, 'after')).toThrow();
  writeFileSync(prompt, oldPrompt);
  const after = runController(project, state, 'after');
  expect(after.phase).toBe('complete');
  expect(after.sourceDigest).toBe(before.sourceDigest);
  expect(after.hostDigest).toBe(before.hostDigest);
  expect(after.history).toEqual(['proof.step', 'proof.step', 'proof.step']);
  expect(before.keys).toHaveLength(1);
  expect(after.keys).toEqual([]);
  expect(after.historyIds).toEqual(expect.arrayContaining(before.historyIds));
  expect(after.historyIds).toHaveLength(before.historyIds.length + 1);
  expect(after.submitCalls).toBe(1);
  expect(after.result?.outputs).toMatchObject({ one: { n: 1 }, two: { n: 2 }, three: { n: 3 } });
});

it('freezes installed bytes, lock, emitted bytes and rejects other bare modules and direct IO', async () => {
  const { project, tarball } = makeInstalledProject();
  const port = createInstalledAuthorReplayPort({ projectRoot: project, module: 'algorithm.ts', exportName: 'sample' });
  const description = await port.describeDefinition();
  expect(description.apiVersion).toBe('gear.author.replay.v1');
  expect(description.configSchema).toMatchObject({ type: 'object', required: ['goal'] });
  expect((await port.replay(replayRequest())).status).toBe('waiting');
  const sdk = join(project, 'node_modules', 'rsi-gear', 'lib', 'algorithm', 'author', 'index.js');
  const originalSdk = readFileSync(sdk);
  writeFileSync(sdk, Buffer.concat([originalSdk, Buffer.from('\n')]));
  await expect(port.replay(replayRequest())).rejects.toThrow(/identity drift/);
  writeFileSync(sdk, Buffer.concat([originalSdk, Buffer.from("\nimport 'left-pad';\n")]));
  expect(() => createInstalledAuthorReplayPort({ projectRoot: project, module: 'algorithm.ts', exportName: 'sample' }))
    .toThrow(/SDK runtime dependency is not closed/);
  writeFileSync(sdk, originalSdk);
  const emitParent = join(project, '.gear', 'author-emit');
  const emit = join(emitParent, readdirSync(emitParent)[0]!, 'algorithm.js');
  const originalEmit = readFileSync(emit);
  writeFileSync(emit, Buffer.concat([originalEmit, Buffer.from('\n')]));
  await expect(port.replay(replayRequest())).rejects.toThrow(/identity drift/);
  writeFileSync(emit, originalEmit);
  const originalLock = readFileSync(join(project, 'package-lock.json'));
  const lock = JSON.parse(originalLock.toString('utf8')) as { packages: Record<string, Record<string, unknown>> };
  lock.packages['node_modules/rsi-gear']!.integrity = 'sha512-AAAAAAAA';
  writeFileSync(join(project, 'package-lock.json'), JSON.stringify(lock));
  await expect(port.replay(replayRequest())).rejects.toThrow(/integrity drift/);
  writeFileSync(join(project, 'package-lock.json'), originalLock);
  const originalTarball = readFileSync(tarball);
  writeFileSync(tarball, Buffer.concat([originalTarball, Buffer.from('\n')]));
  await expect(port.replay(replayRequest())).rejects.toThrow(/integrity drift/);
  writeFileSync(tarball, originalTarball);
  writeFileSync(join(project, 'bad-io.ts'), "import { readFileSync } from 'node:fs'; export const bad = readFileSync('secret');\n");
  expect(() => createInstalledAuthorReplayPort({ projectRoot: project, module: 'bad-io.ts', exportName: 'bad' }))
    .toThrow(/direct external IO/);
  mkdirSync(join(project, 'dist'));
  writeFileSync(join(project, 'dist', 'hidden.ts'), 'export const hidden = 1;\n');
  writeFileSync(join(project, 'bad-excluded.ts'), "import { hidden } from './dist/hidden.js'; export const bad = hidden;\n");
  expect(() => createInstalledAuthorReplayPort({ projectRoot: project, module: 'bad-excluded.ts', exportName: 'bad' }))
    .toThrow(/excluded source directory/);
  writeFileSync(join(project, 'bad-bare.ts'), "import leftPad from 'left-pad'; export const bad = leftPad;\n");
  expect(() => createInstalledAuthorReplayPort({ projectRoot: project, module: 'bad-bare.ts', exportName: 'bad' }))
    .toThrow(/bare package import/);
});

it('accepts exact registry lock metadata and local tarball paths outside the project, and replays JS entry', async () => {
  const { root, project, tarball } = makeInstalledProject();
  writeFileSync(join(project, 'algorithm-js.js'), `import { algorithm } from 'rsi-gear/algorithm/author';\nexport const sample = algorithm(async ctx => ctx.result({ selected: ctx.initialAgent }));\n`);
  const jsPort = createInstalledAuthorReplayPort({ projectRoot: project, module: 'algorithm-js.js', exportName: 'sample' });
  expect(jsPort.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
  expect((await jsPort.replay(replayRequest())).status).toBe('completed');
  const packagePath = join(project, 'package.json'); const lockPath = join(project, 'package-lock.json');
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as { dependencies: Record<string, string> };
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { packages: Record<string, Record<string, unknown>> };
  pkg.dependencies['rsi-gear'] = '0.1.1';
  (lock.packages['']!.dependencies as Record<string, string>)['rsi-gear'] = '0.1.1';
  lock.packages['node_modules/rsi-gear']!.resolved = 'https://registry.npmjs.org/rsi-gear/-/rsi-gear-0.1.1.tgz';
  writeFileSync(packagePath, JSON.stringify(pkg)); writeFileSync(lockPath, JSON.stringify(lock));
  const registryPort = createInstalledAuthorReplayPort({ projectRoot: project, module: 'algorithm.ts', exportName: 'sample' });
  expect((await registryPort.replay(replayRequest())).status).toBe('waiting');
  const outsideTarball = join(root, 'rsi-gear-external.tgz');
  writeFileSync(outsideTarball, readFileSync(tarball));
  const exactLocal = `file:${outsideTarball}`;
  pkg.dependencies['rsi-gear'] = exactLocal;
  (lock.packages['']!.dependencies as Record<string, string>)['rsi-gear'] = exactLocal;
  lock.packages['node_modules/rsi-gear']!.resolved = exactLocal;
  writeFileSync(packagePath, JSON.stringify(pkg)); writeFileSync(lockPath, JSON.stringify(lock));
  expect(createInstalledAuthorReplayPort({ projectRoot: project, module: 'algorithm.ts', exportName: 'sample' }).sourceDigest)
    .toMatch(/^[a-f0-9]{64}$/);
});

it('closes .mjs to .mts helper imports and rejects loader-affecting Node environment', async () => {
  const { project } = makeInstalledProject();
  writeFileSync(join(project, 'mts-helper.mts'), 'export const mark = 1;\n');
  writeFileSync(join(project, 'algorithm-mts.mjs'), `import { algorithm } from 'rsi-gear/algorithm/author';
import { mark } from './mts-helper.mjs';
export const sample = algorithm(async ctx => {
  const value = await ctx.operation('proof.step', { n: mark });
  return ctx.result({ selected: ctx.initialAgent, outputs: { value } });
});
`);
  const port = createInstalledAuthorReplayPort({ projectRoot: project, module: 'algorithm-mts.mjs', exportName: 'sample' });
  expect((await port.replay(replayRequest())).status).toBe('waiting');
  writeFileSync(join(project, 'mts-helper.mts'), 'export const mark = 2;\n');
  await expect(port.replay(replayRequest())).rejects.toThrow(/identity drift/);
  const probe = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { createInstalledAuthorReplayPort } from '${resolve('lib/algorithm/author/process-port.js')}';
    try { createInstalledAuthorReplayPort({ projectRoot: ${JSON.stringify(project)}, module: 'algorithm.ts', exportName: 'sample' }); process.exit(1); }
    catch (error) { if (!String(error).includes('NODE_OPTIONS or NODE_PATH')) process.exit(2); }
  `], { env: { ...process.env, NODE_PATH: join(project, 'node_modules') }, encoding: 'utf8', timeout: 10_000 });
  expect(probe).toBe('');
});

it('rejects a symlinked compiler cache before writing into its target', () => {
  const { root, project } = makeInstalledProject();
  const outside = join(root, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(project, '.gear'));
  expect(() => createInstalledAuthorReplayPort({ projectRoot: project, module: 'algorithm.ts', exportName: 'sample' }))
    .toThrow(/emit directory escapes/);
  expect(readdirSync(outside)).toEqual([]);
});
