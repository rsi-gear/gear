import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { closeSync, constants, fstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { relative, resolve, join } from 'node:path';
import { jsonDigest } from '../schema.js';

/** Read at most maxBytes, including under a concurrent file-size change. */
export function readBoundedFile(path: string, maxBytes: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`Sealed input is not a regular file: ${path}`);
    if (fstatSync(fd).size > maxBytes) throw new Error(`Oversized sealed file: ${path}`);
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - total + 1));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count;
      if (total > maxBytes) throw new Error(`Oversized sealed file: ${path}`);
      chunks.push(chunk.subarray(0, count));
    }
    if (fstatSync(fd).size !== total) throw new Error(`Sealed file changed during read: ${path}`);
    return Buffer.concat(chunks, total);
  } finally { closeSync(fd); }
}

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
      else if (entry.isFile() && (/\.(?:mjs|cjs|js|ts|mts|py|pyi|toml|json|yaml|yml|lock|md|txt)$/.test(entry.name) || /^requirements.*\.txt$/.test(entry.name))) files.push(path);
      if (files.length > 4096) throw new Error('Author source closure exceeds 4096 files');
    }
  }
  visit(base);
  files.sort((a, b) => Buffer.compare(Buffer.from(relative(base, a)), Buffer.from(relative(base, b))));
  const hash = createHash('sha256');
  for (const path of files) {
    const bytes = readBoundedFile(path, 4 * 1024 * 1024);
    hash.update(relative(base, path)); hash.update('\0'); hash.update(String(bytes.length)); hash.update('\0'); hash.update(bytes); hash.update('\0');
  }
  return hash.digest('hex');
}

/** The actual Node executable and version table are part of the author worker identity. */
export function authorNodeRuntimeDigest(nodePath = process.execPath, versions = process.versions): string {
  const executable = realpathSync(nodePath);
  return jsonDigest({ executable, executableDigest: createHash('sha256').update(readBoundedFile(executable, 256 * 1024 * 1024)).digest('hex'), versions });
}

/** Freeze the exact compiler bytes used by A0 source diagnostics, without walking node_modules. */
export function authorSourceCheckerDigest(entryPath?: string, packagePath?: string): string {
  const require = createRequire(import.meta.url);
  const entry = realpathSync(entryPath ?? require.resolve('typescript'));
  const packageJson = realpathSync(packagePath ?? require.resolve('typescript/package.json'));
  const sha256File = (path: string): string => createHash('sha256').update(readBoundedFile(path, 128 * 1024 * 1024)).digest('hex');
  return jsonDigest({ entry, entryDigest: sha256File(entry), packageJson, packageDigest: sha256File(packageJson) });
}

/** Shared TS/Python author port identity for the Node controller and Gear host. */
export function authorHostIdentityDigest(hostRoot: string): string {
  return jsonDigest({ hostSource: authorSourceClosureDigest(hostRoot), nodeRuntime: authorNodeRuntimeDigest(),
    sourceChecker: authorSourceCheckerDigest() });
}

/** Byte-complete, bounded closure for installed SDK packages and emitted author modules. */
export function sealedTreeDigest(root: string): string {
  const base = realpathSync(root);
  const files: string[] = [];
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlink in sealed tree: ${path}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`Unsupported file in sealed tree: ${path}`);
      if (files.length > 20_000) throw new Error('Sealed tree exceeds 20,000 files');
    }
  }
  visit(base);
  files.sort((a, b) => Buffer.compare(Buffer.from(relative(base, a)), Buffer.from(relative(base, b))));
  const hash = createHash('sha256');
  let total = 0;
  for (const path of files) {
    const bytes = readBoundedFile(path, 64 * 1024 * 1024);
    total += bytes.length;
    if (total > 512 * 1024 * 1024)
      throw new Error('Sealed tree exceeds byte limit');
    hash.update(relative(base, path)); hash.update('\0'); hash.update(String(bytes.length)); hash.update('\0');
    hash.update(bytes); hash.update('\0');
  }
  return hash.digest('hex');
}
