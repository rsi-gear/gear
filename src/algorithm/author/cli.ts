/** Thin v2 author command adapter. Physical work belongs to the real author host. */
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { load as loadYaml, JSON_SCHEMA } from 'js-yaml';
import { readBoundedFile } from './identity.js';
import { initAuthorProject, type AuthorProjectLanguage } from './project.js';

export type AuthorCliLock = { lockDigest: string; scope: { runId: string; lockPath: string | null } };
export type AuthorCliSession = { lock: AuthorCliLock;
  runtime: { tick(): Promise<'advanced' | 'waiting' | 'complete'>; snapshot(): unknown };
  adapter: { readResult(snapshot: unknown): unknown | null };
  /** The host may report an irreconcilable state that needs an operator. */
  inspectAttention(): Promise<string | null> | string | null;
  close(): Promise<void> };
export type AuthorCliInspection = { lock: AuthorCliLock; explanation: string; metadata?: unknown };
export type AuthorCliOpenOptions = { runPath: string; profilePath: string;
  scope: { kind: 'preview'; runId?: string } | { kind: 'run'; runId: string };
  maxFrontierWaves: number; python?: string; signal?: AbortSignal };
export interface AuthorCliBackend {
  inspect(options: AuthorCliOpenOptions): Promise<AuthorCliInspection>;
  open(options: AuthorCliOpenOptions): Promise<AuthorCliSession>;
  resume(options: { lockPath: string; python?: string; signal?: AbortSignal }): Promise<AuthorCliSession>;
}
export type AuthorCommandOptions = { backend?: AuthorCliBackend; emit?: (line: string) => void;
  cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal;
  /** Test-only scheduling seam; production waits 1 s after a normal waiting tick. */
  wait?: (signal: AbortSignal) => Promise<void> };
const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;

function options(argv: string[], permitted: readonly string[]): { operand: string | undefined; values: Record<string, string> } {
  const values: Record<string, string> = {};
  let operand: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index]!;
    if (!item.startsWith('--')) {
      if (operand !== undefined) throw new Error(`Unexpected extra argument ${item}`);
      operand = item;
      continue;
    }
    if (!permitted.includes(item) || Object.hasOwn(values, item)) throw new Error(`Unknown or repeated option ${item}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${item}`);
    values[item] = value;
  }
  return { operand, values };
}
function positive(value: string | undefined, label: string): number {
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value)) throw new Error(`Explicit positive ${label} required`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} exceeds safe integer range`);
  return parsed;
}
async function runSource(runPath: string): Promise<import('./run-resolver.js').AuthorRunSpecV2> {
  const bytes = readBoundedFile(runPath, 1024 * 1024);
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const parsed: unknown = loadYaml(source, { schema: JSON_SCHEMA, filename: runPath });
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    && (parsed as Record<string, unknown>).schemaVersion === 1
    && (parsed as Record<string, unknown>).kind === 'algorithm-campaign')
    throw new Error('Legacy RunSpec schemaVersion 1 is unsupported by the public author CLI; use schemaVersion 2');
  // A project can be initialized from the light npm package. Physical schema
  // factories (and their DSH peers) are needed only for v2 admission.
  const { parseAuthorRunSpec } = await import('./run-resolver.js');
  return parseAuthorRunSpec(parsed);
}
function profilePath(alias: string, explicit: string | undefined, env: NodeJS.ProcessEnv, cwd: string): string {
  if (explicit !== undefined) return resolve(cwd, explicit);
  const root = env.GEAR_PROFILE_DIR ? resolve(cwd, env.GEAR_PROFILE_DIR) : join(homedir(), '.config', 'gear', 'profiles');
  return join(root, `${alias}.yaml`);
}
function pythonOption(language: AuthorProjectLanguage, value: string | undefined, cwd: string): { python?: string } {
  if (language === 'python') {
    if (!value) throw new Error('Python author run requires --python PATH to freeze the interpreter');
    return { python: resolve(cwd, value) };
  }
  if (value !== undefined) throw new Error('--python applies only to a Python author project');
  return {};
}
function runIndexDirectory(projectRoot: string): string {
  const gear = join(projectRoot, '.gear');
  const run = join(gear, 'run');
  for (const directory of [gear, run]) {
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Author run index directory must not be linked');
  }
  return run;
}
function runIndexPath(projectRoot: string, runId: string): string {
  if (!runIdPattern.test(runId) || runId === '.' || runId === '..') throw new Error('Invalid author run ID');
  return join(projectRoot, '.gear', 'run', `${runId}.json`);
}
function persistRunIndex(projectRoot: string, lock: AuthorCliLock): void {
  const { runId, lockPath } = lock.scope;
  if (!lockPath || !isAbsolute(lockPath) || !sha256Pattern.test(lock.lockDigest))
    throw new Error('Host did not return a persisted, identified run lock');
  const directory = runIndexDirectory(projectRoot);
  const path = runIndexPath(projectRoot, runId);
  const bytes = JSON.stringify({ schemaVersion: 1, runId, lockPath, lockDigest: lock.lockDigest });
  const temporary = join(directory, `.${runId}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    linkSync(temporary, path);
    const directoryFd = openSync(directory, 'r');
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function lockFromIndex(projectRoot: string, runId: string): { lockPath: string; lockDigest: string } {
  const directory = join(projectRoot, '.gear', 'run');
  if (lstatSync(join(projectRoot, '.gear')).isSymbolicLink() || lstatSync(directory).isSymbolicLink())
    throw new Error('Author run index directory must not be linked');
  const value: unknown = JSON.parse(readBoundedFile(runIndexPath(projectRoot, runId), 16 * 1024).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Author run index invalid');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'lockDigest,lockPath,runId,schemaVersion'
    || row.schemaVersion !== 1 || row.runId !== runId || !sha256Pattern.test(String(row.lockDigest))
    || typeof row.lockPath !== 'string' || !isAbsolute(row.lockPath))
    throw new Error('Author run index identity invalid');
  return { lockPath: row.lockPath, lockDigest: row.lockDigest as string };
}

async function productionBackend(): Promise<AuthorCliBackend> {
  // This is intentionally loaded only for check/run/resume; init remains usable before host installation.
  const modulePath = './host.js';
  let loaded: unknown;
  try { loaded = await import(modulePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND')
      throw new Error('A1 physical author host is unavailable in this Gear installation');
    throw error;
  }
  const host = loaded as Record<string, unknown>;
  if (typeof host.inspectAuthorHost !== 'function' || typeof host.openAuthorHost !== 'function'
    || typeof host.resumeAuthorHost !== 'function')
    throw new Error('A1 physical author host exports are incomplete');
  return {
    inspect: value => (host.inspectAuthorHost as (value: AuthorCliOpenOptions) => Promise<AuthorCliInspection>)(value),
    open: value => (host.openAuthorHost as (value: AuthorCliOpenOptions) => Promise<AuthorCliSession>)(value),
    resume: value => (host.resumeAuthorHost as (value: { lockPath: string; python?: string;
      signal?: AbortSignal }) => Promise<AuthorCliSession>)(value),
  };
}
function noCancelSignal(external?: AbortSignal): { signal: AbortSignal; close(): void } {
  if (external) return { signal: external, close: () => undefined };
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return { signal: controller.signal, close: () => {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  } };
}
async function waitForNextTick(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>(finish => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); finish(); }, 1000);
    const abort = (): void => { clearTimeout(timer); finish(); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Drives a Campaign until completion, attention, or local observer stop.
 * A signal stops scheduling the next tick; an in-flight tick is allowed to
 * finish so its durable outcome is observed without cancelling physical work. */
export async function driveAuthorSession(session: AuthorCliSession, emit: (line: string) => void,
  signal: AbortSignal, wait = waitForNextTick): Promise<'complete' | 'observer-stopped'> {
  const runId = session.lock.scope.runId;
  let announcedWaiting = false;
  while (!signal.aborted) {
    const status = await session.runtime.tick();
    if (status === 'complete') {
      const snapshot = session.runtime.snapshot();
      if (!snapshot) throw new Error('Completed author Campaign has no persisted snapshot');
      const result = session.adapter.readResult(snapshot);
      if (result === null) throw new Error('Completed author Campaign has no sealed result');
      emit(JSON.stringify({ status: 'complete', runId, result }));
      return 'complete';
    }
    if (status === 'advanced') { announcedWaiting = false; continue; }
    if (status !== 'waiting') throw new Error(`Unknown author runtime status ${String(status)}`);
    const attention = await session.inspectAttention();
    if (attention) {
      emit(JSON.stringify({ status: 'needs-attention', runId, reason: attention }));
      throw new Error(`Author run ${runId} needs attention: ${attention}`);
    }
    if (!announcedWaiting) { emit(JSON.stringify({ status: 'waiting', runId })); announcedWaiting = true; }
    await wait(signal);
  }
  emit(JSON.stringify({ status: 'observer-stopped', runId,
    lockPath: session.lock.scope.lockPath }));
  return 'observer-stopped';
}

/** argv starts after `algorithm`; a backend seam tests the CLI without constructing a physical host. */
export async function runAuthorCommand(argv: string[], dependencies: AuthorCommandOptions = {}): Promise<void> {
  const action = argv[0];
  const emit = dependencies.emit ?? (line => process.stdout.write(`${line}\n`));
  const cwd = resolve(dependencies.cwd ?? process.cwd());
  const env = dependencies.env ?? process.env;
  if (action === 'init') {
    const { operand, values } = options(argv.slice(1),
      ['--language', '--template', '--profile', '--sdk-package', '--python-sdk-wheel']);
    if (!operand || (values['--language'] !== 'python' && values['--language'] !== 'typescript')
      || values['--template'] !== 'search' || !values['--profile'])
      throw new Error('usage: algorithm init DIRECTORY --language python|typescript --template search --profile ALIAS');
    const project = initAuthorProject({ directory: resolve(cwd, operand), language: values['--language'],
      template: 'search', profile: values['--profile'],
      ...(values['--sdk-package'] ? { sdkPackage: resolve(cwd, values['--sdk-package']) } : {}),
      ...(values['--python-sdk-wheel'] ? { pythonSdkWheel: resolve(cwd, values['--python-sdk-wheel']) } : {}) });
    emit(JSON.stringify({ status: 'initialized', directory: project.directory, files: project.files,
      dependency: project.dependency, source: project.source }));
    return;
  }
  if (!['check', 'explain', 'run', 'resume'].includes(action ?? ''))
    throw new Error('usage: algorithm <init|check|explain|run|resume> ...');
  if (action === 'resume') {
    const { operand, values } = options(argv.slice(1), ['--lock', '--python']);
    if (!operand && !values['--lock']) throw new Error('usage: algorithm resume RUN_ID | --lock PATH [--python PATH]');
    if (operand && values['--lock']) throw new Error('Choose a run ID or --lock, not both');
    if (operand && !runIdPattern.test(operand)) throw new Error('Invalid author run ID');
    const indexed = values['--lock'] ? undefined : lockFromIndex(cwd, operand!);
    const lockPath = values['--lock'] ? resolve(cwd, values['--lock']) : indexed!.lockPath;
    const backend = dependencies.backend ?? await productionBackend();
    const observer = noCancelSignal(dependencies.signal);
    try {
      const session = await backend.resume({ lockPath,
        ...(values['--python'] ? { python: resolve(cwd, values['--python']) } : {}) });
      try {
        if (operand && session.lock.scope.runId !== operand) throw new Error('Resume lock run ID does not match request');
        if (session.lock.scope.lockPath !== lockPath) throw new Error('Resume host used a different lock path');
        if (indexed && session.lock.lockDigest !== indexed.lockDigest)
          throw new Error('Resume lock identity differs from the project run index');
        await driveAuthorSession(session, emit, observer.signal, dependencies.wait);
      } finally { await session.close(); }
    } finally { observer.close(); }
    return;
  }
  const { operand, values } = options(argv.slice(1),
    ['--profile-file', '--python', '--max-frontier-waves']);
  if (!operand) throw new Error(`usage: algorithm ${action} RUN_YAML --max-frontier-waves N [--python PATH]`);
  const runPath = resolve(cwd, operand);
  const spec = await runSource(runPath);
  const profile = profilePath(spec.profile, values['--profile-file'], env, cwd);
  const maxFrontierWaves = positive(values['--max-frontier-waves'], 'max-frontier-waves');
  const python = pythonOption(spec.algorithm.language, values['--python'], cwd);
  const backend = dependencies.backend ?? await productionBackend();
  const request = { runPath, profilePath: profile, maxFrontierWaves, ...python };
  if (action === 'check' || action === 'explain') {
    const inspected = await backend.inspect({ ...request, scope: { kind: 'preview' } });
    if (!sha256Pattern.test(inspected.lock.lockDigest)) throw new Error('Author check returned an invalid lock identity');
    emit(action === 'explain' ? inspected.explanation : JSON.stringify({ status: 'checked',
      profilePath: profile, lockDigest: inspected.lock.lockDigest,
      note: 'Check may write disposable compiler/scratch CAS files; it creates no formal run Campaign/CAS, run lock, or physical task' }));
    return;
  }
  const runId = randomUUID();
  const observer = noCancelSignal(dependencies.signal);
  try {
    const session = await backend.open({ ...request, scope: { kind: 'run', runId } });
    try {
      if (session.lock.scope.runId !== runId) throw new Error('Author host changed generated run ID');
      persistRunIndex(dirname(runPath), session.lock);
      emit(JSON.stringify({ status: 'started', runId, lockPath: session.lock.scope.lockPath }));
      await driveAuthorSession(session, emit, observer.signal, dependencies.wait);
    } finally { await session.close(); }
  } finally { observer.close(); }
}
