import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { relative, resolve, join } from 'node:path';
import { jsonDigest } from '../schema.js';

/** Conservative closed-tree identity for an A0 author package or compiled host tree. */
export function authorSourceClosureDigest(root: string): string {
  const base = resolve(root);
  const files: string[] = [];
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (['.git', '.gear', '.venv', 'venv', 'node_modules', '__pycache__', 'build', 'dist'].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlink outside author source closure: ${path}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && (/\.(?:mjs|cjs|js|ts|py|pyi|toml|json|yaml|yml|lock)$/.test(entry.name) || /^requirements.*\.txt$/.test(entry.name))) files.push(path);
      if (files.length > 4096) throw new Error('Author source closure exceeds 4096 files');
    }
  }
  visit(base);
  files.sort((a, b) => Buffer.compare(Buffer.from(relative(base, a)), Buffer.from(relative(base, b))));
  const hash = createHash('sha256');
  for (const path of files) {
    const bytes = readFileSync(path);
    if (bytes.length > 4 * 1024 * 1024) throw new Error(`Oversized author source file: ${path}`);
    hash.update(relative(base, path)); hash.update('\0'); hash.update(String(bytes.length)); hash.update('\0'); hash.update(bytes); hash.update('\0');
  }
  return hash.digest('hex');
}

/** The actual Node executable and version table are part of the author worker identity. */
export function authorNodeRuntimeDigest(nodePath = process.execPath, versions = process.versions): string {
  const executable = realpathSync(nodePath);
  return jsonDigest({ executable, executableDigest: createHash('sha256').update(readFileSync(executable)).digest('hex'), versions });
}

/** Freeze the exact compiler bytes used by A0 source diagnostics, without walking node_modules. */
export function authorSourceCheckerDigest(entryPath?: string, packagePath?: string): string {
  const require = createRequire(import.meta.url);
  const entry = realpathSync(entryPath ?? require.resolve('typescript'));
  const packageJson = realpathSync(packagePath ?? require.resolve('typescript/package.json'));
  const sha256File = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
  return jsonDigest({ entry, entryDigest: sha256File(entry), packageJson, packageDigest: sha256File(packageJson) });
}

/** Shared TS/Python author port identity for the Node controller and Gear host. */
export function authorHostIdentityDigest(hostRoot: string): string {
  return jsonDigest({ hostSource: authorSourceClosureDigest(hostRoot), nodeRuntime: authorNodeRuntimeDigest(),
    sourceChecker: authorSourceCheckerDigest() });
}
