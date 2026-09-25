import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { authorSourceClosureDigest, readBoundedFile } from './identity.js';
import { jsonDigest } from '../schema.js';

export type InstalledPythonAuthorSdk = { interpreter: string; sdkPath: string;
  packageRoot: string; packageDigest: string; discoveryDigest: string };

/** Discover the wheel installed in the selected interpreter; never substitute this repository's SDK source. */
export function discoverInstalledPythonAuthorSdk(namedInterpreter: string): InstalledPythonAuthorSdk {
  if (!namedInterpreter || !namedInterpreter.startsWith('/'))
    throw new Error('Python author requires an absolute interpreter path');
  // Keep the selected venv launcher path when executing: resolving a venv/bin/python
  // symlink to the base binary changes sys.prefix and loses that venv's installed wheel.
  const interpreter = resolve(namedInterpreter);
  const binary = realpathSync(interpreter);
  if (!lstatSync(binary).isFile()) throw new Error('Python interpreter is not a regular executable');
  const script = `import importlib.util,json,os,sys\n` +
    `s=importlib.util.find_spec('gear_algorithm')\n` +
    `if sys.version_info < (3,11) or s is None or s.origin is None: raise SystemExit('Python 3.11+ and installed gear_algorithm required')\n` +
    `print(json.dumps({'origin':os.path.realpath(s.origin),'version':sys.version.split()[0],` +
    `'prefix':os.path.realpath(sys.prefix),'basePrefix':os.path.realpath(sys.base_prefix)}))\n`;
  let reported: unknown;
  try {
    const text = execFileSync(interpreter, ['-I', '-c', script], { encoding: 'utf8', timeout: 5_000,
      maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'] });
    reported = JSON.parse(text);
  } catch (error) {
    throw new Error('Selected Python cannot discover an installed gear_algorithm SDK', { cause: error });
  }
  if (!reported || typeof reported !== 'object' || Array.isArray(reported))
    throw new Error('Installed Python SDK discovery returned invalid metadata');
  const value = reported as { origin?: unknown; version?: unknown; prefix?: unknown; basePrefix?: unknown };
  if (typeof value.origin !== 'string' || typeof value.version !== 'string'
    || typeof value.prefix !== 'string' || typeof value.basePrefix !== 'string'
    || !value.origin.endsWith('/gear_algorithm/__init__.py'))
    throw new Error('Installed Python SDK is not a regular gear_algorithm package');
  const origin = realpathSync(value.origin);
  const packageRoot = dirname(origin), sdkPath = dirname(packageRoot);
  if (origin !== join(packageRoot, '__init__.py') || !existsSync(join(packageRoot, 'worker.py')))
    throw new Error('Installed Python SDK worker entry is missing');
  const packageDigest = authorSourceClosureDigest(packageRoot);
  const venvConfig = join(dirname(interpreter), '..', 'pyvenv.cfg');
  const venvConfigDigest = existsSync(venvConfig)
    ? createHash('sha256').update(readBoundedFile(venvConfig, 64 * 1024)).digest('hex') : null;
  const binaryDigest = createHash('sha256').update(readBoundedFile(binary, 256 * 1024 * 1024)).digest('hex');
  return { interpreter, sdkPath, packageRoot, packageDigest,
    discoveryDigest: jsonDigest({ interpreter, binary, binaryDigest, sdkPath, packageRoot,
      packageDigest, version: value.version, prefix: value.prefix,
      basePrefix: value.basePrefix, venvConfigDigest }) };
}
