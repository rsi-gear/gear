import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, jsonDigest, type JsonValue } from '../schema.js';
import { PythonWorker, type PythonWorkerOptions } from '../hosts/python.js';
import { AUTHOR_WIRE_VERSION, type AuthorReplayReply } from './index.js';
import { authorHostIdentityDigest, authorSourceClosureDigest } from './identity.js';
import type { ReplayPort } from './adapter.js';

export type SealedPythonReplayPort = ReplayPort & { sourceDigest: string; hostDigest: string };
type Environment = { executable: string; version: string; packages: [string, string][]; loadedFiles: [string, string][]; executableSha256: string };
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
function environment(interpreter: string, projectRoot: string, sdkRoot: string, modulePath: string, exportName: string): Environment {
  const script = `import json,sys,runpy,stringprep,unicodedata,encodings.idna
from pathlib import Path
sys.path.insert(0,sys.argv[2]);sys.path.insert(0,sys.argv[1])
from gear_algorithm.worker import _load_export,_environment_info
_,source=_load_export(sys.argv[3],sys.argv[4],Path(sys.argv[1]))
print(json.dumps(_environment_info(source)))`;
  const raw = execFileSync(interpreter, ['-c', script, projectRoot, sdkRoot, modulePath, exportName],
    { cwd: projectRoot, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8',
      timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
  const result = JSON.parse(raw) as { interpreter: string; pythonVersion: string; packages: [string, string][]; loadedModules: unknown };
  const executable = realpathSync(result.interpreter);
  const executableSha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
  return { executable, version: result.pythonVersion, packages: result.packages, loadedFiles: loadedFiles(result.loadedModules), executableSha256 };
}
function containedModule(projectRoot: string, module: string): string {
  if (!module.endsWith('.py')) throw new Error('A0 Python author module must be an explicit .py path inside configDir');
  const path = realpathSync(isAbsolute(module) ? module : resolve(projectRoot, module));
  const name = relative(projectRoot, path);
  if (!name || name === '..' || name.startsWith('../') || isAbsolute(name))
    throw new Error('Python author module escapes frozen configDir');
  return path;
}
/** Fresh worker per decision, with project, SDK, interpreter, packages and host closure checked before every replay. */
export function createPythonAuthorReplayPort(options: Omit<PythonWorkerOptions, 'mode'>): SealedPythonReplayPort {
  const projectRoot = realpathSync(options.configDir);
  const modulePath = containedModule(projectRoot, options.module);
  if (!options.sdkPath) throw new Error('A0 Python author requires an explicit frozen sdkPath');
  const sdkRoot = realpathSync(options.sdkPath);
  const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const interpreter = options.interpreter.includes('/') || options.interpreter.includes('\\')
    ? (isAbsolute(options.interpreter) ? options.interpreter : resolve(projectRoot, options.interpreter)) : options.interpreter;
  const frozenEnvironment = environment(interpreter, projectRoot, sdkRoot, modulePath, options.export);
  const source = (): JsonValue => ({ project: authorSourceClosureDigest(projectRoot),
    sdk: authorSourceClosureDigest(sdkRoot), modulePath, moduleSha256: createHash('sha256').update(readFileSync(modulePath)).digest('hex'),
    export: options.export, environment: frozenEnvironment as unknown as JsonValue });
  const sourceDigest = jsonDigest(source());
  const hostDigest = authorHostIdentityDigest(hostRoot);
  const replay: ReplayPort = async request => {
    if (jsonDigest(source()) !== sourceDigest || authorHostIdentityDigest(hostRoot) !== hostDigest
      || createHash('sha256').update(readFileSync(frozenEnvironment.executable)).digest('hex') !== frozenEnvironment.executableSha256)
      throw new Error('Python author source/host/environment closure changed during campaign');
    if (request.version !== AUTHOR_WIRE_VERSION || Buffer.byteLength(canonicalJson(request)) > 1024 * 1024)
      throw new Error('Invalid/oversized author replay request');
    const worker = await PythonWorker.start({ ...options, mode: 'author' });
    try {
      const reported = await worker.call('environment.describe') as Record<string, JsonValue>;
      const reportedFiles = loadedFiles(reported.loadedModules);
      const failed = [
        reported.sourcePath !== modulePath ? 'module-path' : null,
        reported.sourceSha256 !== createHash('sha256').update(readFileSync(modulePath)).digest('hex') ? 'module-bytes' : null,
        reported.interpreter !== frozenEnvironment.executable ? 'interpreter' : null,
        reported.pythonVersion !== frozenEnvironment.version ? 'version' : null,
        canonicalJson(reported.packages) !== canonicalJson(frozenEnvironment.packages) ? 'packages' : null,
        canonicalJson(reportedFiles) !== canonicalJson(frozenEnvironment.loadedFiles) ? `loaded-files:${reportedFiles.length}/${frozenEnvironment.loadedFiles.length}` : null,
      ].filter(Boolean);
      if (failed.length) throw new Error(`Python author worker environment drift: ${failed.join(',')}`);
      const reply = await worker.call('author.replay', request) as AuthorReplayReply;
      if (Buffer.byteLength(canonicalJson(reply)) > 1024 * 1024 || (reply.status !== 'waiting' && reply.status !== 'completed'))
        throw new Error('Invalid/oversized Python author replay reply');
      return reply;
    } finally { await worker.close(); }
  };
  return Object.assign(replay, { sourceDigest, hostDigest });
}
